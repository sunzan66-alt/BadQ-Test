// BadQ Core - APPROVED public-key trust root for BAD_Q Offline licences (kid -> SPKI), pinned per environment IN CODE.
//
// STATUS: TEST has ONE Owner-approved key (kid badq-test-offline-20261012-01, DER SPKI SHA-256
// c9481597bdb960643dc7c968b4af29bbd4906e945e59936eea8fe780f589c1ba). PROD is EMPTY/unprovisioned: every PROD licence fails closed
// ("license-key-untrusted"). Nothing is read from a token, a URL, or the network.
//
// APPROVAL / ROTATION PROCEDURE (out-of-band, never via the API):
//   1. Commercial generates the Ed25519 key pair; the private key stays in the Commercial signing configuration only.
//   2. Commercial sends the Owner { environment, kid, SPKI (base64 of the DER SubjectPublicKeyInfo) } through a trusted channel
//      and the Owner confirms the SHA-256 fingerprint of the SPKI out-of-band.
//   3. The key is added here as status "active" in a Core RELEASE (reviewed diff) - the only way a key becomes trusted.
//   4. Rotation: add the NEW kid as "active" and change the old one to "retired" in the same release. A retired key still verifies
//      licences it already issued (a purchased lifetime licence must keep working offline) but is refused for a NEW activation.
//   5. Compromise: set the kid to "compromised" (never trusted) in a release; devices adopt it when they next update the app.
//      Licences already stored on an offline, un-updated installation cannot be remotely invalidated (documented limitation).
//   6. GET /license-keys (authenticated) is only an aid: Core compares it to this registry and NEVER adds or replaces a key from it.
// PROD stays unprovisioned (projectId null) like the commercial environment profile.
export const OFFLINE_TRUST_REGISTRY = Object.freeze({
  TEST: Object.freeze({
    projectId: "badq-commercial-test",
    keys: Object.freeze({
      "badq-test-offline-20261012-01": Object.freeze({ spki: "MCowBQYDK2VwAyEAVRVKcW7LRXJGmiQ2Fv2+fMkPC9rRgMGmlpo4fU7Voe4=", status: "active" }),
    }),
  }),
  PROD: Object.freeze({ projectId: null, keys: Object.freeze({}) }),
});
export function trustedKeysFor(profile, registry = OFFLINE_TRUST_REGISTRY) {
  if (!profile || typeof profile.environment !== "string" || !Object.prototype.hasOwnProperty.call(registry, profile.environment)) return {};
  const entry = registry[profile.environment];
  if (!entry.projectId || entry.projectId !== profile.projectId) return {}; // unprovisioned / foreign project: trust nothing
  return entry.keys;
}
