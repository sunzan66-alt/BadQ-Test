// BadQ Web Sync Phase 1/2 — isolated Commercial Identity and Badminton Group bridges.
//
// This module intentionally does not import Firestore and never reads Core business state. It uses a
// named Firebase app for Commercial Auth, then asks the trusted Commercial API for the canonical Owner.
// Local gameplay remains available when this module, Auth, or the API is unavailable.

import { createGroupLinkBridge, validateCloudGroupList } from "./group-link.js";
import { createPlayerSyncEngine, createIdbBindingStore } from "./player-sync.js";

export const IDENTITY_LINK_STORAGE_KEY = "badq-commercial-identity-link-v1";
export const IDENTITY_LINK_SCHEMA_VERSION = 1;
export const COMMERCIAL_CONTRACT_VERSION = "1";
export const TEST_PROJECT_ID = "badq-commercial-test";
export const TEST_ENVIRONMENT = "TEST";
export const TEST_API_BASE_URL = "https://api-xommxsjila-as.a.run.app";
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
    environment: TEST_ENVIRONMENT,
    projectId: TEST_PROJECT_ID,
    contractVersion: null,
    ownerId: null,
    accountId: null,
    linkedAt: null,
    lastSuccessfulValidationAt: null,
    lastSuccessfulBootstrapServerTime: null,
    lastErrorCode: errorCode,
  };
}

function isStoredState(value) {
  if (!isRecord(value) || value.schemaVersion !== IDENTITY_LINK_SCHEMA_VERSION ||
      !["linked", "unlinked"].includes(value.linkStatus) ||
      !VALIDATION_STATUSES.has(value.validationStatus) ||
      value.environment !== TEST_ENVIRONMENT || value.projectId !== TEST_PROJECT_ID) return false;
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
      value.environment !== TEST_ENVIRONMENT || typeof expectedUid !== "string" || !expectedUid ||
      value.ownerId !== expectedUid || value.accountId !== expectedUid ||
      typeof value.serverTime !== "string" || !Number.isFinite(Date.parse(value.serverTime)) ||
      !Array.isArray(value.badmintonGroups)) {
    throw new IdentityBridgeError("contract-invalid");
  }
  return {
    contractVersion: COMMERCIAL_CONTRACT_VERSION,
    environment: TEST_ENVIRONMENT,
    ownerId: value.ownerId,
    accountId: value.accountId,
    serverTime: value.serverTime,
    badmintonGroups: validateCloudGroupList(value.badmintonGroups),
  };
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
      state = isStoredState(parsed) ? parsed : unlinkedState("stored-link-invalid");
    }
  } catch {
    state = unlinkedState("storage-unavailable");
  }

  // A prior browser process cannot authorize this process. Every startup begins stale until a fresh
  // token and bootstrap response are verified. The last successful timestamps remain available for UI.
  if (state.linkStatus === "linked") {
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

  async function performValidation() {
    const user = await getCurrentUser();
    if (!user || typeof user.uid !== "string" || !user.uid) {
      transitionFailure("session-unavailable", "signed_out");
      throw new IdentityBridgeError("session-unavailable");
    }
    runtimeAuthenticatedUid = user.uid;
    if (state.linkStatus === "linked" && state.ownerId !== user.uid) {
      transitionFailure("account-mismatch", "account_mismatch");
      throw new IdentityBridgeError("account-mismatch");
    }
    if (user.emailVerified !== true) {
      transitionFailure("email-not-verified", "stale");
      throw new IdentityBridgeError("email-not-verified");
    }

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
      // Phase 5A: protected Cloud capability additionally requires THIS installation to be an authorized device of the
      // verified Owner (server-confirmed in the bootstrap `device` block). Identity alone never enables Cloud.
      if (typeof deviceGate === "function") await deviceGate(user, response.body);
      const validatedAt = isoNow(now);
      return persist({
        schemaVersion: IDENTITY_LINK_SCHEMA_VERSION,
        linkStatus: "linked",
        validationStatus: "validated",
        environment: TEST_ENVIRONMENT,
        projectId: TEST_PROJECT_ID,
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
      return transitionFailure("session-unavailable", "signed_out");
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
export const MAX_AUTHORIZED_DEVICES = 2;
const DEVICE_PLATFORMS = new Set(["web", "android", "ios"]);

function randomHex(randomBytes, byteLength) {
  const bytes = randomBytes(byteLength);
  if (!bytes || bytes.length !== byteLength) throw new IdentityBridgeError("device-credential-unavailable");
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Browser backend: a dedicated IndexedDB database with a single object store. `putIfAbsent` is one readwrite transaction,
// so two tabs can never create two different installation ids / owner keys.
export function createIdbCredentialBackend(indexedDBFactory) {
  if (!indexedDBFactory || typeof indexedDBFactory.open !== "function") throw new IdentityBridgeError("device-credential-unavailable");
  let opening = null;
  const open = () => {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const request = indexedDBFactory.open(DEVICE_CREDENTIAL_DB_NAME, 1);
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
  });
}

const DEVICE_LIMIT_CODES = new Set(["DEVICE_LIMIT_REACHED"]);
const DEVICE_AUTH_FAILURE_CODES = new Set(["device-authorization-required", "device-not-authorized", "device-revoked"]);

export function validateDeviceListContract(value) {
  if (!isRecord(value) || value.contractVersion !== COMMERCIAL_CONTRACT_VERSION || value.environment !== TEST_ENVIRONMENT ||
      value.maxAuthorizedDevices !== MAX_AUTHORIZED_DEVICES || !Array.isArray(value.devices) || value.devices.length > 64) {
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
  let state = { status: "signed_out", errorCode: null, maxAuthorizedDevices: MAX_AUTHORIZED_DEVICES };
  let refs = new Map();
  let classifyToken = 0;
  const subscribers = new Set();
  const snapshot = () => clone(state);
  function set(status, errorCode = null) {
    state = { status, errorCode, maxAuthorizedDevices: MAX_AUTHORIZED_DEVICES };
    for (const callback of subscribers) { try { callback(snapshot()); } catch { /* presentation only */ } }
  }
  const networkStatus = (code) => (code === "offline" ? "offline" : "unavailable");
  const isNetworkCode = (code) => code === "offline" || code === "verification-unavailable";

  async function classifyAuthFailure(uid) {
    const token = ++classifyToken;
    let credential = null;
    try { credential = await credentialStore.getCredential(uid); } catch { if (token === classifyToken) set("unavailable", "device-credential-unavailable"); return; }
    if (token !== classifyToken) return;
    if (!credential) { set("needs_enrollment", "device-enrollment-required"); return; }
    try {
      const devices = validateDeviceListContract(await ownerRequest("/v1/owner/devices"));
      if (token !== classifyToken) return;
      const mine = devices.find((device) => device.id === credential.deviceId);
      if (mine && mine.status === "revoked") set("revoked", "device-revoked");
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
    if (!user || typeof user.uid !== "string" || !user.uid) { classifyToken += 1; set("signed_out"); return; }
    if (!isRecord(identity)) return;
    if (identity.validationStatus === "validated") { classifyToken += 1; set("authorized"); return; }
    if (identity.validationStatus === "account_mismatch") { classifyToken += 1; set("account_mismatch", "account-mismatch"); return; }
    if (user.emailVerified !== true) { classifyToken += 1; set("email_unverified", "email-not-verified"); return; }
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

  async function enroll({ confirm, label, platform = "web" } = {}) {
    if (confirm !== true) throw new IdentityBridgeError("device-confirmation-required");
    const user = requireUser(); requireNoMismatch(); requireOnline();
    const trimmed = typeof label === "string" ? label.trim() : "";
    if (trimmed.length < 1 || trimmed.length > 80 || !DEVICE_PLATFORMS.has(platform)) throw new IdentityBridgeError("invalid-device-request");
    set("enrolling");
    let credential;
    try { credential = await credentialStore.createCredential(user.uid); }
    catch (error) { set("unavailable", "device-credential-unavailable"); throw error; }
    try {
      await ownerRequest("/v1/owner/devices/enroll", {
        method: "POST",
        body: { deviceId: credential.deviceId, label: trimmed, platform, deviceKey: credential.deviceKey, confirmRegistration: true },
      });
    } catch (error) {
      const code = error && error.code ? error.code : "verification-unavailable";
      if (DEVICE_LIMIT_CODES.has(code)) {
        // Never replace/auto-revoke another device and never keep generating identities: drop only the key created for this
        // attempt; the installation id is kept so a later explicit retry reuses it.
        if (credential.created) await credentialStore.deleteCredential(user.uid).catch(() => {});
        set("limit_reached", code);
      } else if (code === "device-policy-migration-required") {
        if (credential.created) await credentialStore.deleteCredential(user.uid).catch(() => {});
        set("migration_required", code);
      } else if (code === "device-revoked") set("revoked", code);
      else if (code === "device-credential-invalid" || code === "device-authorization-required") set("unauthorized", code);
      else if (code === "recent-authentication-required") set("reauth_required", code);
      else if (isNetworkCode(code)) set(networkStatus(code), code);
      else set("unavailable", code);
      throw error;
    }
    try { await revalidateIdentity(); } catch { /* the identity bridge persisted the fail-closed outcome; state derives from it */ }
    onIdentityState(getIdentityState());
    return snapshot();
  }

  async function listDevices() {
    const user = requireUser(); requireNoMismatch(); requireOnline();
    const devices = validateDeviceListContract(await ownerRequest("/v1/owner/devices"));
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
    try {
      await ownerRequest("/v1/owner/devices/reauthorize", { method: "POST", body: { deviceId, confirmReauthorize: true } });
    } catch (error) {
      if (error && error.code === "recent-authentication-required") set("reauth_required", error.code);
      throw error;
    }
    if ((await currentDeviceId(user.uid)) === deviceId) {
      try { await revalidateIdentity(); } catch { /* derived below */ }
      onIdentityState(getIdentityState());
    }
    return listDevices();
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
      if (value?.contractVersion !== COMMERCIAL_CONTRACT_VERSION || value?.environment !== TEST_ENVIRONMENT ||
          value?.cloudGroupId !== cloudGroupId) throw new IdentityBridgeError("player-contract-invalid");
      return value;
    },
    async upsertPlayer(envelope, { signal } = {}) {
      const value = await authorizedRequest("/v1/core/player-mutations", { body: envelope, method: "POST", signal });
      if (value?.contractVersion !== COMMERCIAL_CONTRACT_VERSION || value?.environment !== TEST_ENVIRONMENT) {
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

function unavailableAdapter(reason, state = unlinkedState(reason)) {
  return Object.freeze({
    available: false,
    reason,
    getCurrentOwner: () => null,
    getIdentityLinkState: () => clone(state),
    isIdentityValidated: () => false,
  });
}

// Module-level single-initialization guard: the adapter (and its single recovery listener) is created at most once.
let adapterInitializationStarted = false;

async function initializeBrowserAdapter() {
  if (adapterInitializationStarted) return;
  adapterInitializationStarted = true;
  let config;
  try {
    config = validateTestConfiguration(window.BadQCommercialConfig);
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
        backend: createIdbCredentialBackend(window.indexedDB),
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

    const bridge = createIdentityBridge({
      storage: window.localStorage,
      getCurrentUser: () => auth.currentUser,
      getFreshIdToken: getFreshProof,
      fetchBootstrap,
      deviceGate,
      online: () => navigator.onLine !== false,
    });

    const authorizedRequest = async (path, { body, idempotencyKey, signal, method } = {}) => {
      await bridge.validateLink();
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
        throw new IdentityBridgeError(code, response.status);
      }
      return value;
    };

    // Phase 5A Owner-account routes (device list / enroll / revoke / reauthorize). They carry the fresh Owner token ONLY —
    // never the device header — and stay usable after this device was revoked so the Owner can manage devices.
    const ownerRequest = async (path, { body, method } = {}) => {
      const proof = await getFreshProof(auth.currentUser);
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
      isIdentityValidated: bridge.isCloudIdentityValidated,
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
        if (value?.contractVersion !== COMMERCIAL_CONTRACT_VERSION || value?.environment !== TEST_ENVIRONMENT) {
          throw new IdentityBridgeError("group-contract-invalid");
        }
        return value.group;
      },
      validateCloudGroup: async (groupId) => {
        const value = await authorizedRequest("/v1/core/badminton-groups/validate", { body: { groupId } });
        if (value?.contractVersion !== COMMERCIAL_CONTRACT_VERSION || value?.environment !== TEST_ENVIRONMENT) {
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
        return { validated: bridge.isCloudIdentityValidated() === true, ownerId: state.ownerId, accountId: state.accountId };
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

    window.BadQCommercialBridge = Object.freeze({
      available: true,
      environment: TEST_ENVIRONMENT,
      projectId: TEST_PROJECT_ID,
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
