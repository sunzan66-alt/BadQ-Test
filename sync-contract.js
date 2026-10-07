(function installBadQSyncContract(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BadQSyncContract = Object.freeze(api);
})(typeof globalThis !== "undefined" ? globalThis : this, function createBadQSyncContract() {
  "use strict";

  const LOCAL_GROUP_SCHEMA_VERSION = 1;
  const SYNC_CONTRACT_VERSION = "1";
  const LOCAL_GROUP_ID_PATTERN = /^local_[A-Za-z0-9_-]{16,80}$/;
  const CLOUD_GROUP_ID_PATTERN = /^grp_[a-f0-9]{32}$/;
  const ENTITY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
  const MUTATION_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
  const MUTATION_HASH_PATTERN = /^[a-f0-9]{64}$/;
  const ENTITY_TYPES = new Set(["player", "active_session"]);
  const OPERATIONS = new Set(["upsert", "delete"]);

  function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeName(value) {
    if (typeof value !== "string") return null;
    const name = value.trim();
    if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) return null;
    return name;
  }

  function isLocalGroupId(value) {
    return typeof value === "string" && LOCAL_GROUP_ID_PATTERN.test(value);
  }

  function emptyLocalGroupRegistry() {
    return { schemaVersion: LOCAL_GROUP_SCHEMA_VERSION, records: [] };
  }

  function validLocalGroupRecord(record) {
    return isObject(record) &&
      Object.keys(record).every((key) => ["localGroupId", "name", "aliases", "createdAt", "updatedAt"].includes(key)) &&
      isLocalGroupId(record.localGroupId) && normalizeName(record.name) === record.name &&
      Array.isArray(record.aliases) && record.aliases.every((name) => normalizeName(name) === name) &&
      new Set(record.aliases).size === record.aliases.length && !record.aliases.includes(record.name) &&
      Number.isInteger(record.createdAt) && record.createdAt > 0 &&
      Number.isInteger(record.updatedAt) && record.updatedAt >= record.createdAt;
  }

  function validLocalGroupRegistry(value) {
    if (!isObject(value) || value.schemaVersion !== LOCAL_GROUP_SCHEMA_VERSION ||
        !Array.isArray(value.records) || !value.records.every(validLocalGroupRecord)) return false;
    return new Set(value.records.map((record) => record.localGroupId)).size === value.records.length;
  }

  function randomLocalGroupId(randomId) {
    if (typeof randomId !== "function") throw new Error("local-group-random-source-required");
    const raw = String(randomId()).replace(/[^A-Za-z0-9_-]/g, "");
    if (raw.length < 16 || raw.length > 80) throw new Error("local-group-random-source-invalid");
    return `local_${raw}`;
  }

  function collectLocalGroupSources(value) {
    const sources = [];
    const push = (nameValue, idValue) => {
      const name = normalizeName(nameValue);
      if (!name) return;
      sources.push({ name, localGroupId: isLocalGroupId(idValue) ? idValue : null });
    };
    if (isObject(value)) {
      push(value.session && value.session.name, value.session && value.session.localGroupId);
      for (const session of Array.isArray(value.sessionHistory) ? value.sessionHistory : []) {
        if (isObject(session)) push(session.name, session.localGroupId);
      }
      for (const name of Object.keys(isObject(value.groupDefaults) ? value.groupDefaults : {})) push(name, null);
      for (const name of Object.keys(isObject(value.rankingConfigs) ? value.rankingConfigs : {})) push(name, null);
    }
    const seen = new Set();
    return sources.filter((source) => {
      const key = `${source.localGroupId || "name"}\u0000${source.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function phase2RecordsFromRaw(raw) {
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!isObject(parsed) || !Array.isArray(parsed.records)) return [];
      return parsed.records.filter((record) => isObject(record) && isLocalGroupId(record.localGroupId) &&
        normalizeName(record.localGroupName) === record.localGroupName).map((record) => ({
          localGroupId: record.localGroupId,
          localGroupName: record.localGroupName,
        }));
    } catch {
      return [];
    }
  }

  function namesFor(record) {
    return [record.name, ...(record.aliases || [])];
  }

  function resolveLocalGroup(registry, selector) {
    if (!validLocalGroupRegistry(registry)) return { status: "invalid", record: null };
    if (isLocalGroupId(selector)) {
      const record = registry.records.find((item) => item.localGroupId === selector) || null;
      return { status: record ? "resolved" : "missing", record: record ? clone(record) : null };
    }
    const name = normalizeName(isObject(selector) ? selector.name : selector);
    if (!name) return { status: "invalid", record: null };
    const matches = registry.records.filter((record) => namesFor(record).includes(name));
    return matches.length === 1 ? { status: "resolved", record: clone(matches[0]) } :
      { status: matches.length > 1 ? "ambiguous" : "missing", record: null };
  }

  function migrateLocalGroupRegistry({ stored, sources, phase2Records, randomId, now = Date.now }) {
    if (stored != null && !validLocalGroupRegistry(stored)) {
      return {
        registry: emptyLocalGroupRegistry(),
        conflicts: [{ code: "local-group-registry-invalid", name: null }],
      };
    }
    const records = validLocalGroupRegistry(stored) ? clone(stored.records) : [];
    const conflicts = [];
    const usedIds = new Set(records.map((record) => record.localGroupId));
    const links = Array.isArray(phase2Records) ? phase2Records.filter((record) =>
      isObject(record) && isLocalGroupId(record.localGroupId) && normalizeName(record.localGroupName) === record.localGroupName) : [];

    const create = (id, name) => {
      const stamp = Math.max(1, Math.trunc(Number(now()) || Date.now()));
      const record = { localGroupId: id, name, aliases: [], createdAt: stamp, updatedAt: stamp };
      records.push(record); usedIds.add(id); return record;
    };

    for (const source of Array.isArray(sources) ? sources : []) {
      const name = normalizeName(source && source.name);
      if (!name) continue;
      const explicitId = isLocalGroupId(source.localGroupId) ? source.localGroupId : null;
      if (explicitId) {
        const byId = records.find((record) => record.localGroupId === explicitId);
        if (byId) {
          if (!namesFor(byId).includes(name)) {
            // Historical/restored records are evidence that this name belonged to the same ID, but they
            // are not authority to rename the current canonical display name. The live rename path calls
            // renameLocalGroup explicitly; migration only retains older names as lookup aliases.
            byId.aliases = Array.from(new Set([...byId.aliases, name]));
            byId.updatedAt = Math.max(byId.updatedAt, Math.trunc(Number(now()) || Date.now()));
          }
          continue;
        }
        create(explicitId, name);
        continue;
      }

      const byName = records.filter((record) => namesFor(record).includes(name));
      if (byName.length === 1) continue;
      if (byName.length > 1) { conflicts.push({ code: "local-group-name-ambiguous", name }); continue; }
      const linked = links.filter((record) => record.localGroupName === name);
      if (linked.length > 1) { conflicts.push({ code: "legacy-link-ambiguous", name }); continue; }
      if (linked.length === 1 && !usedIds.has(linked[0].localGroupId)) {
        create(linked[0].localGroupId, name);
        continue;
      }
      if (linked.length === 1 && usedIds.has(linked[0].localGroupId)) {
        const peer = records.find((record) => record.localGroupId === linked[0].localGroupId);
        if (!peer || !namesFor(peer).includes(name)) conflicts.push({ code: "legacy-link-id-conflict", name });
        continue;
      }
      let id;
      do { id = randomLocalGroupId(randomId); } while (usedIds.has(id));
      create(id, name);
    }

    return { registry: { schemaVersion: LOCAL_GROUP_SCHEMA_VERSION, records }, conflicts };
  }

  function renameLocalGroup(registry, localGroupId, nextNameValue, now = Date.now) {
    if (!validLocalGroupRegistry(registry) || !isLocalGroupId(localGroupId)) throw new Error("local-group-invalid");
    const nextName = normalizeName(nextNameValue);
    if (!nextName) throw new Error("local-group-name-invalid");
    const index = registry.records.findIndex((record) => record.localGroupId === localGroupId);
    if (index < 0) throw new Error("local-group-not-found");
    const current = registry.records[index];
    if (current.name === nextName) return clone(registry);
    const next = clone(registry);
    const record = next.records[index];
    record.aliases = Array.from(new Set([...record.aliases, record.name])).filter((name) => name !== nextName);
    record.name = nextName;
    record.updatedAt = Math.max(record.updatedAt, Math.trunc(Number(now()) || Date.now()));
    return next;
  }

  function mergeLocalGroupRegistries(primary, incoming, now = Date.now) {
    if (!validLocalGroupRegistry(primary) || !validLocalGroupRegistry(incoming)) {
      return { ok: false, code: "local-group-registry-invalid" };
    }
    const next = clone(primary);
    for (const candidate of incoming.records) {
      const peer = next.records.find((record) => record.localGroupId === candidate.localGroupId);
      if (!peer) {
        next.records.push(clone(candidate));
        continue;
      }
      const allNames = new Set([...namesFor(peer), ...namesFor(candidate)]);
      allNames.delete(peer.name);
      peer.aliases = Array.from(allNames);
      peer.updatedAt = Math.max(peer.updatedAt, candidate.updatedAt, Math.trunc(Number(now()) || Date.now()));
    }
    return { ok: true, registry: next };
  }

  // ---- Phase 4C: player-specific compatibility validators ---------------------------------------------------------
  // Byte-for-byte the same rules as Commercial functions/src/sync-contract.ts `validPlayerId` and
  // functions/src/players.ts `parsePlayerPayload` (frozen Phase 4 contract section 2/3). `active_session` keeps the
  // original ASCII entityId pattern; only entityType "player" uses the player-specific validator.
  const FORBIDDEN_PLAYER_ID_NAMES = new Set([...Object.getOwnPropertyNames(Object.prototype), "prototype"]);
  const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;
  const PLAYER_PAYLOAD_KEYS = ["displayName", "skillIndex", "archived"];

  function hasOnlyPairedSurrogates(value) {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        index += 1;
        const next = value.charCodeAt(index);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      } else if (code >= 0xdc00 && code <= 0xdfff) return false;
    }
    return true;
  }

  function utf8Length(value) {
    return new TextEncoder().encode(value).length;
  }

  function isValidPlayerId(value) {
    if (typeof value !== "string" || value.trim().length === 0 || !hasOnlyPairedSurrogates(value)) return false;
    const bytes = utf8Length(value);
    if (bytes < 1 || bytes > 256) return false;
    return !CONTROL_OR_FORMAT.test(value) && !FORBIDDEN_PLAYER_ID_NAMES.has(value);
  }

  function validatePlayerPayload(value) {
    if (!isObject(value) || Object.keys(value).length !== 3 || Object.keys(value).some((key) => !PLAYER_PAYLOAD_KEYS.includes(key)) ||
        typeof value.displayName !== "string" || value.displayName.trim().length === 0 ||
        !hasOnlyPairedSurrogates(value.displayName) || [...value.displayName].length > 120 ||
        utf8Length(value.displayName) > 512 || CONTROL_OR_FORMAT.test(value.displayName) ||
        !Number.isInteger(value.skillIndex) || value.skillIndex < 1 || value.skillIndex > 11 ||
        typeof value.archived !== "boolean") return null;
    return { displayName: value.displayName, skillIndex: value.skillIndex, archived: value.archived };
  }

  function validateSyncEnvelope(value) {
    if (!isObject(value) || Object.keys(value).some((key) => ![
      "contractVersion", "schemaVersion", "localGroupId", "cloudGroupId", "entityType",
      "entityId", "expectedRevision", "operation", "payload", "clientMutationId",
    ].includes(key))) return { ok: false, code: "sync-contract-invalid" };
    if (value.contractVersion !== SYNC_CONTRACT_VERSION) return { ok: false, code: "sync-contract-version-unsupported" };
    if (value.schemaVersion !== 1) return { ok: false, code: "sync-schema-version-unsupported" };
    if (
      !isLocalGroupId(value.localGroupId) || !CLOUD_GROUP_ID_PATTERN.test(value.cloudGroupId) ||
      !ENTITY_TYPES.has(value.entityType) ||
      (value.entityType === "player" ? !isValidPlayerId(value.entityId)
        : typeof value.entityId !== "string" || !ENTITY_ID_PATTERN.test(value.entityId)) ||
      !Number.isInteger(value.expectedRevision) || value.expectedRevision < 0 ||
      !OPERATIONS.has(value.operation) || !MUTATION_ID_PATTERN.test(value.clientMutationId) ||
      (value.operation === "upsert" ? !isObject(value.payload) : value.payload !== null)) {
      return { ok: false, code: "sync-contract-invalid" };
    }
    return { ok: true, envelope: clone(value) };
  }

  // Phase 4C: the strict envelope a Players Sync mutation may use - upsert only, approved payload only.
  function validatePlayerMutationEnvelope(value) {
    const parsed = validateSyncEnvelope(value);
    if (!parsed.ok) return parsed;
    const envelope = parsed.envelope;
    if (envelope.entityType !== "player" || envelope.operation !== "upsert") return { ok: false, code: "sync-contract-invalid" };
    const payload = validatePlayerPayload(envelope.payload);
    if (!payload) return { ok: false, code: "sync-contract-invalid" };
    return { ok: true, envelope: { ...envelope, payload } };
  }

  function decideRevisionTransition(current, envelope, trustedMutationHash) {
    const parsed = validateSyncEnvelope(envelope);
    if (!parsed.ok) return parsed;
    if (typeof trustedMutationHash !== "string" || !MUTATION_HASH_PATTERN.test(trustedMutationHash)) {
      return { ok: false, code: "sync-contract-invalid" };
    }
    if (current != null && (!isObject(current) || !Number.isInteger(current.revision) || current.revision < 1 ||
        typeof current.deleted !== "boolean" ||
        (current.lastMutationId == null) !== (current.lastMutationHash == null) ||
        (current.lastMutationId != null && (!MUTATION_ID_PATTERN.test(current.lastMutationId) ||
          !MUTATION_HASH_PATTERN.test(current.lastMutationHash))))) {
      return { ok: false, code: "sync-current-invalid" };
    }
    if (current && current.lastMutationId === envelope.clientMutationId) {
      if (current.lastMutationHash !== trustedMutationHash) {
        return { ok: false, code: "sync-idempotency-conflict", currentRevision: current.revision, deleted: current.deleted };
      }
      return { ok: true, replay: true, revision: current.revision, deleted: current.deleted };
    }
    const currentRevision = current ? current.revision : 0;
    if (envelope.expectedRevision !== currentRevision) {
      return { ok: false, code: "sync-conflict", currentRevision, deleted: !!(current && current.deleted) };
    }
    if (current && current.deleted && envelope.operation === "upsert") {
      return { ok: false, code: "sync-entity-deleted", currentRevision, deleted: true };
    }
    return {
      ok: true,
      replay: false,
      revision: currentRevision + 1,
      deleted: envelope.operation === "delete",
      lastMutationId: envelope.clientMutationId,
      lastMutationHash: trustedMutationHash,
    };
  }

  return {
    LOCAL_GROUP_SCHEMA_VERSION,
    SYNC_CONTRACT_VERSION,
    LOCAL_GROUP_ID_PATTERN,
    CLOUD_GROUP_ID_PATTERN,
    emptyLocalGroupRegistry,
    validLocalGroupRegistry,
    isLocalGroupId,
    normalizeLocalGroupName: normalizeName,
    randomLocalGroupId,
    collectLocalGroupSources,
    phase2RecordsFromRaw,
    resolveLocalGroup,
    migrateLocalGroupRegistry,
    renameLocalGroup,
    mergeLocalGroupRegistries,
    validateSyncEnvelope,
    isValidPlayerId,
    validatePlayerPayload,
    validatePlayerMutationEnvelope,
    PLAYER_PAYLOAD_KEYS,
    decideRevisionTransition,
  };
});
