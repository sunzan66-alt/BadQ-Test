// BadQ Core - Full automatic Owner Sync engine (PLUS / PRO / FOUNDER_ALL_ACCESS only).
//
// Once a group is explicitly linked to Cloud, ALL of the group's business records (group settings, players, sessions, matches, scores,
// history, finance - see owner-sync-model.js) are mirrored automatically; there is no per-player selection. The engine is
// offline-first: the local durable bg-v11 state is the source of truth for interaction, changes are detected by hashing the durable
// snapshot, queued in a durable outbox, and replayed on reconnect with deterministic op ids (a replay is acknowledged as a duplicate by
// the server and can never be applied twice).
//
// Safety properties (all covered by tests/test_owner_sync_unit.mjs):
//  * No silent concurrent overwrite: every upsert/delete carries the record version it was based on (compare-and-set). A version
//    mismatch parks the record as a CONFLICT; it is never retried or overwritten until the Owner resolves it explicitly.
//  * No duplicate replay: opId = sha256(owner|group|key|baseVersion|payloadHash); the in-flight batch is persisted BEFORE sending and
//    replayed byte-identically after a crash/reload.
//  * Initial linking needs an explicit decision (upload / restore / reconcile). Nothing is sent before it.
//  * Local data is never deleted by an entitlement change. Expiry/revocation/device loss only PAUSES syncing.
//  * A Restore/Undo (restoreEpoch change) and a mass deletion are held for Owner review rather than propagated.
//  * Cloud changes are never applied to live local state automatically; fast-forwards are applied only by an explicit call.
//  * Firebase traffic control: debounce + max-wait coalescing, hash diff (only changed records), batch cap, exponential backoff.
//
// TRANSPORT (PENDING-CONTRACT): the final Commercial sync API has not been delivered. Core depends only on this interface, supplied
// through deps.transport; the real HTTP binding must be written against Codex's documented routes. Interface:
//   push({ cloudGroupId, batchId, deviceId, ops:[{ opId, key, collection, op:"upsert"|"delete", baseVersion, payload, payloadHash }] })
//        -> { results:[{ opId, status:"applied"|"duplicate"|"conflict"|"rejected", version?, cloud?:{ version, payloadHash } , code? }] }
//   pull({ cloudGroupId, cursor, limit }) -> { records:[{ key, collection, version, deleted, payload, payloadHash }], cursor, done, total }
// Errors are thrown as objects with `.code` in: network | rate-limited | server | unauthorized | entitlement-denied | device-not-authorized.

import { canonicalText, sha256Hex, projectState, buildStateFromRecords, countRecords } from "./owner-sync-model.js";

export const OWNER_SYNC_SCHEMA = 1;
export const DEFAULTS = Object.freeze({ debounceMs: 3000, maxWaitMs: 30000, maxBatch: 100, backoffBaseMs: 2000, backoffMaxMs: 300000, massDeleteMin: 10, massDeleteRatio: 0.5, pullPageSize: 200 });
const FATAL_PAUSE = new Set(["unauthorized", "entitlement-denied", "device-not-authorized"]);

export class OwnerSyncError extends Error { constructor(code) { super(code); this.name = "OwnerSyncError"; this.code = code; } }
const clone = (v) => JSON.parse(JSON.stringify(v));

export function createMemoryOwnerSyncStore() {
  const m = new Map();
  return { async load(scope) { return m.has(scope) ? clone(m.get(scope)) : null; }, async save(scope, doc) { m.set(scope, clone(doc)); }, _dump: () => m };
}

// Minimal IndexedDB store (production binding). One document per owner+group scope.
export function createIdbOwnerSyncStore({ indexedDB: factory = (typeof indexedDB !== "undefined" ? indexedDB : null), name = "badq-owner-sync-v1" } = {}) {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((resolve, reject) => {
    if (!factory) return reject(new OwnerSyncError("store-unavailable"));
    const req = factory.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("docs");
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(new OwnerSyncError("store-unavailable"));
  }));
  const tx = async (mode, fn) => { const db = await open(); return new Promise((resolve, reject) => { const t = db.transaction("docs", mode); const r = fn(t.objectStore("docs")); t.oncomplete = () => resolve(r && r.result); t.onerror = () => reject(new OwnerSyncError("store-unavailable")); t.onabort = () => reject(new OwnerSyncError("store-unavailable")); }); };
  return { async load(scope) { const v = await tx("readonly", (s) => s.get(scope)); return v ? clone(v) : null; }, async save(scope, doc) { await tx("readwrite", (s) => s.put(clone(doc), scope)); } };
}

export function createOwnerSyncEngine(deps) {
  const { store, transport, host, getCapability } = deps || {};
  if (!store || typeof store.load !== "function" || typeof store.save !== "function" || !transport || typeof transport.push !== "function" || typeof transport.pull !== "function" ||
      !host || typeof host.readDurableSnapshot !== "function" || typeof getCapability !== "function") throw new OwnerSyncError("owner-sync-dependency-invalid");
  const cfg = { ...DEFAULTS, ...(deps.config || {}) };
  const isOnline = deps.isOnline || (() => true);
  const schedule = deps.schedule || ((fn, ms) => { const h = setTimeout(fn, ms); return () => clearTimeout(h); });
  const nowFn = deps.now || Date.now;
  const approvedPrivate = deps.approvedPrivateFields || [];
  const subscribers = new Set();

  let chain = Promise.resolve();
  let doc = null; let scopeKey = null; let cap = null;
  let status = { state: "idle", reason: null };
  let cancelDebounce = null; let firstDirtyAt = null; let cancelRetry = null; let failures = 0; let disposed = false;
  let lastSummary = { pending: 0, conflicts: [], cloudAhead: 0, lastSyncAt: null };

  const emit = () => { for (const cb of subscribers) { try { cb(getStatus()); } catch { /* presentation only */ } } };
  const setStatus = (state, reason = null) => { status = { state, reason }; emit(); };
  const serial = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };

  function newDoc(c) {
    return { schema: OWNER_SYNC_SCHEMA, ownerId: c.ownerId, cloudGroupId: c.cloudGroupId, deviceId: c.deviceId, initialized: false, records: {}, outbox: null, conflicts: {}, cursor: null,
      restoreEpoch: null, reviews: {}, lastSyncAt: null, legacy: null };
  }
  async function load(c) {
    const key = `${c.ownerId}|${c.cloudGroupId}`;
    if (doc && scopeKey === key) return doc;
    let d = await store.load(key);
    if (d && (d.schema !== OWNER_SYNC_SCHEMA || d.ownerId !== c.ownerId || d.cloudGroupId !== c.cloudGroupId)) throw new OwnerSyncError("store-invalid");
    doc = d || newDoc(c); scopeKey = key;
    return doc;
  }
  const save = () => store.save(scopeKey, doc);

  function capability() {
    let c; try { c = getCapability(); } catch { c = { ok: false, code: "capability-unavailable" }; }
    if (!c || c.ok !== true) return { ok: false, code: (c && c.code) || "capability-unavailable" };
    if (!c.ownerId || !c.cloudGroupId || !c.deviceId) return { ok: false, code: "group-link-not-found" };
    return c;
  }
  // Re-check immediately before every network call (an entitlement/identity change mid-flush stops the flush).
  function stillAllowed() { const c = capability(); return c.ok && cap && c.ownerId === cap.ownerId && c.cloudGroupId === cap.cloudGroupId; }

  async function recordFor(entry) {
    const text = canonicalText(entry.payload);
    return { ...entry, payloadHash: await sha256Hex(text) };
  }
  async function projectLocal(state) {
    const map = projectState(state, { approved: approvedPrivate });
    const out = new Map();
    for (const [k, e] of map) out.set(k, await recordFor(e));
    return out;
  }
  const opIdOf = (c, key, baseVersion, hash) => sha256Hex(`${c.ownerId}|${c.cloudGroupId}|${key}|${baseVersion}|${hash || "delete"}`).then((h) => `op_${h.slice(0, 40)}`);

  async function snapshot() {
    const snap = await host.readDurableSnapshot();
    if (!snap || snap.ok !== true || typeof snap.state !== "object" || !snap.state) throw new OwnerSyncError("durable-snapshot-unavailable");
    return snap;
  }

  // ---- diff ---------------------------------------------------------------------------------------------------------------
  async function diff(local) {
    const ops = []; const deletes = [];
    for (const [key, e] of local) {
      if (doc.conflicts[key]) continue;
      const known = doc.records[key];
      if (known && !known.deleted && known.hash === e.payloadHash) continue;
      ops.push({ key, collection: e.collection, op: "upsert", baseVersion: known ? known.version : 0, payload: e.payload, payloadHash: e.payloadHash });
    }
    for (const [key, known] of Object.entries(doc.records)) {
      if (known.deleted || known.cloudOnly || local.has(key) || doc.conflicts[key]) continue;
      deletes.push({ key, collection: key.split("/")[0] === "order" ? key.split("/")[1] : key.split("/")[0], op: "delete", baseVersion: known.version, payload: null, payloadHash: null });
    }
    return { ops, deletes };
  }

  async function sealOps(list) {
    const sealed = [];
    for (const o of list) sealed.push({ ...o, collection: o.collection || "group", opId: await opIdOf(cap, o.key, o.baseVersion, o.payloadHash) });
    return sealed;
  }

  // ---- sending ------------------------------------------------------------------------------------------------------------
  async function sendOutbox() {
    const box = doc.outbox; if (!box) return;
    if (!stillAllowed()) throw new OwnerSyncError("capability-lost");
    if (!isOnline()) throw Object.assign(new OwnerSyncError("offline"), { transient: true });
    let resp;
    try { resp = await transport.push({ cloudGroupId: doc.cloudGroupId, batchId: box.batchId, deviceId: doc.deviceId, ops: box.ops.map((o) => ({ opId: o.opId, key: o.key, collection: o.collection, op: o.op, baseVersion: o.baseVersion, payload: o.payload, payloadHash: o.payloadHash })) }); }
    catch (e) { throw Object.assign(new OwnerSyncError((e && e.code) || "network"), { transient: !FATAL_PAUSE.has(e && e.code) }); }
    if (!resp || !Array.isArray(resp.results)) throw Object.assign(new OwnerSyncError("server-response-invalid"), { transient: true });
    const byId = new Map(resp.results.map((r) => [r && r.opId, r]));
    // every op must have an explicit outcome; otherwise the batch stays in the outbox and is replayed (idempotent by opId)
    if (box.ops.some((o) => !byId.has(o.opId))) throw Object.assign(new OwnerSyncError("server-response-incomplete"), { transient: true });
    for (const o of box.ops) {
      const r = byId.get(o.opId);
      if (r.status === "applied" || r.status === "duplicate") {
        if (!Number.isSafeInteger(r.version) || r.version < 0) throw Object.assign(new OwnerSyncError("server-response-invalid"), { transient: true });
        doc.records[o.key] = o.op === "delete" ? { version: r.version, hash: null, deleted: true } : { version: r.version, hash: o.payloadHash };
        delete doc.conflicts[o.key];
      } else if (r.status === "conflict") {
        doc.conflicts[o.key] = { code: "edit-conflict", baseVersion: o.baseVersion, cloudVersion: r.cloud && Number.isSafeInteger(r.cloud.version) ? r.cloud.version : null,
          cloudHash: r.cloud ? r.cloud.payloadHash || null : null, localHash: o.payloadHash, op: o.op };
      } else {
        doc.conflicts[o.key] = { code: "server-rejected", baseVersion: o.baseVersion, cloudVersion: null, cloudHash: null, localHash: o.payloadHash, op: o.op, detail: r.code || null };
      }
    }
    doc.outbox = null; doc.lastSyncAt = nowFn();
    await save();
  }

  function summarize() {
    lastSummary = { pending: doc ? (doc.outbox ? doc.outbox.ops.length : 0) : 0, conflicts: doc ? Object.keys(doc.conflicts) : [], cloudAhead: lastSummary.cloudAhead, lastSyncAt: doc ? doc.lastSyncAt : null };
  }

  // ---- main flush ---------------------------------------------------------------------------------------------------------
  async function doFlush() {
    if (disposed) return { ok: false, code: "engine-disposed" };
    const c = capability();
    if (!c.ok) { setStatus("disabled", c.code); return { ok: false, code: c.code }; }
    cap = c;
    if (!isOnline()) { setStatus("offline", "offline"); return { ok: false, code: "offline" }; }
    try {
      await load(c);
      if (!doc.initialized) { const info = await initialInfo(); setStatus("initial-decision-required", null); return { ok: false, code: "initial-decision-required", info }; }
      if (doc.reviews.restore) { setStatus("review-required", "local-restored-review"); return { ok: false, code: "local-restored-review" }; }
      if (doc.reviews.massDelete) { setStatus("review-required", "mass-delete-review"); return { ok: false, code: "mass-delete-review" }; }
      setStatus("syncing");
      if (doc.outbox) await sendOutbox();
      for (let round = 0; round < 50; round += 1) {
        const snap = await snapshot();
        // Restore/Undo fence: the durable local state may be an OLDER backup, not an Owner edit
        const epoch = snap.restoreEpoch === undefined || snap.restoreEpoch === null ? 0 : snap.restoreEpoch;
        if (doc.restoreEpoch === null) { doc.restoreEpoch = epoch; await save(); }
        else if (doc.restoreEpoch !== epoch) { doc.reviews.restore = { fromEpoch: doc.restoreEpoch, toEpoch: epoch }; await save(); setStatus("review-required", "local-restored-review"); return { ok: false, code: "local-restored-review" }; }
        const local = await projectLocal(snap.state);
        const { ops, deletes } = await diff(local);
        const known = Object.values(doc.records).filter((r) => !r.deleted).length;
        if (!doc.allowMassDelete && deletes.length >= cfg.massDeleteMin && deletes.length > known * cfg.massDeleteRatio) {
          doc.reviews.massDelete = { count: deletes.length, of: known, at: nowFn() }; await save(); setStatus("review-required", "mass-delete-review"); return { ok: false, code: "mass-delete-review" };
        }
        const all = [...ops, ...deletes];
        if (all.length === 0) break;
        const batch = await sealOps(all.slice(0, cfg.maxBatch));
        doc.outbox = { batchId: `batch_${(await sha256Hex(batch.map((o) => o.opId).join(","))).slice(0, 32)}`, ops: batch };
        await save();                // durable BEFORE the request can be sent
        await sendOutbox();
        if (all.length <= cfg.maxBatch) {
          // a change made while the request was in flight is picked up by one more pass
          const again = await diff(await projectLocal((await snapshot()).state));
          if (again.ops.length + again.deletes.length === 0) break;
        }
      }
      failures = 0; if (doc.allowMassDelete) { delete doc.allowMassDelete; await save(); } summarize();
      setStatus(Object.keys(doc.conflicts).length ? "conflict" : "idle", Object.keys(doc.conflicts).length ? "edit-conflict" : null);
      return { ok: true };
    } catch (e) {
      summarize();
      const code = (e && e.code) || "unknown";
      if (FATAL_PAUSE.has(code) || code === "capability-lost") { setStatus("paused", code); return { ok: false, code }; }
      if (e && e.transient) {
        failures += 1; scheduleRetry();
        setStatus(code === "offline" ? "offline" : "retrying", code); return { ok: false, code };
      }
      setStatus("error", code); return { ok: false, code };
    }
  }

  function scheduleRetry() {
    if (cancelRetry) cancelRetry();
    const wait = Math.min(cfg.backoffMaxMs, cfg.backoffBaseMs * 2 ** Math.min(failures, 10));
    cancelRetry = schedule(() => { cancelRetry = null; flush(); }, wait);
  }

  function flush() { return serial(doFlush); }

  // Called after a durable save (or any time local data may have changed). Coalesces bursts; never sends per keystroke.
  function notifyChanged() {
    if (disposed) return;
    const t = nowFn(); if (firstDirtyAt === null) firstDirtyAt = t;
    if (cancelDebounce) cancelDebounce();
    const wait = Math.max(0, Math.min(cfg.debounceMs, cfg.maxWaitMs - (t - firstDirtyAt)));
    cancelDebounce = schedule(() => { cancelDebounce = null; firstDirtyAt = null; flush(); }, wait);
  }
  function onOnline() { failures = 0; if (cancelRetry) { cancelRetry(); cancelRetry = null; } return flush(); }

  // ---- initial linking ----------------------------------------------------------------------------------------------------
  async function pullAll() {
    const records = []; let cursor = null;
    for (let i = 0; i < 1000; i += 1) {
      if (!stillAllowed()) throw new OwnerSyncError("capability-lost");
      let page;
      try { page = await transport.pull({ cloudGroupId: doc.cloudGroupId, cursor, limit: cfg.pullPageSize }); }
      catch (e) { throw Object.assign(new OwnerSyncError((e && e.code) || "network"), { transient: !FATAL_PAUSE.has(e && e.code) }); }
      if (!page || !Array.isArray(page.records)) throw new OwnerSyncError("server-response-invalid");
      records.push(...page.records);
      if (page.done) return { records, cursor: page.cursor === undefined ? cursor : page.cursor };
      if (page.cursor === cursor) throw new OwnerSyncError("server-response-invalid"); // no progress
      cursor = page.cursor;
    }
    throw new OwnerSyncError("server-response-invalid");
  }
  async function initialInfo() {
    const snap = await snapshot();
    const localCount = countRecords(snap.state);
    let cloudCount;
    try { const p = await transport.pull({ cloudGroupId: doc.cloudGroupId, cursor: null, limit: 1 }); cloudCount = Number.isSafeInteger(p.total) ? p.total : p.records.length; }
    catch { cloudCount = null; }
    const options = cloudCount === null ? [] : cloudCount === 0 ? (localCount > 0 ? ["upload"] : ["upload"]) : localCount === 0 ? ["restore"] : ["reconcile", "restore"];
    return { localCount, cloudCount, options };
  }

  // mode: "upload" | "restore" | "reconcile". Requires explicit confirmation (confirmed === true).
  function startInitial(mode, { confirmed = false } = {}) {
    return serial(async () => {
      if (confirmed !== true) throw new OwnerSyncError("confirmation-required");
      const c = capability(); if (!c.ok) throw new OwnerSyncError(c.code);
      cap = c; await load(c);
      if (doc.initialized) throw new OwnerSyncError("already-initialized");
      const info = await initialInfo();
      if (!info.options.includes(mode)) throw new OwnerSyncError("initial-mode-not-allowed");
      const snap = await snapshot();
      if (mode === "upload") {
        doc.initialized = true; doc.restoreEpoch = snap.restoreEpoch || 0; await save();
      } else {
        const { records, cursor } = await pullAll();
        const cloudMap = new Map(records.filter((r) => !r.deleted).map((r) => [r.key, r]));
        if (mode === "restore") {
          if (typeof host.applyState !== "function") throw new OwnerSyncError("host-restore-unavailable");
          const next = buildStateFromRecords(cloudMap.values(), snap.state);
          const applied = await host.applyState({ state: next, reason: "initial-restore" });
          if (!applied || applied.ok !== true) throw new OwnerSyncError((applied && applied.code) || "local-apply-failed");
          doc.records = {}; for (const r of cloudMap.values()) doc.records[r.key] = { version: r.version, hash: r.payloadHash };
          for (const r of records) if (r.deleted) doc.records[r.key] = { version: r.version, hash: null, deleted: true };
          doc.cursor = cursor; doc.initialized = true; doc.restoreEpoch = (await snapshot()).restoreEpoch || 0; await save();
        } else { // reconcile: identical records adopted, local-only uploaded, cloud-only listed for an explicit pull, differing -> conflict
          const local = await projectLocal(snap.state);
          doc.records = {};
          for (const [key, e] of local) {
            const r = cloudMap.get(key);
            if (!r) continue;
            if (r.payloadHash === e.payloadHash) doc.records[key] = { version: r.version, hash: r.payloadHash };
            else { doc.records[key] = { version: r.version, hash: r.payloadHash }; doc.conflicts[key] = { code: "edit-conflict", baseVersion: r.version, cloudVersion: r.version, cloudHash: r.payloadHash, localHash: e.payloadHash, op: "upsert" }; }
          }
          for (const r of cloudMap.values()) if (!local.has(r.key)) doc.records[r.key] = { version: r.version, hash: r.payloadHash, cloudOnly: true };
          doc.cursor = cursor; doc.initialized = true; doc.restoreEpoch = snap.restoreEpoch || 0; await save();
        }
      }
      return { ok: true };
    }).then(async (r) => { await flush(); return r; });
  }

  // ---- ongoing cloud updates (explicit) -----------------------------------------------------------------------------------
  // Fetches changes; applies only records the local copy has NOT changed since the last sync (fast-forward). Everything else is a conflict.
  function pullUpdates({ apply = false } = {}) {
    return serial(async () => {
      const c = capability(); if (!c.ok) throw new OwnerSyncError(c.code);
      cap = c; await load(c); if (!doc.initialized) throw new OwnerSyncError("not-initialized");
      const { records, cursor } = await pullAll();
      const snap = await snapshot(); const local = await projectLocal(snap.state);
      const fast = []; let conflicts = 0;
      for (const r of records) {
        const known = doc.records[r.key];
        if (known && known.version >= r.version && !known.cloudOnly) continue;
        const localHash = local.has(r.key) ? local.get(r.key).payloadHash : null;
        const unchangedLocally = known ? ((known.deleted ? null : known.hash) === localHash) : localHash === null;
        if (known && known.cloudOnly) { fast.push(r); continue; }
        if (unchangedLocally) fast.push(r);
        else if (localHash === r.payloadHash) doc.records[r.key] = { version: r.version, hash: r.payloadHash }; // both sides already equal
        else { doc.conflicts[r.key] = { code: "edit-conflict", baseVersion: known ? known.version : 0, cloudVersion: r.version, cloudHash: r.payloadHash || null, localHash, op: "upsert" }; conflicts += 1; }
      }
      lastSummary.cloudAhead = fast.length;
      if (apply && fast.length) {
        if (typeof host.applyState !== "function") throw new OwnerSyncError("host-restore-unavailable");
        const merged = new Map();
        for (const [k, e] of local) merged.set(k, { key: k, payload: e.payload });
        for (const r of fast) { if (r.deleted) merged.delete(r.key); else merged.set(r.key, { key: r.key, payload: r.payload }); }
        // order records for cloud-deleted ids are rewritten by their own record; rebuild on top of the live state
        const next = buildStateFromRecords(merged.values(), snap.state);
        const applied = await host.applyState({ state: next, reason: "cloud-fast-forward" });
        if (!applied || applied.ok !== true) throw new OwnerSyncError((applied && applied.code) || "local-apply-failed");
        for (const r of fast) doc.records[r.key] = r.deleted ? { version: r.version, hash: null, deleted: true } : { version: r.version, hash: r.payloadHash };
        doc.restoreEpoch = (await snapshot()).restoreEpoch || 0; lastSummary.cloudAhead = 0;
      }
      doc.cursor = cursor; await save(); summarize(); emit();
      return { ok: true, fastForward: fast.length, conflicts };
    });
  }

  // Owner decision for one conflicted record. keepLocal: rebase on the cloud version, next flush sends local (explicit overwrite).
  // useCloud: apply the cloud record locally and adopt it.
  function resolveConflict(key, choice) {
    return serial(async () => {
      const c = capability(); if (!c.ok) throw new OwnerSyncError(c.code);
      cap = c; await load(c);
      const cf = doc.conflicts[key]; if (!cf) throw new OwnerSyncError("no-such-conflict");
      if (choice === "keepLocal") {
        if (cf.cloudVersion === null) throw new OwnerSyncError("conflict-needs-refresh");
        doc.records[key] = { version: cf.cloudVersion, hash: cf.cloudHash };
        delete doc.conflicts[key];
      } else if (choice === "useCloud") {
        if (typeof host.applyState !== "function") throw new OwnerSyncError("host-restore-unavailable");
        const { records } = await pullAll();
        const r = records.find((x) => x.key === key);
        if (!r) throw new OwnerSyncError("conflict-needs-refresh");
        const snap = await snapshot(); const local = await projectLocal(snap.state);
        const merged = new Map(); for (const [k, e] of local) merged.set(k, { key: k, payload: e.payload });
        if (r.deleted) merged.delete(key); else merged.set(key, { key, payload: r.payload });
        const applied = await host.applyState({ state: buildStateFromRecords(merged.values(), snap.state), reason: "conflict-use-cloud" });
        if (!applied || applied.ok !== true) throw new OwnerSyncError((applied && applied.code) || "local-apply-failed");
        doc.records[key] = r.deleted ? { version: r.version, hash: null, deleted: true } : { version: r.version, hash: r.payloadHash };
        delete doc.conflicts[key];
        doc.restoreEpoch = (await snapshot()).restoreEpoch || 0;
      } else throw new OwnerSyncError("choice-invalid");
      await save(); summarize(); emit();
      return { ok: true };
    }).then(async (r) => { await flush(); return r; });
  }

  // Owner reviewed a Restore/Undo or a mass deletion and wants the current local state to be what syncs.
  function acknowledgeReview(kind) {
    return serial(async () => {
      const c = capability(); if (!c.ok) throw new OwnerSyncError(c.code);
      cap = c; await load(c);
      if (kind === "restore") { const snap = await snapshot(); doc.restoreEpoch = snap.restoreEpoch || 0; delete doc.reviews.restore; }
      else if (kind === "massDelete") { delete doc.reviews.massDelete; doc.allowMassDelete = true; }
      else throw new OwnerSyncError("review-kind-invalid");
      await save(); emit();
      return { ok: true };
    }).then(async (r) => { await flush(); return r; });
  }

  // Cross-device restore onto THIS (authorized) device: replaces local business data with the Cloud copy. Needs explicit confirmation;
  // the host is responsible for its own pre-restore safety snapshot (Core's existing restore pipeline provides Undo).
  function restoreFromCloud({ confirmed = false } = {}) {
    return serial(async () => {
      if (confirmed !== true) throw new OwnerSyncError("confirmation-required");
      const c = capability(); if (!c.ok) throw new OwnerSyncError(c.code);
      cap = c; await load(c);
      if (typeof host.applyState !== "function") throw new OwnerSyncError("host-restore-unavailable");
      const { records, cursor } = await pullAll();
      const live = records.filter((r) => !r.deleted);
      if (live.length === 0) throw new OwnerSyncError("cloud-empty");
      const snap = await snapshot();
      const applied = await host.applyState({ state: buildStateFromRecords(live, snap.state), reason: "cloud-restore" });
      if (!applied || applied.ok !== true) throw new OwnerSyncError((applied && applied.code) || "local-apply-failed");
      doc.records = {}; for (const r of records) doc.records[r.key] = r.deleted ? { version: r.version, hash: null, deleted: true } : { version: r.version, hash: r.payloadHash };
      doc.conflicts = {}; doc.reviews = {}; doc.outbox = null; doc.cursor = cursor; doc.initialized = true;
      doc.restoreEpoch = (await snapshot()).restoreEpoch || 0; await save(); summarize(); emit();
      return { ok: true, restored: live.length };
    });
  }

  // Legacy selective Players Sync migration. bindings: [{ playerId, syncStatus, conflictCode, hasPending }] from the old player-sync store.
  // Nothing local is changed or deleted. Players whose legacy binding is unresolved (pending / conflict / fenced) are NOT pushed; they
  // are parked as "legacy-review" until the Owner resolves them. Idempotent.
  function migrateLegacy(bindings) {
    return serial(async () => {
      const c = capability(); if (!c.ok) throw new OwnerSyncError(c.code);
      cap = c; await load(c);
      if (!Array.isArray(bindings)) throw new OwnerSyncError("legacy-bindings-invalid");
      doc.legacy = doc.legacy || { migratedAt: nowFn(), players: {} };
      let parked = 0;
      for (const b of bindings) {
        if (!b || typeof b.playerId !== "string") continue;
        const unresolved = !!b.hasPending || b.syncStatus === "conflict" || b.syncStatus === "pending" || b.syncStatus === "paused_missing_local";
        doc.legacy.players[b.playerId] = { unresolved };
        if (unresolved) {
          const key = `players/${b.playerId.replace(/\//g, "_")}`;
          if (!doc.conflicts[key]) { doc.conflicts[key] = { code: "legacy-review", baseVersion: 0, cloudVersion: null, cloudHash: null, localHash: null, op: "upsert" }; parked += 1; }
        }
      }
      await save(); summarize(); emit();
      return { ok: true, parked };
    });
  }

  function getStatus() { return { ...status, ...lastSummary, initialized: !!(doc && doc.initialized) }; }
  function dispose() { disposed = true; if (cancelDebounce) cancelDebounce(); if (cancelRetry) cancelRetry(); subscribers.clear(); }
  // Identity/Owner/group change: forget in-memory scope (durable docs stay per owner+group; never deleted).
  function invalidate() { doc = null; scopeKey = null; cap = null; lastSummary = { pending: 0, conflicts: [], cloudAhead: 0, lastSyncAt: null }; setStatus("idle"); }

  return Object.freeze({ notifyChanged, flush, onOnline, startInitial, pullUpdates, resolveConflict, acknowledgeReview, restoreFromCloud, migrateLegacy, getStatus, invalidate, dispose,
    subscribe(cb) { subscribers.add(cb); return () => subscribers.delete(cb); } });
}
