/* ObscuraX service worker. Built into dist/sw.js by vite.config.js, which fills
   in the version and the file list. Everything the app needs is cached on
   install, so after the first visit it opens and works with no connection. */

const VERSION = "__VERSION__";
const ASSETS = __ASSETS__;
const CACHE = `obscurax-${VERSION}`;
const scoped = path => new URL(path, self.registration.scope).href;
// ignoreVary: module scripts are requested with an Origin header that the
// precache requests lack; hosts that send `Vary: Origin` would otherwise miss.
const MATCH = { cacheName: CACHE, ignoreVary: true };

self.addEventListener("install", event => {
  // `reload` skips the HTTP cache so a new version never caches stale files.
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS.map(a => new Request(scoped(a), { cache: "reload" })))));
  // No skipWaiting here: an update waits until the page accepts it, so
  // work in progress is never interrupted by a reload.
});

self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith("obscurax-") && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // The app is a single page: every navigation gets the cached page.
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      const cached = await caches.match(scoped("./"), MATCH);
      if (cached) return cached;
      return fetch(req);
    })());
    return;
  }

  // Cache first (files are content-hashed); anything else is fetched and kept.
  event.respondWith((async () => {
    const cached = await caches.match(req, { ...MATCH, ignoreSearch: true });
    if (cached) return cached;
    const res = await fetch(req);
    // Never keep a host's HTML fallback page under a file's URL (e.g. an old,
    // deleted script): that would break the app until the cache is replaced.
    const isHtml = (res.headers.get("content-type") || "").includes("text/html");
    if (res.ok && res.type === "basic" && !isHtml) {
      const copy = res.clone();
      caches.open(CACHE).then(cache => cache.put(req, copy)).catch(() => {});
    }
    return res;
  })());
});
