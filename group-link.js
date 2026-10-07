// BadQ Web Sync Phase 2 — isolated local-to-Cloud Badminton Group linkage.
//
// This module never reads or writes bg-v11, the Critical Journal, Backup/Restore or Firestore. Phase 3
// makes localGroupId the only local selector; localGroupName is display metadata and may change without
// changing the link. Ownership always comes from the freshly validated Commercial Identity Bridge.

export const GROUP_LINK_STORAGE_KEY = "badq-commercial-group-links-v1";
export const GROUP_LINK_SCHEMA_VERSION = 2;
export const GROUP_LINK_CONTRACT_VERSION = "1";
export const SYNC_CONTRACT_VERSION = "1";
export const GROUP_LINK_ENVIRONMENT = "TEST";
export const GROUP_LINK_PROJECT_ID = "badq-commercial-test";

const LINK_STATUSES = new Set(["linked", "unlinked"]);
const VALIDATION_STATUSES = new Set([
  "validated", "stale", "offline", "deleted", "account_mismatch", "unlinked",
]);
const cloudGroupIdPattern = /^grp_[a-f0-9]{32}$/;
const stateKeys = new Set(["schemaVersion", "environment", "projectId", "contractVersion", "records"]);
const recordKeysV1 = new Set([
  "localGroupId", "localGroupName", "ownerId", "accountId", "cloudGroupId",
  "cloudGroupDisplayName", "linkStatus", "validationStatus", "environment", "projectId",
  "contractVersion", "linkedAt", "lastValidatedAt", "lastErrorCode",
]);
const recordKeys = new Set([...recordKeysV1, "syncContractVersion"]);

export class GroupLinkError extends Error {
  constructor(code) {
    super(code);
    this.name = "GroupLinkError";
    this.code = code;
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

function validIso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function normalizeLocalGroupName(value) {
  if (typeof value !== "string") throw new GroupLinkError("local-group-invalid");
  const name = value.trim();
  if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new GroupLinkError("local-group-invalid");
  }
  return name;
}

function validRecordShape(record, keys, requireSyncVersion) {
  if (!isRecord(record) || Object.keys(record).some((key) => !keys.has(key)) ||
      typeof record.localGroupId !== "string" || !/^local_[A-Za-z0-9_-]{16,80}$/.test(record.localGroupId) ||
      typeof record.localGroupName !== "string" || record.localGroupName.length === 0 || record.localGroupName.length > 120 ||
      /[\u0000-\u001f\u007f]/.test(record.localGroupName) ||
      typeof record.ownerId !== "string" || !record.ownerId || typeof record.accountId !== "string" || !record.accountId ||
      record.accountId !== record.ownerId ||
      !LINK_STATUSES.has(record.linkStatus) || !VALIDATION_STATUSES.has(record.validationStatus) ||
      record.environment !== GROUP_LINK_ENVIRONMENT || record.projectId !== GROUP_LINK_PROJECT_ID ||
      record.contractVersion !== GROUP_LINK_CONTRACT_VERSION ||
      (requireSyncVersion && record.syncContractVersion !== SYNC_CONTRACT_VERSION) ||
      (record.lastValidatedAt !== null && !validIso(record.lastValidatedAt)) ||
      (record.linkedAt !== null && !validIso(record.linkedAt)) ||
      (record.lastErrorCode !== null && typeof record.lastErrorCode !== "string")) return false;
  if (record.linkStatus === "linked") {
    return cloudGroupIdPattern.test(record.cloudGroupId) &&
      typeof record.cloudGroupDisplayName === "string" && record.cloudGroupDisplayName.length > 0 &&
      record.cloudGroupDisplayName.length <= 80 && !/[\u0000-\u001f\u007f]/.test(record.cloudGroupDisplayName) &&
      record.validationStatus !== "unlinked" && validIso(record.linkedAt);
  }
  return record.cloudGroupId === null && record.cloudGroupDisplayName === null &&
    record.linkedAt === null && record.validationStatus === "unlinked";
}

function validRecord(record) {
  return validRecordShape(record, recordKeys, true);
}

function validV1Record(record) {
  return validRecordShape(record, recordKeysV1, false);
}

function emptyState() {
  return {
    schemaVersion: GROUP_LINK_SCHEMA_VERSION,
    environment: GROUP_LINK_ENVIRONMENT,
    projectId: GROUP_LINK_PROJECT_ID,
    contractVersion: GROUP_LINK_CONTRACT_VERSION,
    records: [],
  };
}

function validState(value) {
  if (!isRecord(value) || Object.keys(value).some((key) => !stateKeys.has(key)) ||
      value.schemaVersion !== GROUP_LINK_SCHEMA_VERSION ||
      value.environment !== GROUP_LINK_ENVIRONMENT || value.projectId !== GROUP_LINK_PROJECT_ID ||
      value.contractVersion !== GROUP_LINK_CONTRACT_VERSION || !Array.isArray(value.records) ||
      !value.records.every(validRecord)) return false;
  const ids = new Set();
  const cloudIds = new Set();
  for (const record of value.records) {
    if (ids.has(record.localGroupId)) return false;
    if (record.linkStatus === "linked" && cloudIds.has(record.cloudGroupId)) return false;
    ids.add(record.localGroupId);
    if (record.linkStatus === "linked") cloudIds.add(record.cloudGroupId);
  }
  return true;
}

function validV1State(value) {
  if (!isRecord(value) || Object.keys(value).some((key) => !stateKeys.has(key)) ||
      value.schemaVersion !== 1 || value.environment !== GROUP_LINK_ENVIRONMENT ||
      value.projectId !== GROUP_LINK_PROJECT_ID || value.contractVersion !== GROUP_LINK_CONTRACT_VERSION ||
      !Array.isArray(value.records) || !value.records.every(validV1Record)) return false;
  const ids = new Set(), names = new Set(), cloudIds = new Set();
  for (const record of value.records) {
    if (ids.has(record.localGroupId) || names.has(record.localGroupName)) return false;
    if (record.linkStatus === "linked" && cloudIds.has(record.cloudGroupId)) return false;
    ids.add(record.localGroupId); names.add(record.localGroupName);
    if (record.linkStatus === "linked") cloudIds.add(record.cloudGroupId);
  }
  return true;
}

function migrateV1State(value) {
  return {
    ...value,
    schemaVersion: GROUP_LINK_SCHEMA_VERSION,
    records: value.records.map((record) => ({ ...record, syncContractVersion: SYNC_CONTRACT_VERSION })),
  };
}

function normalizeCloudGroup(value) {
  if (!isRecord(value) || !cloudGroupIdPattern.test(value.groupId) ||
      typeof value.displayName !== "string" || !value.displayName || value.displayName.length > 80 ||
      /[\u0000-\u001f\u007f]/.test(value.displayName) ||
      value.status !== "active") throw new GroupLinkError("group-contract-invalid");
  return { groupId: value.groupId, displayName: value.displayName, status: "active" };
}

export function validateCloudGroupList(value) {
  if (!Array.isArray(value)) throw new GroupLinkError("group-contract-invalid");
  const groups = value.map(normalizeCloudGroup);
  if (new Set(groups.map((group) => group.groupId)).size !== groups.length) {
    throw new GroupLinkError("group-contract-invalid");
  }
  return groups;
}

export function createGroupLinkBridge({
  storage,
  getIdentityState,
  isIdentityValidated,
  listCloudGroups,
  createCloudGroup,
  validateCloudGroup,
  randomId,
  now = Date.now,
  online = () => true,
}) {
  if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function" ||
      typeof getIdentityState !== "function" || typeof isIdentityValidated !== "function" ||
      typeof listCloudGroups !== "function" || typeof createCloudGroup !== "function" ||
      typeof validateCloudGroup !== "function" || typeof randomId !== "function") {
    throw new GroupLinkError("group-link-dependency-invalid");
  }

  let state;
  let migrationBlocked = false;
  try {
    const raw = storage.getItem(GROUP_LINK_STORAGE_KEY);
    const parsed = raw === null ? emptyState() : JSON.parse(raw);
    if (validState(parsed)) state = parsed;
    else if (validV1State(parsed)) {
      state = migrateV1State(parsed);
      storage.setItem(GROUP_LINK_STORAGE_KEY, JSON.stringify(state));
    } else {
      state = emptyState();
      migrationBlocked = raw !== null;
    }
  } catch {
    state = emptyState();
    migrationBlocked = true;
  }
  // Cached success never authorizes a new browser process.
  state = {
    ...state,
    records: state.records.map((record) => record.linkStatus === "linked"
      ? { ...record, validationStatus: "stale", lastErrorCode: "validation-required" }
      : record),
  };

  const validatedLocalIds = new Set();
  const pendingCreateKeys = new Map();
  const subscribers = new Set();
  let operationQueue = Promise.resolve();

  function emit() {
    const snapshot = clone(state);
    for (const callback of subscribers) {
      try { callback(snapshot); } catch { /* presentation listeners cannot affect linkage */ }
    }
  }

  function persist(next) {
    if (migrationBlocked) throw new GroupLinkError("group-link-migration-required");
    try { storage.setItem(GROUP_LINK_STORAGE_KEY, JSON.stringify(next)); }
    catch { throw new GroupLinkError("storage-unavailable"); }
    state = next;
    emit();
  }

  function replaceRecord(localGroupId, nextRecord) {
    persist({ ...state, records: state.records.map((record) =>
      record.localGroupId === localGroupId ? nextRecord : record) });
  }

  function identity() {
    if (migrationBlocked) throw new GroupLinkError("group-link-migration-required");
    const current = getIdentityState();
    if (!isIdentityValidated() || !isRecord(current) || current.linkStatus !== "linked" ||
        current.validationStatus !== "validated" || current.environment !== GROUP_LINK_ENVIRONMENT ||
        current.projectId !== GROUP_LINK_PROJECT_ID || current.contractVersion !== GROUP_LINK_CONTRACT_VERSION ||
        typeof current.ownerId !== "string" || !current.ownerId || current.accountId !== current.ownerId) {
      throw new GroupLinkError("identity-not-validated");
    }
    return { ownerId: current.ownerId, accountId: current.accountId };
  }

  function recordFor(selector) {
    const localGroupId = typeof selector === "string" ? selector : selector?.localGroupId;
    if (typeof localGroupId !== "string" || !/^local_[A-Za-z0-9_-]{16,80}$/.test(localGroupId)) {
      throw new GroupLinkError("local-group-invalid");
    }
    return state.records.find((record) => record.localGroupId === localGroupId) || null;
  }

  function ensureOwner(record, currentIdentity) {
    if (record.ownerId !== currentIdentity.ownerId || record.accountId !== currentIdentity.accountId) {
      validatedLocalIds.delete(record.localGroupId);
      replaceRecord(record.localGroupId, {
        ...record, validationStatus: "account_mismatch", lastErrorCode: "account-mismatch",
      });
      throw new GroupLinkError("account-mismatch");
    }
  }

  function enqueue(operation) {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.catch(() => {});
    return result;
  }

  function failureCode(error) {
    if (online() === false) return "offline";
    return typeof error?.code === "string" ? error.code : "group-verification-unavailable";
  }

  async function listGroups() {
    identity();
    return validateCloudGroupList(await listCloudGroups());
  }

  async function linkExisting({ localGroupId, localGroupName, cloudGroupId }) {
    return enqueue(async () => {
      const currentIdentity = identity();
      const name = normalizeLocalGroupName(localGroupName);
      if (typeof localGroupId !== "string" || !/^local_[A-Za-z0-9_-]{16,80}$/.test(localGroupId)) {
        throw new GroupLinkError("local-group-invalid");
      }
      if (!cloudGroupIdPattern.test(cloudGroupId)) throw new GroupLinkError("group-contract-invalid");
      const existing = state.records.find((record) => record.localGroupId === localGroupId) || null;
      if (existing) {
        ensureOwner(existing, currentIdentity);
        if (existing.linkStatus === "linked" && existing.cloudGroupId !== cloudGroupId) {
          throw new GroupLinkError("group-link-conflict");
        }
      }
      const reusedCloudTarget = state.records.find((record) => record.localGroupId !== localGroupId &&
        record.linkStatus === "linked" && record.cloudGroupId === cloudGroupId);
      if (reusedCloudTarget) throw new GroupLinkError("cloud-group-already-linked");
      let group;
      try { group = normalizeCloudGroup(await validateCloudGroup(cloudGroupId)); }
      catch (error) {
        const code = failureCode(error);
        if (existing?.linkStatus === "linked") {
          replaceRecord(existing.localGroupId, {
            ...existing,
            validationStatus: code === "offline" ? "offline" : code === "group-not-found" ? "deleted" : "stale",
            lastErrorCode: code,
          });
        }
        throw error instanceof GroupLinkError ? error : new GroupLinkError(code);
      }
      const linkedAt = existing?.linkStatus === "linked" ? existing.linkedAt : isoNow(now);
      const record = {
        localGroupId,
        localGroupName: name,
        ownerId: currentIdentity.ownerId,
        accountId: currentIdentity.accountId,
        cloudGroupId: group.groupId,
        cloudGroupDisplayName: group.displayName,
        linkStatus: "linked",
        validationStatus: "validated",
        environment: GROUP_LINK_ENVIRONMENT,
        projectId: GROUP_LINK_PROJECT_ID,
        contractVersion: GROUP_LINK_CONTRACT_VERSION,
        syncContractVersion: SYNC_CONTRACT_VERSION,
        linkedAt,
        lastValidatedAt: isoNow(now),
        lastErrorCode: null,
      };
      if (existing) replaceRecord(existing.localGroupId, record);
      else persist({ ...state, records: [...state.records, record] });
      validatedLocalIds.add(record.localGroupId);
      return clone(record);
    });
  }

  async function createAndLink({ localGroupId, localGroupName, displayName = localGroupName }) {
    return enqueue(async () => {
      const currentIdentity = identity();
      const name = normalizeLocalGroupName(localGroupName);
      if (typeof localGroupId !== "string" || !/^local_[A-Za-z0-9_-]{16,80}$/.test(localGroupId)) {
        throw new GroupLinkError("local-group-invalid");
      }
      const existing = state.records.find((record) => record.localGroupId === localGroupId) || null;
      if (existing) {
        ensureOwner(existing, currentIdentity);
        if (existing.linkStatus === "linked") throw new GroupLinkError("group-link-conflict");
      }
      const cloudName = normalizeLocalGroupName(displayName);
      const createKey = pendingCreateKeys.get(localGroupId) || String(randomId()).replace(/[^A-Za-z0-9_-]/g, "");
      if (createKey.length < 22 || createKey.length > 128) throw new GroupLinkError("random-id-invalid");
      pendingCreateKeys.set(localGroupId, createKey);
      let group;
      try {
        group = normalizeCloudGroup(await createCloudGroup(cloudName, createKey));
        pendingCreateKeys.delete(localGroupId);
      }
      catch (error) {
        const code = failureCode(error);
        throw error instanceof GroupLinkError ? error : new GroupLinkError(code);
      }
      const timestamp = isoNow(now);
      const record = {
        localGroupId,
        localGroupName: name,
        ownerId: currentIdentity.ownerId,
        accountId: currentIdentity.accountId,
        cloudGroupId: group.groupId,
        cloudGroupDisplayName: group.displayName,
        linkStatus: "linked",
        validationStatus: "validated",
        environment: GROUP_LINK_ENVIRONMENT,
        projectId: GROUP_LINK_PROJECT_ID,
        contractVersion: GROUP_LINK_CONTRACT_VERSION,
        syncContractVersion: SYNC_CONTRACT_VERSION,
        linkedAt: timestamp,
        lastValidatedAt: timestamp,
        lastErrorCode: null,
      };
      if (existing) replaceRecord(existing.localGroupId, record);
      else persist({ ...state, records: [...state.records, record] });
      validatedLocalIds.add(record.localGroupId);
      return clone(record);
    });
  }

  async function validateLink(selector) {
    return enqueue(async () => {
      const currentIdentity = identity();
      const record = recordFor(selector);
      if (!record || record.linkStatus !== "linked") throw new GroupLinkError("group-link-not-found");
      ensureOwner(record, currentIdentity);
      try {
        const group = normalizeCloudGroup(await validateCloudGroup(record.cloudGroupId));
        const next = {
          ...record,
          cloudGroupDisplayName: group.displayName,
          validationStatus: "validated",
          lastValidatedAt: isoNow(now),
          lastErrorCode: null,
        };
        replaceRecord(record.localGroupId, next);
        validatedLocalIds.add(record.localGroupId);
        return clone(next);
      } catch (error) {
        const code = failureCode(error);
        validatedLocalIds.delete(record.localGroupId);
        replaceRecord(record.localGroupId, {
          ...record,
          validationStatus: code === "offline" ? "offline" : code === "group-not-found" ? "deleted" : "stale",
          lastErrorCode: code,
        });
        throw error instanceof GroupLinkError ? error : new GroupLinkError(code);
      }
    });
  }

  async function unlink(selector, options = {}) {
    return enqueue(async () => {
      if (options.explicit !== true) throw new GroupLinkError("explicit-unlink-required");
      const currentIdentity = identity();
      const record = recordFor(selector);
      if (!record) throw new GroupLinkError("group-link-not-found");
      ensureOwner(record, currentIdentity);
      const next = {
        ...record,
        cloudGroupId: null,
        cloudGroupDisplayName: null,
        linkStatus: "unlinked",
        validationStatus: "unlinked",
        linkedAt: null,
        lastErrorCode: null,
      };
      validatedLocalIds.delete(record.localGroupId);
      replaceRecord(record.localGroupId, next);
      return clone(next);
    });
  }

  function reconcileLocalGroups(groups) {
    if (migrationBlocked) throw new GroupLinkError("group-link-migration-required");
    if (!Array.isArray(groups)) throw new GroupLinkError("local-group-invalid");
    const byId = new Map();
    for (const group of groups) {
      if (!isRecord(group) || typeof group.localGroupId !== "string" ||
          !/^local_[A-Za-z0-9_-]{16,80}$/.test(group.localGroupId)) throw new GroupLinkError("local-group-invalid");
      byId.set(group.localGroupId, normalizeLocalGroupName(group.name));
    }
    let changed = false;
    const records = state.records.map((record) => {
      const name = byId.get(record.localGroupId);
      if (!name || name === record.localGroupName) return record;
      changed = true;
      return { ...record, localGroupName: name };
    });
    if (changed) persist({ ...state, records });
    return clone(records);
  }

  function markAllStale(reason = "validation-required") {
    if (migrationBlocked) return;
    validatedLocalIds.clear();
    const records = state.records.map((record) => record.linkStatus === "linked"
      ? { ...record, validationStatus: "stale", lastErrorCode: reason }
      : record);
    persist({ ...state, records });
  }

  return Object.freeze({
    getState: () => ({ ...clone(state), migrationStatus: migrationBlocked ? "blocked" : "ready" }),
    getRecords: () => clone(state.records),
    listGroups,
    linkExisting,
    createAndLink,
    validateLink,
    unlink,
    reconcileLocalGroups,
    markAllStale,
    isGroupLinkValidated(selector) {
      const record = recordFor(selector);
      if (!record || !validatedLocalIds.has(record.localGroupId) || !isIdentityValidated()) return false;
      const current = getIdentityState();
      return record.linkStatus === "linked" && record.validationStatus === "validated" &&
        record.ownerId === current.ownerId && record.accountId === current.accountId;
    },
    subscribe(callback) {
      if (typeof callback !== "function") throw new GroupLinkError("subscriber-invalid");
      subscribers.add(callback);
      try { callback(clone(state)); } catch { /* isolate presentation */ }
      return () => subscribers.delete(callback);
    },
  });
}
