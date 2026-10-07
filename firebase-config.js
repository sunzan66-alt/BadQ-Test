// firebase-config.js — Firebase Web App client configuration for BadQ Cloud.
//
// NOTE ON THIS FILE'S HISTORY: this file (and firebase-sync.js next to it) were originally introduced in
// v1.11.35 ("Member Portal Phase 1 — Firebase Foundation") and shipped with every value EMPTY by default,
// since no real Firebase project existed yet at that time. This P2.1 patch (v1.12.8) fills in the real
// project config the Owner provided, since BadQ Online (Owner Auth + Workspace + Active Device) needs a
// live project to actually connect to. If Firebase can't be reached at all (offline, this exact file
// missing, the CDN blocked, etc.), firebase-sync.js degrades to window.BadQCloud = {available:false} and
// the rest of the app is completely unaffected either way — see that file's header comment.
//
// These are CLIENT configuration values, not secrets. A browser has to have them to talk to the project at
// all, and they are not sufficient on their own to read/write anything — real security comes from Firebase
// Authentication + the Firestore Security Rules deployed alongside them (see firestore.rules), never from
// hiding these values. Do not treat this file as sensitive.
window.__BADQ_FIREBASE_CONFIG__ = {
  apiKey: "AIzaSyDajOa0C7ZG2iEJnNG3Xoa4kEq52G0oWbE",
  authDomain: "badq-4cd48.firebaseapp.com",
  projectId: "badq-4cd48",
  storageBucket: "badq-4cd48.firebasestorage.app",
  messagingSenderId: "481234210772",
  appId: "1:481234210772:web:c8ffaef4a218ad30d81041",
};
