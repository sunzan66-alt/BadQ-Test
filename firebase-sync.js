// firebase-sync.js — BadQ Cloud client bootstrap.
//
// This is the ONLY place the Firebase SDK is loaded or any Firebase network call is made anywhere in BadQ.
// It is loaded as a plain ES module: <script type="module" src="firebase-sync.js"></script> directly from
// index.html's <head> (see the comment there) — this keeps BadQ's existing GitHub-Pages-static-file
// deployment and its existing compile_splice.js pipeline completely untouched; no bundler, no build step,
// no dependency on either of those source files for anything Firebase-related. firebase-config.js (loaded
// as a plain, non-module <script> immediately before this file) sets window.__BADQ_FIREBASE_CONFIG__.
//
// CONTRACT: everything is exposed on window.BadQCloud. If Firebase can't be reached or initialized for ANY
// reason at all (offline, this file/its CDN blocked, missing/invalid config, a corporate/sandbox network
// policy, an unexpected exception, ...), window.BadQCloud.available is/becomes false and every method
// safely rejects with a clear Thai error message instead of throwing synchronously or hanging. This file
// NEVER throws at load time and NEVER blocks or interferes with BadQ's own local-first boot sequence,
// which does not read this file, does not await anything from it, and works 100% offline whether or not
// this script ever finishes (or even starts) loading.
//
// Two independent feature layers share this one global, on purpose (see BadmintonOrganizer.jsx's own
// comment above BadQOnlineSheet for the full rationale):
//   1. LEGACY (v1.11.35, "Member Portal (Beta)", Club-centric):
//        getCurrentOwner() / onAuthChange(cb) / registerOwner(email,pw) / signInOwner(email,pw) /
//        signOutOwner() / createClub(name) / allocateBadqId(payload)
//      Unchanged signatures/behavior. MemberPortalSheet depends on these exactly as documented.
//   2. P2.1 Cloud Foundation (v1.12.8) + P2.1 SECURITY HARDENING (v1.12.9, this patch), Workspace-centric:
//        sendVerificationEmail() / reloadCurrentUser() / sendPasswordReset(email) — Owner Auth additions
//        getOrCreateWorkspace(ownerUid) / subscribeWorkspace(workspaceId, onNext, onError) /
//        claimActiveDevice(workspaceId, deviceId, appVersion, {isTakeover}) /
//        pingDeviceHeartbeat(deviceId, activeSessionId, appVersion)      — Workspace/Device authority
//      Used exclusively by the new BadQOnlineSheet. Both layers share the SAME single Firebase Auth
//      session (there is only ever one signed-in user per browser) — signing in/out in one panel is
//      visible in the other, which is expected, not a bug.
//
// P2.1 does NOT sync any BadQ business data (players/groups/matches/finance/history/ranking) to Firestore.
// The documents this file's Workspace-layer methods ever touch are:
//   users/{ownerUid}                             { workspaceId, createdAt, updatedAt, schemaVersion }
//   workspaces/{workspaceId}                     { primaryOwnerUid, activeDeviceId, activeDeviceSince,
//                                                   activeDeviceVersion, createdAt, updatedAt, schemaVersion }
//   workspaces/{workspaceId}/devices/{deviceId}  { status, lastSeenAt, appVersion, createdAt }
//   workspaces/{workspaceId}/private/authority   { activeSessionId, updatedAt }  -- NEVER read by this file
//                                                   directly; only the Cloud Functions (Admin SDK) ever
//                                                   touch it. See the hardening note below.
// (plus the pre-existing clubs/{clubId} and clubs/{clubId}/players/{playerId} and badqIds/{badqId}
// documents the LEGACY layer already used, completely unaffected by any of the above.)
//
// ============================================================================================
// v1.12.9 — P2.1 SECURITY HARDENING: why this now uses Cloud Functions instead of direct Firestore writes
// ============================================================================================
// v1.12.8's getOrCreateWorkspace/claimActiveDevice ran as PLAIN CLIENT Firestore transactions, gated only
// by "the caller's uid matches this document's own ownerUid" rules. That was explicitly flagged at the time
// as an incomplete story: it stops any OTHER Firebase account from touching your Workspace, but it cannot
// stop the SAME Owner's own old, revoked browser session from writing activeDeviceId back to itself, because
// both sessions carry the identical Firebase Auth identity and Firestore Rules have no concept of "which
// browser tab" a request came from. That gap was accepted at the time because closing it needs the Blaze
// billing plan. The project is now on Blaze, so this patch closes it for real:
//
//   - users/{uid}, workspaces/{id}, and workspaces/{id}/devices/{deviceId} are now WRITE-DENIED to every
//     client, unconditionally, in firestore.rules. There is no "owner-scoped write" rule for them anymore,
//     because that is exactly the rule shape that could not distinguish a legitimate device from a revoked
//     one sharing the same UID. The ONLY way any of these documents is ever created or changed is through
//     the trusted Cloud Functions below, using the Admin SDK (which bypasses Firestore Rules entirely) and
//     deriving the caller's identity solely from their own verified ID token — never from anything the
//     client claims about itself.
//   - claimActiveDevice's Cloud Function mints a fresh, unguessable "activeSessionId" on every successful
//     claim or takeover, and returns it ONLY in that one call's response — to the device that made the call,
//     and to no one else, ever. It is stored server-side in workspaces/{id}/private/authority, a document
//     Firestore Rules make unreadable to EVERY client (including the legitimate Owner's own other devices)
//     specifically so a revoked device can never simply read the new value and reuse it. Each device caches
//     its own copy locally (see BadmintonOrganizer.jsx's BadQOnlineSheet: "bg-v11-active-session-<deviceId>",
//     isolated from business data exactly like deviceId itself).
//   - The one concrete "protected Cloud write" this phase exposes, pingDeviceHeartbeat, requires that cached
//     value as an argument and is REJECTED (STALE_SESSION) the instant a different device has since taken
//     over — because the old device's cached copy can never match what the trusted backend now holds, and it
//     has no way to learn the new value. This holds indefinitely, not just "until the old ID token expires."
//   - Custom claims (a commonly-suggested alternative) were deliberately NOT used for this comparison: a
//     custom claim lives on the Firebase Auth ACCOUNT, not on a specific device/session instance, so the
//     moment either device's ID token next refreshes, BOTH devices would receive the identical latest claim
//     value — silently un-revoking the old one. A per-claim-request opaque capability, checked against
//     server-held state and never exposed to any client read, does not have that failure mode.
//
// v1.12.10: pingDeviceHeartbeat's server-side check was hardened to bind ALL THREE of {uid,
// workspace.activeDeviceId, authority.activeSessionId} atomically, closing a gap where a caller holding a
// valid activeSessionId could present a different deviceId. No call-site change was needed in this file —
// the request shape and response shape are unchanged; only functions/index.js's internal validation and the
// new STALE_DEVICE error marker (see KNOWN_MARKERS below) changed.
//
// v1.12.11: claimActiveDevice's own entry-point gap is closed — a submitted deviceId that merely happens to
// equal the current activeDeviceId is no longer, by itself, enough to mint a fresh activeSessionId. This
// file's claimActiveDevice() wrapper now also forwards opts.currentActiveSessionId (this device's own cached
// capability, when present) to the Function as `currentActiveSessionId`. No new error marker was needed —
// this case reuses the existing STALE_SESSION marker. activeSessionId itself is still never logged by this
// file and is still never written into any Firestore document this file or the client can read.
//
// WHAT THIS FILE STILL CANNOT VERIFY BY ITSELF: whether the deployed Cloud Functions and firestore.rules
// actually behave as designed against a LIVE Firebase project is a deployment-time fact, not a client-code
// fact — this file only calls httpsCallable(...) and reports whatever the backend decides. See the P2.1
// hardening completion report for exactly what was/was not verified in this development sandbox (no network
// path to any Firebase/Google host exists here, so no live call of any kind could be exercised).

(async () => {
  const config = (typeof window !== "undefined" && window.__BADQ_FIREBASE_CONFIG__) || null;
  const hasConfig = !!(config && config.apiKey && config.projectId && config.appId);

  function makeUnavailable(reason) {
    const unavailableError = () => Promise.reject(new Error("Firebase ไม่พร้อมใช้งาน (" + reason + ")"));
    window.BadQCloud = {
      available: false,
      reason: reason || "unavailable",
      getCurrentOwner: () => null,
      onAuthChange: () => () => {},
      registerOwner: unavailableError,
      signInOwner: unavailableError,
      signOutOwner: () => Promise.resolve(),
      sendVerificationEmail: unavailableError,
      reloadCurrentUser: () => Promise.resolve(null),
      sendPasswordReset: unavailableError,
      createClub: unavailableError,
      allocateBadqId: unavailableError,
      getOrCreateWorkspace: unavailableError,
      subscribeWorkspace: () => () => {},
      claimActiveDevice: unavailableError,
      pingDeviceHeartbeat: unavailableError,
    };
    try { window.dispatchEvent(new CustomEvent("badq:cloud-ready", { detail: { available: false, reason } })); } catch (e) {}
  }

  if (!hasConfig) { makeUnavailable("no-config"); return; }

  const SDK_VERSION = "10.13.2";
  let appMod, authMod, fsMod, funcMod;
  try {
    [appMod, authMod, fsMod, funcMod] = await Promise.all([
      import(/* webpackIgnore: true */ `https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-app.js`),
      import(/* webpackIgnore: true */ `https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-auth.js`),
      import(/* webpackIgnore: true */ `https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-firestore.js`),
      import(/* webpackIgnore: true */ `https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-functions.js`),
    ]);
  } catch (e) {
    // Network blocked, CDN unreachable, offline, corporate/sandbox egress policy, etc. — BadQ keeps
    // working 100% locally either way; this is not a fatal error for the app as a whole.
    makeUnavailable("sdk-load-failed");
    return;
  }

  let app, auth, db, functionsClient;
  try {
    app = appMod.initializeApp(config);
    auth = authMod.getAuth(app);
    db = fsMod.getFirestore(app);
    // Region must match wherever functions/index.js is actually deployed (see that file's header + the
    // deployment notes in the P2.1 hardening completion report). Firebase defaults both sides to
    // us-central1 when no region is specified, so leaving this blank is correct as long as `firebase deploy
    // --only functions` is also never given an explicit region override.
    functionsClient = funcMod.getFunctions(app);
    // Best-effort: keep the Owner signed in across reloads/PWA relaunch, matching how the rest of BadQ
    // treats "stay logged in" as the default. If this exact persistence mode isn't available in this
    // browser, Firebase Auth still falls back to its own default persistence — this is a preference,
    // never a requirement for the rest of this file to work.
    try { await authMod.setPersistence(auth, authMod.browserLocalPersistence); } catch (e) {}
  } catch (e) {
    makeUnavailable("init-failed");
    return;
  }

  // Only the 3 fields the rest of the app ever needs — never the full Firebase User object (which carries
  // provider metadata, refresh tokens, etc. that BadQ has no reason to touch or persist).
  const shapeUser = (u) => (u ? { uid: u.uid, email: u.email, emailVerified: u.emailVerified } : null);

  // The handful of literal error markers functions/index.js's HttpsError calls use as their `message` (its
  // SECOND constructor argument) -- the Firebase callable SDK preserves that string verbatim as the client-
  // side error's own .message, regardless of SDK version, so matching on it here is stable. Re-shaped into
  // {code, message} so cloudErrorMessage's existing MAP (BadmintonOrganizer.jsx) keeps working unchanged.
  const KNOWN_MARKERS = ["DEVICE_CONFLICT", "STALE_SESSION", "STALE_DEVICE", "EMAIL_NOT_VERIFIED", "WORKSPACE_NOT_FOUND", "NOT_WORKSPACE_OWNER"];
  function normalizeFunctionsError(e) {
    const rawMessage = (e && e.message) || "";
    const marker = KNOWN_MARKERS.find((m) => rawMessage.indexOf(m) !== -1);
    const err = new Error(marker || rawMessage || "เรียกใช้งานไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
    err.code = marker || (e && e.code) || "unknown";
    return err;
  }

  const callGetOrCreateWorkspace = funcMod.httpsCallable(functionsClient, "getOrCreateWorkspace");
  const callClaimActiveDevice = funcMod.httpsCallable(functionsClient, "claimActiveDevice");
  const callPingDeviceHeartbeat = funcMod.httpsCallable(functionsClient, "pingDeviceHeartbeat");

  // Idempotent, create-once Workspace resolution (spec section F), now a trusted Cloud Function (see
  // functions/index.js: exports.getOrCreateWorkspace) instead of a client-run transaction — the Function
  // derives the caller's uid solely from their own verified ID token, so the `ownerUid` argument here is
  // kept only so existing call sites (BadQOnlineSheet) don't need to change; the Function never trusts it.
  function getOrCreateWorkspace(ownerUid) {
    return callGetOrCreateWorkspace({}).then((res) => res.data.workspaceId).catch((e) => { throw normalizeFunctionsError(e); });
  }

  // Real-time Workspace subscription — this is how a revoked device notices activeDeviceId changed out
  // from under it without needing to be refreshed/reopened (spec section J). This remains a plain client
  // Firestore read (firestore.rules still allow the Workspace's own Owner to READ this document on any of
  // their devices, revoked or not — that's required for a revoked device's own UI to detect and display its
  // revocation). Only WRITES to this document are now Function-only; see the hardening note above.
  function subscribeWorkspace(workspaceId, onNext, onError) {
    const ref = fsMod.doc(db, "workspaces", workspaceId);
    return fsMod.onSnapshot(ref, (snap) => { onNext(snap.exists() ? { id: snap.id, ...snap.data() } : null); }, (err) => { if (onError) onError(err); });
  }

  // Registers this device as Active when none exists yet, or (isTakeover:true) forcibly switches Active
  // authority to this device regardless of who currently holds it. NEVER silently overwrites an existing
  // DIFFERENT active device unless isTakeover is explicitly true — the Cloud Function throws DEVICE_CONFLICT
  // instead, which is exactly what tells BadQOnlineSheet to show the takeover-confirmation UI rather than
  // proceed. Runs as a single Firestore transaction INSIDE the trusted Cloud Function (spec section I),
  // so two near-simultaneous takeover attempts can never both "win" silently. On success, resolves to
  // { workspaceId, activeDeviceId, activeSessionId, activeDeviceSince } — activeSessionId is the one-time
  // capability this device must cache locally and present to pingDeviceHeartbeat; see functions/index.js.
  //
  // v1.12.11: also forwards opts.currentActiveSessionId (this device's own locally-cached activeSessionId,
  // when it has one) as `currentActiveSessionId`. The Cloud Function now requires this to match its own
  // server-held authority.activeSessionId whenever the submitted deviceId already equals the workspace's
  // current activeDeviceId — a plain deviceId match is no longer sufficient proof for that case (see
  // functions/index.js's v1.12.11 header addendum for the full rationale). Passing this value here is safe
  // to do unconditionally: the Function only consults it for that one same-device case and ignores it
  // otherwise (first claim / genuine different-device takeover). ownerUid/workspaceId are deliberately never
  // sent as authority inputs — identity stays server-derived from the caller's own verified ID token, exactly
  // as before this patch.
  function claimActiveDevice(workspaceId, deviceId, appVersion, opts) {
    const isTakeover = !!(opts && opts.isTakeover);
    const currentActiveSessionId = (opts && typeof opts.currentActiveSessionId === "string" && opts.currentActiveSessionId) || null;
    // workspaceId is accepted only for call-site symmetry with the pre-hardening signature; the Function
    // re-derives the real one server-side from the caller's own users/{uid} doc and ignores this value.
    return callClaimActiveDevice({ deviceId, appVersion: appVersion || null, confirmTakeover: isTakeover, currentActiveSessionId })
      .then((res) => res.data)
      .catch((e) => { throw normalizeFunctionsError(e); });
  }

  // The one concrete "protected Cloud write" in this phase (see the hardening note above for why it exists
  // and what it proves). Presents this device's locally-cached activeSessionId as an argument to the
  // trusted pingDeviceHeartbeat Cloud Function; the Function compares it against the server-held authority
  // record and only THEN performs the actual Firestore write (Admin SDK) — the secret itself is never
  // written back into any client-readable document, by design.
  function pingDeviceHeartbeat(deviceId, activeSessionId, appVersion) {
    return callPingDeviceHeartbeat({ deviceId, activeSessionId, appVersion: appVersion || null })
      .then((res) => res.data)
      .catch((e) => { throw normalizeFunctionsError(e); });
  }

  window.BadQCloud = {
    available: true,

    // ---- legacy (v1.11.35, Member Portal Beta) — unchanged signatures/behavior ----
    getCurrentOwner: () => shapeUser(auth.currentUser),
    onAuthChange: (cb) => authMod.onAuthStateChanged(auth, (u) => cb(shapeUser(u))),
    registerOwner: (email, password) => authMod.createUserWithEmailAndPassword(auth, email, password).then((cred) => shapeUser(cred.user)),
    signInOwner: (email, password) => authMod.signInWithEmailAndPassword(auth, email, password).then((cred) => shapeUser(cred.user)),
    signOutOwner: () => authMod.signOut(auth),
    createClub: (name) => {
      const uid = auth.currentUser && auth.currentUser.uid;
      if (!uid) return Promise.reject(new Error("ยังไม่ได้เข้าสู่ระบบ"));
      const clubRef = fsMod.doc(fsMod.collection(db, "clubs"));
      return fsMod.setDoc(clubRef, { name, ownerUid: uid, createdAt: fsMod.serverTimestamp() }).then(() => clubRef.id);
    },
    // allocateBadqId is a Cloud Function in the legacy design (the only code path allowed to create a
    // clubs/{clubId}/players/{playerId} doc — see firestore.rules). Now that Blaze functions exist for the
    // P2.1 Workspace layer, deploying this one too is straightforward future work, but it is NOT part of
    // this security-hardening patch's scope (which is Owner/Workspace/Device authority only) — it still
    // correctly reports "not available" rather than silently writing the player doc directly from the
    // client, which the rules deliberately disallow.
    allocateBadqId: () => Promise.reject(new Error("allocateBadqId ต้องใช้ Cloud Function ที่ยังไม่ได้ deploy ไว้ในแพตช์นี้")),

    // ---- P2.1 Owner Auth (unchanged from v1.12.8) ----
    sendVerificationEmail: () => { if (!auth.currentUser) return Promise.reject(new Error("ยังไม่ได้เข้าสู่ระบบ")); return authMod.sendEmailVerification(auth.currentUser); },
    reloadCurrentUser: () => { if (!auth.currentUser) return Promise.resolve(null); return authMod.reload(auth.currentUser).then(() => shapeUser(auth.currentUser)); },
    sendPasswordReset: (email) => authMod.sendPasswordResetEmail(auth, email),

    // ---- P2.1 Workspace / Single Active Device — now Cloud-Function-backed (v1.12.9 hardening) ----
    getOrCreateWorkspace,
    subscribeWorkspace,
    claimActiveDevice,
    pingDeviceHeartbeat,
  };
  try { window.dispatchEvent(new CustomEvent("badq:cloud-ready", { detail: { available: true } })); } catch (e) {}
})();
