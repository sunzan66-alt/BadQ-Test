// BadQ Web Sync Phase 4C - isolated Players Sync binding store and fail-closed reconciliation engine.
//
// Boundaries (frozen Phase 4 contract, sections 3-5):
//  * Binding evidence lives ONLY in the separate IndexedDB database `badq-commercial-player-sync-v1`. This module never
//    reads or writes bg-v11, the Critical Journal, Backup/Restore or any Core persisted key, and never imports Firestore.
//  * Local player data is read ONLY through `host.readDurableSnapshot()` (the saved, read-back bg-v11 state) - never from an
//    optimistic in-memory value - and is changed ONLY through the Owner-approved `host.applyApprovedFields()` /
//    `host.createPlayerFromCloud()` calls after an explicit preview.
//  * Cloud access is ONLY the two Commercial HTTPS routes, supplied as `api` (no token ever enters this module).
//  * A pending mutation is written durably to the binding store BEFORE any request can be sent, and an unresolved pending
//    mutation is never replaced by a different payload except by an explicit, revision-fenced Owner resolution.
//  * Invalidation (offline / logout / owner switch / Restore / Undo / reload) closes the transport and marks reconciliation
//    stale. It never deletes pending or acknowledged evidence.

export const PLAYER_SYNC_DB_NAME = "badq-commercial-player-sync-v1";
export const PLAYER_SYNC_DB_VERSION = 1;
export const PLAYER_SYNC_STORE = "bindings";
export const PLAYER_SYNC_SCHEMA_VERSION = 1;
export const PLAYER_SYNC_ENVIRONMENT = "TEST";
export const PLAYER_SYNC_PROJECT_ID = "badq-commercial-test";
export const PLAYER_SYNC_CONTRACT_VERSION = "1";

const LOCAL_GROUP_PATTERN = /^local_[A-Za-z0-9_-]{16,80}$/;
const CLOUD_GROUP_PATTERN = /^grp_[a-f0-9]{32}$/;
const MUTATION_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_CLOUD_PAGES = 100;
const CLOUD_PAGE_SIZE = 100;

export const MEMBERSHIPS = Object.freeze(["selected", "not_selected"]);
export const SYNC_STATUSES = Object.freeze(["unselected", "stale", "ready", "pending", "conflict", "paused_missing_local"]);
export const CONFLICT_CODES = Object.freeze([
  "identity-collision", "edit-conflict", "cloud-update-available", "cloud-missing", "cloud-regressed",
  "cloud-inconsistent", "pending-obsolete", "local-payload-invalid", "local-duplicate-id",
  "local-reappeared-review", "local-restored-review", "restored-dispatch-review", "pending-unsettled", "dispatch-armed",
  "server-rejected", "server-response-invalid", "server-conflict",
]);
// DURABLE fences: a record carrying one of these codes never publishes anything until an explicit, reviewed Owner resolution.
//  local-restored-review - a Restore/Undo happened; the durable local value may be an older backup, not an Owner edit.
//  pending-unsettled     - the Owner accepted the Cloud value while an older mutation might still commit; its evidence is retained.
//  restored-dispatch-review - same as local-restored-review, but the row holds a pending mutation that MAY have been dispatched.
// Round 2 - DURABLE DISPATCH PROOF (no schema change: only allowlisted status/code values of the frozen record are used):
//  syncStatus "pending" + conflictCode null            = PREPARED: the pending is durable and the request was provably NEVER armed/sent.
//  syncStatus "pending" + conflictCode "dispatch-armed" = ARMED: written durably BEFORE the network request begins. From this instant the
//                                                          mutation MAY be in flight; its evidence can only be retired by a PROVEN outcome.
//  local-restored-review on a row WITH a pending is only ever written from a PREPARED row (see fenceRows); every other pending-holding
//  state (conflict, paused, restored-dispatch-review, pending-unsettled ...) is treated as POSSIBLY DISPATCHED. A false "possibly sent" is
//  acceptable; a false "never sent" is not.
export const FENCE_CODES = Object.freeze(["local-restored-review", "restored-dispatch-review", "pending-unsettled"]);
const FENCE_SET = new Set(FENCE_CODES);
const isFenced = (record) => !!record && record.conflictCode !== null && FENCE_SET.has(record.conflictCode);
// PROVABLY never dispatched: pending present and the durable state is exactly "prepared" (or the Restore fence applied to a prepared row).
// Also "retirable": a pending parked as conflict/"server-rejected" got a definitive pre-write rejection (zero Cloud write), so it can never commit.
const isPrepared = (record) => !!record && record.membership === "selected" && record.pending !== null &&
  ((record.syncStatus === "pending" && record.conflictCode === null) ||
   (record.syncStatus === "conflict" && (record.conflictCode === "local-restored-review" || record.conflictCode === "server-rejected")));
const MEMBERSHIP_SET = new Set(MEMBERSHIPS);
const STATUS_SET = new Set(SYNC_STATUSES);
const CONFLICT_SET = new Set(CONFLICT_CODES);

const RECORD_KEYS = [
  "schemaVersion", "environment", "projectId", "contractVersion", "ownerId", "accountId", "localGroupId",
  "cloudGroupId", "playerId", "membership", "lastAcknowledged", "pending", "syncStatus", "conflictCode",
];
const ACK_KEYS = ["revision", "payload", "payloadHash"];
const PENDING_KEYS = [
  "clientMutationId", "expectedRevision", "basePayloadHash", "payload", "payloadHash",
  "sourceRestoreEpoch", "sourceLocalPayloadHash",
];

export class PlayerSyncError extends Error {
  constructor(code, status = null) {
    super(code);
    this.name = "PlayerSyncError";
    this.code = code;
    this.status = status;
  }
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
function exactKeys(value, keys) {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function bindingKeyOf(record) {
  return JSON.stringify([record.environment, record.ownerId, record.localGroupId, record.cloudGroupId, record.playerId]);
}

export async function defaultSha256Hex(text) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) throw new PlayerSyncError("hash-unavailable");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Same canonical form as the Commercial backend's profileHash, so hashes are comparable across both sides.
export function canonicalPayloadText(payload) {
  return JSON.stringify([payload.displayName, payload.skillIndex, payload.archived]);
}

// ---- record validation ---------------------------------------------------------------------------------------------------
// `contract` is the Core sync-contract module (isValidPlayerId / validatePlayerPayload); it is injected so the single frozen
// validator in sync-contract.js is the only implementation.
function validAckShape(ack, contract) {
  return isRecord(ack) && exactKeys(ack, ACK_KEYS) && Number.isSafeInteger(ack.revision) && ack.revision >= 1 &&
    !!contract.validatePlayerPayload(ack.payload) && HASH_PATTERN.test(ack.payloadHash);
}
function validPendingShape(pending, contract) {
  if (!isRecord(pending) || !exactKeys(pending, PENDING_KEYS) || !MUTATION_ID_PATTERN.test(pending.clientMutationId) ||
      !isNonNegativeSafeInteger(pending.expectedRevision) || !contract.validatePlayerPayload(pending.payload) ||
      !HASH_PATTERN.test(pending.payloadHash) || !isNonNegativeSafeInteger(pending.sourceRestoreEpoch) ||
      !HASH_PATTERN.test(pending.sourceLocalPayloadHash)) return false;
  return pending.expectedRevision === 0 ? pending.basePayloadHash === null : HASH_PATTERN.test(pending.basePayloadHash);
}

export function validBindingShape(record, contract) {
  if (!isRecord(record) || !exactKeys(record, RECORD_KEYS) || record.schemaVersion !== PLAYER_SYNC_SCHEMA_VERSION ||
      record.environment !== PLAYER_SYNC_ENVIRONMENT || record.projectId !== PLAYER_SYNC_PROJECT_ID ||
      record.contractVersion !== PLAYER_SYNC_CONTRACT_VERSION ||
      typeof record.ownerId !== "string" || !record.ownerId || record.accountId !== record.ownerId ||
      !LOCAL_GROUP_PATTERN.test(record.localGroupId) || !CLOUD_GROUP_PATTERN.test(record.cloudGroupId) ||
      !contract.isValidPlayerId(record.playerId) || !MEMBERSHIP_SET.has(record.membership) ||
      !STATUS_SET.has(record.syncStatus) ||
      (record.conflictCode !== null && !CONFLICT_SET.has(record.conflictCode)) ||
      (record.lastAcknowledged !== null && !validAckShape(record.lastAcknowledged, contract)) ||
      (record.pending !== null && !validPendingShape(record.pending, contract))) return false;
  if (record.membership === "not_selected") return record.syncStatus === "unselected";
  if (record.syncStatus === "unselected") return false;
  if (record.syncStatus === "pending" && record.pending === null) return false;
  if (record.syncStatus === "ready" && (record.pending !== null || record.lastAcknowledged === null)) return false;
  return true;
}

// ---- stores ---------------------------------------------------------------------------------------------------------------
// Store interface (all async):
//   open()                          -> void            (rejects PlayerSyncError("store-unavailable"))
//   getAll()                        -> [{ key, record }]
//   get(key)                        -> record | null
//   transact(key, fn, { withAll })  -> any             fn(existing|null, allRowsOrNull) runs INSIDE one readwrite
//                                                      transaction and returns { write?: record, result?: any }; throwing
//                                                      aborts the transaction and rejects with the thrown error.
export function createIdbBindingStore({ indexedDB: factory = (typeof indexedDB !== "undefined" ? indexedDB : null) } = {}) {
  let dbPromise = null;
  function open() {
    if (dbPromise) return dbPromise;
    if (!factory || typeof factory.open !== "function") return Promise.reject(new PlayerSyncError("store-unavailable"));
    dbPromise = new Promise((resolve, reject) => {
      let request;
      try { request = factory.open(PLAYER_SYNC_DB_NAME, PLAYER_SYNC_DB_VERSION); }
      catch { reject(new PlayerSyncError("store-unavailable")); return; }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PLAYER_SYNC_STORE)) db.createObjectStore(PLAYER_SYNC_STORE);
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { try { db.close(); } catch { /* already closed */ } dbPromise = null; };
        resolve(db);
      };
      request.onerror = () => reject(new PlayerSyncError("store-unavailable"));
      request.onblocked = () => reject(new PlayerSyncError("store-unavailable"));
    }).catch((error) => { dbPromise = null; throw error; });
    return dbPromise;
  }

  function request(requestObject) {
    return new Promise((resolve, reject) => {
      requestObject.onsuccess = () => resolve(requestObject.result);
      requestObject.onerror = () => reject(new PlayerSyncError("store-unavailable"));
    });
  }

  async function readAll(objectStore) {
    const [keys, values] = await Promise.all([request(objectStore.getAllKeys()), request(objectStore.getAll())]);
    return keys.map((key, index) => ({ key, record: values[index] }));
  }

  async function getAll() {
    const db = await open();
    let tx;
    try { tx = db.transaction(PLAYER_SYNC_STORE, "readonly"); } catch { throw new PlayerSyncError("store-unavailable"); }
    return readAll(tx.objectStore(PLAYER_SYNC_STORE));
  }

  async function get(key) {
    const db = await open();
    let tx;
    try { tx = db.transaction(PLAYER_SYNC_STORE, "readonly"); } catch { throw new PlayerSyncError("store-unavailable"); }
    const value = await request(tx.objectStore(PLAYER_SYNC_STORE).get(key));
    return value === undefined ? null : value;
  }

  async function transact(key, fn, { withAll = false } = {}) {
    const db = await open();
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction(PLAYER_SYNC_STORE, "readwrite"); }
      catch { reject(new PlayerSyncError("store-unavailable")); return; }
      const objectStore = tx.objectStore(PLAYER_SYNC_STORE);
      let outcome;
      let failure = null;
      tx.oncomplete = () => resolve(outcome);
      tx.onabort = () => reject(failure || new PlayerSyncError("store-write-failed"));
      const fail = (error) => { failure = error; try { tx.abort(); } catch { /* already finished */ } };
      const run = (existing, all) => {
        try {
          const out = fn(existing === undefined ? null : existing, all);
          outcome = out ? out.result : undefined;
          if (out && out.write) objectStore.put(out.write, key);
        } catch (error) { fail(error); }
      };
      const getRequest = objectStore.get(key);
      getRequest.onerror = () => fail(new PlayerSyncError("store-unavailable"));
      getRequest.onsuccess = () => {
        if (!withAll) { run(getRequest.result, null); return; }
        readAll(objectStore).then((all) => run(getRequest.result, all), () => fail(new PlayerSyncError("store-unavailable")));
      };
    });
  }

  return Object.freeze({ open, getAll, get, transact });
}

// In-memory store with the SAME contract (used by unit tests and as a stand-in for tab-sharing tests). A shared instance
// between two engines models two tabs on one IndexedDB: transact() calls are serialized, exactly like readwrite transactions.
export function createMemoryBindingStore(initial = []) {
  const rows = new Map(initial.map(({ key, record }) => [key, clone(record)]));
  let queue = Promise.resolve();
  const faults = { nextTransactCode: null, openCode: null };
  return Object.freeze({
    async open() { if (faults.openCode) throw new PlayerSyncError(faults.openCode); },
    async getAll() { return Array.from(rows.entries(), ([key, record]) => ({ key, record: clone(record) })); },
    async get(key) { return rows.has(key) ? clone(rows.get(key)) : null; },
    transact(key, fn, { withAll = false } = {}) {
      const run = () => {
        if (faults.nextTransactCode) { const code = faults.nextTransactCode; faults.nextTransactCode = null; throw new PlayerSyncError(code); }
        const existing = rows.has(key) ? clone(rows.get(key)) : null;
        const all = withAll ? Array.from(rows.entries(), ([k, record]) => ({ key: k, record: clone(record) })) : null;
        const out = fn(existing, all);
        if (out && out.write) rows.set(key, clone(out.write));
        return out ? out.result : undefined;
      };
      const result = queue.then(run, run);
      queue = result.then(() => undefined, () => undefined);
      return result;
    },
    // test hooks (not part of the production interface)
    __rows: rows,
    __faults: faults,
  });
}

// ---- Restore critical-section gate ------------------------------------------------------------------------------------------
// A readers/writer gate. Every operation that can CREATE a binding or RELEASE a Restore fence (select/reselect, cloud import, Accept Cloud,
// Use Local) runs as a SHARED holder; Restore runs "verified fence scan -> promote" as the EXCLUSIVE holder. So a binding can never be created or
// released between the fence scan and the promotion, and an operation that starts after the Restore reads the post-Restore durable state.
// Production (commercial-sync.js) backs this with the Web Locks API (cross-tab); this in-process version serves a single JS context and tests.
// FIFO and writer-preferring: once Restore is waiting, later shared requests queue behind it.
export function createInProcessRestoreGate() {
  let readers = 0; let writer = false; const queue = [];
  function pump() {
    while (queue.length) {
      const head = queue[0];
      if (head.mode === "shared" ? !writer : (!writer && readers === 0)) {
        queue.shift();
        if (head.mode === "shared") readers += 1; else writer = true;
        head.grant();
      } else break;
    }
  }
  function enter(mode, fn) {
    return new Promise((resolve, reject) => {
      queue.push({ mode, grant: () => {
        Promise.resolve().then(fn).then(resolve, reject).finally(() => { if (mode === "shared") readers -= 1; else writer = false; pump(); });
      } });
      pump();
    });
  }
  return Object.freeze({ shared: (fn) => enter("shared", fn), exclusive: (fn) => enter("exclusive", fn) });
}

// ---- engine ---------------------------------------------------------------------------------------------------------------
const IDENTITY_CODES = new Set([
  "unauthenticated", "email-verification-required", "session-unavailable", "account-mismatch",
  "email-not-verified", "identity-proof-invalid", "identity-not-validated", "contract-invalid",
]);
const HTTP_CONFLICT_CODES = new Set(["sync-conflict", "sync-idempotency-conflict", "sync-current-invalid"]);
const REJECT_CODES = new Set([
  "sync-contract-invalid", "sync-schema-version-unsupported", "sync-contract-version-unsupported", "invalid-cursor",
]);
// Errors that make the WHOLE pass meaningless (identity / group / store / transport gone) versus per-player outcomes.
const PASS_ABORT_CODES = new Set([
  "transport-closed", "identity-not-validated", "group-link-not-validated", "group-link-not-found", "group-link-changed",
  "account-mismatch", "store-unavailable", "store-invalid", "engine-disposed", "group-not-found", "unauthenticated",
  "email-verification-required", "session-unavailable", "email-not-verified", "identity-proof-invalid", "contract-invalid",
]);

function classifyApiError(error) {
  const code = error && typeof error.code === "string" ? error.code : "verification-unavailable";
  const status = error && Number.isInteger(error.status) ? error.status : null;
  if (code === "group-not-found") return { kind: "group", code, status };
  if (IDENTITY_CODES.has(code)) return { kind: "identity", code, status };
  if (HTTP_CONFLICT_CODES.has(code)) return { kind: "conflict", code, status };
  if (REJECT_CODES.has(code)) return { kind: "rejected", code, status };
  return { kind: "network", code: code === "offline" ? "offline" : "verification-unavailable", status };
}

function defaultRandomMutationId() {
  const cryptoApi = typeof crypto !== "undefined" ? crypto : null;
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function") throw new PlayerSyncError("random-unavailable");
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  if (bytes.every((byte) => byte === 0)) throw new PlayerSyncError("random-unavailable");
  return "pm_" + Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function samePayload(a, b) {
  return !!a && !!b && a.displayName === b.displayName && a.skillIndex === b.skillIndex && a.archived === b.archived;
}

export function createPlayerSyncEngine(deps) {
  const { store, api, contract, host, getIdentity, getGroupLink } = deps || {};
  if (!store || typeof store.transact !== "function" || typeof store.getAll !== "function" || typeof store.get !== "function" ||
      !api || typeof api.listPlayers !== "function" || typeof api.upsertPlayer !== "function" ||
      !contract || typeof contract.isValidPlayerId !== "function" || typeof contract.validatePlayerPayload !== "function" ||
      typeof contract.validatePlayerMutationEnvelope !== "function" ||
      !host || typeof host.readDurableSnapshot !== "function" ||
      typeof getIdentity !== "function" || typeof getGroupLink !== "function") {
    throw new PlayerSyncError("player-sync-dependency-invalid");
  }
  const restoreGate = deps.restoreGate && typeof deps.restoreGate.shared === "function" && typeof deps.restoreGate.exclusive === "function"
    ? deps.restoreGate : createInProcessRestoreGate();
  const sha256Hex = deps.sha256Hex || defaultSha256Hex;
  const randomMutationId = deps.randomMutationId || defaultRandomMutationId;
  const withLease = deps.withLease || ((name, fn) => fn());
  const isOnline = deps.isOnline || (() => true);
  const schedule = deps.schedule || ((fn, ms) => { const handle = setTimeout(fn, ms); return () => clearTimeout(handle); });
  const debounceMs = Number.isInteger(deps.debounceMs) && deps.debounceMs >= 0 ? deps.debounceMs : 1500;

  let generation = 0;
  let controller = typeof AbortController === "function" ? new AbortController() : null;
  let storeState = "unopened"; // unopened | ready | unavailable | invalid
  let cache = new Map();
  const fresh = new Set();
  const subscribers = new Set();
  let disposed = false;
  let reconcileChain = Promise.resolve();
  let cancelDebounce = null;
  let debounceRequested = false;
  // Runtime-only OBSERVATION of the last restore epoch seen by a full pass. It is never the gate itself: the gate is the DURABLE
  // fence code on each binding (see FENCE_CODES), so it survives reconcile passes, reloads and other tabs.
  let lastPassEpoch = null;

  const hashOf = (payload) => sha256Hex(canonicalPayloadText(payload));
  const currentSignal = () => (controller ? controller.signal : undefined);

  function emit() {
    for (const callback of subscribers) {
      try { callback({ type: "changed" }); } catch { /* presentation listeners cannot affect sync outcomes */ }
    }
  }

  // ---- store loading -----------------------------------------------------------------------------------------------------
  async function refresh() {
    let rows;
    try { await store.open(); rows = await store.getAll(); }
    catch { storeState = "unavailable"; throw new PlayerSyncError("store-unavailable"); }
    const next = new Map();
    let invalid = 0;
    for (const row of rows) {
      const record = row && row.record;
      if (!validBindingShape(record, contract) || row.key !== bindingKeyOf(record)) { invalid += 1; continue; }
      const hashesOk = (!record.lastAcknowledged || (await hashOf(record.lastAcknowledged.payload)) === record.lastAcknowledged.payloadHash) &&
        (!record.pending || ((await hashOf(record.pending.payload)) === record.pending.payloadHash &&
          record.pending.sourceLocalPayloadHash === record.pending.payloadHash));
      if (!hashesOk) { invalid += 1; continue; }
      next.set(row.key, record);
    }
    cache = next;
    if (invalid > 0) { storeState = "invalid"; emit(); throw new PlayerSyncError("store-invalid"); }
    storeState = "ready";
    return cache;
  }

  async function afterWrite(key) {
    const record = await store.get(key);
    if (record && validBindingShape(record, contract) && bindingKeyOf(record) === key) cache.set(key, record);
    emit();
    return record;
  }

  // ---- capability / liveness ---------------------------------------------------------------------------------------------
  function capability(localGroupId) {
    if (disposed) return { ok: false, code: "engine-disposed" };
    const identity = getIdentity();
    if (!isRecord(identity) || identity.validated !== true || typeof identity.ownerId !== "string" || !identity.ownerId ||
        identity.accountId !== identity.ownerId) return { ok: false, code: "identity-not-validated" };
    const link = getGroupLink(localGroupId);
    if (!isRecord(link) || link.linked !== true) return { ok: false, code: "group-link-not-found" };
    if (link.ownerId !== identity.ownerId || link.accountId !== identity.accountId) return { ok: false, code: "account-mismatch" };
    if (link.validated !== true) return { ok: false, code: "group-link-not-validated" };
    if (!CLOUD_GROUP_PATTERN.test(link.cloudGroupId)) return { ok: false, code: "group-link-not-found" };
    return { ok: true, ownerId: identity.ownerId, cloudGroupId: link.cloudGroupId, localGroupId };
  }
  function requireCapability(localGroupId) {
    if (typeof localGroupId !== "string" || !LOCAL_GROUP_PATTERN.test(localGroupId)) throw new PlayerSyncError("local-group-invalid");
    const result = capability(localGroupId);
    if (!result.ok) throw new PlayerSyncError(result.code);
    return result;
  }
  function ensureLive(g, cap) {
    if (disposed) throw new PlayerSyncError("engine-disposed");
    if (g !== generation) throw new PlayerSyncError("transport-closed");
    const again = capability(cap.localGroupId);
    if (!again.ok) throw new PlayerSyncError(again.code);
    if (again.ownerId !== cap.ownerId || again.cloudGroupId !== cap.cloudGroupId) throw new PlayerSyncError("group-link-changed");
  }
  function scopeMatches(record, cap) {
    return record.environment === PLAYER_SYNC_ENVIRONMENT && record.ownerId === cap.ownerId &&
      record.localGroupId === cap.localGroupId && record.cloudGroupId === cap.cloudGroupId;
  }

  // ---- durable local snapshot --------------------------------------------------------------------------------------------
  async function readSnapshot() {
    let result;
    try { result = await host.readDurableSnapshot(); }
    catch { throw new PlayerSyncError("durable-snapshot-unavailable"); }
    if (!isRecord(result) || result.ok !== true || !isNonNegativeSafeInteger(result.restoreEpoch) || !Array.isArray(result.players)) {
      throw new PlayerSyncError("durable-snapshot-unavailable");
    }
    const byId = new Map();
    const dupes = new Set();
    for (const player of result.players) {
      if (!isRecord(player) || typeof player.id !== "string") continue;
      if (byId.has(player.id)) dupes.add(player.id); else byId.set(player.id, player);
    }
    return { restoreEpoch: result.restoreEpoch, byId, dupes };
  }
  function localPayloadOf(player) {
    return contract.validatePlayerPayload({ displayName: player.name, skillIndex: player.skillIndex, archived: player.archived === true });
  }

  // ---- cloud reads --------------------------------------------------------------------------------------------------------
  function normalizeCloudPlayer(value, cap) {
    if (!isRecord(value) || Object.keys(value).some((key) => !["cloudGroupId", "playerId", "payload", "revision", "updatedAt", "lastMutationId", "replay"].includes(key)) ||
        value.cloudGroupId !== cap.cloudGroupId || !contract.isValidPlayerId(value.playerId) ||
        !Number.isSafeInteger(value.revision) || value.revision < 1 ||
        typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)) ||
        typeof value.lastMutationId !== "string" || !MUTATION_ID_PATTERN.test(value.lastMutationId)) {
      throw new PlayerSyncError("cloud-response-invalid");
    }
    const payload = contract.validatePlayerPayload(value.payload);
    if (!payload) throw new PlayerSyncError("cloud-response-invalid");
    return { playerId: value.playerId, payload, revision: value.revision, updatedAt: value.updatedAt, lastMutationId: value.lastMutationId };
  }

  async function callApi(operation) {
    try { return await operation(); }
    catch (error) {
      const info = classifyApiError(error);
      const wrapped = new PlayerSyncError(info.code, info.status);
      wrapped.kind = info.kind;
      throw wrapped;
    }
  }

  async function fetchCloudIndex(cap, g) {
    const index = new Map();
    const seen = new Set();
    let cursor;
    for (let pages = 0; pages < MAX_CLOUD_PAGES; pages += 1) {
      ensureLive(g, cap);
      const page = await callApi(() => api.listPlayers(cap.cloudGroupId, { cursor, pageSize: CLOUD_PAGE_SIZE, signal: currentSignal() }));
      ensureLive(g, cap);
      if (!isRecord(page) || !Array.isArray(page.players) || page.players.length > CLOUD_PAGE_SIZE ||
          (page.nextCursor !== null && typeof page.nextCursor !== "string")) throw new PlayerSyncError("cloud-response-invalid");
      for (const item of page.players) {
        const record = normalizeCloudPlayer(item, cap);
        if (index.has(record.playerId)) throw new PlayerSyncError("cloud-response-invalid");
        index.set(record.playerId, record);
      }
      if (page.nextCursor === null) return index;
      if (seen.has(page.nextCursor)) throw new PlayerSyncError("cloud-response-invalid");
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new PlayerSyncError("cloud-list-too-large");
  }

  function makeContext(cap, g, snap) {
    let index = null;
    return {
      cap, g, snap,
      async cloudIndex(force = false) {
        if (index && !force) return index;
        index = await fetchCloudIndex(cap, g);
        return index;
      },
      updateCloud(record) { if (index) index.set(record.playerId, record); },
    };
  }

  // ---- binding writes (every one is a single atomic store transaction) ------------------------------------------------
  function outcome(rec, kind, extra = {}) {
    return { playerId: rec.playerId, outcome: kind, status: extra.status || rec.syncStatus, code: extra.code || null, ...extra.more };
  }

  async function writeBinding(key, mutate) {
    const written = await store.transact(key, (existing) => {
      if (!existing || !validBindingShape(existing, contract)) throw new PlayerSyncError("store-invalid");
      const result = mutate(existing);
      if (!result || !result.next) return { result: existing };
      if (!validBindingShape(result.next, contract) || bindingKeyOf(result.next) !== key) throw new PlayerSyncError("store-invalid");
      return { write: result.next, result: result.next };
    });
    await afterWrite(key);
    return written;
  }

  async function setStatus(key, status, conflictCode, { onlyIfNoPending = false, release = false } = {}) {
    const record = await writeBinding(key, (cur) => {
      if (cur.membership !== "selected") return null;
      if (isFenced(cur) && !release) return null; // only an explicit reviewed Owner resolution may move a fenced binding
      if (onlyIfNoPending && cur.pending) return null;
      if (status === "ready" && (cur.pending || !cur.lastAcknowledged)) return null;
      if (status === "pending" && !cur.pending) return null;
      if (cur.syncStatus === status && cur.conflictCode === conflictCode) return null;
      return { next: { ...cur, syncStatus: status, conflictCode } };
    });
    if (status === "ready" && record.syncStatus === "ready") fresh.add(key); else fresh.delete(key);
    return record;
  }

  async function setConflict(key, code) {
    const record = await setStatus(key, "conflict", code);
    return outcome(record, record.syncStatus === "conflict" ? "conflict" : "skipped", { code });
  }

  // A response belongs to one durable mutation, not merely to a player binding. An older tab's late rejection/409 must never park or
  // relabel a newer pending mutation. Check the ID in the same transaction that changes status, including after an awaited Cloud read.
  async function setConflictForPending(key, mutationId, code) {
    const record = await writeBinding(key, (cur) => {
      if (cur.membership !== "selected" || !cur.pending || cur.pending.clientMutationId !== mutationId || isFenced(cur)) return null;
      if (cur.syncStatus === "conflict" && cur.conflictCode === code) return null;
      return { next: { ...cur, syncStatus: "conflict", conflictCode: code } };
    });
    if (!record.pending || record.pending.clientMutationId !== mutationId) return outcome(record, "skipped", { code: "stale-response" });
    fresh.delete(key);
    return outcome(record, record.syncStatus === "conflict" ? "conflict" : "skipped", { code: record.conflictCode || code });
  }

  async function acknowledge(key, ctx, mutationId, cloud) {
    const ack = { revision: cloud.revision, payload: cloud.payload, payloadHash: await hashOf(cloud.payload) };
    const record = await writeBinding(key, (cur) => {
      if (cur.pending && cur.pending.clientMutationId === mutationId) {
        // The outcome is now KNOWN, so the evidence can be retired - but a fenced binding stays fenced (and not ready): the
        // acknowledged value may differ from what the Owner approved locally.
        if (isFenced(cur)) return { next: { ...cur, lastAcknowledged: ack, pending: null } };
        return { next: { ...cur, lastAcknowledged: ack, pending: null, syncStatus: cur.membership === "selected" ? "ready" : "unselected", conflictCode: null } };
      }
      // the pending record was already settled elsewhere (another tab): never move acknowledgement backwards
      if (cur.lastAcknowledged && cur.lastAcknowledged.revision >= ack.revision) return null;
      throw new PlayerSyncError("binding-changed");
    });
    if (record.membership === "selected" && record.syncStatus === "ready") fresh.add(key);
    ctx.updateCloud(cloud);
    if (record.membership === "selected" && record.syncStatus !== "ready") {
      return outcome(record, "conflict", { code: record.conflictCode, more: { ackHash: ack.payloadHash } });
    }
    return outcome(record, "ready", { more: { ackHash: ack.payloadHash } });
  }

  // ---- reconciliation -----------------------------------------------------------------------------------------------------
  function mutationResponse(response, rec, pending) {
    if (!isRecord(response) || response.contractVersion !== PLAYER_SYNC_CONTRACT_VERSION ||
        response.environment !== PLAYER_SYNC_ENVIRONMENT || typeof response.replay !== "boolean" ||
        response.cloudGroupId !== rec.cloudGroupId || response.playerId !== rec.playerId ||
        response.revision !== pending.expectedRevision + 1 || response.lastMutationId !== pending.clientMutationId ||
        typeof response.updatedAt !== "string" || !Number.isFinite(Date.parse(response.updatedAt))) return null;
    const payload = contract.validatePlayerPayload(response.payload);
    if (!payload || !samePayload(payload, pending.payload)) return null;
    return { playerId: rec.playerId, payload, revision: response.revision, updatedAt: response.updatedAt, lastMutationId: response.lastMutationId };
  }

  async function armDispatch(key, pending) {
    await writeBinding(key, (cur) => {
      if (cur.membership !== "selected" || !cur.pending || cur.pending.clientMutationId !== pending.clientMutationId) throw new PlayerSyncError("binding-changed");
      if (isFenced(cur)) throw new PlayerSyncError("binding-fenced"); // a Restore fence landed between the last gate and now: send nothing
      if (cur.syncStatus === "pending" && cur.conflictCode === "dispatch-armed") return null;
      return { next: { ...cur, syncStatus: "pending", conflictCode: "dispatch-armed" } };
    });
    const live = await store.get(key); // verify the evidence is really durable before any byte leaves the device
    if (!live || !live.pending || live.pending.clientMutationId !== pending.clientMutationId || live.syncStatus !== "pending" || live.conflictCode !== "dispatch-armed") {
      throw new PlayerSyncError("dispatch-arm-unverified");
    }
    fresh.delete(key);
  }

  async function sendPending(key, rec, ctx, { allowRefetch }) {
    const pending = rec.pending;
    const checked = contract.validatePlayerMutationEnvelope({
      contractVersion: PLAYER_SYNC_CONTRACT_VERSION, schemaVersion: 1, localGroupId: rec.localGroupId, cloudGroupId: rec.cloudGroupId,
      entityType: "player", entityId: rec.playerId, expectedRevision: pending.expectedRevision, operation: "upsert",
      payload: { displayName: pending.payload.displayName, skillIndex: pending.payload.skillIndex, archived: pending.payload.archived },
      clientMutationId: pending.clientMutationId,
    });
    if (!checked.ok) return setConflictForPending(key, pending.clientMutationId, "server-rejected");
    if (rec.ownerId !== ctx.cap.ownerId || rec.cloudGroupId !== ctx.cap.cloudGroupId) throw new PlayerSyncError("group-link-changed");
    // Last gate before the network: the binding must still hold THIS pending, must not be fenced, and the durable Core value must
    // STILL be the value this pending was created from (fresh committed read - never the pass-start snapshot).
    const live = await store.get(key);
    if (!live || !live.pending || live.pending.clientMutationId !== pending.clientMutationId) throw new PlayerSyncError("binding-changed");
    if (isFenced(live)) return outcome(live, "conflict", { code: live.conflictCode });
    if (!(await refreshSnapshot(ctx))) return { playerId: rec.playerId, outcome: "restart" };
    const nowLocal = ctx.snap.byId.get(rec.playerId) || null;
    const nowPayload = nowLocal ? localPayloadOf(nowLocal) : null;
    if (ctx.snap.restoreEpoch !== pending.sourceRestoreEpoch || !nowPayload || (await hashOf(nowPayload)) !== pending.sourceLocalPayloadHash) {
      return { playerId: rec.playerId, outcome: "restart" };
    }
    // DISPATCH ARM: durable evidence that this exact mutation may now be in flight. The network request MUST NOT begin unless this write
    // succeeded and read back; if it fails nothing is sent (the pending stays PREPARED = provably never dispatched).
    await armDispatch(key, pending);
    if (deps.afterDispatchArm) await deps.afterDispatchArm({ key, clientMutationId: pending.clientMutationId }); // test hook (crash between arm and send)
    ensureLive(ctx.g, ctx.cap);
    let response;
    try { response = await callApi(() => api.upsertPlayer(checked.envelope, { signal: currentSignal() })); }
    catch (error) { return handleSendError(error, key, rec, ctx, allowRefetch); }
    // The request may already have committed even if this tab is no longer live: pending evidence stays and is replayed later.
    ensureLive(ctx.g, ctx.cap);
    const verified = mutationResponse(response, rec, pending);
    if (!verified) return setConflictForPending(key, pending.clientMutationId, "server-response-invalid");
    return acknowledge(key, ctx, pending.clientMutationId, verified);
  }

  async function handleSendError(error, key, rec, ctx, allowRefetch) {
    const mutationId = rec.pending.clientMutationId;
    const live = await store.get(key);
    if (!live || !live.pending || live.pending.clientMutationId !== mutationId) {
      return outcome(live || rec, "skipped", { code: "stale-response" });
    }
    if (error.kind === "identity" || error.kind === "group") { closeTransport(error.code); throw error; }
    if (error.kind === "conflict") {
      if (!allowRefetch) return setConflictForPending(key, mutationId, "server-conflict");
      const cloud = (await ctx.cloudIndex(true)).get(rec.playerId) || null;
      return decideAfterCloud(key, rec, ctx, cloud);
    }
    if (error.kind === "rejected" && error.code !== "invalid-cursor") {
      // A definitive contract/validation rejection of THIS exact request is returned before any write (zero Cloud write for this
      // clientMutationId). The rejected pending is RETAINED as the non-auto-retry marker (conflict/"server-rejected" + pending): while the
      // durable value is still that payload nothing is ever re-sent and no new mutationId is created (see resolvePending).
      return setConflictForPending(key, mutationId, "server-rejected");
    }
    const current = await store.get(key);
    if (!current || !current.pending || current.pending.clientMutationId !== mutationId) return outcome(current || rec, "skipped", { code: "stale-response" });
    return outcome(current, "pending", { code: error.code }); // network/unavailable: pending retained, same mutation retried later
  }

  // What a Cloud read PROVES about a held pending mutation:
  //  committed  - Cloud's current record was written by exactly this mutation (id, revision and payload all match)
  //  dead       - Cloud moved past the mutation's expected revision by someone/something else: it can never commit
  //  unsettled  - Cloud is still exactly at the expected revision: it has NOT committed (yet) and a still-in-flight copy could
  //  ambiguous  - anything else (own id with different content, regressed Cloud ...): never resolved automatically
  function classifyPending(pending, cloud) {
    const cloudRevision = cloud ? cloud.revision : 0;
    if (cloud && cloud.lastMutationId === pending.clientMutationId) {
      return cloud.revision === pending.expectedRevision + 1 && samePayload(cloud.payload, pending.payload) ? "committed" : "ambiguous";
    }
    if (cloudRevision > pending.expectedRevision) return "dead";
    if (cloudRevision === pending.expectedRevision) return "unsettled";
    return "ambiguous";
  }

  // Used after a 409 on a pending that still matched the durable local value: it is NEVER re-sent from here.
  async function decideAfterCloud(key, rec, ctx, cloud) {
    const pending = rec.pending;
    const kind = classifyPending(pending, cloud);
    if (kind === "committed") return acknowledge(key, ctx, pending.clientMutationId, cloud);
    if (kind === "ambiguous") return setConflictForPending(key, pending.clientMutationId, cloud && cloud.lastMutationId === pending.clientMutationId ? "server-response-invalid" : "cloud-inconsistent");
    if (kind === "unsettled") {
      if (cloud && (await hashOf(cloud.payload)) !== pending.basePayloadHash) return setConflictForPending(key, pending.clientMutationId, "cloud-inconsistent");
      if (ctx.snap.restoreEpoch !== pending.sourceRestoreEpoch) return setConflictForPending(key, pending.clientMutationId, "pending-obsolete");
      return setConflictForPending(key, pending.clientMutationId, "server-conflict");
    }
    return setConflictForPending(key, pending.clientMutationId, "edit-conflict");
  }

  async function resolvePending(key, rec, ctx, localHash) {
    const pending = rec.pending;
    const epochSame = ctx.snap.restoreEpoch === pending.sourceRestoreEpoch;
    const localSame = localHash !== null && localHash === pending.sourceLocalPayloadHash;
    if (epochSame && rec.syncStatus === "conflict" && rec.conflictCode === "server-rejected") {
      // Parked after a definitive rejection. Same durable payload -> fail closed, NO request, NO new mutationId (no retry loop).
      if (localSame) return outcome(rec, "conflict", { code: "server-rejected" });
      // The durable payload changed: the parked attempt provably wrote nothing, so retire it (id re-verified in the transaction) and let
      // normal reconciliation validate the CURRENT payload and, if valid, publish it as a NEW revision-fenced mutation.
      await writeBinding(key, (cur) => {
        if (!cur.pending || cur.pending.clientMutationId !== pending.clientMutationId || cur.conflictCode !== "server-rejected" || cur.membership !== "selected") throw new PlayerSyncError("binding-changed");
        return { next: { ...cur, pending: null, syncStatus: "stale", conflictCode: null } };
      });
      fresh.delete(key);
      return { playerId: rec.playerId, outcome: "restart" };
    }
    if (epochSame && localSame) {
      // Same durable value as the pending: (re)send the SAME mutation (exact idempotent replay). sendPending arms durably first; the
      // dispatch evidence is never reset to "prepared" here.
      return sendPending(key, rec, ctx, { allowRefetch: true });
    }
    // The durable local state no longer supports this pending payload. It is NEVER (re)sent. First establish what happened to it.
    const cloud = (await ctx.cloudIndex(true)).get(rec.playerId) || null;
    // Another tab may have settled/replaced this pending while the Cloud read was awaited: never act on a stale view of the binding.
    const heldNow = await store.get(key);
    if (!heldNow || !heldNow.pending || heldNow.pending.clientMutationId !== pending.clientMutationId) return { playerId: rec.playerId, outcome: "restart" };
    rec = heldNow;
    const kind = classifyPending(pending, cloud);
    if (kind === "committed") return acknowledge(key, ctx, pending.clientMutationId, cloud); // historical outcome; reconcileOne then publishes the CURRENT value as a NEW mutation
    if (kind === "ambiguous") return setConflictForPending(key, pending.clientMutationId, cloud && cloud.lastMutationId === pending.clientMutationId ? "server-response-invalid" : "cloud-inconsistent");
    if (kind === "dead") return setConflictForPending(key, pending.clientMutationId, "edit-conflict");
    // unsettled: Cloud still shows the expected revision. That is NOT proof the request was never sent (it may be in flight, or about to land).
    if (cloud && (await hashOf(cloud.payload)) !== pending.basePayloadHash) return setConflictForPending(key, pending.clientMutationId, "cloud-inconsistent");
    // Only LOCAL DURABLE evidence that dispatch was never armed allows retiring/replacing the pending. The decision is made on the live
    // record (the one in hand may predate another tab arming it) and re-verified inside the retiring transaction.
    const liveRec = await store.get(key);
    if (!liveRec || !liveRec.pending || liveRec.pending.clientMutationId !== pending.clientMutationId) return { playerId: rec.playerId, outcome: "restart" };
    if (!isPrepared(liveRec)) return outcome(liveRec, "pending", { code: "outcome-unknown" }); // possibly in flight: retained, fenced, not ready, not replaced
    if (!epochSame || localHash === null) return setConflictForPending(key, pending.clientMutationId, localHash === null ? "local-payload-invalid" : "pending-obsolete"); // evidence retained, Owner reviews
    // Same Restore epoch, the Owner simply changed the value again: retire the never-sent attempt and publish the CURRENT durable
    // value as a NEW mutation fenced at the revision Cloud is at right now (an old copy could then only ever fail with 409).
    const current = ctx.snap.byId.get(rec.playerId);
    const currentPayload = localPayloadOf(current);
    const cloudHash = cloud ? await hashOf(cloud.payload) : null;
    if (cloud && cloudHash === localHash) return retirePendingConverged(key, rec, ctx, cloud);
    return startPending(key, ctx, { expectedRevision: cloud ? cloud.revision : 0, basePayloadHash: cloudHash, replaces: pending.clientMutationId, replaceWhen: "prepared" },
      currentPayload, localHash);
  }

  // The current durable local value already equals Cloud's current value: nothing needs publishing, the superseded attempt is retired.
  async function retirePendingConverged(key, rec, ctx, cloud) {
    const held = rec.pending.clientMutationId;
    const ack = { revision: cloud.revision, payload: cloud.payload, payloadHash: await hashOf(cloud.payload) };
    const record = await writeBinding(key, (cur) => {
      if (cur.membership !== "selected" || !cur.pending || cur.pending.clientMutationId !== held) throw new PlayerSyncError("binding-changed");
      if (!isPrepared(cur) || isFenced(cur)) throw new PlayerSyncError("binding-changed"); // armed meanwhile: it may be in flight, never retire it
      return { next: { ...cur, lastAcknowledged: ack, pending: null, syncStatus: "ready", conflictCode: null } };
    });
    if (record.syncStatus === "ready") fresh.add(key);
    return outcome(record, "ready");
  }

  // Re-reads the DURABLE Core snapshot (committed primary storage) and compares it with the one this pass is using. Returns true when
  // the Restore epoch and this player's payload are unchanged; otherwise adopts the newest snapshot into ctx and returns false.
  async function refreshSnapshot(ctx) {
    const next = await readSnapshot();
    const before = ctx.snap;
    // A Restore landed while this pass was waiting: that is Restore evidence, not an Owner edit. Fence durably (publication closed).
    if (next.restoreEpoch !== before.restoreEpoch) await fenceRows();
    let changed = next.restoreEpoch !== before.restoreEpoch || next.dupes.size !== before.dupes.size;
    if (!changed) {
      const ids = new Set([...before.byId.keys(), ...next.byId.keys()]);
      for (const id of ids) {
        const a = before.byId.get(id), b = next.byId.get(id);
        const pa = a ? localPayloadOf(a) : null, pb = b ? localPayloadOf(b) : null;
        if (!!a !== !!b || (pa === null) !== (pb === null) || (pa && pb && !samePayload(pa, pb))) { changed = true; break; }
      }
    }
    ctx.snap = next;
    return !changed;
  }

  async function startPending(key, ctx, spec, localPayload, localHash) {
    const clientMutationId = randomMutationId();
    if (!MUTATION_ID_PATTERN.test(clientMutationId)) throw new PlayerSyncError("random-unavailable");
    // FRESHNESS: the snapshot this decision was made from may be old (a Cloud list was awaited since). Re-read the committed durable
    // Core state immediately before the pending exists; if the player value or the Restore epoch moved, create NOTHING and restart.
    if (!(await refreshSnapshot(ctx))) return { playerId: JSON.parse(key)[4], outcome: "restart" };
    const pending = {
      clientMutationId, expectedRevision: spec.expectedRevision, basePayloadHash: spec.basePayloadHash,
      payload: localPayload, payloadHash: localHash, sourceRestoreEpoch: ctx.snap.restoreEpoch, sourceLocalPayloadHash: localHash,
    };
    // The pending record is made durable BEFORE any request can be sent. If this write fails nothing is sent.
    const written = await writeBinding(key, (cur) => {
      if (cur.membership !== "selected") throw new PlayerSyncError("binding-changed");
      if (isFenced(cur) && !spec.release) throw new PlayerSyncError("binding-changed"); // a Restore fence landed meanwhile
      if (spec.replaces !== undefined) {
        const held = cur.pending ? cur.pending.clientMutationId : null;
        if (held !== spec.replaces) throw new PlayerSyncError("binding-changed");
        // A pending that MAY have been dispatched is only replaced when its outcome is PROVEN (spec.replaceWhen "proven"); otherwise the
        // durable record must still say "never dispatched" at the moment of replacement.
        if (spec.replaceWhen === "prepared" && !isPrepared(cur)) throw new PlayerSyncError("binding-changed");
        if (spec.replaceWhen !== "prepared" && spec.replaceWhen !== "proven" && spec.replaces !== null) throw new PlayerSyncError("binding-changed");
      } else if (cur.pending) {
        return null; // another tab already holds the unresolved mutation: never replace it, reconcile THAT one
      } else {
        const ackRevision = cur.lastAcknowledged ? cur.lastAcknowledged.revision : 0;
        const ackHash = cur.lastAcknowledged ? cur.lastAcknowledged.payloadHash : null;
        if (ackRevision !== spec.expectedRevision || ackHash !== spec.basePayloadHash) throw new PlayerSyncError("binding-changed");
      }
      return { next: { ...cur, pending, syncStatus: "pending", conflictCode: null } };
    });
    fresh.delete(key);
    return resolvePending(key, written, ctx, localHash);
  }

  async function reconcileStep(key, ctx) {
    const rec = await store.get(key);
    if (!rec || !validBindingShape(rec, contract) || bindingKeyOf(rec) !== key) throw new PlayerSyncError("store-invalid");
    if (rec.membership !== "selected") return outcome(rec, "skipped");
    const pid = rec.playerId;
    const local = ctx.snap.byId.get(pid) || null;
    if (!local && !ctx.snap.dupes.has(pid)) {
      // absent from the durable local state (for example after a Restore): pause only. Evidence is retained, nothing is deleted.
      const paused = await setStatus(key, "paused_missing_local", null, { release: true });
      return outcome(paused, "paused");
    }
    if (isFenced(rec)) return passiveFenced(key, rec, ctx);
    if (ctx.snap.dupes.has(pid)) return setConflict(key, "local-duplicate-id");
    if (rec.syncStatus === "paused_missing_local") {
      // reappearance (for example after Restore) needs explicit Owner review: nothing is sent or compared automatically
      const review = await setStatus(key, "paused_missing_local", "local-reappeared-review");
      return outcome(review, "paused", { code: "local-reappeared-review" });
    }
    const localPayload = localPayloadOf(local);
    const localHash = localPayload ? await hashOf(localPayload) : null;
    if (rec.pending) return resolvePending(key, rec, ctx, localHash);
    if (!localPayload) return setConflict(key, "local-payload-invalid");
    const cloud = (await ctx.cloudIndex()).get(pid) || null;
    const ack = rec.lastAcknowledged;
    if (ack === null) {
      if (cloud) return setConflict(key, "identity-collision");
      return startPending(key, ctx, { expectedRevision: 0, basePayloadHash: null }, localPayload, localHash);
    }
    if (!cloud) return setConflict(key, "cloud-missing");
    const cloudHash = await hashOf(cloud.payload);
    if (cloud.revision < ack.revision) return setConflict(key, "cloud-regressed");
    if (cloud.revision === ack.revision && cloudHash !== ack.payloadHash) return setConflict(key, "cloud-inconsistent");
    const cloudChanged = cloud.revision !== ack.revision;
    const localChanged = localHash !== ack.payloadHash;
    if (!cloudChanged && !localChanged) { const ready = await setStatus(key, "ready", null); return outcome(ready, "ready"); }
    if (!cloudChanged) {
      return startPending(key, ctx, { expectedRevision: ack.revision, basePayloadHash: ack.payloadHash }, localPayload, localHash);
    }
    if (!localChanged) return setConflict(key, "cloud-update-available");
    if (localHash === cloudHash) return acknowledgeConverged(key, ctx, cloud);
    return setConflict(key, "edit-conflict");
  }

  // A fenced binding publishes NOTHING. The only thing a pass may do is learn the fate of a held pending mutation (a read): when Cloud
  // proves it committed, the evidence is retired into the acknowledgement while the fence (and the conflict status) stays.
  async function passiveFenced(key, rec, ctx) {
    if (rec.pending) {
      const cloud = (await ctx.cloudIndex(true)).get(rec.playerId) || null;
      if (classifyPending(rec.pending, cloud) === "committed") return acknowledge(key, ctx, rec.pending.clientMutationId, cloud);
    }
    return outcome(rec, "conflict", { code: rec.conflictCode });
  }

  // Local and cloud independently reached the SAME approved payload: acknowledge the cloud revision (no write to either side).
  async function acknowledgeConverged(key, ctx, cloud) {
    const ack = { revision: cloud.revision, payload: cloud.payload, payloadHash: await hashOf(cloud.payload) };
    const record = await writeBinding(key, (cur) => {
      if (cur.membership !== "selected" || cur.pending) return null;
      return { next: { ...cur, lastAcknowledged: ack, syncStatus: "ready", conflictCode: null } };
    });
    if (record.syncStatus === "ready") fresh.add(key);
    return outcome(record, "ready");
  }

  async function reconcileOne(key, ctx) {
    let result = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      result = await reconcileStep(key, ctx);
      if (result.outcome === "restart") continue; // the durable Core value / Restore epoch moved mid-pass: re-enter from the newest snapshot
      // After an acknowledgement the durable local value may already differ from what was acknowledged (it changed while the
      // older mutation was being resolved). The follow-up step publishes that newer value as a NEW mutation.
      if (result.outcome === "ready" && result.ackHash) {
        const rec = await store.get(key);
        await refreshSnapshot(ctx); // the durable value may have moved while the older mutation was in flight
        const local = rec ? ctx.snap.byId.get(rec.playerId) : null;
        const payload = local ? localPayloadOf(local) : null;
        if (payload && (await hashOf(payload)) !== result.ackHash) { result = null; continue; }
      }
      return result;
    }
    const rec = await store.get(key);
    return outcome(rec || { playerId: JSON.parse(key)[4], syncStatus: null }, "skipped", { code: "local-changing" });
  }

  function closeTransport(reason) {
    generation += 1;
    if (controller) { try { controller.abort(); } catch { /* ignore */ } controller = new AbortController(); }
    fresh.clear();
    if (cancelDebounce) { cancelDebounce(); cancelDebounce = null; debounceRequested = false; }
    emit();
    return reason;
  }

  async function reconcileNow({ localGroupId, playerIds = null }) {
    const cap = requireCapability(localGroupId);
    if (!isOnline()) throw new PlayerSyncError("offline");
    const g = generation;
    await refresh();
    const wanted = Array.isArray(playerIds) ? new Set(playerIds) : null;
    const keys = [];
    for (const [key, record] of cache) {
      if (scopeMatches(record, cap) && record.membership === "selected" && (!wanted || wanted.has(record.playerId))) keys.push(key);
    }
    const results = [];
    if (keys.length === 0) return { ok: true, results };
    const snap = await readSnapshot();
    const ctx = makeContext(cap, g, snap);
    if (lastPassEpoch !== null && snap.restoreEpoch !== lastPassEpoch) await fenceRows();
    for (const key of keys) {
      ensureLive(g, cap);
      const playerId = JSON.parse(key)[4];
      try { results.push(await withLease(key, () => reconcileOne(key, ctx))); }
      catch (error) {
        const code = error && typeof error.code === "string" ? error.code : "sync-unavailable";
        if (PASS_ABORT_CODES.has(code)) throw error;
        results.push({ playerId, outcome: "error", status: null, code });
      }
    }
    if (!wanted) lastPassEpoch = ctx.snap.restoreEpoch;
    return { ok: true, results };
  }

  function enqueue(operation) {
    const run = reconcileChain.then(operation, operation);
    reconcileChain = run.then(() => undefined, () => undefined);
    return run;
  }

  // ---- Owner actions --------------------------------------------------------------------------------------------------------
  const USE_CLOUD_CODES = new Set(["identity-collision", "cloud-update-available", "edit-conflict", "pending-obsolete", "local-restored-review", "restored-dispatch-review", "pending-unsettled"]);
  const USE_LOCAL_CODES = new Set(["edit-conflict", "pending-obsolete", "cloud-missing", "local-restored-review", "restored-dispatch-review", "pending-unsettled"]);

  function findSelected(cap, playerId) {
    for (const [key, record] of cache) {
      if (scopeMatches(record, cap) && record.playerId === playerId && record.membership === "selected") return { key, record };
    }
    return null;
  }

  async function localSide(snap, playerId) {
    if (snap.dupes.has(playerId)) throw new PlayerSyncError("local-duplicate-id");
    const local = snap.byId.get(playerId);
    if (!local) throw new PlayerSyncError("local-player-missing");
    const payload = localPayloadOf(local);
    if (!payload) throw new PlayerSyncError("local-payload-invalid");
    return { payload, hash: await hashOf(payload) };
  }

  // Preview authorization is bound to the WHOLE decision context, not just two values: environment/project boundary, owner/account,
  // local group, cloud group, player, the binding's identity and state (status, code, acknowledgement, held pending), the Cloud
  // revision + payload, the local payload hash and the Restore epoch. Any change to any of them invalidates the preview.
  async function contextToken(kind, cap, record, localHash, cloud, restoreEpoch, playerId) {
    const parts = [
      "badq-player-preview-v1", PLAYER_SYNC_ENVIRONMENT, PLAYER_SYNC_PROJECT_ID, PLAYER_SYNC_CONTRACT_VERSION, kind,
      cap.ownerId, cap.ownerId, cap.localGroupId, cap.cloudGroupId, playerId,
      record ? [record.membership, record.syncStatus, record.conflictCode,
        record.lastAcknowledged ? [record.lastAcknowledged.revision, record.lastAcknowledged.payloadHash] : null,
        record.pending ? [record.pending.clientMutationId, record.pending.expectedRevision, record.pending.payloadHash, record.pending.sourceRestoreEpoch] : null] : null,
      cloud ? [cloud.revision, await hashOf(cloud.payload)] : null, localHash, restoreEpoch,
    ];
    return `ctx1:${await sha256Hex(JSON.stringify(parts))}`;
  }
  const tokenFor = (cap, record, localHash, cloud, restoreEpoch) => contextToken("resolve", cap, record, localHash, cloud, restoreEpoch, record.playerId);

  function diffFields(local, cloud) {
    if (!cloud) return [];
    return ["displayName", "skillIndex", "archived"].filter((field) => local[field] !== cloud[field])
      .map((field) => ({ field, local: local[field], cloud: cloud[field] }));
  }

  async function selectPlayerInner({ localGroupId, playerId } = {}) {
    const cap = requireCapability(localGroupId);
    await refresh();
    if (!contract.isValidPlayerId(playerId)) throw new PlayerSyncError("player-id-unsupported");
    const snap = await readSnapshot();
    await localSide(snap, playerId); // duplicate / missing / invalid-payload players cannot be selected
    const record = {
      schemaVersion: PLAYER_SYNC_SCHEMA_VERSION, environment: PLAYER_SYNC_ENVIRONMENT, projectId: PLAYER_SYNC_PROJECT_ID,
      contractVersion: PLAYER_SYNC_CONTRACT_VERSION, ownerId: cap.ownerId, accountId: cap.ownerId, localGroupId,
      cloudGroupId: cap.cloudGroupId, playerId, membership: "selected", lastAcknowledged: null, pending: null,
      syncStatus: "stale", conflictCode: null,
    };
    const key = bindingKeyOf(record);
    await store.transact(key, (existing, all) => {
      const clash = (all || []).some(({ record: other }) => isRecord(other) && other.environment === PLAYER_SYNC_ENVIRONMENT &&
        other.ownerId === cap.ownerId && other.localGroupId === localGroupId && other.playerId === playerId &&
        other.cloudGroupId !== cap.cloudGroupId && other.membership === "selected");
      if (clash) throw new PlayerSyncError("binding-target-conflict");
      if (existing) {
        if (!validBindingShape(existing, contract)) throw new PlayerSyncError("store-invalid");
        if (existing.membership === "selected") return { result: existing };
        // reselect REUSES the binding; a Restore / unsettled fence it carries is NOT released by deselect + reselect
        const next = isFenced(existing) ? { ...existing, membership: "selected", syncStatus: "conflict" }
          : { ...existing, membership: "selected", syncStatus: "stale", conflictCode: null };
        if (!validBindingShape(next, contract)) throw new PlayerSyncError("store-invalid");
        return { write: next, result: next };
      }
      return { write: record, result: record };
    }, { withAll: true });
    await afterWrite(key);
    fresh.delete(key);
    try { await enqueue(() => reconcileNow({ localGroupId, playerIds: [playerId] })); }
    catch (error) { return { selected: true, reconciled: false, code: error && error.code ? error.code : "sync-unavailable" }; }
    return { selected: true, reconciled: true, code: null };
  }

  // The shared lock is taken BEFORE entering the serial queue (never inside it): every queued operation already holds it, so a waiting
  // Restore (exclusive) can never deadlock against the queue.
  const sharedOp = (fn) => (arg) => restoreGate.shared(() => fn(arg));
  const selectPlayer = sharedOp(selectPlayerInner);
  const acceptCloudUpdate = sharedOp(acceptCloudUpdateInner);
  const useLocalValue = sharedOp(useLocalValueInner);
  const importCloudPlayer = sharedOp(importCloudPlayerInner);

  async function deselectPlayer({ localGroupId, playerId } = {}) {
    const identity = getIdentity();
    if (!isRecord(identity) || typeof identity.ownerId !== "string" || !identity.ownerId) throw new PlayerSyncError("identity-not-validated");
    await refresh();
    const matches = [];
    for (const [key, record] of cache) {
      if (record.ownerId === identity.ownerId && record.localGroupId === localGroupId && record.playerId === playerId &&
          record.membership === "selected") matches.push(key);
    }
    for (const key of matches) {
      // Deselect NEVER deletes the cloud player and NEVER deletes pending / acknowledged evidence.
      await writeBinding(key, (cur) => (cur.membership === "not_selected" ? null :
        { next: { ...cur, membership: "not_selected", syncStatus: "unselected" } }));
      fresh.delete(key);
    }
    return { deselected: matches.length > 0 };
  }

  // Authoritative public/automatic reconciliation entry point. It takes the shared Restore gate BEFORE the serial queue and holds it
  // through durable snapshot, pending/arm, network and definite/uncertain response handling. selectPlayerInner calls the private
  // reconcileNow while its OUTER selectPlayer shared holder is active; never reacquire this non-reentrant Web Lock from inside it.
  function reconcile(options) {
    return restoreGate.shared(() => enqueue(() => reconcileNow(options || {})));
  }

  async function previewResolution({ localGroupId, playerId } = {}) {
    const cap = requireCapability(localGroupId);
    if (!isOnline()) throw new PlayerSyncError("offline");
    const g = generation;
    await refresh();
    const found = findSelected(cap, playerId);
    if (!found) throw new PlayerSyncError("binding-not-found");
    const code = found.record.conflictCode;
    if (!(found.record.syncStatus === "conflict" && (USE_CLOUD_CODES.has(code) || USE_LOCAL_CODES.has(code)))) {
      throw new PlayerSyncError("no-resolution-needed");
    }
    const snap = await readSnapshot();
    const local = await localSide(snap, playerId);
    const ctx = makeContext(cap, g, snap);
    const cloud = (await ctx.cloudIndex(true)).get(playerId) || null;
    return {
      playerId, kind: code, local: local.payload, cloud: cloud ? { payload: cloud.payload, revision: cloud.revision } : null,
      fields: diffFields(local.payload, cloud && cloud.payload), hasPending: found.record.pending !== null,
      canUseCloud: !!cloud && USE_CLOUD_CODES.has(code), canUseLocal: USE_LOCAL_CODES.has(code),
      token: await tokenFor(cap, found.record, local.hash, cloud, snap.restoreEpoch),
    };
  }

  function acceptCloudUpdateInner({ localGroupId, playerId, token } = {}) {
    return enqueue(async () => {
      const cap = requireCapability(localGroupId);
      if (!isOnline()) throw new PlayerSyncError("offline");
      const g = generation;
      await refresh();
      const found = findSelected(cap, playerId);
      if (!found || found.record.syncStatus !== "conflict" || !USE_CLOUD_CODES.has(found.record.conflictCode)) throw new PlayerSyncError("no-resolution-needed");
      const snap = await readSnapshot();
      const local = await localSide(snap, playerId);
      const ctx = makeContext(cap, g, snap);
      const cloud = (await ctx.cloudIndex(true)).get(playerId) || null;
      if (!cloud) throw new PlayerSyncError("cloud-missing");
      if (typeof token !== "string" || token !== await tokenFor(cap, found.record, local.hash, cloud, snap.restoreEpoch)) throw new PlayerSyncError("preview-stale");
      // Choosing the Cloud value may record Owner intent but it can NEVER erase an operation that might still commit.
      const held = found.record.pending;
      let heldKind = null;
      if (held) {
        heldKind = classifyPending(held, cloud);
        if (heldKind === "committed") { await acknowledge(found.key, ctx, held.clientMutationId, cloud); throw new PlayerSyncError("preview-stale"); } // outcome learned: re-preview against it
        if (heldKind === "ambiguous") throw new PlayerSyncError("pending-outcome-ambiguous");
      }
      let keepPending = false;
      ensureLive(g, cap);
      let applied;
      try { applied = await host.applyApprovedFields({ playerId, expectedLocal: local.payload, cloud: cloud.payload }); }
      catch { applied = { ok: false, code: "local-apply-failed" }; }
      if (!isRecord(applied) || applied.ok !== true) throw new PlayerSyncError(isRecord(applied) && typeof applied.code === "string" ? applied.code : "local-apply-failed");
      const after = (await readSnapshot()).byId.get(playerId);
      const afterPayload = after ? localPayloadOf(after) : null;
      if (!afterPayload || !samePayload(afterPayload, cloud.payload)) throw new PlayerSyncError("local-apply-not-durable");
      ensureLive(g, cap);
      const heldBefore = held ? held.clientMutationId : null;
      const ack = { revision: cloud.revision, payload: cloud.payload, payloadHash: await hashOf(cloud.payload) };
      const record = await writeBinding(found.key, (cur) => {
        if (cur.membership !== "selected" || (cur.pending ? cur.pending.clientMutationId : null) !== heldBefore) throw new PlayerSyncError("binding-changed");
        // Not committed (yet): a copy that MAY have been dispatched could still land after this decision, so its evidence is retained.
        // Only a pending that the durable record still proves was NEVER dispatched (prepared) is dropped.
        keepPending = heldKind === "unsettled" && !isPrepared(cur);
        if (keepPending) {
          // Fence, retain mutationId/payload/revision evidence, do NOT report ready and do NOT advance the acknowledgement.
          return { next: { ...cur, syncStatus: "conflict", conflictCode: "pending-unsettled" } };
        }
        return { next: { ...cur, lastAcknowledged: ack, pending: null, syncStatus: "ready", conflictCode: null } };
      });
      if (record.syncStatus === "ready") fresh.add(found.key); else fresh.delete(found.key);
      return keepPending ? { ok: true, settled: false, status: record.syncStatus, code: record.conflictCode } : { ok: true, settled: true, status: "ready", code: null };
    });
  }

  function useLocalValueInner({ localGroupId, playerId, token } = {}) {
    return enqueue(async () => {
      const cap = requireCapability(localGroupId);
      if (!isOnline()) throw new PlayerSyncError("offline");
      const g = generation;
      await refresh();
      const found = findSelected(cap, playerId);
      if (!found || found.record.syncStatus !== "conflict" || !USE_LOCAL_CODES.has(found.record.conflictCode)) throw new PlayerSyncError("no-resolution-needed");
      const snap = await readSnapshot();
      const local = await localSide(snap, playerId);
      const ctx = makeContext(cap, g, snap);
      const cloud = (await ctx.cloudIndex(true)).get(playerId) || null;
      if (typeof token !== "string" || token !== await tokenFor(cap, found.record, local.hash, cloud, snap.restoreEpoch)) throw new PlayerSyncError("preview-stale");
      const held = found.record.pending;
      let replaceWhen;
      if (held) {
        const kind = classifyPending(held, cloud);
        if (kind === "committed") { await acknowledge(found.key, ctx, held.clientMutationId, cloud); throw new PlayerSyncError("preview-stale"); }
        if (kind === "ambiguous") throw new PlayerSyncError("pending-outcome-ambiguous");
        // A pending that MAY be in flight is never replaced while its outcome is unknown (Cloud merely still showing the old revision proves nothing).
        if (kind === "unsettled" && !isPrepared(found.record)) throw new PlayerSyncError("pending-outcome-unknown");
        replaceWhen = kind === "dead" ? "proven" : "prepared";
      }
      // Explicit, revision-fenced Owner choice: a NEW mutation based on the freshly read cloud revision (never a blind overwrite).
      // It releases the Restore / unsettled fence because the Owner reviewed both values.
      return startPending(found.key, ctx, {
        expectedRevision: cloud ? cloud.revision : 0,
        basePayloadHash: cloud ? await hashOf(cloud.payload) : null,
        replaces: held ? held.clientMutationId : null,
        replaceWhen,
        release: true,
      }, local.payload, local.hash);
    });
  }

  function resumeAfterReview({ localGroupId, playerId } = {}) {
    return enqueue(async () => {
      const cap = requireCapability(localGroupId);
      await refresh();
      const found = findSelected(cap, playerId);
      if (!found || found.record.syncStatus !== "paused_missing_local") throw new PlayerSyncError("no-resolution-needed");
      const snap = await readSnapshot();
      if (!snap.byId.has(playerId)) throw new PlayerSyncError("local-player-missing");
      // The player is back, but its reappeared value may be an older restored one: it is NOT published. It enters the durable review
      // state and only an explicit preview + Owner resolution can release it.
      // a paused row's pending may have been dispatched before it paused: only a pending-free row gets the plain review code
      const reviewCode = found.record.pending ? "restored-dispatch-review" : "local-restored-review";
      const record = await setStatus(found.key, "conflict", reviewCode, { release: true });
      return outcome(record, "conflict", { code: reviewCode });
    });
  }

  async function listCloudOnly({ localGroupId } = {}) {
    const cap = requireCapability(localGroupId);
    if (!isOnline()) throw new PlayerSyncError("offline");
    const g = generation;
    await refresh();
    const snap = await readSnapshot();
    const ctx = makeContext(cap, g, snap);
    const index = await ctx.cloudIndex(true);
    const bound = new Set();
    for (const record of cache.values()) if (scopeMatches(record, cap)) bound.add(record.playerId);
    const rows = [];
    for (const cloud of index.values()) {
      if (snap.byId.has(cloud.playerId) || bound.has(cloud.playerId)) continue;
      let known = false;
      if (typeof host.isKnownPlayerId === "function") { try { known = (await host.isKnownPlayerId(cloud.playerId)) === true; } catch { known = true; } }
      rows.push({ playerId: cloud.playerId, payload: cloud.payload, revision: cloud.revision, importable: !known,
        reason: known ? "local-id-reference-collision" : null, token: await contextToken("import", cap, null, null, cloud, snap.restoreEpoch, cloud.playerId) });
    }
    return rows;
  }

  function importCloudPlayerInner({ localGroupId, playerId, token } = {}) {
    return enqueue(async () => {
      const cap = requireCapability(localGroupId);
      if (!isOnline()) throw new PlayerSyncError("offline");
      if (typeof host.createPlayerFromCloud !== "function") throw new PlayerSyncError("host-unsupported");
      const g = generation;
      await refresh();
      const snap = await readSnapshot();
      if (snap.byId.has(playerId)) throw new PlayerSyncError("identity-collision");
      if (typeof host.isKnownPlayerId === "function" && (await host.isKnownPlayerId(playerId)) !== false) throw new PlayerSyncError("local-id-reference-collision");
      for (const record of cache.values()) if (scopeMatches(record, cap) && record.playerId === playerId) throw new PlayerSyncError("binding-exists");
      const ctx = makeContext(cap, g, snap);
      const cloud = (await ctx.cloudIndex(true)).get(playerId) || null;
      if (!cloud) throw new PlayerSyncError("cloud-missing");
      if (typeof token !== "string" || token !== await contextToken("import", cap, null, null, cloud, snap.restoreEpoch, playerId)) throw new PlayerSyncError("preview-stale");
      ensureLive(g, cap);
      let created;
      try { created = await host.createPlayerFromCloud({ playerId, payload: cloud.payload }); }
      catch { created = { ok: false, code: "local-apply-failed" }; }
      if (!isRecord(created) || created.ok !== true) throw new PlayerSyncError(isRecord(created) && typeof created.code === "string" ? created.code : "local-apply-failed");
      const after = (await readSnapshot()).byId.get(playerId);
      const afterPayload = after ? localPayloadOf(after) : null;
      if (!afterPayload || !samePayload(afterPayload, cloud.payload)) throw new PlayerSyncError("local-apply-not-durable");
      ensureLive(g, cap);
      const ack = { revision: cloud.revision, payload: cloud.payload, payloadHash: await hashOf(cloud.payload) };
      const record = {
        schemaVersion: PLAYER_SYNC_SCHEMA_VERSION, environment: PLAYER_SYNC_ENVIRONMENT, projectId: PLAYER_SYNC_PROJECT_ID,
        contractVersion: PLAYER_SYNC_CONTRACT_VERSION, ownerId: cap.ownerId, accountId: cap.ownerId, localGroupId,
        cloudGroupId: cap.cloudGroupId, playerId, membership: "selected", lastAcknowledged: ack, pending: null,
        syncStatus: "ready", conflictCode: null,
      };
      const key = bindingKeyOf(record);
      await store.transact(key, (existing, all) => {
        if (existing) throw new PlayerSyncError("binding-exists");
        const clash = (all || []).some(({ record: other }) => isRecord(other) && other.ownerId === cap.ownerId &&
          other.localGroupId === localGroupId && other.playerId === playerId && other.cloudGroupId !== cap.cloudGroupId && other.membership === "selected");
        if (clash) throw new PlayerSyncError("binding-target-conflict");
        if (!validBindingShape(record, contract)) throw new PlayerSyncError("store-invalid");
        return { write: record, result: record };
      }, { withAll: true });
      await afterWrite(key);
      fresh.add(key);
      return { ok: true };
    });
  }

  // ---- gates / notifications ------------------------------------------------------------------------------------------------
  // Durable Restore/Undo fence: EVERY binding row on this device (any owner / group / membership) that holds evidence is moved to the
  // review state in the isolated store. Pending and acknowledgement evidence is retained byte-for-byte; nothing is deleted; nothing is
  // published until an explicit reviewed Owner resolution. Because it is stored, it survives repeated passes, reloads and other tabs.
  // A row needs the fence when it is not already fenced and could publish (selected, not paused) or holds evidence (deselected).
  const needsFence = (record) => {
    if (isFenced(record)) return false;
    if (record.membership === "selected") return record.syncStatus !== "paused_missing_local";
    return !(record.lastAcknowledged === null && record.pending === null);
  };
  // Returns { ok, required, fenced, code? }. ok === true ONLY when every row that needed the fence was durably written AND a fresh read of
  // the store confirms it. Any failure (store unavailable, invalid row, write error, failed verification) is ok:false.
  async function fenceAll(reason) {
    closeTransport(reason);
    return fenceRows();
  }
  async function fenceRows() {
    try { await refresh(); } catch (error) { return { ok: false, required: null, fenced: 0, code: error && error.code ? error.code : "store-unavailable" }; }
    const wanted = [];
    for (const [key, record] of Array.from(cache)) if (needsFence(record)) wanted.push(key);
    let writeFailed = false;
    for (const key of wanted) {
      try {
        await writeBinding(key, (cur) => {
          if (!needsFence(cur)) return null;
          // A pending that is not provably PREPARED may be in flight: keep that knowledge in the fence code itself.
          const code = cur.pending && !isPrepared(cur) ? "restored-dispatch-review" : "local-restored-review";
          if (cur.membership === "selected") return { next: { ...cur, syncStatus: "conflict", conflictCode: code } };
          return { next: { ...cur, conflictCode: code } }; // deselected evidence keeps the fence for a later reselect
        });
        fresh.delete(key);
      } catch { writeFailed = true; }
    }
    // VERIFY from the store itself (not the cache, not the write result).
    let rows;
    try { await store.open(); rows = await store.getAll(); } catch { return { ok: false, required: wanted.length, fenced: 0, code: "store-unavailable" }; }
    let unfenced = 0;
    for (const row of rows) {
      const record = row && row.record;
      if (!validBindingShape(record, contract) || row.key !== bindingKeyOf(record)) { unfenced += 1; continue; }
      if (needsFence(record)) unfenced += 1;
    }
    const ok = !writeFailed && unfenced === 0;
    return ok ? { ok: true, required: wanted.length, fenced: wanted.length } : { ok: false, required: wanted.length, fenced: Math.max(0, wanted.length - unfenced), code: "fence-not-durable" };
  }
  // Defense-in-depth / standalone fence (no lock): used for the post-promotion re-scan and by tests. NOT what makes Restore safe.
  function fenceForRestore(reason) { return fenceAll(typeof reason === "string" ? reason : "restore-started"); }

  // THE Restore critical section. Under the EXCLUSIVE gate: (1) fence + verify every binding, (2) run `promoteFn` (Core's promotion) while
  // still holding the gate. Nothing that creates/releases a binding can run in between, in this tab or any other. `ctl` is the caller's
  // abort/progress cell: `ctl.aborted` (set by the caller's timeout) stops the section BEFORE promotion; `ctl.promoting` is set synchronously
  // right before promotion starts so a timeout can no longer abandon it. Returns { ok, reason?, result? }; a promotion that throws is rethrown.
  async function runRestoreCritical(reason, promoteFn, ctl = {}) {
    if (typeof promoteFn !== "function") throw new PlayerSyncError("restore-critical-invalid");
    closeTransport(typeof reason === "string" ? reason : "restore-started");
    let out;
    try {
      out = await restoreGate.exclusive(async () => {
        if (ctl.aborted) return { ok: false, reason: "fence-timeout" };
        const fence = await fenceRows();
        if (!fence.ok) return { ok: false, reason: "fence-failed", fence };
        if (ctl.aborted) return { ok: false, reason: "fence-timeout", fence };
        ctl.promoting = true;
        try { return { ok: true, fence, result: await promoteFn() }; }
        catch (error) { return { ok: true, fence, promoteError: { error } }; }
      });
    } catch (error) {
      return { ok: false, reason: error && error.code === "restore-lock-unavailable" ? "fence-unavailable" : "fence-exception" };
    }
    if (out.promoteError) throw out.promoteError.error;
    return out;
  }

  async function markStale(reason) {
    if (typeof reason === "string" && reason.startsWith("restore")) return fenceAll(reason);
    closeTransport(reason);
    try { await refresh(); } catch { return { ok: false }; }
    for (const [key, record] of Array.from(cache)) {
      if (record.membership !== "selected" || record.syncStatus !== "ready") continue;
      try { await writeBinding(key, (cur) => (cur.membership === "selected" && cur.syncStatus === "ready" ? { next: { ...cur, syncStatus: "stale" } } : null)); }
      catch { /* a failed stale marker still leaves the runtime gate closed */ }
    }
    return { ok: true };
  }

  let lastOwnerId = null;
  function handleIdentityChange(state) {
    const owner = isRecord(state) && state.linkStatus === "linked" && typeof state.ownerId === "string" ? state.ownerId : null;
    const validated = owner !== null && state.validationStatus === "validated";
    const ownerChanged = lastOwnerId !== null && owner !== lastOwnerId;
    if (owner !== null) lastOwnerId = owner;
    if (!validated || ownerChanged) return markStale(ownerChanged ? "owner-changed" : "identity-not-validated");
    return Promise.resolve({ ok: true });
  }

  let linkSignature = null;
  function handleGroupLinkChange(state) {
    const records = isRecord(state) && Array.isArray(state.records) ? state.records : [];
    const signature = JSON.stringify(records.map((record) => [record.localGroupId, record.linkStatus, record.cloudGroupId, record.ownerId, record.validationStatus])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
    const changed = linkSignature !== null && signature !== linkSignature;
    linkSignature = signature;
    if (changed) { closeTransport("group-link-changed"); return true; }
    return false;
  }

  async function reconcileAllQuiet() {
    try {
      const identity = getIdentity();
      if (!isRecord(identity) || identity.validated !== true || !isOnline()) return;
      await refresh();
      const groups = new Set();
      for (const record of cache.values()) if (record.ownerId === identity.ownerId && record.membership === "selected") groups.add(record.localGroupId);
      for (const localGroupId of groups) {
        try { await reconcile({ localGroupId }); } catch { /* per-group failure leaves its bindings pending/stale */ }
      }
    } catch { /* quiet by design */ }
  }

  function scheduleReconcile() {
    if (disposed || cancelDebounce) return;
    debounceRequested = true;
    cancelDebounce = schedule(() => { cancelDebounce = null; debounceRequested = false; reconcileAllQuiet(); }, debounceMs);
  }

  function hasSelectedBindings() {
    for (const record of cache.values()) if (record.membership === "selected") return true;
    return false;
  }

  function eligibility(player) {
    if (!isRecord(player) || !contract.isValidPlayerId(player.id)) return { ok: false, code: "player-id-unsupported" };
    if (!localPayloadOf(player)) return { ok: false, code: "local-payload-invalid" };
    return { ok: true, code: null };
  }

  function getView(localGroupId) {
    const identity = getIdentity();
    const ownerId = isRecord(identity) && typeof identity.ownerId === "string" && identity.ownerId ? identity.ownerId : null;
    const validGroup = typeof localGroupId === "string" && LOCAL_GROUP_PATTERN.test(localGroupId);
    const cap = validGroup ? capability(localGroupId) : { ok: false, code: "local-group-invalid" };
    const gateOpen = cap.ok && storeState === "ready";
    const bindings = {};
    if (ownerId && validGroup) {
      for (const [key, record] of cache) {
        if (record.ownerId !== ownerId || record.localGroupId !== localGroupId) continue;
        const targetMismatch = cap.ok && record.cloudGroupId !== cap.cloudGroupId;
        let status = record.membership === "not_selected" ? "unselected" : record.syncStatus;
        if (record.membership === "selected" && status === "ready" && (!gateOpen || targetMismatch || !fresh.has(key))) status = "stale";
        const entry = { playerId: record.playerId, membership: record.membership, status, conflictCode: record.conflictCode,
          revision: record.lastAcknowledged ? record.lastAcknowledged.revision : null, hasPending: record.pending !== null, targetMismatch };
        const existing = bindings[record.playerId];
        if (!existing || (existing.targetMismatch && !targetMismatch)) bindings[record.playerId] = entry;
      }
    }
    return { capability: cap.ok ? { ok: true, code: null } : { ok: false, code: cap.code }, storeState, bindings };
  }

  function subscribe(callback) {
    if (typeof callback !== "function") throw new PlayerSyncError("subscriber-invalid");
    subscribers.add(callback);
    return () => subscribers.delete(callback);
  }

  async function init() {
    try { await refresh(); } catch { /* the view reports storeState; local Core is unaffected */ }
    emit();
    return storeState;
  }

  function dispose() {
    disposed = true;
    closeTransport("dispose");
    subscribers.clear();
  }

  return Object.freeze({
    init, refresh: () => refresh().then(() => { emit(); return storeState; }), getView, eligibility, subscribe,
    selectPlayer, deselectPlayer, reconcile, previewResolution, acceptCloudUpdate, useLocalValue, resumeAfterReview,
    listCloudOnly, importCloudPlayer, markStale, fenceForRestore, runRestoreCritical, closeTransport, handleIdentityChange, handleGroupLinkChange,
    scheduleReconcile, hasSelectedBindings, dispose,
    // test-only introspection (not used by production code)
    __generation: () => generation, __storeState: () => storeState, __debounceRequested: () => debounceRequested,
  });
}
