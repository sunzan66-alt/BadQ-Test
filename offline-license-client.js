// BadQ Core - /v2/offline client (BAD_Q Offline MVP). Implements ONLY the Codex contract CORE-OFFLINE-MVP-CONTRACT.md:
//   GET  /v2/offline/owner/status          GET  /v2/offline/owner/devices
//   POST /v2/offline/owner/devices/enroll  (explicit confirmation; optional explicit confirmLegacyMigration)
//   POST /v2/offline/owner/trial {confirm}  POST /v2/offline/owner/redeem {code, confirm}
//   GET  /v2/offline/core/bootstrap         POST /v2/offline/core/license {confirm}
// Transport (`request`) is injected: it adds the Firebase bearer token (and, for /core/*, X-BadQ-Device-Id / X-BadQ-Device-Key) and
// returns the parsed JSON or throws an Error with `.code` / `.status`. Nothing here talks to Firebase, creates an identity, enrolls a
// device on its own, or touches operational data.
//
// Wire assumptions NOT spelled out in the contract text (isolated in the three parse* functions + extractLicense, flagged in the report):
//   * every v2 response carries contractVersion "2" and environment; the error envelope is { error: { code } } (as v1);
//   * GET /core/bootstrap returns the Owner-status fields at top level plus device { id, status } and serverTime (ISO);
//   * POST /core/license returns { license: <compact JWS>, keyId } (the JWS header kid is authoritative).
import { OFFLINE_CONTRACT_VERSION } from "./offline-jws.js";

const isRecord = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isIso = (v) => typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));
const PLAN = new Set(["BAD_Q_LIFETIME", "BAD_Q_TRIAL"]);
const REASON = new Set(["active", "expired", "revoked", "no_entitlement"]);
const PLATFORMS = new Set(["web", "android", "ios"]);
const DEVICE_LIMIT_CODES = new Set(["DEVICE_LIMIT_REACHED", "device-limit-reached"]);
const UNCERTAIN = new Set(["offline", "verification-unavailable"]);
export class OfflineClientError extends Error { constructor(code, status) { super(code); this.name = "OfflineClientError"; this.code = code; if (status) this.status = status; } }
const fail = (code) => new OfflineClientError(code);

export function parseOwnerStatus(v, { environment, uid = null }) {
  if (!isRecord(v) || v.contractVersion !== OFFLINE_CONTRACT_VERSION || v.environment !== environment) throw fail("offline-contract-invalid");
  if (typeof v.ownerId !== "string" || !v.ownerId || typeof v.accountId !== "string" || v.accountId !== v.ownerId) throw fail("offline-contract-invalid");
  if (uid !== null && v.ownerId !== uid) throw fail("account-mismatch"); // expected canonical UID = authenticated token subject
  if (!(v.planId === null || PLAN.has(v.planId)) || !REASON.has(v.reason)) throw fail("offline-contract-invalid");
  if ((v.planId === null) === (v.reason === "active")) throw fail("offline-contract-invalid");
  if (!(v.validUntil === null || isIso(v.validUntil))) throw fail("offline-contract-invalid");
  if (v.planId === "BAD_Q_TRIAL" && v.validUntil === null) throw fail("offline-contract-invalid");
  if (v.maxAuthorizedDevices !== 1) throw fail("offline-contract-invalid");
  const e = v.entitlements;
  if (!isRecord(e) || typeof e.coreAppAccess !== "boolean" || e.cloudSyncAccess !== false || e.memberPortalAccess !== false || e.memberLinkAccess !== false) throw fail("offline-contract-invalid");
  return { ownerId: v.ownerId, planId: v.planId, reason: v.reason, validUntil: v.validUntil, coreAppAccess: e.coreAppAccess };
}
export function parseBootstrap(v, { environment, uid, deviceId, nowMs = Date.now() }) {
  const status = parseOwnerStatus(v, { environment, uid });
  if (!isRecord(v.device) || v.device.status !== "authorized" || typeof v.device.id !== "string") throw fail("offline-contract-invalid");
  if (v.device.id !== deviceId) throw fail("device-mismatch");
  if (!isIso(v.serverTime)) throw fail("offline-contract-invalid");
  return { ...status, deviceId: v.device.id, serverTimeMs: Date.parse(v.serverTime) };
}
export function extractLicense(v, { environment }) {
  if (!isRecord(v) || v.contractVersion !== OFFLINE_CONTRACT_VERSION || v.environment !== environment || typeof v.license !== "string" || v.license.length === 0) throw fail("offline-contract-invalid");
  return v.license;
}

async function sha256Hex(text) {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createOfflineLicenseClient({ environment, request, getUser, credentialStore, license, storage = null, uuid = () => globalThis.crypto.randomUUID(), online = () => true }) {
  if (typeof request !== "function" || typeof getUser !== "function" || !credentialStore || !license || typeof environment !== "string") throw fail("bridge-dependency-invalid");
  const OPS_KEY = "badq-offline-pending-ops-v1";
  const readOps = () => { try { const v = JSON.parse(storage.getItem(OPS_KEY) || "{}"); return isRecord(v) ? v : {}; } catch { return {}; } };
  const writeOps = (o) => { try { storage.setItem(OPS_KEY, JSON.stringify(o)); } catch { /* best effort: only costs idempotent replay */ } };
  // One Idempotency-Key per (operation, owner, body hash), kept until the server gave a DEFINITIVE answer: an uncertain response is retried
  // with the identical key and body; a different body gets a new key.
  async function keyFor(op, uid, body) {
    const id = `${op}:${uid}:${await sha256Hex(JSON.stringify(body))}`;
    const ops = readOps(); if (!ops[id]) { ops[id] = uuid(); if (storage) writeOps(ops); }
    return { id, key: ops[id] };
  }
  const settle = (id) => { if (!storage) return; const ops = readOps(); if (ops[id]) { delete ops[id]; writeOps(ops); } };

  function requireUser() {
    const u = getUser();
    if (!u || typeof u.uid !== "string" || !u.uid) throw fail("session-unavailable");
    if (u.emailVerified !== true) throw fail("email-not-verified");
    return u;
  }
  const requireOnline = () => { if (online() === false) throw fail("offline"); };

  async function fetchStatus({ expectedUid } = {}) {
    const u = requireUser(); requireOnline();
    return parseOwnerStatus(await request("/v2/offline/owner/status", { expectedUid: expectedUid || u.uid }), { environment, uid: u.uid });
  }
  async function bootstrap() {
    const u = requireUser(); requireOnline();
    const cred = await credentialStore.getCredential(u.uid);
    if (!cred) throw fail("device-enrollment-required");
    const body = await request("/v2/offline/core/bootstrap", { deviceUid: u.uid, expectedUid: u.uid });
    return parseBootstrap(body, { environment, uid: u.uid, deviceId: cred.deviceId });
  }

  // ---- enrollment: explicit, single-flight per Owner, cancellable until the request actually leaves the device
  let enrollInFlight = null;
  function enroll(options = {}) {
    if (options.confirm !== true) return Promise.reject(fail("device-confirmation-required"));
    if (options.migrateLegacy === true && options.confirmLegacyMigration !== true) return Promise.reject(fail("legacy-migration-confirmation-required"));
    let u; try { u = requireUser(); } catch (e) { return Promise.reject(e); }
    if (typeof options.expectedUid === "string" && options.expectedUid !== u.uid) return Promise.reject(fail("session-changed"));
    if (enrollInFlight) return enrollInFlight.uid === u.uid ? enrollInFlight.promise : Promise.reject(fail("enrollment-in-progress"));
    const entry = { uid: u.uid, promise: null };
    entry.promise = enrollOnce(options, u.uid).finally(() => { if (enrollInFlight === entry) enrollInFlight = null; });
    enrollInFlight = entry; return entry.promise;
  }
  async function enrollOnce({ label, platform = "web", signal, onSend, migrateLegacy = false }, uid) {
    const intact = () => { const c = getUser(); return !!c && c.uid === uid; };
    const cancelled = () => !!(signal && signal.aborted);
    requireOnline();
    const text = typeof label === "string" ? label.trim() : "";
    if (text.length < 1 || text.length > 80 || !PLATFORMS.has(platform)) throw fail("invalid-device-request");
    if (cancelled()) throw fail("enrollment-cancelled");
    let cred;
    if (migrateLegacy) {
      // A legacy protocol upgrade needs a FRESH id/key. It is staged beside (never over) the current credential until the server accepts it.
      if (typeof credentialStore.createPendingCredential !== "function") throw fail("device-credential-unavailable");
      cred = await credentialStore.createPendingCredential(uid);
    } else cred = await credentialStore.createCredential(uid); // existing local device id/key (created once, explicitly)
    if (cancelled()) throw fail("enrollment-cancelled");
    if (!intact()) throw fail("session-changed");
    const body = { deviceId: cred.deviceId, label: text, platform, deviceKey: cred.deviceKey, confirmRegistration: true, ...(migrateLegacy ? { confirmLegacyMigration: true } : {}) };
    const { id, key } = await keyFor(migrateLegacy ? "migrate" : "enroll", uid, { deviceId: body.deviceId, label: body.label, platform: body.platform, m: migrateLegacy });
    try {
      await request("/v2/offline/owner/devices/enroll", { method: "POST", body, idempotencyKey: key, expectedUid: uid,
        beforeSend: () => { if (cancelled()) throw fail("enrollment-cancelled"); if (!intact()) throw fail("session-changed"); if (typeof onSend === "function") { try { onSend(); } catch { /* presentation only */ } } } });
    } catch (e) {
      const code = e && e.code ? e.code : "verification-unavailable";
      if (!UNCERTAIN.has(code)) settle(id);
      if (!migrateLegacy && DEVICE_LIMIT_CODES.has(code) && cred.created && typeof credentialStore.deleteCredential === "function") await credentialStore.deleteCredential(uid).catch(() => {});
      if (!migrateLegacy && code === "device-policy-migration-required" && cred.created && typeof credentialStore.deleteCredential === "function") await credentialStore.deleteCredential(uid).catch(() => {});
      throw e;
    }
    settle(id);
    if (migrateLegacy) await credentialStore.promotePendingCredential(uid); // local ops only; retry via finishMigration() if it fails
    if (!intact()) throw fail("session-changed");
    return { ok: true, migrated: migrateLegacy };
  }
  async function finishMigration() { const u = requireUser(); return credentialStore.promotePendingCredential(u.uid); }

  // ---- grant activation (trial / redeem) followed by the signed licence
  async function grant(op, path, body, expectedUid) {
    const u = requireUser(); requireOnline();
    if (typeof expectedUid === "string" && expectedUid !== u.uid) throw fail("session-changed");
    const { id, key } = await keyFor(op, u.uid, body);
    try { await request(path, { method: "POST", body, idempotencyKey: key, expectedUid: u.uid }); }
    catch (e) { const code = e && e.code ? e.code : "verification-unavailable"; if (!UNCERTAIN.has(code)) settle(id); throw e; }
    settle(id);
    try { return { granted: true, ...(await activateLicense()) }; }
    catch (e) { return { granted: true, licensed: false, code: e && e.code ? e.code : "verification-unavailable" }; } // the grant is kept server-side; "Refresh licence" retries
  }
  function startTrial({ confirm, expectedUid } = {}) { if (confirm !== true) return Promise.reject(fail("trial-confirmation-required")); return grant("trial", "/v2/offline/owner/trial", { confirm: true }, expectedUid); }
  function redeem({ code, confirm, expectedUid } = {}) {
    if (confirm !== true) return Promise.reject(fail("redeem-confirmation-required"));
    const c = typeof code === "string" ? code.trim() : "";
    if (c.length < 4 || c.length > 128 || /\s/.test(c)) return Promise.reject(fail("redeem-code-invalid"));
    return grant("redeem", "/v2/offline/owner/redeem", { code: c, confirm: true }, expectedUid);
  }

  async function activateLicense() {
    const u = requireUser(); requireOnline();
    const cred = await credentialStore.getCredential(u.uid);
    if (!cred) throw fail("device-enrollment-required");
    const boot = await bootstrap();                                   // full-schema validation BEFORE asking for a licence
    if (boot.planId === null) throw fail(boot.reason === "revoked" ? "license-revoked" : boot.reason === "expired" ? "license-expired" : "offline-grant-required");
    if (boot.coreAppAccess !== true) throw fail("offline-contract-invalid");
    const token = extractLicense(await request("/v2/offline/core/license", { method: "POST", body: { confirm: true }, idempotencyKey: uuid(), deviceUid: u.uid, expectedUid: u.uid }), { environment });
    const view = await license.activate({ token, ownerId: u.uid, deviceId: cred.deviceId, serverTimeMs: boot.serverTimeMs });
    license.applyServerStatus("ok");
    return { licensed: true, view: license.view() };
  }

  // Online reconnect: honour a DEFINITIVE server decision only. A network/contract failure never changes state and nothing is deleted.
  async function refreshServerStatus() {
    const u = getUser();
    if (!u || u.emailVerified !== true || online() === false) return { skipped: true };
    let cred; try { cred = await credentialStore.getCredential(u.uid); } catch { return { skipped: true }; }
    if (!cred || license.boundOwner() !== u.uid) return { skipped: true }; // another Owner / no local licence: nothing to honour here
    try {
      const boot = parseBootstrap(await request("/v2/offline/core/bootstrap", { deviceUid: u.uid, expectedUid: u.uid }), { environment, uid: u.uid, deviceId: cred.deviceId });
      if (boot.planId === null && boot.reason === "revoked") return { status: license.applyServerStatus("revoked") };
      if (boot.planId !== null) return { status: license.applyServerStatus("ok") };
      return { skipped: true, reason: boot.reason };
    } catch (e) {
      const code = e && e.code ? e.code : "verification-unavailable";
      if (code === "device-revoked") return { status: license.applyServerStatus("device_revoked") };
      return { skipped: true, code };
    }
  }

  return Object.freeze({ fetchStatus, bootstrap, enroll, finishMigration, startTrial, redeem, activateLicense, refreshServerStatus });
}
