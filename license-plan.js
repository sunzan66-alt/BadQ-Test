// BadQ Core - commercial plan model (pure, no I/O, no Firebase, no DOM).
//
// Plans (Owner-approved launch architecture):
//   BAD_Q               THB 399 lifetime, 1 device, 3-day trial, online activation once then offline forever, NO Cloud Sync.
//   PLUS                THB 119/month, 2 devices, offline-first + automatic full Owner Cloud Sync.
//   PRO                 THB 189/month, 3 Owner devices, Plus features + Member Portal.
//   FOUNDER_ALL_ACCESS  approved original testers: all present and future highest-tier features, lifetime, currently 3 devices.
//
// CONTRACT STATUS: the final Commercial plan/entitlement wire schema has NOT been delivered to Core. Everything that reads wire
// field names lives in parseLicenseProjection() below and is marked PENDING-CONTRACT. It accepts an OPTIONAL `license` object
// next to the existing frozen `plans` / `entitlements` bootstrap fields and otherwise falls back to the existing FULL / ONLINE
// early-access projection. Nothing here invents an endpoint.
//
// Policy: capacity and features come from the PLAN (and a server-supplied deviceLimit), never from a constant. Expiry never deletes
// or hides local data; Core enforces no offline hard lock (not approved).

export const PLAN_IDS = Object.freeze(["BAD_Q", "PLUS", "PRO", "FOUNDER_ALL_ACCESS"]);
export const LEGACY_PLAN_ID = "EARLY_ACCESS_LEGACY";
export const MAX_SANE_DEVICE_LIMIT = 16;

export const PLAN_CATALOG = Object.freeze({
  BAD_Q: Object.freeze({ id: "BAD_Q", lifetime: true, trialDays: 3, deviceLimit: 1, ownerCloudSync: false, memberPortal: false, offlineAfterActivation: true }),
  PLUS: Object.freeze({ id: "PLUS", lifetime: false, trialDays: 0, deviceLimit: 2, ownerCloudSync: true, memberPortal: false, offlineAfterActivation: false }),
  PRO: Object.freeze({ id: "PRO", lifetime: false, trialDays: 0, deviceLimit: 3, ownerCloudSync: true, memberPortal: true, offlineAfterActivation: false }),
  FOUNDER_ALL_ACCESS: Object.freeze({ id: "FOUNDER_ALL_ACCESS", lifetime: true, trialDays: 0, deviceLimit: 3, ownerCloudSync: true, memberPortal: true, offlineAfterActivation: false }),
  // Existing Early Access projection (FULL/ONLINE) until the Commercial backend serves `license`: ONLINE-equivalent behaviour, 2 devices.
  [LEGACY_PLAN_ID]: Object.freeze({ id: LEGACY_PLAN_ID, lifetime: false, trialDays: 0, deviceLimit: 2, ownerCloudSync: true, memberPortal: false, offlineAfterActivation: false }),
});

export const LICENSE_STATES = Object.freeze(["none", "trial", "active", "grace", "expired", "revoked", "released", "unverified", "invalid"]);
const SERVER_STATES = new Set(["trial", "active", "grace", "expired", "revoked", "released"]);
const isRecord = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isIso = (v) => typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));

export function deviceCapacity(planId, serverLimit) {
  const plan = PLAN_CATALOG[planId];
  if (Number.isSafeInteger(serverLimit) && serverLimit >= 1 && serverLimit <= MAX_SANE_DEVICE_LIMIT) return serverLimit; // server is authoritative
  return plan ? plan.deviceLimit : 1;
}

// PENDING-CONTRACT: optional `license` block. Shape assumed (isolated here only):
//   { planId, status: trial|active|grace|expired|revoked|released, validUntil: ISO|null, trialEndsAt: ISO|null, lifetime: boolean,
//     deviceLimit: integer, renewal: { autoRenew: boolean, nextRenewalAt: ISO|null, cancelAtPeriodEnd: boolean } | null }
// Returns { ok:true, license } or { ok:false, code }.
export function parseLicenseProjection(body) {
  if (!isRecord(body) || body.license === undefined) return { ok: true, license: null };
  const l0 = body.license;
  const l = isRecord(l0) && l0.planId === "BAD_Q_LIFETIME" ? { ...l0, planId: "BAD_Q" } : l0; // contract alias: BAD_Q_LIFETIME == BAD_Q
  if (!isRecord(l) || !PLAN_IDS.includes(l.planId) || !SERVER_STATES.has(l.status)) return { ok: false, code: "license-contract-invalid" };
  if (!(l.validUntil === null || l.validUntil === undefined || isIso(l.validUntil))) return { ok: false, code: "license-contract-invalid" };
  if (!(l.trialEndsAt === null || l.trialEndsAt === undefined || isIso(l.trialEndsAt))) return { ok: false, code: "license-contract-invalid" };
  if (l.deviceLimit !== undefined && !(Number.isSafeInteger(l.deviceLimit) && l.deviceLimit >= 1 && l.deviceLimit <= MAX_SANE_DEVICE_LIMIT)) return { ok: false, code: "license-contract-invalid" };
  let renewal = null;
  if (l.renewal !== undefined && l.renewal !== null) {
    const r = l.renewal;
    if (!isRecord(r) || typeof r.autoRenew !== "boolean" || !(r.nextRenewalAt === null || r.nextRenewalAt === undefined || isIso(r.nextRenewalAt)) ||
        (r.cancelAtPeriodEnd !== undefined && typeof r.cancelAtPeriodEnd !== "boolean")) return { ok: false, code: "license-contract-invalid" };
    renewal = { autoRenew: r.autoRenew, nextRenewalAt: r.nextRenewalAt || null, cancelAtPeriodEnd: r.cancelAtPeriodEnd === true };
  }
  return { ok: true, license: { planId: l.planId, status: l.status, validUntil: l.validUntil || null, trialEndsAt: l.trialEndsAt || null,
    lifetime: l.lifetime === true, deviceLimit: l.deviceLimit === undefined ? null : l.deviceLimit, renewal } };
}

// Maps a verified entitlement-manager state (+ optional parsed license) to what the UI/engines may rely on.
//   entitlement: { status: granted|none|expired|revoked|unverified|invalid, validUntil, fromServer, lastVerified }
//   license:     result of parseLicenseProjection().license or null
//   nowMs:       server-skew-corrected "now"
export function deriveLicenseView({ entitlement = null, license = null, serverDeviceLimit = null, nowMs = Date.now() } = {}) {
  const ent = entitlement || { status: "unverified" };
  let planId = null; let state = "none"; let validUntil = null; let trialEndsAt = null; let renewal = null; let lifetime = false;
  if (license) {
    planId = license.planId; validUntil = license.validUntil; trialEndsAt = license.trialEndsAt; renewal = license.renewal; lifetime = license.lifetime || (PLAN_CATALOG[planId].lifetime && license.status === "active" && license.validUntil === null);
    state = license.status;
    // The existing frozen plans/entitlements projection stays the authority until the final contract replaces it: a licence block can
    // never grant more than a server-verified granted entitlement in this session.
    if (ent.status !== "granted") state = ent.status === "unverified" ? "unverified" : ["revoked", "expired", "invalid"].includes(ent.status) ? ent.status : "none";
    // the clock can only tighten a grant, never extend it
    if ((state === "active" || state === "grace") && !lifetime && validUntil && nowMs >= Date.parse(validUntil)) state = "expired";
    if (state === "trial" && trialEndsAt && nowMs >= Date.parse(trialEndsAt)) state = "expired";
  } else if (ent.status === "granted") {
    planId = LEGACY_PLAN_ID; state = "active"; validUntil = ent.validUntil || null;
    if (validUntil && nowMs >= Date.parse(validUntil)) state = "expired";
  } else if (ent.status === "expired") { planId = (ent.lastVerified && ent.lastVerified.planId) || null; state = "expired"; }
  else if (ent.status === "revoked") state = "revoked";
  else if (ent.status === "invalid") state = "invalid";
  else if (ent.status === "unverified") state = "unverified";
  const plan = planId ? PLAN_CATALOG[planId] : null;
  const live = state === "active" || state === "trial" || state === "grace";
  const verified = ent.fromServer === true || (license !== null && ent.status !== "unverified" && ent.status !== "invalid");
  const capacity = deviceCapacity(planId, serverDeviceLimit !== null ? serverDeviceLimit : (license ? license.deviceLimit : null));
  return Object.freeze({
    planId, state, lifetime, validUntil, trialEndsAt, renewal, deviceCapacity: capacity,
    trialRemainingMs: state === "trial" && trialEndsAt ? Math.max(0, Date.parse(trialEndsAt) - nowMs) : null,
    // capability flags - all require a server-verified live grant in THIS session (a cached copy only explains what was last verified)
    ownerCloudSync: !!(plan && plan.ownerCloudSync && live && verified && state !== "trial"),
    memberPortal: !!(plan && plan.memberPortal && live && verified),
    // data policy: expiry/revocation never removes or hides local data, and local gameplay never consults the licence
    localDataPolicy: "retained",
    hardLock: false,
    contractPending: license === null,
  });
}

export function planLabelKey(view) {
  const K = { BAD_Q: "badq", PLUS: "plus", PRO: "pro", FOUNDER_ALL_ACCESS: "founder", EARLY_ACCESS_LEGACY: "legacy" };
  return view && view.planId ? `license.plan.${K[view.planId]}` : "license.plan.none";
}
