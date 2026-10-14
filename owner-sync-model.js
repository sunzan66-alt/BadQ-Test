// BadQ Core - Full Owner Sync data model (pure; no I/O). Projects the durable bg-v11 state into stable, individually versioned
// records and rebuilds a state from records (cross-device restore). Used only by PLUS / PRO / FOUNDER Owner Sync.
//
// Records are keyed "<source>/<id>" (source = the bg-v11 key), one per array item, so an edit sends ONLY the items that changed.
// Order of an id-array travels as a tiny "order/<source>" record (an insert at the front never rewrites every item).
//
// Never synced (device-local or non-business): localGroups (link evidence), cloudClub, lastIntentionalPlayerWipeAt, journalReceipts,
// restoreEpoch, savedAt, pageInstanceId. Private fields and inline images are stripped by policy (see stripPrivate); an Owner-approved
// allow-list can re-include named fields, default is none.

export const MODEL_VERSION = 1;
export const EXCLUDED_KEYS = Object.freeze(["localGroups", "cloudClub", "lastIntentionalPlayerWipeAt", "journalReceipts", "restoreEpoch", "savedAt", "pageInstanceId"]);
// source key -> collection label (group, players, sessions, matches, scores, history, finance)
export const SOURCE_COLLECTION = Object.freeze({
  players: "players",
  settings: "group", courtCount: "group", courtLabels: "group", mode: "group", roundNo: "group", groupDefaults: "group", rankingConfigs: "group", lockPairs: "group",
  session: "sessions", sessionHistory: "sessions",
  current: "matches", future: "matches",
  history: "history", rewardHistory: "history", tournamentHistory: "history", activeTournament: "scores",
  generalExpenses: "finance", otherIncome: "finance", discountCredits: "finance",
});
export const PRIVATE_PLAYER_FIELDS = Object.freeze(["phone", "tel", "lineId", "line", "email", "photo", "photoRef", "avatar", "note", "notes", "address", "birthday", "birthdate", "idCard", "nationalId"]);
const IMG = /^(data:image\/|@img:)/;

const isRecord = (v) => !!v && typeof v === "object" && !Array.isArray(v);

export function canonicalText(value) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (isRecord(v)) { const o = {}; for (const k of Object.keys(v).sort()) { if (v[k] !== undefined) o[k] = walk(v[k]); } return o; }
    return v;
  };
  return JSON.stringify(walk(value));
}
export async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const buf = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Deep copy removing inline images everywhere and private player fields; `approved` re-includes named private fields (default none).
export function stripPrivate(value, { approved = [] } = {}) {
  const allow = new Set(approved);
  const deny = new Set(PRIVATE_PLAYER_FIELDS.filter((f) => !allow.has(f)));
  const walk = (v, depth) => {
    if (depth > 12) return null;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1)).filter((x) => x !== undefined);
    if (isRecord(v)) {
      const o = {};
      for (const k of Object.keys(v)) {
        if (deny.has(k)) continue;
        const x = v[k];
        if (typeof x === "string" && IMG.test(x)) continue;
        if (x === undefined || typeof x === "function") continue;
        o[k] = walk(x, depth + 1);
      }
      return o;
    }
    if (typeof v === "string" && IMG.test(v)) return undefined;
    return v;
  };
  return walk(value, 0);
}

const idOf = (item) => (isRecord(item) && (typeof item.id === "string" || Number.isSafeInteger(item.id)) && String(item.id).length > 0 && String(item.id).length <= 120 ? String(item.id) : null);
const safeId = (id) => id.replace(/[\/]/g, "_");

// -> Map(key -> { key, source, collection, id, payload })
export function projectState(state, { approved = [] } = {}) {
  const out = new Map();
  if (!isRecord(state)) return out;
  const put = (source, id, payload, extra = {}) => out.set(`${source}/${id}`, { key: `${source}/${id}`, source, collection: extra.collection || SOURCE_COLLECTION[source], id, payload, ...(extra.kind ? { kind: extra.kind } : {}) });
  for (const source of Object.keys(SOURCE_COLLECTION)) {
    if (EXCLUDED_KEYS.includes(source) || !Object.prototype.hasOwnProperty.call(state, source)) continue;
    const v = state[source];
    if (Array.isArray(v)) {
      const ids = v.map(idOf);
      const unique = ids.every((x) => x !== null) && new Set(ids).size === ids.length;
      if (unique) {
        v.forEach((item, i) => put(source, safeId(ids[i]), stripPrivate(item, { approved }), { kind: "item" }));
        put("order", source, { ids: ids.map(safeId) }, { collection: SOURCE_COLLECTION[source], kind: "order" });
      } else put(source, "_all", { items: stripPrivate(v, { approved }) }, { kind: "blob" });
    } else put(source, "_value", { v: v === undefined ? null : stripPrivate(v, { approved }) }, { kind: "value" });
  }
  return out;
}

// Rebuild a state from cloud records on top of `base` (which supplies device-local keys and anything the cloud has never seen).
// records: iterable of { key, deleted?, payload }
export function buildStateFromRecords(records, base = {}) {
  const state = { ...base };
  const items = new Map(); const orders = new Map(); const blobs = new Map(); const values = new Map();
  for (const r of records) {
    if (!r || r.deleted || typeof r.key !== "string") continue;
    const slash = r.key.indexOf("/"); if (slash < 1) continue;
    const head = r.key.slice(0, slash); const tail = r.key.slice(slash + 1);
    if (head === "order") { if (r.payload && Array.isArray(r.payload.ids)) orders.set(tail, r.payload.ids); continue; }
    if (!Object.prototype.hasOwnProperty.call(SOURCE_COLLECTION, head)) continue; // unknown/foreign source: ignored, never applied
    if (tail === "_all") blobs.set(head, r.payload && r.payload.items);
    else if (tail === "_value") values.set(head, r.payload ? r.payload.v : null);
    else { if (!items.has(head)) items.set(head, new Map()); items.get(head).set(tail, r.payload); }
  }
  for (const [source, v] of values) state[source] = v;
  for (const [source, v] of blobs) if (Array.isArray(v)) state[source] = v;
  for (const [source, ids] of orders) if (!items.has(source) && ids.length === 0 && Object.prototype.hasOwnProperty.call(SOURCE_COLLECTION, source)) state[source] = [];
  for (const [source, map] of items) {
    const order = orders.get(source) || [];
    const arr = []; const seen = new Set();
    for (const id of order) if (map.has(id)) { arr.push(map.get(id)); seen.add(id); }
    for (const [id, payload] of map) if (!seen.has(id)) arr.push(payload);
    // merge private/local-only fields of an existing local item with the same id (stripped fields must never be erased by a restore)
    const local = Array.isArray(base[source]) ? new Map(base[source].map((x) => [idOf(x), x])) : new Map();
    state[source] = arr.map((p) => { const l = local.get(idOf(p)); return l ? { ...l, ...p } : p; });
  }
  return state;
}

export function countRecords(state) {
  let n = 0; for (const r of projectState(state).values()) if (r.kind !== "order") n += 1; return n;
}
