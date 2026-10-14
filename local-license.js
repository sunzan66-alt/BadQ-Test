// BadQ Core - BAD_Q Offline licence store (server-authorized, Ed25519-signed, device-bound).
//
// A licence exists ONLY as a signed compact JWS obtained online (POST /v2/offline/core/license) and verified against the PINNED
// trust registry (offline-jws.js). Core never invents a trial or a grant locally. States:
//   not_activated  no verified licence (fresh install, or the Owner has not yet started the server trial / redeemed a code)
//   trial          BAD_Q_TRIAL, before the SIGNED expiresAt
//   trial_expired  BAD_Q_TRIAL at/after expiresAt
//   active         BAD_Q_LIFETIME (expiresAt null) - works offline indefinitely, no recurring check
//   revoked        online reconnect reported the plan revoked/expired by the server
//   device_released online reconnect reported THIS device revoked (Admin unlock) - data untouched
//   invalid        a stored record fails verification / is unreadable (never silently treated as valid, never auto-deleted)
//   checking       transient: the stored record has not been verified yet (init() pending); gameplay is not restricted meanwhile
// Gameplay start is restricted in not_activated / trial_expired / revoked / device_released / invalid (see canStartGames); reading data,
// history, finance, Backup/Restore, and finishing games already in progress are NEVER restricted and nothing is ever deleted.
//
// Storage: its OWN primary + mirror localStorage keys (never bg-v11, the Critical Journal, or a Backup). The record carries
// { environment, binding{ownerId, deviceId}, license{token, claims, kid}, clock, server } as ONE JSON value (atomic per key), written
// to both copies with read-back. A Restore therefore cannot roll a licence back, and a Backup never carries it to another device.
//
// Clock (advisory only - there is no offline authority): a persisted high-water mark means rolling the clock back never extends a
// trial; clearing storage / a new profile removes the local record (the server grants a trial once per Owner, so a new profile must
// re-fetch the SAME signed trial expiry online - it cannot restart it).

import { verifyOfflineLicense } from "./offline-jws.js";

export const LOCAL_LICENSE_KEY = "badq-local-license-v2";
export const LOCAL_LICENSE_MIRROR_KEY = "badq-local-license-v2-mirror";
export const LOCAL_LICENSE_SCHEMA = 2;
export const CLOCK_ROLLBACK_TOLERANCE_MS = 5 * 60 * 1000;
export const HIGH_WATER_PERSIST_STEP_MS = 60 * 1000;
export const ENFORCE_GAMEPLAY_GATE = true; // the approved restriction for unactivated / expired / revoked licences
export const RESTRICTED_STATES = Object.freeze(["not_activated", "trial_expired", "revoked", "device_released", "invalid"]);
export const PRICE_THB = 399;
export const TRIAL_HOURS = 72;

const isRecord = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isEpoch = (v) => Number.isSafeInteger(v) && v > 0 && v < 4102444800000;
export class LocalLicenseError extends Error { constructor(code) { super(code); this.name = "LocalLicenseError"; this.code = code; } }

function validRecord(r) {
  if (!isRecord(r) || r.schemaVersion !== LOCAL_LICENSE_SCHEMA || typeof r.environment !== "string" || !r.environment) return false;
  if (!isRecord(r.clock) || !isEpoch(r.clock.highWaterMs)) return false;
  if (!isRecord(r.server) || !["ok", "revoked", "device_revoked"].includes(r.server.status)) return false;
  if (r.license === null) return r.binding === null;
  return isRecord(r.binding) && typeof r.binding.ownerId === "string" && r.binding.ownerId.length > 0 && typeof r.binding.deviceId === "string" && r.binding.deviceId.length > 0 &&
    isRecord(r.license) && typeof r.license.token === "string" && typeof r.license.kid === "string" && isRecord(r.license.claims);
}

export function createLocalLicense({ storage, now = Date.now, environment, getRegistry, subtle } = {}) {
  if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") throw new LocalLicenseError("storage-invalid");
  if (typeof environment !== "string" || !environment || typeof getRegistry !== "function") throw new LocalLicenseError("verifier-required"); // no optional verifier
  let rec = null; let loadError = null; let verified = null; // verified: null (not yet) | { ok:true } | { ok:false, code }
  let lastPersistedHighWater = 0; let rolledBack = false;
  const subscribers = new Set();
  const emit = () => { for (const cb of subscribers) { try { cb(view()); } catch { /* presentation only */ } } };

  function read(key) { try { const raw = storage.getItem(key); if (!raw) return null; const v = JSON.parse(raw); return validRecord(v) ? v : "corrupt"; } catch { return "corrupt"; } }
  function load() {
    const a = read(LOCAL_LICENSE_KEY); const b = read(LOCAL_LICENSE_MIRROR_KEY);
    const good = [a, b].filter((x) => x && x !== "corrupt");
    if (good.length === 0) { rec = null; loadError = (a === "corrupt" || b === "corrupt") ? "license-record-corrupt" : null; return; }
    good.sort((x, y) => (y.license ? 1 : 0) - (x.license ? 1 : 0) || y.clock.highWaterMs - x.clock.highWaterMs);
    rec = good[0]; loadError = null; lastPersistedHighWater = rec.clock.highWaterMs;
    if (a !== good[0] || b !== good[0]) { try { persist(); } catch { /* best effort self-heal */ } }
  }
  function persist() {
    const text = JSON.stringify(rec); let ok = 0;
    for (const key of [LOCAL_LICENSE_KEY, LOCAL_LICENSE_MIRROR_KEY]) { try { storage.setItem(key, text); if (storage.getItem(key) === text) ok += 1; } catch { /* counted */ } }
    if (ok === 0) throw new LocalLicenseError("license-persist-failed");
    lastPersistedHighWater = rec.clock.highWaterMs;
  }
  load();

  function touch() {
    const t = now();
    const hw = rec ? rec.clock.highWaterMs : 0;
    rolledBack = rec ? t < hw - CLOCK_ROLLBACK_TOLERANCE_MS : false;
    if (rec && t > hw) { rec.clock.highWaterMs = t; if (t - lastPersistedHighWater >= HIGH_WATER_PERSIST_STEP_MS) { try { persist(); } catch { /* advisory */ } } }
    return Math.max(t, hw);
  }

  // Re-verifies the STORED licence against the pinned registry and its own binding. Async (WebCrypto). Safe to call repeatedly.
  async function init() {
    if (!rec || !rec.license) { verified = { ok: true }; emit(); return view(); }
    if (rec.environment !== environment) { verified = { ok: false, code: "license-environment-mismatch" }; emit(); return view(); }
    const r = await verifyOfflineLicense({ token: rec.license.token, registry: getRegistry(), expected: { environment, ownerId: rec.binding.ownerId, deviceId: rec.binding.deviceId }, checkIssuedAt: false, subtle });
    verified = r.ok ? { ok: true } : { ok: false, code: r.code };
    if (r.ok && JSON.stringify(r.claims) !== JSON.stringify(rec.license.claims)) verified = { ok: false, code: "license-claims-invalid" };
    emit(); return view();
  }

  function view() {
    const common = { planId: "BAD_Q", priceThb: PRICE_THB, trialHours: TRIAL_HOURS, deviceCapacity: 1, ownerCloudSync: false, memberPortal: false, hardLock: false, localDataPolicy: "retained", licensePlan: null };
    const mk = (state, extra = {}) => Object.freeze({ ...common, state, restricted: ENFORCE_GAMEPLAY_GATE && RESTRICTED_STATES.includes(state), clockRollbackDetected: rolledBack, ...extra });
    if (loadError && !rec) return mk("invalid", { errorCode: loadError });
    if (!rec || !rec.license) return mk("not_activated", { serverStatus: rec ? rec.server.status : "ok" });
    const c = rec.license.claims;
    if (verified === null) return mk("checking", { licensePlan: c.planId });
    if (!verified.ok) return mk("invalid", { errorCode: verified.code, licensePlan: c.planId });
    const effective = touch();
    const base = { licensePlan: c.planId, lifetime: c.planId === "BAD_Q_LIFETIME", activatedAt: c.issuedAt, trialEndsAt: c.expiresAt === null ? null : new Date(c.expiresAt).toISOString() };
    if (rec.server.status === "device_revoked") return mk("device_released", base);
    if (rec.server.status === "revoked") return mk("revoked", base);
    if (c.expiresAt === null) return mk("active", { ...base, validUntil: null });
    const remaining = c.expiresAt - effective; // exact boundary: expiresAt itself is already expired
    return mk(remaining > 0 ? "trial" : "trial_expired", { ...base, trialRemainingMs: Math.max(0, remaining) });
  }

  // Stores a NEW signed licence obtained online. Verified first (active key only, issuedAt against SERVER time when known).
  async function activate({ token, ownerId, deviceId, serverTimeMs = null }) {
    const nowMs = isEpoch(serverTimeMs) ? serverTimeMs : now();
    const r = await verifyOfflineLicense({ token, registry: getRegistry(), expected: { environment, ownerId, deviceId }, nowMs, forActivation: true, subtle });
    if (!r.ok) throw new LocalLicenseError(r.code);
    if (rec && loadError == null && rec.license && verified && verified.ok && rec.binding.ownerId === ownerId) {
      const cur = rec.license.claims;
      // never downgrade a purchased lifetime licence to a trial, and never swap in a different trial (once per Owner; the original expiry is kept)
      if (cur.planId === "BAD_Q_LIFETIME" && r.claims.planId !== "BAD_Q_LIFETIME") return view();
      if (cur.planId === "BAD_Q_TRIAL" && r.claims.planId === "BAD_Q_TRIAL" && cur.grantId !== r.claims.grantId) return view();
    }
    const t = now(); const hw = Math.max(t, rec ? rec.clock.highWaterMs : 0);
    const next = { schemaVersion: LOCAL_LICENSE_SCHEMA, environment, binding: { ownerId, deviceId }, license: { token, kid: r.kid, claims: r.claims, storedAt: t },
      clock: { highWaterMs: isEpoch(serverTimeMs) ? Math.max(hw, serverTimeMs) : hw }, server: { status: "ok", at: t } };
    const previous = rec; rec = next; loadError = null;
    try { persist(); } catch (e) { rec = previous; throw e; }
    verified = { ok: true }; emit(); return view();
  }

  // Result of an ONLINE check. Only a definitive server answer changes state; a network failure never calls this.
  function applyServerStatus(kind) {
    if (!["ok", "revoked", "device_revoked"].includes(kind)) throw new LocalLicenseError("server-state-invalid");
    if (!rec) { rec = { schemaVersion: LOCAL_LICENSE_SCHEMA, environment, binding: null, license: null, clock: { highWaterMs: now() }, server: { status: kind, at: now() } }; }
    else { rec.server = { status: kind, at: now() }; }
    persist(); emit(); return view();
  }

  // Explicit recovery from an unreadable record (both copies corrupt): removes ONLY the two licence keys, never app data.
  // The Owner then re-fetches the SAME signed licence online (a trial keeps its original server expiry).
  function recoverFromCorruption() {
    for (const key of [LOCAL_LICENSE_KEY, LOCAL_LICENSE_MIRROR_KEY]) { try { storage.removeItem(key); } catch { /* best effort */ } }
    rec = null; loadError = null; verified = { ok: true }; emit(); return view();
  }

  const restricted = () => view().restricted === true;
  return Object.freeze({ view, init, activate, applyServerStatus, recoverFromCorruption, restricted, canStartGames: () => !restricted(),
    subscribe: (cb) => { subscribers.add(cb); return () => subscribers.delete(cb); },
    boundOwner: () => (rec && rec.binding ? rec.binding.ownerId : null), boundDevice: () => (rec && rec.binding ? rec.binding.deviceId : null),
    exportForTests: () => (rec ? JSON.parse(JSON.stringify(rec)) : null) });
}
