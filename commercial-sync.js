// BadQ Web Sync Phase 1/2 — isolated Commercial Identity and Badminton Group bridges.
//
// This module intentionally does not import Firestore and never reads Core business state. It uses a
// named Firebase app for Commercial Auth, then asks the trusted Commercial API for the canonical Owner.
// Local gameplay remains available when this module, Auth, or the API is unavailable.

import { createGroupLinkBridge, validateCloudGroupList } from "./group-link.js";
import { createPlayerSyncEngine, createIdbBindingStore } from "./player-sync.js";
import { parseLicenseProjection, deriveLicenseView } from "./license-plan.js";
import { createLocalLicense } from "./local-license.js";
import { createOfflineLicenseClient } from "./offline-license-client.js";
import { trustedKeysFor } from "./offline-trust-registry.js";
import { createOwnerSyncEngine, createIdbOwnerSyncStore } from "./owner-sync.js";

export const IDENTITY_LINK_STORAGE_KEY = "badq-commercial-identity-link-v1";
export const IDENTITY_LINK_SCHEMA_VERSION = 1;
export const COMMERCIAL_CONTRACT_VERSION = "1";
export const TEST_PROJECT_ID = "badq-commercial-test";
export const TEST_ENVIRONMENT = "TEST";
export const TEST_API_BASE_URL = "https://api-xommxsjila-as.a.run.app";
// ----------------------------------------------------------------------------------------------------------------------
// Environment profiles (Early Access). The Commercial endpoint, Firebase project and device-credential database are pinned PER
// ENVIRONMENT in this table, in code: a runtime config can only SELECT a profile, never supply an arbitrary endpoint. A profile
// whose projectId / apiBaseUrl are null is NOT PROVISIONED and refuses to start (fail-closed). PROD stays unprovisioned until the
// Owner + Commercial supply and review its real values. The active profile is chosen once per page load and can never be
// changed afterwards; links and credentials created under one environment are never reused under another.
// ----------------------------------------------------------------------------------------------------------------------
export const ENVIRONMENT_PROFILES = Object.freeze({
  TEST: Object.freeze({ environment: "TEST", projectId: TEST_PROJECT_ID, apiBaseUrl: TEST_API_BASE_URL, credentialDbName: "badq-commercial-device-credential-v1" }),
  PROD: Object.freeze({ environment: "PROD", projectId: null, apiBaseUrl: null, credentialDbName: "badq-commercial-device-credential-prod-v1" }),
});
export function isProfileProvisioned(profile) {
  return isRecord(profile) && typeof profile.environment === "string" && /^[A-Z]{2,12}$/.test(profile.environment) &&
    typeof profile.projectId === "string" && profile.projectId.length > 0 &&
    typeof profile.apiBaseUrl === "string" && /^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(profile.apiBaseUrl) &&
    typeof profile.credentialDbName === "string" && profile.credentialDbName.length > 0;
}
let activeProfile = ENVIRONMENT_PROFILES.TEST;
let activeProfileLocked = false;
export function getActiveEnvironmentProfile() { return activeProfile; }
export function activateEnvironmentProfile(profile) {
  if (!isProfileProvisioned(profile)) throw new IdentityBridgeError("environment-not-provisioned");
  if (activeProfileLocked && (profile.environment !== activeProfile.environment || profile.projectId !== activeProfile.projectId ||
      profile.apiBaseUrl !== activeProfile.apiBaseUrl)) throw new IdentityBridgeError("environment-switch-forbidden");
  activeProfile = profile; activeProfileLocked = true;
}
function isKnownForeignEnvironment(value) {
  // A stored link written under ANOTHER known environment/project than the active one (never silently dropped or rebound).
  return Object.values(ENVIRONMENT_PROFILES).some((p) => p.environment === value.environment &&
    (value.environment !== activeProfile.environment || value.projectId !== activeProfile.projectId)) &&
    typeof value.projectId === "string" && value.projectId.length > 0;
}
export function validateCommercialConfiguration(raw, profiles = ENVIRONMENT_PROFILES) {
  if (!isRecord(raw) || raw.enabled !== true) return { enabled: false };
  const profile = typeof raw.environment === "string" && Object.prototype.hasOwnProperty.call(profiles, raw.environment) ? profiles[raw.environment] : null;
  if (!profile) throw new IdentityBridgeError("environment-invalid");
  if (!isProfileProvisioned(profile)) throw new IdentityBridgeError("environment-not-provisioned");
  if (raw.apiBaseUrl !== profile.apiBaseUrl || !isRecord(raw.firebase) || raw.firebase.projectId !== profile.projectId) {
    throw new IdentityBridgeError("environment-mismatch");
  }
  for (const key of ["apiKey", "authDomain", "appId"]) {
    if (typeof raw.firebase[key] !== "string" || raw.firebase[key].trim().length === 0) throw new IdentityBridgeError("configuration-incomplete");
  }
  return {
    enabled: true, environment: profile.environment, profile, apiBaseUrl: profile.apiBaseUrl,
    firebase: { apiKey: raw.firebase.apiKey, authDomain: raw.firebase.authDomain, projectId: profile.projectId, appId: raw.firebase.appId },
  };
}

const FIREBASE_CDN_VERSION = "12.19.0";
const FIREBASE_APP_NAME = "badq-commercial-test-identity-bridge";

const VALIDATION_STATUSES = new Set([
  "unlinked", "validated", "stale", "offline", "signed_out", "account_mismatch",
]);

export class IdentityBridgeError extends Error {
  constructor(code, status = null) {
    super(code);
    this.name = "IdentityBridgeError";
    this.code = code;
    this.status = status;
  }
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isoNow(now) {
  return new Date(now()).toISOString();
}

function unlinkedState(errorCode = null) {
  return {
    schemaVersion: IDENTITY_LINK_SCHEMA_VERSION,
    linkStatus: "unlinked",
    validationStatus: "unlinked",
    environment: activeProfile.environment,
    projectId: activeProfile.projectId,
    contractVersion: null,
    ownerId: null,
    accountId: null,
    linkedAt: null,
    lastSuccessfulValidationAt: null,
    lastSuccessfulBootstrapServerTime: null,
    lastErrorCode: errorCode,
  };
}

function isStoredState(value, foreign = false) {
  if (!isRecord(value) || value.schemaVersion !== IDENTITY_LINK_SCHEMA_VERSION ||
      !["linked", "unlinked"].includes(value.linkStatus) ||
      !VALIDATION_STATUSES.has(value.validationStatus) ||
      !(foreign ? isKnownForeignEnvironment(value) : (value.environment === activeProfile.environment && value.projectId === activeProfile.projectId))) return false;
  if (value.linkStatus === "unlinked") {
    return value.ownerId === null && value.accountId === null && value.contractVersion === null;
  }
  return value.contractVersion === COMMERCIAL_CONTRACT_VERSION &&
    typeof value.ownerId === "string" && value.ownerId.length > 0 &&
    typeof value.accountId === "string" && value.accountId.length > 0 &&
    typeof value.linkedAt === "string" && Number.isFinite(Date.parse(value.linkedAt)) &&
    (value.lastSuccessfulValidationAt === null ||
      (typeof value.lastSuccessfulValidationAt === "string" && Number.isFinite(Date.parse(value.lastSuccessfulValidationAt)))) &&
    (value.lastSuccessfulBootstrapServerTime === null ||
      (typeof value.lastSuccessfulBootstrapServerTime === "string" && Number.isFinite(Date.parse(value.lastSuccessfulBootstrapServerTime))));
}

export function validateTestConfiguration(raw) {
  if (!isRecord(raw) || raw.enabled !== true) return { enabled: false };
  if (raw.environment !== TEST_ENVIRONMENT || raw.apiBaseUrl !== TEST_API_BASE_URL ||
      !isRecord(raw.firebase) || raw.firebase.projectId !== TEST_PROJECT_ID) {
    throw new IdentityBridgeError("environment-mismatch");
  }
  for (const key of ["apiKey", "authDomain", "appId"]) {
    if (typeof raw.firebase[key] !== "string" || raw.firebase[key].trim().length === 0) {
      throw new IdentityBridgeError("configuration-incomplete");
    }
  }
  return {
    enabled: true,
    environment: TEST_ENVIRONMENT,
    apiBaseUrl: TEST_API_BASE_URL,
    firebase: {
      apiKey: raw.firebase.apiKey,
      authDomain: raw.firebase.authDomain,
      projectId: TEST_PROJECT_ID,
      appId: raw.firebase.appId,
    },
  };
}

export function validateBootstrapContract(value, expectedUid) {
  if (!isRecord(value) || value.contractVersion !== COMMERCIAL_CONTRACT_VERSION ||
      value.environment !== activeProfile.environment || typeof expectedUid !== "string" || !expectedUid ||
      value.ownerId !== expectedUid || value.accountId !== expectedUid ||
      typeof value.serverTime !== "string" || !Number.isFinite(Date.parse(value.serverTime)) ||
      !Array.isArray(value.badmintonGroups)) {
    throw new IdentityBridgeError("contract-invalid");
  }
  return {
    contractVersion: COMMERCIAL_CONTRACT_VERSION,
    environment: activeProfile.environment,
    ownerId: value.ownerId,
    accountId: value.accountId,
    serverTime: value.serverTime,
    badmintonGroups: validateCloudGroupList(value.badmintonGroups),
  };
}

// ======================================================================================================================
// Early Access — server entitlement (Core side). Deliberately SEPARATE from authenticated identity and from device
// authorization: the three are independent inputs and a paid Owner Cloud capability needs all of them.
//
// CONTRACT: Commercial Early Access bootstrap (GET /v1/core/bootstrap, no data wrapper, contractVersion "1"). Every wire-format
// assumption lives in parseEntitlementProjection below (the ONLY place that reads entitlement field names). The authoritative
// authorization inputs are exactly:
//   plans.FULL / plans.ONLINE = { allowed: boolean, reason: string, validUntil: ISO|null }   (both REQUIRED)
//       allowed=true  => reason "active"       (validUntil null OR a UTC expiry; null is NOT, by itself, proof of lifetime)
//       allowed=false => reason one of no_entitlement | not_started | expired | revoked
//   entitlements = { coreAppAccess, cloudSyncAccess, <other *Access flags>: boolean, maxPeople: null|integer>=0 }
// Paid Owner Cloud = (FULL.allowed OR ONLINE.allowed) AND entitlements.cloudSyncAccess === true, and the projection must be
// CONSISTENT (cloudSyncAccess must equal "some plan is allowed"). planId, subscriptionStatus, any top-level validUntil, persisted
// flags, coreAppAccess, maxPeople and every other flag are NOT authorization and are never consulted. FULL grants no Member
// capability. Anything missing, malformed or contradictory is "invalid" and DENIES (fail-closed). Identity binding (contractVersion,
// environment, ownerId === accountId === authenticated UID) is enforced by validateBootstrapContract BEFORE this is reached.
//
// Policy:
//   * Only a grant verified by the server IN THIS SESSION (a successful bootstrap) can enable paid Cloud operations. A cached copy
//     is kept (own localStorage key, never bg-v11 / backup) purely so the UI can say what was last verified.
//   * Offline / network / 503 verification-unavailable => status "unverified": never treated as revoked or expired, nothing local is touched.
//   * none / expired / revoked / invalid => paid Cloud denied. Local gameplay, saved groups, players, history, images and
//     Backup/Restore never consult entitlement at all. Device enrollment never consults it either.
//   * Expiry is judged against SERVER time (skew-corrected); the device clock can only tighten, never extend, a grant.
// ======================================================================================================================
export const ENTITLEMENT_STORAGE_KEY = "badq-commercial-entitlement-v1";
export const ENTITLEMENT_SCHEMA_VERSION = 2;
export const ENTITLEMENT_CONTRACT = Object.freeze({ provisional: false, source: "commercial-early-access-bootstrap", planKeys: Object.freeze(["FULL", "ONLINE"]) });
const ENTITLEMENT_DENIED = new Set(["none", "expired", "revoked", "invalid"]);
const PLAN_DENIED_REASONS = new Set(["no_entitlement", "not_started", "expired", "revoked"]);
const isIsoInstant = (v) => typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));
const INVALID = Object.freeze({ ok: false, code: "entitlement-contract-invalid" });
const INCONSISTENT = Object.freeze({ ok: false, code: "entitlement-projection-inconsistent" });

function parsePlanDecision(entry, serverMs) {
  if (!isRecord(entry) || typeof entry.allowed !== "boolean" || typeof entry.reason !== "string" ||
      !(entry.validUntil === null || isIsoInstant(entry.validUntil))) return null;
  if (entry.allowed) {
    if (entry.reason !== "active") return null;
    // a plan that is already past its own end at server time is not allowed (and the server's flag is then contradictory => inconsistent)
    if (entry.validUntil !== null && Date.parse(entry.validUntil) <= serverMs) return { allowed: false, reason: "expired", validUntil: entry.validUntil, contradictory: true };
    return { allowed: true, reason: "active", validUntil: entry.validUntil, contradictory: false };
  }
  if (!PLAN_DENIED_REASONS.has(entry.reason)) return null;
  return { allowed: false, reason: entry.reason, validUntil: entry.validUntil, contradictory: false };
}

export function parseEntitlementProjection(body) {
  if (!isRecord(body) || !isRecord(body.plans) || !isRecord(body.entitlements)) return INVALID;
  const serverMs = Date.parse(body.serverTime);
  if (!Number.isFinite(serverMs)) return INVALID;
  const f = body.entitlements;
  // only cloudSyncAccess is read for authorization; every other *Access flag (and maxPeople) is shape-checked but never consulted
  if (typeof f.coreAppAccess !== "boolean" || typeof f.cloudSyncAccess !== "boolean" || !(f.maxPeople === null || (Number.isSafeInteger(f.maxPeople) && f.maxPeople >= 0)) ||
      Object.keys(f).some((k) => /Access$/.test(k) && typeof f[k] !== "boolean")) return INVALID;
  const plans = [];
  for (const key of ENTITLEMENT_CONTRACT.planKeys) {
    const decision = Object.prototype.hasOwnProperty.call(body.plans, key) ? parsePlanDecision(body.plans[key], serverMs) : null;
    if (!decision) return INVALID;
    plans.push(decision);
  }
  const anyAllowed = plans.some((p) => p.allowed);
  const evaluatedAt = body.serverTime;
  // the server's own capability flag must agree with its plan decisions; a disagreement in EITHER direction is contradictory authority
  if (anyAllowed !== f.cloudSyncAccess || plans.some((p) => p.contradictory)) return INCONSISTENT;
  if (anyAllowed) {
    const allowedPlans = plans.filter((p) => p.allowed);
    const validUntil = allowedPlans.some((p) => p.validUntil === null) ? null : allowedPlans.map((p) => p.validUntil).sort((x, y) => Date.parse(y) - Date.parse(x))[0];
    return { ok: true, evaluatedAt, decision: { allowed: true, status: "granted", reason: "active", validUntil } };
  }
  const reasons = plans.map((p) => p.reason);
  const status = reasons.includes("revoked") ? "revoked" : reasons.includes("expired") ? "expired" : "none";
  const reason = reasons.includes("revoked") ? "revoked" : reasons.includes("expired") ? "expired" : reasons.includes("not_started") ? "not_started" : "no_entitlement";
  return { ok: true, evaluatedAt, decision: { allowed: false, status, reason, validUntil: null } };
}

export function createEntitlementManager({ storage = null, now = Date.now, contract = ENTITLEMENT_CONTRACT } = {}) {
  const subscribers = new Set();
  let state = { status: "unverified", ownerId: null, environment: null, evaluatedAt: null, validUntil: null, reason: null, verifiedAt: null, skewMs: 0, fromServer: false, errorCode: null, lastVerified: null, license: null };
  const validCached = (v) => isRecord(v) && v.schemaVersion === ENTITLEMENT_SCHEMA_VERSION && typeof v.ownerId === "string" && v.ownerId.length > 0 &&
    v.environment === activeProfile.environment && ["granted", "none", "expired", "revoked"].includes(v.status) &&
    typeof v.verifiedAt === "string" && Number.isFinite(Date.parse(v.verifiedAt));
  try {
    const raw = storage && storage.getItem(ENTITLEMENT_STORAGE_KEY);
    if (raw) { const parsed = JSON.parse(raw); if (validCached(parsed)) state = { ...state, lastVerified: parsed }; }
  } catch { /* an unreadable cache is simply absent */ }
  const emit = () => { const snap = getState(); for (const cb of subscribers) { try { cb(snap); } catch { /* presentation only */ } } };
  function effectiveStatus() {
    if (state.status === "granted" && state.validUntil !== null && now() + state.skewMs >= Date.parse(state.validUntil)) return "expired";
    return state.status;
  }
  function getState() { return clone({ ...state, status: effectiveStatus() }); }
  function ingest(body, ownerId, serverTime) {
    if (typeof ownerId !== "string" || !ownerId) throw new IdentityBridgeError("bridge-dependency-invalid");
    let parsed = isRecord(body) && body.ownerId === ownerId && body.accountId === ownerId ? parseEntitlementProjection(body) : INVALID;
    // PENDING-CONTRACT: optional plan/licence block (BAD_Q / PLUS / PRO / FOUNDER_ALL_ACCESS). Malformed => the whole projection is invalid (fail closed).
    const lic = parsed.ok ? parseLicenseProjection(body) : { ok: true, license: null };
    if (!lic.ok) parsed = INVALID;
    const skewMs = Number.isFinite(Date.parse(serverTime)) ? Date.parse(serverTime) - now() : 0;
    if (!parsed.ok) {
      state = { ...state, status: "invalid", ownerId, environment: activeProfile.environment, evaluatedAt: null, validUntil: null, reason: null, skewMs, fromServer: true, errorCode: lic.ok ? parsed.code : "license-contract-invalid", license: null };
    } else {
      const verifiedAt = new Date(now()).toISOString();
      const d = parsed.decision;
      state = { ...state, status: d.status, ownerId, environment: activeProfile.environment, evaluatedAt: parsed.evaluatedAt, validUntil: d.validUntil, reason: d.reason, verifiedAt, skewMs, fromServer: true, errorCode: null, license: lic.license };
      const record = { schemaVersion: ENTITLEMENT_SCHEMA_VERSION, ownerId, environment: activeProfile.environment, status: d.status, evaluatedAt: parsed.evaluatedAt, validUntil: d.validUntil, reason: d.reason, verifiedAt, planId: lic.license ? lic.license.planId : null };
      state.lastVerified = record;
      try { if (storage) storage.setItem(ENTITLEMENT_STORAGE_KEY, JSON.stringify(record)); } catch { /* retention is best effort; the live decision does not depend on it */ }
    }
    emit();
  }
  // Could not verify right now (offline, network, auth/device failure before the entitlement was read). NEVER a revocation.
  function markUnverified(code) {
    state = { ...state, status: "unverified", fromServer: false, errorCode: typeof code === "string" ? code : null };
    emit();
  }
  // The Commercial API itself refused a Cloud call for entitlement reasons: deny until the next verified bootstrap says otherwise.
  function markServerDenied() {
    state = { ...state, status: state.status === "revoked" || state.status === "expired" ? state.status : "none", fromServer: true, reason: "server-denied" };
    emit();
  }
  // Sign-out / Owner change: forget the live decision (never the stored last-verified copy of the SAME Owner).
  function reset() {
    state = { ...state, status: "unverified", ownerId: null, evaluatedAt: null, validUntil: null, reason: null, verifiedAt: null, skewMs: 0, fromServer: false, errorCode: null, license: null };
    emit();
  }
  function isCloudAllowed(ownerId) {
    return typeof ownerId === "string" && ownerId.length > 0 && state.ownerId === ownerId && state.fromServer === true && effectiveStatus() === "granted";
  }
  return Object.freeze({
    getState, ingest, markUnverified, markServerDenied, reset, isCloudAllowed, getLicense: () => (state.license ? clone(state.license) : null), nowSkewed: () => now() + state.skewMs,
    isDeniedStatus: (status) => ENTITLEMENT_DENIED.has(status),
    subscribe(cb) { if (typeof cb !== "function") throw new IdentityBridgeError("subscriber-invalid"); subscribers.add(cb); try { cb(getState()); } catch { /* isolate */ } return () => subscribers.delete(cb); },
  });
}

function normalizeFailure(error, online) {
  if (error instanceof IdentityBridgeError) return error;
  if (online && online() === false) return new IdentityBridgeError("offline");
  return new IdentityBridgeError("verification-unavailable");
}

export function createIdentityBridge({
  storage,
  getCurrentUser,
  getFreshIdToken,
  fetchBootstrap,
  deviceGate = null,
  entitlements = null,
  now = Date.now,
  online = () => true,
}) {
  if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function" ||
      typeof getCurrentUser !== "function" || typeof getFreshIdToken !== "function" ||
      typeof fetchBootstrap !== "function") {
    throw new IdentityBridgeError("bridge-dependency-invalid");
  }

  let state;
  try {
    const raw = storage.getItem(IDENTITY_LINK_STORAGE_KEY);
    if (raw === null) state = unlinkedState();
    else {
      const parsed = JSON.parse(raw);
      if (isStoredState(parsed)) state = parsed;
      else if (isStoredState(parsed, true) && parsed.linkStatus === "linked") {
        // A link written under ANOTHER environment/project: keep it untouched and refuse every Cloud step (no silent unlink / rebind).
        state = { ...parsed, validationStatus: "account_mismatch", lastErrorCode: "environment-mismatch" };
      } else state = unlinkedState("stored-link-invalid");
    }
  } catch {
    state = unlinkedState("storage-unavailable");
  }

  // A prior browser process cannot authorize this process. Every startup begins stale until a fresh
  // token and bootstrap response are verified. The last successful timestamps remain available for UI.
  if (state.linkStatus === "linked" && state.lastErrorCode !== "environment-mismatch") {
    state = { ...state, validationStatus: "stale", lastErrorCode: "validation-required" };
  }

  let runtimeAuthenticatedUid = null;
  const subscribers = new Set();

  function emit() {
    const snapshot = clone(state);
    for (const callback of subscribers) {
      try { callback(snapshot); } catch { /* UI listeners cannot change identity-validation outcome. */ }
    }
  }

  function persist(next) {
    try {
      storage.setItem(IDENTITY_LINK_STORAGE_KEY, JSON.stringify(next));
    } catch {
      throw new IdentityBridgeError("storage-unavailable");
    }
    state = next;
    emit();
    return clone(state);
  }

  function transitionFailure(code, validationStatus = "stale") {
    const next = state.linkStatus === "linked"
      ? { ...state, validationStatus, lastErrorCode: code }
      : { ...unlinkedState(code), validationStatus: validationStatus === "signed_out" ? "unlinked" : validationStatus };
    runtimeAuthenticatedUid = validationStatus === "account_mismatch" ? runtimeAuthenticatedUid : null;
    return persist(next);
  }

  const linkEnvironmentMismatch = () => state.linkStatus === "linked" &&
    (state.environment !== activeProfile.environment || state.projectId !== activeProfile.projectId);

  async function performValidation() {
    const user = await getCurrentUser();
    if (!user || typeof user.uid !== "string" || !user.uid) {
      transitionFailure("session-unavailable", "signed_out");
      throw new IdentityBridgeError("session-unavailable");
    }
    runtimeAuthenticatedUid = user.uid;
    if (linkEnvironmentMismatch()) {
      transitionFailure("environment-mismatch", "account_mismatch");
      throw new IdentityBridgeError("environment-mismatch");
    }
    if (state.linkStatus === "linked" && state.ownerId !== user.uid) {
      transitionFailure("account-mismatch", "account_mismatch");
      throw new IdentityBridgeError("account-mismatch");
    }
    if (user.emailVerified !== true) {
      transitionFailure("email-not-verified", "stale");
      throw new IdentityBridgeError("email-not-verified");
    }

    let entitlementRead = false;
    try {
      const proof = await getFreshIdToken(user);
      if (!isRecord(proof) || typeof proof.token !== "string" || !proof.token ||
          proof.uid !== user.uid || proof.emailVerified !== true) {
        throw new IdentityBridgeError("identity-proof-invalid");
      }
      const response = await fetchBootstrap(proof.token, user.uid);
      if (!isRecord(response) || !Number.isInteger(response.status)) {
        throw new IdentityBridgeError("verification-unavailable");
      }
      if (response.status !== 200) {
        const code = typeof response.body?.error?.code === "string" ? response.body.error.code :
          response.status === 401 ? "unauthenticated" :
          response.status === 403 ? "email-verification-required" : "verification-unavailable";
        throw new IdentityBridgeError(code, response.status);
      }
      const verified = validateBootstrapContract(response.body, user.uid);
      if (state.linkStatus === "linked" &&
          (state.ownerId !== verified.ownerId || state.accountId !== verified.accountId)) {
        throw new IdentityBridgeError("account-mismatch");
      }
      // Early Access: the server entitlement is read from the verified bootstrap and kept SEPARATE from identity and from device
      // authorization (it is recorded even when the device gate below then refuses).
      if (entitlements) { entitlements.ingest(response.body, verified.ownerId, verified.serverTime); entitlementRead = true; }
      // Phase 5A: protected Cloud capability additionally requires THIS installation to be an authorized device of the
      // verified Owner (server-confirmed in the bootstrap `device` block). Identity alone never enables Cloud.
      if (typeof deviceGate === "function") await deviceGate(user, response.body);
      const validatedAt = isoNow(now);
      return persist({
        schemaVersion: IDENTITY_LINK_SCHEMA_VERSION,
        linkStatus: "linked",
        validationStatus: "validated",
        environment: activeProfile.environment,
        projectId: activeProfile.projectId,
        contractVersion: COMMERCIAL_CONTRACT_VERSION,
        ownerId: verified.ownerId,
        accountId: verified.accountId,
        linkedAt: state.linkStatus === "linked" ? state.linkedAt : validatedAt,
        lastSuccessfulValidationAt: validatedAt,
        lastSuccessfulBootstrapServerTime: verified.serverTime,
        lastErrorCode: null,
      });
    } catch (error) {
      const failure = normalizeFailure(error, online);
      if (entitlements && !entitlementRead) entitlements.markUnverified(failure.code);
      transitionFailure(failure.code, failure.code === "offline" ? "offline" :
        failure.code === "account-mismatch" ? "account_mismatch" : "stale");
      throw failure;
    }
  }

  // Phase 3 Item D remediation — identity-validation serialization boundary.
  // Every identity validation (auth-state callback, authorizedRequest, group listing, exported/manual
  // validation, reconnect recovery) calls validateLink(), so serializing here guarantees that two
  // validations never run concurrently and that a stale in-flight (e.g. offline) validation can never
  // finish AFTER, and overwrite, a newer one. A caller arriving during a run waits for that run to settle and
  // then shares ONE trailing run that starts fresh (it never joins the stale run's outcome); several callers
  // arriving during the same run coalesce into that single trailing run. There are no timers or retries.
  let validationInFlight = null;
  let validationQueued = null;
  let validationActive = false;

  function startValidation() {
    validationActive = true;
    const run = performValidation();
    validationInFlight = run;
    const settle = () => {
      validationActive = false;
      if (validationInFlight === run && validationQueued === null) validationInFlight = null;
    };
    run.then(settle, settle);
    return run;
  }

  function validateLink() {
    if (validationInFlight === null) return startValidation();
    if (validationQueued === null) {
      validationQueued = validationInFlight.then(() => undefined, () => undefined).then(() => {
        validationQueued = null;
        return startValidation();
      });
    }
    return validationQueued;
  }

  async function handleAuthState(user) {
    runtimeAuthenticatedUid = user && typeof user.uid === "string" ? user.uid : null;
    if (!runtimeAuthenticatedUid) {
      if (entitlements) entitlements.reset();
      return transitionFailure("session-unavailable", "signed_out");
    }
    if (linkEnvironmentMismatch()) {
      return transitionFailure("environment-mismatch", "account_mismatch");
    }
    if (state.linkStatus === "linked" && state.ownerId !== runtimeAuthenticatedUid) {
      return transitionFailure("account-mismatch", "account_mismatch");
    }
    if (user.emailVerified !== true) {
      return transitionFailure("email-not-verified", "stale");
    }
    return validateLink();
  }

  // Phase 5A: a protected route answered "device-authorization-required" (revoked / unknown device or bad proof). Fail closed
  // immediately for every Cloud capability without touching any local data or the stored link ownership.
  function reportDeviceFailure(code) {
    if (typeof code !== "string" || !code) throw new IdentityBridgeError("bridge-dependency-invalid");
    return transitionFailure(code, "stale");
  }

  function unlinkIdentity(options = {}) {
    if (options.explicit !== true) throw new IdentityBridgeError("explicit-unlink-required");
    runtimeAuthenticatedUid = null;
    if (entitlements) entitlements.reset();
    return persist(unlinkedState());
  }

  return Object.freeze({
    getState: () => clone(state),
    validateLink,
    isValidationPending: () => validationActive || validationQueued !== null,
    handleAuthState,
    reportDeviceFailure,
    unlinkIdentity,
    isCloudIdentityValidated: () => state.linkStatus === "linked" &&
      state.validationStatus === "validated" && runtimeAuthenticatedUid === state.ownerId,
    subscribe(callback) {
      if (typeof callback !== "function") throw new IdentityBridgeError("subscriber-invalid");
      subscribers.add(callback);
      try { callback(clone(state)); } catch { /* isolate presentation subscribers */ }
      return () => subscribers.delete(callback);
    },
  });
}

// ======================================================================================================================
// Phase 5A — Commercial Owner device credential + device authorization (Core side of the frozen Commercial contract,
// docs/WEBSYNC_PHASE5A_COMMERCIAL_IDENTITY.md). This layer is deliberately separate from `bg-v11`, the Journal, Backup /
// Restore and every localStorage key the Core app owns:
//   * the 256-bit device key lives ONLY in its own IndexedDB database (DEVICE_CREDENTIAL_DB_NAME), which no Backup /
//     Restore / Journal / diagnostics path ever enumerates or serializes;
//   * the raw key is generated with crypto.getRandomValues, sent ONLY as the `deviceKey` field of the one explicit
//     enroll request body and as the `X-BadQ-Device-Key` header of protected Core API calls — never in a URL, a log,
//     the UI state, an error, or any exported file;
//   * a device is enrolled only after an explicit Owner confirmation; nothing here ever enrolls, replaces, revokes or
//     reauthorizes a device on its own.
// ======================================================================================================================
export const DEVICE_CREDENTIAL_DB_NAME = "badq-commercial-device-credential-v1";
const DEVICE_CREDENTIAL_STORE = "credentials";
const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const DEVICE_KEY_PATTERN = /^[a-f0-9]{64}$/;
// Default only (legacy Early Access). The real capacity comes from the PLAN (1 BAD_Q / 2 PLUS / 3 PRO / 3 FOUNDER) as reported by the server
// device list; the manager never assumes a fixed number once a list or plan capacity is known.
export const MAX_AUTHORIZED_DEVICES = 2;
const MAX_SANE_DEVICE_LIMIT = 16;
const DEVICE_PLATFORMS = new Set(["web", "android", "ios"]);

function randomHex(randomBytes, byteLength) {
  const bytes = randomBytes(byteLength);
  if (!bytes || bytes.length !== byteLength) throw new IdentityBridgeError("device-credential-unavailable");
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Browser backend: a dedicated IndexedDB database with a single object store. `putIfAbsent` is one readwrite transaction,
// so two tabs can never create two different installation ids / owner keys.
export function createIdbCredentialBackend(indexedDBFactory, dbName = DEVICE_CREDENTIAL_DB_NAME) {
  if (!indexedDBFactory || typeof indexedDBFactory.open !== "function") throw new IdentityBridgeError("device-credential-unavailable");
  let opening = null;
  const open = () => {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const request = indexedDBFactory.open(dbName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(DEVICE_CREDENTIAL_STORE)) request.result.createObjectStore(DEVICE_CREDENTIAL_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => { opening = null; reject(new IdentityBridgeError("device-credential-unavailable")); };
      request.onblocked = () => { opening = null; reject(new IdentityBridgeError("device-credential-unavailable")); };
    });
    return opening;
  };
  const run = async (mode, work) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      let result;
      let tx;
      try { tx = db.transaction(DEVICE_CREDENTIAL_STORE, mode); } catch { reject(new IdentityBridgeError("device-credential-unavailable")); return; }
      const store = tx.objectStore(DEVICE_CREDENTIAL_STORE);
      work(store, (value) => { result = value; });
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(new IdentityBridgeError("device-credential-unavailable"));
      tx.onabort = () => reject(new IdentityBridgeError("device-credential-unavailable"));
    });
  };
  return Object.freeze({
    get: (key) => run("readonly", (store, set) => { store.get(key).onsuccess = (event) => set(event.target.result ?? null); }),
    delete: (key) => run("readwrite", (store) => { store.delete(key); }),
    putIfAbsent: (key, value) => run("readwrite", (store, set) => {
      store.get(key).onsuccess = (event) => {
        const existing = event.target.result;
        if (existing !== undefined && existing !== null) { set(existing); return; }
        store.put(value, key);
        set(value);
      };
    }),
  });
}

export function createDeviceCredentialStore({ backend, randomBytes, now = Date.now }) {
  if (!backend || typeof backend.get !== "function" || typeof backend.putIfAbsent !== "function" ||
      typeof backend.delete !== "function" || typeof randomBytes !== "function") {
    throw new IdentityBridgeError("device-credential-unavailable");
  }
  const ownerKey = (uid) => {
    if (typeof uid !== "string" || !uid) throw new IdentityBridgeError("session-unavailable");
    return `owner:${uid}`;
  };
  const validInstallation = (value) => isRecord(value) && typeof value.deviceId === "string" && DEVICE_ID_PATTERN.test(value.deviceId);
  const validCredential = (value) => validInstallation(value) && typeof value.deviceKey === "string" && DEVICE_KEY_PATTERN.test(value.deviceKey);
  return Object.freeze({
    // The installation id is created at most once, only when an Owner explicitly enrolls, and is never regenerated.
    async ensureInstallation() {
      const created = { deviceId: `bq-${randomHex(randomBytes, 16)}`, createdAt: new Date(now()).toISOString() };
      const stored = await backend.putIfAbsent("installation", created);
      if (!validInstallation(stored)) throw new IdentityBridgeError("device-credential-unavailable");
      return stored.deviceId;
    },
    async hasInstallation() { return validInstallation(await backend.get("installation")); },
    // Returns the proof for this Owner, or null. A malformed record fails closed (never silently repaired / replaced).
    async getCredential(uid) {
      const stored = await backend.get(ownerKey(uid));
      if (stored === null || stored === undefined) return null;
      if (!validCredential(stored)) throw new IdentityBridgeError("device-credential-unavailable");
      return { deviceId: stored.deviceId, deviceKey: stored.deviceKey };
    },
    // Idempotent: an existing credential for this Owner is returned unchanged (same id AND same key), so an enrollment
    // retry after a lost response is accepted by the server's idempotent path. Returns {created, deviceId, deviceKey}.
    async createCredential(uid) {
      const key = ownerKey(uid);
      const existing = await this.getCredential(uid);
      if (existing) return { created: false, ...existing };
      const deviceId = await this.ensureInstallation();
      const candidate = { deviceId, deviceKey: randomHex(randomBytes, 32), createdAt: new Date(now()).toISOString() };
      const stored = await backend.putIfAbsent(key, candidate);
      if (!validCredential(stored)) throw new IdentityBridgeError("device-credential-unavailable");
      return { created: stored === candidate || stored.deviceKey === candidate.deviceKey, deviceId: stored.deviceId, deviceKey: stored.deviceKey };
    },
    async deleteCredential(uid) { await backend.delete(ownerKey(uid)); },
    // Legacy protocol upgrade (explicit, confirmed): a FRESH id/key staged under "pending:<uid>" - never over the live credential - and
    // idempotent (a retry after a lost response reuses the same staged pair). promotePendingCredential() runs only after the server
    // accepted it; every step is idempotent so an interrupted promotion is simply repeated.
    async createPendingCredential(uid) {
      const key = `pending:${ownerKey(uid)}`;
      const existing = await backend.get(key);
      if (existing !== null && existing !== undefined) { if (!validCredential(existing)) throw new IdentityBridgeError("device-credential-unavailable"); return { created: false, deviceId: existing.deviceId, deviceKey: existing.deviceKey }; }
      const candidate = { deviceId: `bq-${randomHex(randomBytes, 16)}`, deviceKey: randomHex(randomBytes, 32), createdAt: new Date(now()).toISOString() };
      const stored = await backend.putIfAbsent(key, candidate);
      if (!validCredential(stored)) throw new IdentityBridgeError("device-credential-unavailable");
      return { created: true, deviceId: stored.deviceId, deviceKey: stored.deviceKey };
    },
    async promotePendingCredential(uid) {
      const key = `pending:${ownerKey(uid)}`;
      const pending = await backend.get(key);
      if (pending === null || pending === undefined) return false;
      if (!validCredential(pending)) throw new IdentityBridgeError("device-credential-unavailable");
      await backend.delete(ownerKey(uid));
      await backend.putIfAbsent(ownerKey(uid), pending);
      await backend.delete("installation");
      await backend.putIfAbsent("installation", { deviceId: pending.deviceId, createdAt: pending.createdAt });
      await backend.delete(key);
      return true;
    },
    async hasPendingCredential(uid) { const v = await backend.get(`pending:${ownerKey(uid)}`); return v !== null && v !== undefined; },
  });
}

const DEVICE_LIMIT_CODES = new Set(["DEVICE_LIMIT_REACHED"]);
const DEVICE_AUTH_FAILURE_CODES = new Set(["device-authorization-required", "device-not-authorized", "device-revoked"]);

export function validateDeviceListContract(value) {
  if (!isRecord(value) || value.contractVersion !== COMMERCIAL_CONTRACT_VERSION || value.environment !== activeProfile.environment ||
      !(Number.isSafeInteger(value.maxAuthorizedDevices) && value.maxAuthorizedDevices >= 1 && value.maxAuthorizedDevices <= MAX_SANE_DEVICE_LIMIT) || !Array.isArray(value.devices) || value.devices.length > 64) {
    throw new IdentityBridgeError("device-contract-invalid");
  }
  return value.devices.map((device) => {
    if (!isRecord(device) || typeof device.id !== "string" || !DEVICE_ID_PATTERN.test(device.id) ||
        !["authorized", "revoked"].includes(device.status) ||
        !(device.label === null || (typeof device.label === "string" && device.label.length <= 80)) ||
        !(device.platform === null || DEVICE_PLATFORMS.has(device.platform)) ||
        !(device.lastSeenAt === null || (typeof device.lastSeenAt === "string" && Number.isFinite(Date.parse(device.lastSeenAt))))) {
      throw new IdentityBridgeError("device-contract-invalid");
    }
    return { id: device.id, status: device.status, label: device.label, platform: device.platform, lastSeenAt: device.lastSeenAt };
  });
}

// Owner-facing device authorization state machine. Raw device ids never leave this closure (the UI only gets opaque `ref`s).
export function createDeviceManager({
  credentialStore,
  getUser,
  ownerRequest,
  getIdentityState,
  revalidateIdentity,
  reportDeviceFailure,
  reauthenticate,
  online = () => true,
}) {
  if (!credentialStore || typeof getUser !== "function" || typeof ownerRequest !== "function" ||
      typeof getIdentityState !== "function" || typeof revalidateIdentity !== "function" ||
      typeof reportDeviceFailure !== "function") throw new IdentityBridgeError("bridge-dependency-invalid");
  let currentMax = MAX_AUTHORIZED_DEVICES;
  let state = { status: "signed_out", errorCode: null, maxAuthorizedDevices: MAX_AUTHORIZED_DEVICES };
  let refs = new Map();
  let classifyToken = 0;
  const subscribers = new Set();
  const snapshot = () => clone(state);
  // v1.15.4 (reauth status fix): "reauth_required" is shared by two DIFFERENT pending intents - registering this device ("enroll") and
  // re-authorizing an already-registered device ("reauthorize"). The presentation must not show new-device registration wording for
  // the latter, so the intent travels with the state (only while status === "reauth_required"; absent otherwise).
  let pendingReauthorize = null; // { uid, deviceId } - the explicit reauthorization the Owner confirmed, waiting for recent authentication
  let reauthRun = 0;
  function set(status, errorCode = null, reauthIntent = null, reauthCurrent = null) {
    state = { status, errorCode, maxAuthorizedDevices: currentMax, ...(status === "reauth_required" && reauthIntent ? { reauthIntent } : {}), ...(status === "reauth_required" && reauthIntent === "reauthorize" && reauthCurrent !== null ? { reauthCurrent: reauthCurrent === true } : {}) };
    for (const callback of subscribers) { try { callback(snapshot()); } catch { /* presentation only */ } }
  }
  // Capacity is plan-driven: learned from every validated server device list, or hinted by the plan view before any list exists.
  function noteMax(n) {
    if (!(Number.isSafeInteger(n) && n >= 1 && n <= MAX_SANE_DEVICE_LIMIT) || n === currentMax) return;
    currentMax = n; state = { ...state, maxAuthorizedDevices: n };
    for (const callback of subscribers) { try { callback(snapshot()); } catch { /* presentation only */ } }
  }
  function parseDeviceList(raw) { const devices = validateDeviceListContract(raw); noteMax(raw.maxAuthorizedDevices); return devices; }
  const networkStatus = (code) => (code === "offline" ? "offline" : "unavailable");
  const isNetworkCode = (code) => code === "offline" || code === "verification-unavailable";

  async function classifyAuthFailure(uid) {
    const token = ++classifyToken;
    let credential = null;
    try { credential = await credentialStore.getCredential(uid); } catch { if (token === classifyToken) set("unavailable", "device-credential-unavailable"); return; }
    if (token !== classifyToken) return;
    if (!credential) { set("needs_enrollment", "device-enrollment-required"); return; }
    try {
      const devices = parseDeviceList(await ownerRequest("/v1/owner/devices"));
      if (token !== classifyToken) return;
      const mine = devices.find((device) => device.id === credential.deviceId);
      // Server-authoritative classification of "this installation is not authorized":
      //  - the Owner's server list has NO record of this installation's id (e.g. a local credential left behind by an enrollment
      //    that never completed): the device is simply UNREGISTERED -> offer the explicit, confirmed registration again. The local
      //    credential is kept and reused; nothing is mutated here.
      //  - a server record exists and is revoked: stays revoked (registration must never be a way around a revoke).
      //  - a server record exists, is not revoked, yet the proof was rejected: fail closed (no automatic re-enrollment).
      if (!mine) set("needs_enrollment", "device-enrollment-required");
      else if (mine.status === "revoked") set("revoked", "device-revoked");
      else set("unauthorized", "device-authorization-required");
    } catch (error) {
      if (token !== classifyToken) return;
      // A network failure is NEVER interpreted as a revoked / deleted identity.
      const code = error && error.code ? error.code : "verification-unavailable";
      if (isNetworkCode(code)) set(networkStatus(code), code); else set("unavailable", code);
    }
  }

  // Driven by the identity bridge: every identity validation outcome re-derives the device state.
  function onIdentityState(identity) {
    const user = getUser();
    // A pending reauthorization belongs to the Owner who confirmed it: sign-out / another Owner drops it (stale callbacks are invalidated).
    if (pendingReauthorize && (!user || user.uid !== pendingReauthorize.uid)) { pendingReauthorize = null; reauthRun += 1; }
    if (!user || typeof user.uid !== "string" || !user.uid) { classifyToken += 1; set("signed_out"); return; }
    if (!isRecord(identity)) return;
    if (identity.validationStatus === "validated") { classifyToken += 1; pendingReauthorize = null; set("authorized"); return; }
    if (identity.validationStatus === "account_mismatch") { classifyToken += 1; set("account_mismatch", "account-mismatch"); return; }
    if (user.emailVerified !== true) { classifyToken += 1; set("email_unverified", "email-not-verified"); return; }
    // An unrelated, still-unvalidated identity event (the device is exactly as unauthorized as before) must not tear down the recovery
    // the Owner is in the middle of: the pending reauthorization stays until it completes, is cancelled, or the Owner changes.
    if (pendingReauthorize && state.status === "reauth_required" && state.reauthIntent === "reauthorize") return;
    const code = identity.lastErrorCode;
    if (code === "device-enrollment-required") { classifyToken += 1; set("needs_enrollment", code); return; }
    if (code === "device-authorization-required" || code === "device-not-authorized") { classifyAuthFailure(user.uid); return; }
    if (code === "device-revoked") { classifyToken += 1; set("revoked", code); return; }
    if (identity.validationStatus === "offline" || code === "offline") { classifyToken += 1; set("offline", "offline"); return; }
    if (code === "verification-unavailable" || code === "device-credential-unavailable") { classifyToken += 1; set("unavailable", code); return; }
    // Any other non-validated outcome (contract / environment mismatch, unlinked, unknown failure) fails closed: the previous
    // "authorized" state must never survive a validation that did not succeed.
    if (!code) { classifyToken += 1; set("unknown"); return; }
    classifyToken += 1; set("unavailable", code);
  }

  function requireUser() {
    const user = getUser();
    if (!user || typeof user.uid !== "string" || !user.uid) throw new IdentityBridgeError("session-unavailable");
    if (user.emailVerified !== true) throw new IdentityBridgeError("email-not-verified");
    return user;
  }
  function requireOnline() { if (online() === false) throw new IdentityBridgeError("offline"); }
  function requireNoMismatch() {
    const identity = getIdentityState();
    if (isRecord(identity) && identity.validationStatus === "account_mismatch") throw new IdentityBridgeError("account-mismatch");
  }

  // v1.15.4 (P3): enrollment is single-flight PER OWNER. A second call for the same Owner while one is pending returns the SAME
  // promise (no second request, no second credential); a call for a different Owner while one is pending is refused. It can be
  // cancelled with `signal` until the request has actually been sent (`onSend` fires from `beforeSend`, after the fresh proof resolved, immediately before fetch); once sent it
  // cannot be recalled and runs to completion. `expectedUid` pins the call to the Owner who confirmed the registration.
  let enrollInFlight = null; // { uid, promise }
  function enroll(options = {}) {
    const { confirm, expectedUid } = options;
    if (confirm !== true) return Promise.reject(new IdentityBridgeError("device-confirmation-required"));
    let user;
    try { user = requireUser(); } catch (error) { return Promise.reject(error); }
    if (typeof expectedUid === "string" && expectedUid !== user.uid) return Promise.reject(new IdentityBridgeError("session-changed"));
    if (enrollInFlight) {
      if (enrollInFlight.uid === user.uid) return enrollInFlight.promise;
      return Promise.reject(new IdentityBridgeError("enrollment-in-progress"));
    }
    const entry = { uid: user.uid, promise: null };
    entry.promise = enrollOnce(options, user.uid).finally(() => { if (enrollInFlight === entry) enrollInFlight = null; });
    enrollInFlight = entry;
    return entry.promise;
  }

  async function enrollOnce({ label, platform = "web", signal, onSend }, uid) {
    const sessionIntact = () => { const current = getUser(); return !!current && current.uid === uid; };
    const cancelled = () => !!(signal && signal.aborted);
    requireNoMismatch(); requireOnline();
    const trimmed = typeof label === "string" ? label.trim() : "";
    if (trimmed.length < 1 || trimmed.length > 80 || !DEVICE_PLATFORMS.has(platform)) throw new IdentityBridgeError("invalid-device-request");
    if (cancelled()) throw new IdentityBridgeError("enrollment-cancelled");
    const previous = state;
    set("enrolling");
    const restore = () => set(previous.status, previous.errorCode);
    let credential;
    try { credential = await credentialStore.createCredential(uid); }
    catch (error) { set("unavailable", "device-credential-unavailable"); throw error; }
    // Last checkpoint before the request leaves the device: dismissed/cancelled or a different Owner signed in => nothing is sent.
    if (cancelled()) { restore(); throw new IdentityBridgeError("enrollment-cancelled"); }
    if (!sessionIntact()) { restore(); throw new IdentityBridgeError("session-changed"); }
    try {
      await ownerRequest("/v1/owner/devices/enroll", {
        method: "POST",
        expectedUid: uid,
        // Runs after getFreshProof() resolved, right before fetch(): cancellation and the pinned Owner are re-checked here, and
        // onSend fires only now (the POST can no longer be recalled once this returns).
        beforeSend: () => {
          if (cancelled()) throw new IdentityBridgeError("enrollment-cancelled");
          if (!sessionIntact()) throw new IdentityBridgeError("session-changed");
          if (typeof onSend === "function") { try { onSend(); } catch { /* presentation only */ } }
        },
        body: { deviceId: credential.deviceId, label: trimmed, platform, deviceKey: credential.deviceKey, confirmRegistration: true },
      });
    } catch (error) {
      const code = error && error.code ? error.code : "verification-unavailable";
      if (code === "session-changed" || code === "enrollment-cancelled") { restore(); throw error; }
      if (DEVICE_LIMIT_CODES.has(code)) {
        // Never replace/auto-revoke another device and never keep generating identities: drop only the key created for this
        // attempt; the installation id is kept so a later explicit retry reuses it.
        if (credential.created) await credentialStore.deleteCredential(uid).catch(() => {});
        // The number shown to the Owner must be the SERVER'S plan limit (1 / 2 / 3 ...), never a default: learn it from the device list (best effort).
        try { parseDeviceList(await ownerRequest("/v1/owner/devices", { expectedUid: uid })); } catch { /* keep the last known limit */ }
        set("limit_reached", code);
      } else if (code === "device-policy-migration-required") {
        if (credential.created) await credentialStore.deleteCredential(uid).catch(() => {});
        set("migration_required", code);
      } else if (code === "device-revoked") set("revoked", code);
      else if (code === "device-credential-invalid" || code === "device-authorization-required") set("unauthorized", code);
      else if (code === "recent-authentication-required") set("reauth_required", code, "enroll");
      else if (isNetworkCode(code)) set(networkStatus(code), code);
      else if (/environment|contract/.test(code)) set("unavailable", code); // contract / environment problems stay fail-closed
      else set("needs_enrollment", code); // the server rejected this attempt: the local credential is kept and an explicit retry stays possible (never marked revoked)
      throw error;
    }
    // The registration is done server-side. Only the Owner who started it may drive local state from the outcome.
    if (!sessionIntact()) throw new IdentityBridgeError("session-changed");
    try { await revalidateIdentity(); } catch { /* the identity bridge persisted the fail-closed outcome; state derives from it */ }
    onIdentityState(getIdentityState());
    return snapshot();
  }

  async function listDevices() {
    const user = requireUser(); requireNoMismatch(); requireOnline();
    const devices = parseDeviceList(await ownerRequest("/v1/owner/devices"));
    const credential = await credentialStore.getCredential(user.uid).catch(() => null);
    refs = new Map();
    return devices.map((device, index) => {
      const ref = `d${index + 1}`;
      refs.set(ref, device.id);
      return {
        ref,
        status: device.status,
        label: device.label,
        platform: device.platform,
        lastSeenAt: device.lastSeenAt,
        isCurrent: !!credential && credential.deviceId === device.id,
      };
    }).sort((left, right) => Number(right.isCurrent) - Number(left.isCurrent));
  }

  async function currentDeviceId(uid) {
    try { return (await credentialStore.getCredential(uid))?.deviceId || null; } catch { return null; }
  }

  async function revokeDevice(ref, { explicit } = {}) {
    if (explicit !== true) throw new IdentityBridgeError("explicit-revoke-required");
    const user = requireUser(); requireNoMismatch(); requireOnline();
    const deviceId = refs.get(ref);
    if (!deviceId) throw new IdentityBridgeError("device-not-found", 404);
    await ownerRequest("/v1/owner/devices/revoke", { method: "POST", body: { deviceId } });
    if ((await currentDeviceId(user.uid)) === deviceId) {
      // Revoking THIS installation: fail closed at once. Local Core data is never touched; the credential is kept so an
      // explicit reauthorization can restore the same enrolled device (never a new identity).
      reportDeviceFailure("device-revoked");
      set("revoked", "device-revoked");
    }
    return listDevices();
  }

  async function reauthorizeDevice(ref, { confirm } = {}) {
    if (confirm !== true) throw new IdentityBridgeError("device-confirmation-required");
    const user = requireUser(); requireNoMismatch(); requireOnline();
    const deviceId = refs.get(ref);
    if (!deviceId) throw new IdentityBridgeError("device-not-found", 404);
    return reauthorizeById(user.uid, deviceId);
  }

  async function reauthorizeById(uid, deviceId) {
    try {
      // Pinned to the Owner who confirmed: an Owner switch while the fresh proof is pending sends nothing.
      await ownerRequest("/v1/owner/devices/reauthorize", { method: "POST", expectedUid: uid, body: { deviceId, confirmReauthorize: true } });
    } catch (error) {
      if (error && error.code === "recent-authentication-required") {
        // The Owner's confirmation is remembered (same Owner + same device) so the recovery UI can continue THIS reauthorization.
        pendingReauthorize = { uid, deviceId };
        let isCurrent = false; try { isCurrent = (await currentDeviceId(uid)) === deviceId; } catch { /* not the current device as far as we know */ }
        if (pendingReauthorize && pendingReauthorize.uid === uid && pendingReauthorize.deviceId === deviceId) set("reauth_required", error.code, "reauthorize", isCurrent);
      } else if (pendingReauthorize && pendingReauthorize.uid === uid) pendingReauthorize = null;
      throw error;
    }
    if (pendingReauthorize && pendingReauthorize.uid === uid) pendingReauthorize = null;
    if ((await currentDeviceId(uid)) === deviceId) {
      try { await revalidateIdentity(); } catch { /* derived below */ }
      onIdentityState(getIdentityState());
    }
    return listDevices();
  }

  // Continues the reauthorization the Owner already confirmed (same device, same Owner) after recent authentication. Never enrolls,
  // never creates a credential, never targets a different device.
  async function resumeReauthorization(password) {
    const user = requireUser(); requireNoMismatch(); requireOnline();
    const pending = pendingReauthorize;
    if (!pending || pending.uid !== user.uid || state.status !== "reauth_required" || state.reauthIntent !== "reauthorize") {
      if (!pending && state.status === "reauth_required" && state.reauthIntent === "reauthorize") cancelReauthorization(); // orphaned recovery card: reset it
      throw new IdentityBridgeError("reauthorization-not-pending");
    }
    if (typeof reauthenticate !== "function") throw new IdentityBridgeError("bridge-dependency-invalid");
    const run = ++reauthRun;
    try {
      await reauthenticate(password); // state stays "reauth_required"/"reauthorize" meanwhile (no flicker back to the revoked / enrollment cards)
      const again = getUser();
      if (run !== reauthRun || pendingReauthorize !== pending || !again || again.uid !== pending.uid) throw new IdentityBridgeError("session-changed");
      return await reauthorizeById(pending.uid, pending.deviceId);
    } catch (error) {
      const soft = error && ((error.code && /^auth\//.test(error.code)) || error.code === "recent-authentication-required"); // wrong password / network: the Owner can retry
      if (!soft && pendingReauthorize === pending) { pendingReauthorize = null; if (state.status === "reauth_required" && state.reauthIntent === "reauthorize") onIdentityState(getIdentityState()); }
      throw error;
    }
  }

  // Cancel / dismiss: forgets the pending reauthorization (invalidating any in-flight continuation before its request is sent) and
  // re-derives the device state from the identity. Nothing is sent.
  function cancelReauthorization() {
    if (!pendingReauthorize && !(state.status === "reauth_required" && state.reauthIntent === "reauthorize")) return snapshot();
    pendingReauthorize = null; reauthRun += 1;
    // The recovery card must disappear immediately (the re-derivation below can be asynchronous): a reauthorization is only ever
    // pending for a device that was revoked, so that is the state it returns to until the identity says otherwise.
    if (state.status === "reauth_required" && state.reauthIntent === "reauthorize") set("revoked", "device-revoked");
    onIdentityState(getIdentityState());
    return snapshot();
  }

  async function reauthenticateOwner(password) {
    if (typeof reauthenticate !== "function") throw new IdentityBridgeError("bridge-dependency-invalid");
    requireUser(); requireOnline();
    await reauthenticate(password);
    if (state.status === "reauth_required") {
      const identity = getIdentityState();
      if (isRecord(identity) && identity.validationStatus === "validated") set("authorized"); else onIdentityState(identity);
    }
    return snapshot();
  }

  return Object.freeze({
    getState: snapshot,
    onIdentityState,
    enroll,
    listDevices,
    revokeDevice,
    reauthorizeDevice,
    resumeReauthorization,
    cancelReauthorization,
    setCapacityHint: noteMax,
    reauthenticateOwner,
    subscribe(callback) {
      if (typeof callback !== "function") throw new IdentityBridgeError("subscriber-invalid");
      subscribers.add(callback);
      try { callback(snapshot()); } catch { /* presentation only */ }
      return () => subscribers.delete(callback);
    },
  });
}

export { DEVICE_AUTH_FAILURE_CODES };

// Phase 3 Item D remediation — reconnect recovery coordinator.
// Root cause (runtime-confirmed on the unmodified baseline): an offline validation downgrades the identity to
// "offline"/"stale", and the group-link layer refuses every operation ("identity-not-validated") before any
// network request while identity is not validated, while the only identity revalidation paths (auth callback at
// boot, authorizedRequest) sit behind that same gate. Nothing revalidated identity when connectivity returned.
// This coordinator is event driven only (no timers, no polling, no retry loop). One recovery pass =
// identity validation -> if validated, revalidation of the existing linked group records of the SAME owner.
// It never links, unlinks, creates, signs in/out or switches owner; owner checks stay in the existing
// identity bridge (account-mismatch) and group-link layer (ensureOwner).
const NETWORK_FAILURE_CODES = new Set(["offline", "verification-unavailable"]);

export function createReconnectRecovery({
  getIdentityState,
  getAuthUser,
  validateIdentity,
  isIdentityValidationPending = () => false,
  getGroupRecords,
  validateGroup,
  isOnline = () => true,
}) {
  if (typeof getIdentityState !== "function" || typeof getAuthUser !== "function" ||
      typeof validateIdentity !== "function" || typeof getGroupRecords !== "function" ||
      typeof validateGroup !== "function") {
    throw new IdentityBridgeError("bridge-dependency-invalid");
  }

  let installedTarget = null;
  let run = null;
  let rerunRequested = false;

  function targetId(selector) {
    return typeof selector === "string" ? selector : selector && selector.localGroupId;
  }

  function isRecoverable(includePending) {
    if (isOnline() === false) return false;
    const identity = getIdentityState();
    if (!isRecord(identity) || identity.linkStatus !== "linked") return false;
    const user = getAuthUser();
    if (!user || typeof user.uid !== "string" || user.uid !== identity.ownerId) return false;
    if (identity.validationStatus === "offline") return true;
    if (identity.validationStatus === "stale" && NETWORK_FAILURE_CODES.has(identity.lastErrorCode)) return true;
    return includePending === true && isIdentityValidationPending() === true;
  }

  async function runPass() {
    const results = new Map();
    try { await validateIdentity(); } catch { /* the bridge already persisted the fail-closed state */ }
    const identity = getIdentityState();
    if (!isRecord(identity) || identity.linkStatus !== "linked" || identity.validationStatus !== "validated") {
      return { identityValidated: false, results };
    }
    for (const record of getGroupRecords()) {
      if (!isRecord(record) || record.linkStatus !== "linked") continue;
      if (record.ownerId !== identity.ownerId || record.accountId !== identity.accountId) continue;
      if (record.validationStatus === "deleted" || record.validationStatus === "account_mismatch") continue;
      try { results.set(record.localGroupId, { ok: true, value: await validateGroup(record.localGroupId) }); }
      catch (error) { results.set(record.localGroupId, { ok: false, error }); }
    }
    return { identityValidated: true, results };
  }

  function recover({ includePending = true } = {}) {
    if (run !== null) return run;
    if (!isRecoverable(includePending)) return Promise.resolve(null);
    run = (async () => {
      rerunRequested = false;
      let last = await runPass();
      // At most ONE trailing pass, and only if another online event arrived during this pass and recovery is
      // still needed (e.g. connectivity flapped). Further events start a new recovery themselves.
      if (rerunRequested && isRecoverable(true)) {
        rerunRequested = false;
        last = await runPass();
      }
      return last;
    })().finally(() => { run = null; });
    return run;
  }

  function onOnline() {
    if (run !== null) { rerunRequested = true; return; }
    recover({ includePending: true }).catch(() => {});
  }

  // Manual group Validate: if identity needs network recovery (or a recovery pass is already running) wait for
  // that single pass; the pass already sent at most one validation per linked record, so reuse its outcome
  // instead of sending a second request for the same target.
  async function validateGroupLink(selector) {
    if (run !== null || isRecoverable(false)) {
      const outcome = await recover({ includePending: false }).catch(() => null);
      const entry = outcome && outcome.results.get(targetId(selector));
      if (entry) {
        if (entry.ok) return entry.value;
        throw entry.error;
      }
    }
    return validateGroup(selector);
  }

  function install(target) {
    if (installedTarget !== null) return false;
    if (!target || typeof target.addEventListener !== "function" || typeof target.removeEventListener !== "function") {
      throw new IdentityBridgeError("bridge-dependency-invalid");
    }
    installedTarget = target;
    target.addEventListener("online", onOnline);
    return true;
  }

  function dispose() {
    if (installedTarget === null) return false;
    installedTarget.removeEventListener("online", onOnline);
    installedTarget = null;
    rerunRequested = false;
    return true;
  }

  return Object.freeze({
    install,
    dispose,
    recover: () => recover({ includePending: true }),
    whenIdle: () => run || Promise.resolve(null),
    validateGroupLink,
  });
}

// Phase 4C - Commercial Players API adapter. It ONLY maps the two frozen Phase 4B routes onto the existing authorized request
// boundary (fresh token, identity/group validation, no token exposure). It never invents a route, header or field.
const CLOUD_GROUP_ID_PATTERN = /^grp_[a-f0-9]{32}$/;
export function createPlayersApi(authorizedRequest) {
  if (typeof authorizedRequest !== "function") throw new IdentityBridgeError("player-api-unavailable");
  return Object.freeze({
    async listPlayers(cloudGroupId, { cursor, pageSize, signal } = {}) {
      if (typeof cloudGroupId !== "string" || !CLOUD_GROUP_ID_PATTERN.test(cloudGroupId)) throw new IdentityBridgeError("group-not-found", 404);
      const query = [];
      if (pageSize !== undefined) query.push(`pageSize=${encodeURIComponent(String(pageSize))}`);
      if (cursor) query.push(`cursor=${encodeURIComponent(String(cursor))}`);
      const path = `/v1/core/badminton-groups/${cloudGroupId}/players${query.length ? `?${query.join("&")}` : ""}`;
      const value = await authorizedRequest(path, { signal });
      if (value?.contractVersion !== COMMERCIAL_CONTRACT_VERSION || value?.environment !== activeProfile.environment ||
          value?.cloudGroupId !== cloudGroupId) throw new IdentityBridgeError("player-contract-invalid");
      return value;
    },
    async upsertPlayer(envelope, { signal } = {}) {
      const value = await authorizedRequest("/v1/core/player-mutations", { body: envelope, method: "POST", signal });
      if (value?.contractVersion !== COMMERCIAL_CONTRACT_VERSION || value?.environment !== activeProfile.environment) {
        throw new IdentityBridgeError("player-contract-invalid");
      }
      return value;
    },
  });
}

// The Core host is registered by the app (window.BadQPlayerSyncHost). Until it exists every call fails closed.
export function createLazyPlayerHost(getHost) {
  const missing = () => ({ ok: false, code: "durable-snapshot-unavailable" });
  const call = (name) => async (...args) => {
    const host = getHost();
    if (!host || typeof host[name] !== "function") return name === "isKnownPlayerId" ? true : missing();
    return host[name](...args);
  };
  return Object.freeze({
    readDurableSnapshot: call("readDurableSnapshot"),
    applyApprovedFields: call("applyApprovedFields"),
    createPlayerFromCloud: call("createPlayerFromCloud"),
    isKnownPlayerId: call("isKnownPlayerId"),
  });
}

// Restore must keep working when Commercial is unavailable (configuration disabled / not provisioned, Firebase SDK unreachable on a
// first offline launch of a new origin, …). The Restore critical section still has to fence any persisted Player Sync binding BEFORE the
// restored data is promoted, so an inert engine (no identity, no network, no cloud route) is built over the same binding store and the
// same cross-tab Restore gate purely to run that fence. If even that cannot be built, Restore stays refused (fail-closed, as before).
function createRestoreFenceOnly() {
  try {
    const contract = window.BadQSyncContract;
    if (!contract) return null;
    const locks = () => (navigator.locks && typeof navigator.locks.request === "function" ? navigator.locks : null);
    const engine = createPlayerSyncEngine({
      store: createIdbBindingStore(),
      restoreGate: {
        shared: (fn) => (locks() ? locks().request("badq-player-sync-restore-gate", { mode: "shared" }, fn) : Promise.resolve().then(fn)),
        exclusive: (fn) => (locks() ? locks().request("badq-player-sync-restore-gate", { mode: "exclusive" }, fn)
          : Promise.reject(Object.assign(new Error("restore-lock-unavailable"), { code: "restore-lock-unavailable" }))),
      },
      api: createPlayersApi(async () => { throw new IdentityBridgeError("bridge-unavailable"); }),
      contract,
      host: createLazyPlayerHost(() => window.BadQPlayerSyncHost),
      getIdentity: () => ({ validated: false, ownerId: null, accountId: null }),
      getGroupLink: () => ({ linked: false }),
      isOnline: () => false,
      withLease: (name, fn) => (locks() ? locks().request(`badq-player-sync-${name}`, fn) : fn()),
    });
    return Object.freeze({
      runRestoreCritical: engine.runRestoreCritical, fenceForRestore: engine.fenceForRestore, markStale: engine.markStale,
      quiesce: (reason) => engine.closeTransport(reason), notifyDurableSave: () => {},
    });
  } catch { return null; }
}

function unavailableAdapter(reason, state = unlinkedState(reason)) {
  const restoreOnly = typeof window !== "undefined" ? createRestoreFenceOnly() : null;
  return Object.freeze({
    available: false,
    reason,
    getCurrentOwner: () => null,
    getIdentityLinkState: () => clone(state),
    isIdentityValidated: () => false,
    ...(restoreOnly ? { playerSync: restoreOnly } : {}),
  });
}

// ---- BAD_Q Offline licence (module level: the stored licence works with NO network, NO Firebase and NO sign-in) ------------------
// Contract: CORE-OFFLINE-MVP-CONTRACT.md (/v2/offline). The licence is a server-signed Ed25519 JWS verified against the PINNED registry in
// offline-trust-registry.js. Everything that talks to the server lives in offline-license-client.js and is wired inside the bridge below.
// Enforcement applies only when the Commercial configuration is ENABLED (an unconfigured build has nothing to activate against), and
// never to an Owner whose last server-verified legacy FULL/ONLINE grant is still valid (those plans are unchanged).
let localLicenseSingleton = null; let localLicenseEnv = null;
function offlineProfileFromConfig() {
  try { const cfg = validateCommercialConfiguration(typeof window !== "undefined" ? window.BadQCommercialConfig : null); return cfg.enabled ? cfg.profile : null; } catch { return null; }
}
function getLocalLicenseSingleton() {
  if (localLicenseSingleton) return localLicenseSingleton;
  const profile = offlineProfileFromConfig();
  if (!profile) return null;
  try {
    localLicenseSingleton = createLocalLicense({ storage: window.localStorage, environment: profile.environment, getRegistry: () => trustedKeysFor(profile) });
    localLicenseEnv = profile.environment;
  } catch { localLicenseSingleton = null; }
  return localLicenseSingleton;
}
function legacyGrantStillValid() {
  // Reads the cached, server-verified legacy entitlement record directly (works offline, before any bridge exists).
  try {
    const r = JSON.parse(window.localStorage.getItem(ENTITLEMENT_STORAGE_KEY) || "null");
    if (!isRecord(r) || r.status !== "granted" || r.environment !== localLicenseEnv) return false;
    return r.validUntil === null || (isIsoInstant(r.validUntil) && Date.parse(r.validUntil) > Date.now());
  } catch { return false; }
}
function buildLocalLicenseApi() {
  const NOT_CONFIGURED = Object.freeze({ planId: "BAD_Q", state: "not_configured", restricted: false, hardLock: false, localDataPolicy: "retained", deviceCapacity: 1, ownerCloudSync: false });
  const lic = () => getLocalLicenseSingleton();
  return Object.seal({
    configured: () => !!lic(),
    view: () => { const l = lic(); if (!l) return NOT_CONFIGURED; const v = l.view(); return legacyGrantStillValid() && v.restricted ? Object.freeze({ ...v, restricted: false, legacyEntitled: true }) : v; },
    canStartGames: () => { const l = lic(); return !l || l.canStartGames() || legacyGrantStillValid(); },
    subscribe: (cb) => { const l = lic(); return l ? l.subscribe(cb) : () => {}; },
    init: () => { const l = lic(); return l ? l.init() : Promise.resolve(NOT_CONFIGURED); },
    recover: () => { const l = lic(); if (!l) throw new IdentityBridgeError("configuration-disabled"); return l.recoverFromCorruption(); },
    // set by the bridge once Firebase + the credential store are available (null while offline / not provisioned)
    offline: null,
  });
}
let localLicenseApi = null;
try { if (typeof window !== "undefined") { localLicenseApi = window.BadQLocalLicenseApi = buildLocalLicenseApi(); localLicenseApi.init().catch(() => {}); } } catch { /* non-browser */ }

// Module-level single-initialization guard: the adapter (and its single recovery listener) is created at most once.
let adapterInitializationStarted = false;

async function initializeBrowserAdapter() {
  if (adapterInitializationStarted) return;
  adapterInitializationStarted = true;
  let config;
  try {
    config = validateCommercialConfiguration(window.BadQCommercialConfig);
    if (config.enabled) activateEnvironmentProfile(config.profile);
  } catch (error) {
    window.BadQCommercialBridge = unavailableAdapter(error.code || "configuration-invalid");
    window.dispatchEvent(new CustomEvent("badq:commercial-bridge-ready"));
    return;
  }
  if (!config.enabled) {
    window.BadQCommercialBridge = unavailableAdapter("configuration-disabled");
    window.dispatchEvent(new CustomEvent("badq:commercial-bridge-ready"));
    return;
  }

  try {
    const appSdk = await import(`https://www.gstatic.com/firebasejs/${FIREBASE_CDN_VERSION}/firebase-app.js`);
    const authSdk = await import(`https://www.gstatic.com/firebasejs/${FIREBASE_CDN_VERSION}/firebase-auth.js`);
    const existing = appSdk.getApps().find((candidate) => candidate.name === FIREBASE_APP_NAME);
    const app = existing || appSdk.initializeApp(config.firebase, FIREBASE_APP_NAME);
    let auth;
    try {
      auth = authSdk.initializeAuth(app, { persistence: authSdk.browserLocalPersistence });
    } catch {
      auth = authSdk.getAuth(app);
      await authSdk.setPersistence(auth, authSdk.browserLocalPersistence);
    }
    auth.languageCode = "th";

    const getFreshProof = async (expectedUser) => {
      if (!expectedUser || typeof expectedUser.uid !== "string" || !expectedUser.uid) {
        throw new IdentityBridgeError("session-unavailable");
      }
      const expectedUid = expectedUser.uid;
      await authSdk.reload(expectedUser);
      if (!auth.currentUser || auth.currentUser.uid !== expectedUid) {
        throw new IdentityBridgeError("account-mismatch");
      }
      const result = await authSdk.getIdTokenResult(auth.currentUser, true);
      const claimUid = result.claims.sub ?? result.claims.user_id;
      return {
        token: result.token,
        uid: claimUid,
        emailVerified: auth.currentUser.emailVerified === true && result.claims.email_verified === true,
      };
    };

    // Phase 5A: the device credential lives in its own IndexedDB database (never bg-v11 / backups / localStorage).
    let credentialStore = null;
    try {
      credentialStore = createDeviceCredentialStore({
        backend: createIdbCredentialBackend(window.indexedDB, config.profile.credentialDbName),
        randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
      });
    } catch { credentialStore = null; }
    const readDeviceCredential = async (uid) => {
      if (!credentialStore) throw new IdentityBridgeError("device-credential-unavailable");
      return credentialStore.getCredential(uid);
    };
    // The ONLY place the device proof becomes request headers; used by bootstrap and every protected Core route.
    const deviceProofHeaders = async (uid) => {
      const credential = await readDeviceCredential(uid);
      return credential ? { "X-BadQ-Device-Id": credential.deviceId, "X-BadQ-Device-Key": credential.deviceKey } : {};
    };

    let lastBootstrapBody = null;
    const fetchBootstrap = async (token, uid) => {
      const proofHeaders = await deviceProofHeaders(uid);
      try {
        const response = await fetch(`${config.apiBaseUrl}/v1/core/bootstrap`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...proofHeaders },
          cache: "no-store",
        });
        const body = await response.json().catch(() => null);
        lastBootstrapBody = response.status === 200 ? body : null;
        return { status: response.status, body };
      } catch {
        throw new IdentityBridgeError(navigator.onLine === false ? "offline" : "verification-unavailable");
      }
    };

    // Server-confirmed device authorization: Cloud capability needs a local credential AND a bootstrap `device` block that
    // names THIS installation as authorized. Authentication alone never enables Cloud.
    const deviceGate = async (user, body) => {
      const credential = await readDeviceCredential(user.uid);
      if (!credential) throw new IdentityBridgeError("device-enrollment-required");
      const device = body && body.device;
      if (!isRecord(device) || device.id !== credential.deviceId || device.status !== "authorized") {
        throw new IdentityBridgeError("device-not-authorized");
      }
    };

    // Early Access: server entitlement, kept apart from identity + device state (own localStorage key, never bg-v11 / Backup).
    const entitlement = createEntitlementManager({ storage: window.localStorage });
    const bridge = createIdentityBridge({
      entitlements: entitlement,
      storage: window.localStorage,
      getCurrentUser: () => auth.currentUser,
      getFreshIdToken: getFreshProof,
      fetchBootstrap,
      deviceGate,
      online: () => navigator.onLine !== false,
    });

    // Paid Owner Cloud capability = verified identity AND server-confirmed device AND a server-verified entitlement grant.
    const cloudAllowed = () => bridge.isCloudIdentityValidated() === true && entitlement.isCloudAllowed(bridge.getState().ownerId) === true;
    const authorizedRequest = async (path, { body, idempotencyKey, signal, method } = {}) => {
      await bridge.validateLink();
      if (!cloudAllowed()) throw new IdentityBridgeError("cloud-entitlement-required", 403);
      const proof = await getFreshProof(auth.currentUser);
      const headers = {
        Authorization: `Bearer ${proof.token}`,
        Accept: "application/json",
        ...(await deviceProofHeaders(proof.uid)),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      };
      let response;
      try {
        response = await fetch(`${config.apiBaseUrl}${path}`, {
          method: method || (body === undefined ? "GET" : "POST"),
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          cache: "no-store",
          ...(signal ? { signal } : {}),
        });
      } catch {
        throw new IdentityBridgeError(navigator.onLine === false ? "offline" : "verification-unavailable");
      }
      const value = await response.json().catch(() => null);
      if (!response.ok) {
        const code = typeof value?.error?.code === "string" ? value.error.code :
          response.status === 401 ? "unauthenticated" :
          response.status === 403 ? "email-verification-required" : "verification-unavailable";
        if (DEVICE_AUTH_FAILURE_CODES.has(code)) { try { bridge.reportDeviceFailure(code); } catch { /* fail-closed already */ } }
        else if (/entitlement/i.test(code)) entitlement.markServerDenied();
        throw new IdentityBridgeError(code, response.status);
      }
      return value;
    };

    // Phase 5A Owner-account routes (device list / enroll / revoke / reauthorize). They carry the fresh Owner token ONLY —
    // never the device header — and stay usable after this device was revoked so the Owner can manage devices.
    const ownerRequest = async (path, { body, method, expectedUid, beforeSend } = {}) => {
      const proof = await getFreshProof(auth.currentUser);
      // v1.15.4 (P3): a state-changing Owner call can be pinned to the Owner who started it. If the signed-in account changed
      // in between (another tab / sign-out + sign-in), nothing is sent.
      if (typeof expectedUid === "string" && proof.uid !== expectedUid) throw new IdentityBridgeError("session-changed");
      // Last synchronous checkpoint AFTER the (possibly slow) proof acquisition and immediately before fetch(): the caller may veto
      // (cancelled / Owner switched => throws, nothing is sent) and is told the request is now actually leaving the device.
      if (typeof beforeSend === "function") beforeSend(proof);
      let response;
      try {
        response = await fetch(`${config.apiBaseUrl}${path}`, {
          method: method || (body === undefined ? "GET" : "POST"),
          headers: {
            Authorization: `Bearer ${proof.token}`,
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          cache: "no-store",
        });
      } catch {
        throw new IdentityBridgeError(navigator.onLine === false ? "offline" : "verification-unavailable");
      }
      const value = await response.json().catch(() => null);
      if (!response.ok) {
        const code = typeof value?.error?.code === "string" ? value.error.code :
          response.status === 401 ? "unauthenticated" :
          response.status === 403 ? "email-verification-required" : "verification-unavailable";
        throw new IdentityBridgeError(code, response.status);
      }
      return value;
    };

    const groupBridge = createGroupLinkBridge({
      storage: window.localStorage,
      getIdentityState: bridge.getState,
      isIdentityValidated: cloudAllowed,
      listCloudGroups: async () => {
        await bridge.validateLink();
        const current = auth.currentUser;
        if (!current || !lastBootstrapBody) throw new IdentityBridgeError("verification-unavailable");
        return validateBootstrapContract(lastBootstrapBody, current.uid).badmintonGroups;
      },
      createCloudGroup: async (displayName, idempotencyKey) => {
        const value = await authorizedRequest("/v1/core/badminton-groups", {
          body: { displayName }, idempotencyKey,
        });
        if (value?.contractVersion !== COMMERCIAL_CONTRACT_VERSION || value?.environment !== activeProfile.environment) {
          throw new IdentityBridgeError("group-contract-invalid");
        }
        return value.group;
      },
      validateCloudGroup: async (groupId) => {
        const value = await authorizedRequest("/v1/core/badminton-groups/validate", { body: { groupId } });
        if (value?.contractVersion !== COMMERCIAL_CONTRACT_VERSION || value?.environment !== activeProfile.environment) {
          throw new IdentityBridgeError("group-contract-invalid");
        }
        return value.group;
      },
      randomId: () => {
        if (typeof crypto.randomUUID === "function") return crypto.randomUUID().replace(/-/g, "");
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      },
      online: () => navigator.onLine !== false,
    });

    const reconnectRecovery = createReconnectRecovery({
      getIdentityState: bridge.getState,
      getAuthUser: () => auth.currentUser,
      validateIdentity: bridge.validateLink,
      isIdentityValidationPending: bridge.isValidationPending,
      getGroupRecords: groupBridge.getRecords,
      validateGroup: groupBridge.validateLink,
      isOnline: () => navigator.onLine !== false,
    });
    reconnectRecovery.install(window);

    const deviceManager = createDeviceManager({
      credentialStore: credentialStore || { getCredential: async () => { throw new IdentityBridgeError("device-credential-unavailable"); } },
      getUser: () => auth.currentUser,
      ownerRequest,
      getIdentityState: bridge.getState,
      revalidateIdentity: bridge.validateLink,
      reportDeviceFailure: bridge.reportDeviceFailure,
      reauthenticate: async (password) => {
        const user = auth.currentUser;
        if (!user || typeof user.email !== "string" || !user.email) throw new IdentityBridgeError("session-unavailable");
        const credential = authSdk.EmailAuthProvider.credential(user.email, password);
        await authSdk.reauthenticateWithCredential(user, credential);
        await authSdk.getIdToken(user, true);
      },
      online: () => navigator.onLine !== false,
    });
    bridge.subscribe((identity) => { deviceManager.onIdentityState(identity); });

    const authSubscribers = new Set();
    authSdk.onAuthStateChanged(auth, (user) => {
      bridge.handleAuthState(user).catch(() => {});
      for (const callback of authSubscribers) callback(user);
    });

    // Phase 4C Players Sync: explicit per-player opt-in, binding evidence in its own IndexedDB, cloud access only through
    // the two Commercial routes above the identity boundary. Local Core never waits for or depends on this engine.
    let playerSync = null;
    try {
      const contract = window.BadQSyncContract;
      const identityForPlayers = () => {
        const state = bridge.getState();
        return { validated: cloudAllowed() === true, ownerId: state.ownerId, accountId: state.accountId };
      };
      const linkForPlayers = (localGroupId) => {
        const record = groupBridge.getRecords().find((entry) => entry.localGroupId === localGroupId) || null;
        if (!record || record.linkStatus !== "linked") return { linked: false };
        let validated = false;
        try { validated = groupBridge.isGroupLinkValidated({ localGroupId }) === true; } catch { validated = false; }
        return { linked: true, validated, ownerId: record.ownerId, accountId: record.accountId, cloudGroupId: record.cloudGroupId };
      };
      const engine = createPlayerSyncEngine({
        store: createIdbBindingStore(),
        // Cross-tab Restore critical section (Web Locks). Without Web Locks the exclusive section FAILS CLOSED: Restore is refused (retryable)
        // rather than run without the cross-tab guarantee.
        restoreGate: {
          shared: (fn) => (navigator.locks && typeof navigator.locks.request === "function"
            ? navigator.locks.request("badq-player-sync-restore-gate", { mode: "shared" }, fn) : Promise.resolve().then(fn)),
          exclusive: (fn) => (navigator.locks && typeof navigator.locks.request === "function"
            ? navigator.locks.request("badq-player-sync-restore-gate", { mode: "exclusive" }, fn)
            : Promise.reject(Object.assign(new Error("restore-lock-unavailable"), { code: "restore-lock-unavailable" }))),
        },
        api: createPlayersApi(authorizedRequest),
        contract,
        host: createLazyPlayerHost(() => window.BadQPlayerSyncHost),
        getIdentity: identityForPlayers,
        getGroupLink: linkForPlayers,
        isOnline: () => navigator.onLine !== false,
        withLease: (name, fn) => (navigator.locks && typeof navigator.locks.request === "function"
          ? navigator.locks.request(`badq-player-sync-${name}`, fn) : fn()),
      });
      bridge.subscribe((state) => { engine.handleIdentityChange(state); });
      // Entitlement lost/unverified while online: stop any open cloud transport (local Core and its saved data are never touched).
      let wasAllowed = false;
      const syncAllowance = () => { const now = cloudAllowed(); if (wasAllowed && !now) { try { engine.closeTransport("entitlement-lost"); } catch { /* best effort */ } } wasAllowed = now; };
      entitlement.subscribe(syncAllowance); bridge.subscribe(syncAllowance);
      groupBridge.subscribe((state) => { engine.handleGroupLinkChange(state); });
      window.addEventListener("offline", () => { engine.closeTransport("offline"); });
      window.addEventListener("online", () => { engine.scheduleReconcile(); });
      engine.init().catch(() => {});
      playerSync = Object.freeze({
        init: engine.init, getView: engine.getView, eligibility: engine.eligibility, subscribe: engine.subscribe,
        selectPlayer: engine.selectPlayer, deselectPlayer: engine.deselectPlayer, reconcile: engine.reconcile,
        previewResolution: engine.previewResolution, acceptCloudUpdate: engine.acceptCloudUpdate, useLocalValue: engine.useLocalValue,
        resumeAfterReview: engine.resumeAfterReview, listCloudOnly: engine.listCloudOnly, importCloudPlayer: engine.importCloudPlayer,
        markStale: engine.markStale, fenceForRestore: engine.fenceForRestore, runRestoreCritical: engine.runRestoreCritical, quiesce: (reason) => engine.closeTransport(reason), notifyDurableSave: () => { if (engine.hasSelectedBindings()) engine.scheduleReconcile(); },
      });
    } catch { playerSync = null; }

    // ---- Plan / licence view (BAD_Q, PLUS, PRO, FOUNDER_ALL_ACCESS) -------------------------------------------------------------
    // The view is derived, never stored: server-verified entitlement (+ optional licence block, PENDING-CONTRACT) -> plan, state, features,
    // device capacity. Device capacity is pushed to the device manager so the UI never shows a fixed two-device label.
    const licenseView = () => deriveLicenseView({ entitlement: entitlement.getState(), license: entitlement.getLicense(), nowMs: entitlement.nowSkewed() });
    const syncCapacity = () => { try { const v = licenseView(); if (v.planId && v.state !== "unverified") deviceManager.setCapacityHint(v.deviceCapacity); } catch { /* presentation only */ } };
    entitlement.subscribe(syncCapacity);

    // ---- Full automatic Owner Sync (PLUS / PRO / FOUNDER) -----------------------------------------------------------------------
    // The engine is complete and tested against a mock transport. The Commercial sync API is NOT yet specified, so the production
    // transport is a FAIL-CLOSED placeholder: it performs no network request and reports "transport-pending-contract".
    let ownerSync = null;
    try {
      let cachedDeviceId = null; let cachedFor = null;
      const refreshDeviceId = () => {
        const uid = auth.currentUser && auth.currentUser.uid;
        if (!uid || !credentialStore) { cachedDeviceId = null; cachedFor = null; return; }
        if (cachedFor === uid && cachedDeviceId) return;
        credentialStore.getCredential(uid).then((c) => { cachedDeviceId = c ? c.deviceId : null; cachedFor = uid; }).catch(() => { cachedDeviceId = null; });
      };
      deviceManager.subscribe(refreshDeviceId);
      const pendingTransport = Object.freeze({
        push: async () => { throw Object.assign(new Error("transport-pending-contract"), { code: "transport-pending-contract" }); },
        pull: async () => { throw Object.assign(new Error("transport-pending-contract"), { code: "transport-pending-contract" }); },
      });
      const ownerSyncCapability = () => {
        if (!cloudAllowed()) return { ok: false, code: "identity-or-entitlement-not-allowed" };
        const view = licenseView();
        if (!view.ownerCloudSync) return { ok: false, code: view.planId === "BAD_Q" ? "plan-has-no-cloud-sync" : "plan-not-active" };
        if (deviceManager.getState().status !== "authorized") return { ok: false, code: "device-not-authorized" };
        const linked = groupBridge.getRecords().filter((r) => r.linkStatus === "linked").filter((r) => { try { return groupBridge.isGroupLinkValidated({ localGroupId: r.localGroupId }) === true; } catch { return false; } });
        if (linked.length === 0) return { ok: false, code: "group-link-not-found" };
        if (linked.length > 1) return { ok: false, code: "multiple-linked-groups" };
        refreshDeviceId();
        if (!cachedDeviceId) return { ok: false, code: "device-credential-unavailable" };
        const state = bridge.getState();
        return { ok: true, ownerId: state.ownerId, cloudGroupId: linked[0].cloudGroupId, deviceId: cachedDeviceId };
      };
      const engine = createOwnerSyncEngine({
        store: createIdbOwnerSyncStore(), transport: pendingTransport,
        host: {
          readDurableSnapshot: async () => { const h = window.BadQOwnerSyncHost; if (!h) return { ok: false, code: "host-unavailable" }; return h.readDurableSnapshot(); },
          applyState: async (args) => { const h = window.BadQOwnerSyncHost; if (!h || typeof h.applyState !== "function") return { ok: false, code: "host-unavailable" }; return h.applyState(args); },
        },
        getCapability: ownerSyncCapability, isOnline: () => navigator.onLine !== false,
      });
      const onChange = () => { try { engine.invalidate(); } catch { /* best effort */ } };
      bridge.subscribe((s) => { if (s && s.validationStatus !== "validated") onChange(); });
      window.addEventListener("online", () => { engine.onOnline().catch(() => {}); });
      ownerSync = Object.freeze({
        getStatus: engine.getStatus, subscribe: engine.subscribe, notifyChanged: engine.notifyChanged, flush: engine.flush, onOnline: engine.onOnline,
        startInitial: engine.startInitial, pullUpdates: engine.pullUpdates, resolveConflict: engine.resolveConflict, acknowledgeReview: engine.acknowledgeReview,
        restoreFromCloud: engine.restoreFromCloud, migrateLegacy: engine.migrateLegacy,
      });
    } catch { ownerSync = null; }

    // ---- BAD_Q Offline (/v2/offline) client -------------------------------------------------------------------------------------
    // Transport only: fresh Owner bearer token (+ the existing bound-device proof headers for /core/*). It never enrolls on its own.
    const offlineRequest = async (path, { body, method, idempotencyKey, expectedUid, beforeSend, deviceUid } = {}) => {
      const proof = await getFreshProof(auth.currentUser);
      if (typeof expectedUid === "string" && proof.uid !== expectedUid) throw new IdentityBridgeError("session-changed");
      if (proof.emailVerified !== true) throw new IdentityBridgeError("email-not-verified");
      const deviceHeaders = deviceUid ? await deviceProofHeaders(proof.uid) : {};
      if (deviceUid && !deviceHeaders["X-BadQ-Device-Id"]) throw new IdentityBridgeError("device-enrollment-required");
      if (typeof beforeSend === "function") beforeSend(proof);
      let response;
      try {
        response = await fetch(`${config.apiBaseUrl}${path}`, {
          method: method || (body === undefined ? "GET" : "POST"),
          headers: { Authorization: `Bearer ${proof.token}`, Accept: "application/json", ...deviceHeaders, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store",
        });
      } catch { throw new IdentityBridgeError(navigator.onLine === false ? "offline" : "verification-unavailable"); }
      const value = await response.json().catch(() => null);
      if (!response.ok) {
        const code = typeof value?.error?.code === "string" ? value.error.code : response.status === 401 ? "unauthenticated" : response.status === 403 ? "email-verification-required" : response.status === 409 ? "conflict" : "verification-unavailable";
        throw new IdentityBridgeError(code, response.status);
      }
      return value;
    };
    let offlineClient = null;
    const offlineLicenseStore = getLocalLicenseSingleton();
    if (credentialStore && offlineLicenseStore) {
      try {
        offlineClient = createOfflineLicenseClient({ environment: activeProfile.environment, request: offlineRequest, getUser: () => auth.currentUser, credentialStore, license: offlineLicenseStore, storage: window.localStorage, online: () => navigator.onLine !== false });
      } catch { offlineClient = null; }
    }
    const offlineApi = offlineClient ? Object.freeze({ ...offlineClient, reauthenticate: (password) => deviceManager.reauthenticateOwner(password), hasPendingMigration: async () => { const u = auth.currentUser; return !!(u && typeof credentialStore.hasPendingCredential === "function" && await credentialStore.hasPendingCredential(u.uid)); } }) : null;
    if (localLicenseApi) localLicenseApi.offline = offlineApi;
    // Online reconnect: honour a definitive server decision (revocation / device unlock) without deleting anything. Never enrolls.
    if (offlineApi) {
      let refreshTimer = null;
      const scheduleRefresh = () => { if (refreshTimer) return; refreshTimer = setTimeout(() => { refreshTimer = null; offlineApi.refreshServerStatus().catch(() => {}); }, 1500); };
      window.addEventListener("online", scheduleRefresh);
      authSdk.onAuthStateChanged(auth, (u) => { if (u) scheduleRefresh(); });
    }

    window.BadQCommercialBridge = Object.freeze({
      available: true,
      environment: activeProfile.environment,
      projectId: activeProfile.projectId,
      getEntitlementState: entitlement.getState,
      getLicenseView: licenseView,
      offline: offlineApi,
      ownerSync,
      onEntitlementChange: entitlement.subscribe,
      isCloudCapabilityAllowed: cloudAllowed,
      getCurrentOwner: () => auth.currentUser,
      onAuthChange(callback) {
        authSubscribers.add(callback);
        callback(auth.currentUser);
        return () => authSubscribers.delete(callback);
      },
      registerOwner: (email, password) => authSdk.createUserWithEmailAndPassword(auth, email.trim(), password),
      signInOwner: (email, password) => authSdk.signInWithEmailAndPassword(auth, email.trim(), password),
      signOutOwner: () => authSdk.signOut(auth),
      sendVerificationEmail: () => {
        if (!auth.currentUser) throw new IdentityBridgeError("session-unavailable");
        return authSdk.sendEmailVerification(auth.currentUser);
      },
      reloadCurrentUser: async () => {
        if (!auth.currentUser) throw new IdentityBridgeError("session-unavailable");
        await authSdk.reload(auth.currentUser);
        await authSdk.getIdToken(auth.currentUser, true);
        await bridge.handleAuthState(auth.currentUser).catch(() => {});
        return auth.currentUser;
      },
      sendPasswordReset: (email) => authSdk.sendPasswordResetEmail(auth, email.trim()),
      getDeviceState: deviceManager.getState,
      onDeviceStateChange: deviceManager.subscribe,
      enrollThisDevice: async (options) => {
        try { if (navigator.storage && typeof navigator.storage.persist === "function") await navigator.storage.persist(); } catch { /* best effort */ }
        return deviceManager.enroll(options);
      },
      listOwnerDevices: deviceManager.listDevices,
      revokeOwnerDevice: deviceManager.revokeDevice,
      reauthorizeOwnerDevice: deviceManager.reauthorizeDevice,
      resumeDeviceReauthorization: deviceManager.resumeReauthorization,
      cancelDeviceReauthorization: deviceManager.cancelReauthorization,
      setDeviceCapacityHint: deviceManager.setCapacityHint,
      reauthenticateOwner: deviceManager.reauthenticateOwner,
      getIdentityLinkState: bridge.getState,
      validateIdentityLink: bridge.validateLink,
      unlinkIdentity: bridge.unlinkIdentity,
      isIdentityValidated: bridge.isCloudIdentityValidated,
      onIdentityLinkChange: bridge.subscribe,
      listBadmintonGroups: groupBridge.listGroups,
      linkBadmintonGroup: groupBridge.linkExisting,
      createAndLinkBadmintonGroup: groupBridge.createAndLink,
      validateBadmintonGroupLink: (selector) => reconnectRecovery.validateGroupLink(selector),
      unlinkBadmintonGroup: groupBridge.unlink,
      reconcileBadmintonGroupIdentities: groupBridge.reconcileLocalGroups,
      markBadmintonGroupLinksStale: groupBridge.markAllStale,
      getBadmintonGroupLinkState: groupBridge.getState,
      getBadmintonGroupLinks: groupBridge.getRecords,
      isBadmintonGroupLinkValidated: groupBridge.isGroupLinkValidated,
      onBadmintonGroupLinkChange: groupBridge.subscribe,
      playerSync,
    });
    window.dispatchEvent(new CustomEvent("badq:commercial-bridge-ready"));
  } catch {
    window.BadQCommercialBridge = unavailableAdapter("bridge-initialization-failed");
    window.dispatchEvent(new CustomEvent("badq:commercial-bridge-ready"));
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  initializeBrowserAdapter();
}
