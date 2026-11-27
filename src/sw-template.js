/* ObscuraX service worker. Built into dist/sw.js by vite.config.js, which fills
   in the version and the file list. Everything the app needs is cached on
   install, so after the first visit it opens and works with no connection. */

const VERSION = "__VERSION__";
const ASSETS = __ASSETS__;
/** Large optional files (nudity detector): cached the first time they're used. */
const ON_DEMAND = __ON_DEMAND__;
const CACHE = `obscurax-${VERSION}`;
// Kept across versions, so an update doesn't make people download 27 MB again
// (or lose the detector while offline). Entries this version doesn't use are pruned.
const ON_DEMAND_CACHE = "obscurax-on-demand";
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
    for (const key of await caches.keys()) if (key.startsWith("obscurax-") && key !== CACHE && key !== ON_DEMAND_CACHE) await caches.delete(key);
    const wanted = new Set(ON_DEMAND.map(scoped));
    const od = await caches.open(ON_DEMAND_CACHE);
    for (const req of await od.keys()) if (!wanted.has(req.url)) await od.delete(req);
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

  // On-demand files: from their own cache, downloaded and kept on first use.
  if (ON_DEMAND.some(p => scoped(p) === url.origin + url.pathname)) {
    event.respondWith((async () => {
      const od = await caches.open(ON_DEMAND_CACHE);
      const hit = await od.match(req, { ignoreVary: true, ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && res.type === "basic") await od.put(req, res.clone()).catch(() => {});
      return res;
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
