// BadQ service worker — enables offline use AND a user-controlled update (v1.14.9).
// Bump CACHE_NAME (kept in lockstep with APP_VERSION) on every deploy.
//
// v1.14.9 CONTROLLED-UPDATE ARCHITECTURE. A newly deployed version must never silently become the running app: the Owner may be
// mid-session and decides when to update (the "อัปเดตตอนนี้" banner). So:
//   * every version precaches its OWN complete shell (index.html + the scripts it references + manifest/icons) into its OWN
//     versioned cache namespace at install, and the install FAILS (the worker never becomes "waiting") if the fetched shell is not
//     exactly this worker's version — a half-deployed / stale-CDN shell can never be stored under a version's name;
//   * the page shell and every same-origin static asset is served CACHE-FIRST from the ACCEPTED version's namespace (never
//     network-first), so a reload / reopen keeps running the accepted version coherently, online and offline;
//   * the accepted version is a tiny durable record (own cache "badq-sw-state"). It changes ONLY when the Owner approves: the
//     explicit SKIP_WAITING message writes it BEFORE skipWaiting(). If the browser activates a newer waiting worker on its own
//     (e.g. after a full PWA close), that worker still serves the previously ACCEPTED shell and keeps its cache until approval.
// There is exactly one skipWaiting() call, reachable only from that explicit message. The update probe (cache: "no-store") goes to
// the network and is never stored.
const CACHE_NAME = "badq-cache-v1.14.9";
// Only caches that follow BadQ's OWN versioned naming convention are ever eligible for obsolete-cache cleanup;
// caches of other apps on the same origin (e.g. other GitHub Pages projects) are never listed for deletion.
const BADQ_CACHE_RE = /^badq-cache-v[0-9][0-9.]*$/;
const CACHE_PREFIX = "badq-cache-v";
const WORKER_VERSION = CACHE_NAME.slice(CACHE_PREFIX.length);
const STATE_CACHE = "badq-sw-state"; // not a versioned name: never swept as "obsolete"
const SHELL_URL = self.registration.scope; // e.g. https://<user>.github.io/BadQ/ — the app's own index.html
const ACCEPTED_URL = SHELL_URL + "__badq_accepted_version__"; // synthetic key inside STATE_CACHE (never fetched)
const ASSETS = [
  SHELL_URL,
  SHELL_URL + "manifest.webmanifest",
  SHELL_URL + "icon-192.png",
  SHELL_URL + "icon-512.png",
  SHELL_URL + "icon-180.png",
  SHELL_URL + "favicon-32.png",
];

// Phase 4D security remediation (authenticated / Commercial API cache isolation).
// This Service Worker caches STATIC APP ASSETS ONLY. Any request that carries an Authorization header, or that
// targets a Commercial API route (/v1/... — e.g. /v1/core/bootstrap, /v1/core/badminton-groups/*,
// /v1/core/player-mutations, and every other Owner-scoped route reached through the Commercial adapter), is
// NEVER stored in Cache Storage and NEVER served from it: it goes straight to the network, so one Owner/session
// can never read another's response from a shared cache entry, and offline never "answers" an authenticated call
// with stale business data. This is deliberately fail-closed (a URL that cannot be parsed is treated as API).
// Business/API responses are intentionally NOT keyed per Authorization — the contract is "no caching at all".
const API_PATH_RE = /^\/v1(\/|$)/;
function isAuthenticatedOrApiRequest(req) {
  try {
    if (req.headers && req.headers.has("Authorization")) return true;
    return API_PATH_RE.test(new URL(req.url).pathname);
  } catch (_) {
    return true;
  }
}

// ---- accepted-version record (durable, Cache Storage only — never IndexedDB / localStorage / Journal / Backup) ----
function readAcceptedVersion() {
  return caches.open(STATE_CACHE)
    .then((cache) => cache.match(ACCEPTED_URL))
    .then((res) => (res ? res.text() : null))
    .then((v) => (v && BADQ_CACHE_RE.test(CACHE_PREFIX + v) ? v : null));
}
function writeAcceptedVersion(version) {
  return caches.open(STATE_CACHE).then((cache) => cache.put(ACCEPTED_URL, new Response(version)));
}
// Resolves the name of the cache that serves the page: the ACCEPTED version's namespace while it still exists; otherwise (first
// controlled worker, or the accepted namespace is gone) this worker's own version is adopted as the accepted one.
function resolveServingCacheName() {
  return readAcceptedVersion().then((accepted) => {
    if (accepted === WORKER_VERSION) return CACHE_NAME;
    if (accepted === null) return writeAcceptedVersion(WORKER_VERSION).then(() => CACHE_NAME);
    const name = CACHE_PREFIX + accepted;
    return caches.has(name).then((exists) => (exists ? name : writeAcceptedVersion(WORKER_VERSION).then(() => CACHE_NAME)));
  });
}
function matchAccepted(request) {
  return resolveServingCacheName()
    .then((name) => caches.open(name))
    .then((cache) => cache.match(request));
}

// v1.14.3 handoff cleanup (v1.14.9: version-aware). Only BadQ-versioned namespaces STRICTLY OLDER than this worker, and not the
// accepted one, are obsolete: v1.14.2 stored authenticated /v1 responses in "badq-cache-v1.14.2" and is removed ENTIRELY (never
// read, never migrated). A NEWER namespace belongs to a waiting worker and is never touched (its precache must survive until the
// Owner approves). Fail-closed: a rejected keys()/delete(), a delete() that does not return true, or a read-back that still shows
// an obsolete BadQ cache rejects this promise, and the activate handler then does NOT reach clients.claim().
function versionOlderThan(name, version) {
  const a = name.slice(CACHE_PREFIX.length).split(".").map(Number), b = version.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d < 0; }
  return false;
}
function cleanupObsoleteBadqCaches() {
  return readAcceptedVersion().then((accepted) => {
    const obsoleteNames = (names) => names.filter((n) => BADQ_CACHE_RE.test(n) && n !== CACHE_NAME && n !== CACHE_PREFIX + accepted && versionOlderThan(n, WORKER_VERSION));
    return caches.keys()
      .then((names) =>
        Promise.all(
          obsoleteNames(names).map((n) =>
            caches.delete(n).then((deleted) => {
              if (deleted !== true) throw new Error("badq-cache-delete-failed:" + n);
            })
          )
        )
      )
      .then(() => caches.keys())
      .then((names) => {
        const left = obsoleteNames(names);
        if (left.length) throw new Error("badq-obsolete-cache-remains:" + left.join(","));
      });
  });
}

// Read-back guard for the current cache: it must never contain an authenticated / API entry.
function verifyCurrentCacheHasNoProtectedEntries() {
  return caches.open(CACHE_NAME)
    .then((cache) => cache.keys())
    .then((reqs) => {
      if (reqs.some(isAuthenticatedOrApiRequest)) throw new Error("badq-protected-entry-in-current-cache");
    });
}

// Hygiene sweep (best effort, lifetime-owned): an older worker's in-flight cache write may land AFTER the activation cleanup
// above; this sweep removes any recreated OLDER obsolete cache the next time the worker handles a fetch.
let obsoleteSweepStarted = false;

// ---- install: precache this version's complete shell into its own namespace ----
// Same-origin scripts the shell references (and their static relative ES-module imports) are version-sensitive runtime files:
// they are discovered from the shell itself, so the worker needs no hard-coded file list.
function discoverScriptUrls(html) {
  const out = [];
  html.replace(/<script\b[^>]*\bsrc\s*=\s*["']([^"'#?]+)["']/gi, (_, src) => { out.push(src); return _; });
  return out.map((src) => new URL(src, SHELL_URL).href).filter((u) => new URL(u).origin === self.location.origin);
}
function precacheScript(cache, url, seen, depth) {
  if (seen.has(url)) return Promise.resolve();
  seen.add(url);
  return fetch(url, { cache: "reload" }).then((res) => {
    if (!res || !res.ok) return null; // a missing optional file never blocks install; a NETWORK failure rejects (install retried later)
    return cache.put(url, res.clone()).then(() => {
      if (depth >= 2) return null;
      return res.text().then((text) => {
        const deps = [];
        text.replace(/(?:\bimport\b|\bexport\b)[^;"'`]*?\bfrom\s*["'](\.{1,2}\/[^"']+)["']|\bimport\s*["'](\.{1,2}\/[^"']+)["']/g, (m, a, b) => { deps.push(a || b); return m; });
        return Promise.all(deps.map((d) => precacheScript(cache, new URL(d, url).href, seen, depth + 1)));
      });
    });
  });
}
function precacheVersion() {
  return caches.open(CACHE_NAME).then((cache) =>
    fetch(SHELL_URL, { cache: "reload" }).then((res) => {
      if (!res || !res.ok) throw new Error("badq-shell-unavailable");
      return res.clone().text().then((html) => {
        const m = /APP_VERSION\s*=\s*"([^"]+)"/.exec(html);
        if (!m || m[1] !== WORKER_VERSION) throw new Error("badq-shell-version-mismatch");
        return cache.put(SHELL_URL, res).then(() => {
          const seen = new Set([SHELL_URL]);
          const scripts = discoverScriptUrls(html).map((u) => precacheScript(cache, u, seen, 0));
          const statics = ASSETS.filter((u) => u !== SHELL_URL).map((url) =>
            fetch(url, { cache: "reload" })
              .then((r) => (r && r.ok ? cache.put(url, r) : null))
              .catch(() => {}) // missing/unreachable icon or manifest must never block install
          );
          return Promise.all(scripts.concat(statics));
        });
      });
    })
  );
}

self.addEventListener("install", (event) => {
  // v1.11.41 (Section B): the new worker INSTALLS AND WAITS — it never calls self.skipWaiting() here. It activates ONLY in response
  // to an explicit SKIP_WAITING message sent after the user taps "อัปเดตตอนนี้" (see the "message" listener below).
  event.waitUntil(precacheVersion());
});

// The ONLY trigger for self.skipWaiting(): the Owner's explicit update tap. The accepted version is recorded FIRST (so even a
// worker that was already activated by the browser starts serving this version from now on), then the worker is released, then
// the page is told the acceptance is durable. GET_STATE is read-only: it lets a page learn whether a newer worker is already
// active but not yet accepted.
self.addEventListener("message", (event) => {
  const type = event.data && event.data.type;
  const reply = (msg) => { try { if (event.source) event.source.postMessage(msg); } catch (_) {} };
  if (type === "SKIP_WAITING") {
    event.waitUntil(writeAcceptedVersion(WORKER_VERSION).then(() => self.skipWaiting()).then(() => reply({ type: "BADQ_ACCEPTED", version: WORKER_VERSION })).then(() => cleanupObsoleteBadqCaches()).catch(() => {}));
  } else if (type === "GET_STATE") {
    event.waitUntil(readAcceptedVersion().then((accepted) => reply({ type: "BADQ_SW_STATE", workerVersion: WORKER_VERSION, acceptedVersion: accepted })));
  }
});

self.addEventListener("activate", (event) => {
  // clients.claim() is safe/appropriate here: activation happens either after the Owner's explicit approval, or (browser-initiated,
  // e.g. after a full close) while this worker keeps serving the previously ACCEPTED version until approval. The obsolete-cache
  // cleanup + read-back verification MUST succeed before clients.claim(); there is intentionally no .catch(): a failed cleanup
  // rejects the lifetime promise and claim() is never called. Cache Storage only — never IndexedDB / localStorage / app data.
  event.waitUntil(
    resolveServingCacheName()
      .then(() => cleanupObsoleteBadqCaches())
      .then(() => verifyCurrentCacheHasNoProtectedEntries())
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  // Phase 4D: authenticated / Commercial API requests bypass Cache Storage entirely (no cache.put, no
  // caches.match fallback). Must stay BEFORE the navigation and static-asset branches.
  if (isAuthenticatedOrApiRequest(req)) {
    event.respondWith(fetch(req));
    return;
  }

  // Hygiene sweep for late writes by an older worker (see above). Owned by the event lifetime; failures are
  // deliberately non-fatal HERE because this sweep is not what gates clients.claim().
  if (!obsoleteSweepStarted) {
    obsoleteSweepStarted = true;
    event.waitUntil(cleanupObsoleteBadqCaches().catch(() => {}));
  }

  // Page navigations (initial load, reloads, the app's own cache-busted reload): CACHE-FIRST from the accepted version's own
  // namespace so the running version only changes when the Owner approves; the network is only a fallback if that shell is gone.
  if (req.mode === "navigate") {
    event.respondWith(matchAccepted(SHELL_URL).then((r) => r || matchAccepted(req)).then((r) => r || fetch(req)));
    return;
  }

  // Explicit freshness probes (the app's update check uses cache: "no-store") always reach the network and are never stored.
  if (req.cache === "no-store" || req.cache === "reload") {
    event.respondWith(fetch(req));
    return;
  }

  // Same-origin static files (scripts, manifest, icons): cache-first from the accepted version's namespace; a miss fetches once
  // and is stored in that same namespace (lifetime-owned write). Cross-origin GETs keep the earlier network-first behaviour.
  const sameOrigin = new URL(req.url).origin === self.location.origin;
  if (sameOrigin) {
    event.respondWith(
      matchAccepted(req).then((hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            event.waitUntil(resolveServingCacheName().then((name) => caches.open(name)).then((c) => c.put(req, clone)).catch(() => {}));
          }
          return res;
        })
      )
    );
    return;
  }
  event.respondWith(fetch(req).catch(() => matchAccepted(req)));
});
