// BadQ Core - BAD_Q Offline licence: compact JWS (Ed25519 / "EdDSA") verification against a PINNED key registry.
//
// Trust model (contract CORE-OFFLINE-MVP-CONTRACT.md):
//   * The verification key comes ONLY from the registry compiled into Core (offline-trust-registry.js, kid -> SPKI per environment).
//   * Nothing inside the token (kid is only a LOOKUP KEY; jku / jwk / x5u / x5c are rejected) and nothing fetched at runtime can add,
//     replace or override a key. There is no unsigned path, no "verifier optional" path and no fallback algorithm.
//   * Verification is mandatory and fails closed: missing WebCrypto Ed25519, unknown kid, bad signature, wrong environment / Owner /
//     device / contract version / plan, or malformed claims => { ok:false, code }.
// Pure module: no storage, no network, no DOM.

export const OFFLINE_CONTRACT_VERSION = "2";
export const OFFLINE_PLANS = Object.freeze(["BAD_Q_LIFETIME", "BAD_Q_TRIAL"]);
export const ISSUED_AT_SKEW_MS = 10 * 60 * 1000;
const B64U = /^[A-Za-z0-9_-]+$/;
const KID = /^[A-Za-z0-9._:-]{1,64}$/;
const FORBIDDEN_HEADER = ["jku", "jwk", "x5u", "x5c", "x5t", "x5t#S256", "crit", "b64", "zip"];
const isRecord = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isEpoch = (v) => Number.isSafeInteger(v) && v > 0 && v < 4102444800000;

function b64uBytes(s) {
  if (typeof s !== "string" || s.length === 0 || !B64U.test(s)) return null;
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  try { const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; } catch { return null; }
}
function b64Bytes(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  try { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; } catch { return null; }
}
const jsonOf = (bytes) => { try { const v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); return isRecord(v) ? v : null; } catch { return null; } };

// Splits and structurally validates a compact JWS WITHOUT trusting anything in it.
export function parseCompactJws(token) {
  if (typeof token !== "string" || token.length < 20 || token.length > 8192) return { ok: false, code: "license-malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) return { ok: false, code: "license-malformed" }; // empty signature (unsigned / alg none) is malformed
  const hb = b64uBytes(parts[0]); const pb = b64uBytes(parts[1]); const sb = b64uBytes(parts[2]);
  if (!hb || !pb || !sb) return { ok: false, code: "license-malformed" };
  const header = jsonOf(hb); const claims = jsonOf(pb);
  if (!header || !claims) return { ok: false, code: "license-malformed" };
  if (header.alg !== "EdDSA") return { ok: false, code: "license-alg-unsupported" };
  if (FORBIDDEN_HEADER.some((k) => Object.prototype.hasOwnProperty.call(header, k))) return { ok: false, code: "license-header-forbidden" };
  if (typeof header.kid !== "string" || !KID.test(header.kid)) return { ok: false, code: "license-malformed" };
  if (sb.length !== 64) return { ok: false, code: "license-signature-invalid" };
  return { ok: true, header, claims, kid: header.kid, signingInput: new TextEncoder().encode(`${parts[0]}.${parts[1]}`), signature: sb };
}

// registry: { [kid]: { spki: <base64 SPKI>, status: "active" | "retired" | "compromised" } }
//   active      verifies existing licences AND may be used for a new activation
//   retired     verifies licences already issued (a lifetime licence must stay valid), but is refused for a NEW activation
//   compromised never trusted
export async function verifyOfflineLicense({ token, registry, expected, nowMs = Date.now(), forActivation = false, checkIssuedAt = true, subtle = globalThis.crypto && globalThis.crypto.subtle }) {
  const p = parseCompactJws(token);
  if (!p.ok) return p;
  if (!isRecord(registry) || !isRecord(expected)) return { ok: false, code: "license-key-untrusted" };
  const entry = Object.prototype.hasOwnProperty.call(registry, p.kid) ? registry[p.kid] : null;
  if (!isRecord(entry) || typeof entry.spki !== "string" || !["active", "retired"].includes(entry.status)) return { ok: false, code: "license-key-untrusted" };
  if (forActivation && entry.status !== "active") return { ok: false, code: "license-key-untrusted" };
  const spki = b64Bytes(entry.spki);
  if (!spki) return { ok: false, code: "license-key-untrusted" };
  if (!subtle || typeof subtle.importKey !== "function") return { ok: false, code: "ed25519-unsupported" };
  let valid = false;
  try {
    const key = await subtle.importKey("spki", spki, { name: "Ed25519" }, false, ["verify"]);
    valid = (await subtle.verify({ name: "Ed25519" }, key, p.signature, p.signingInput)) === true;
  } catch { return { ok: false, code: "ed25519-unsupported" }; }
  if (!valid) return { ok: false, code: "license-signature-invalid" };
  // ---- claims are only meaningful after the signature verified
  const c = p.claims;
  if (c.contractVersion !== OFFLINE_CONTRACT_VERSION) return { ok: false, code: "license-contract-mismatch" };
  if (typeof c.environment !== "string" || c.environment !== expected.environment) return { ok: false, code: "license-environment-mismatch" };
  if (typeof c.ownerId !== "string" || c.ownerId.length === 0 || c.ownerId !== expected.ownerId) return { ok: false, code: "license-owner-mismatch" };
  if (typeof c.deviceId !== "string" || c.deviceId.length === 0 || c.deviceId !== expected.deviceId) return { ok: false, code: "license-device-mismatch" };
  if (typeof c.grantId !== "string" || c.grantId.length === 0 || c.grantId.length > 200) return { ok: false, code: "license-claims-invalid" };
  if (!OFFLINE_PLANS.includes(c.planId)) return { ok: false, code: "license-plan-invalid" };
  if (!isEpoch(c.issuedAt)) return { ok: false, code: "license-claims-invalid" };
  if (c.expiresAt !== null && !isEpoch(c.expiresAt)) return { ok: false, code: "license-claims-invalid" };
  if (c.planId === "BAD_Q_LIFETIME" && c.expiresAt !== null) return { ok: false, code: "license-claims-invalid" }; // lifetime never carries an expiry
  if (c.planId === "BAD_Q_TRIAL" && (c.expiresAt === null || c.expiresAt <= c.issuedAt)) return { ok: false, code: "license-claims-invalid" };
  if (checkIssuedAt && c.issuedAt > nowMs + ISSUED_AT_SKEW_MS) return { ok: false, code: "license-issued-in-future" };
  return { ok: true, kid: p.kid, claims: { contractVersion: c.contractVersion, environment: c.environment, ownerId: c.ownerId, deviceId: c.deviceId, grantId: c.grantId, planId: c.planId, issuedAt: c.issuedAt, expiresAt: c.expiresAt } };
}
