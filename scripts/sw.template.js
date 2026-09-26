// Service worker (generated into dist/sw.js at build time, see vite.config.ts).
// - App shell: precached per build; old builds' caches are removed on activate.
// - Pages: network first, so a deploy shows up on the next load; cache when offline.
// - /ort/ (ONNX Runtime, ~28 MB, fixed file names): cache first, keyed by the ORT version.
// - /models/: not touched here — src/neural/ort.ts keeps them in its own Cache.
// Everything served is same-origin and keeps its original headers, so the page
// stays cross-origin isolated (COOP/COEP) when it comes from the cache.
const VERSION = __VERSION__;
const PRECACHE = __PRECACHE__;
const ORT_VERSION = __ORT_VERSION__;
const SHELL = `shell-${VERSION}`;
const ORT = `ort-${ORT_VERSION}`;

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // One by one: a single failed request must not lose the whole install.
    await Promise.all(PRECACHE.map((u) => c.add(new Request(u, { cache: "reload" })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if ((k.startsWith("shell-") && k !== SHELL) || (k.startsWith("ort-") && k !== ORT)) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;
  if (p.startsWith("/models/") || p.startsWith("/__")) return;

  if (req.mode === "navigate") {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(SHELL)).put("/", res.clone()).catch(() => {});
        return res;
      } catch {
        return (await caches.match("/", { cacheName: SHELL })) ?? Response.error();
      }
    })());
    return;
  }

  if (p.startsWith("/ort/")) {
    e.respondWith(cacheFirst(ORT, req));
    return;
  }
  if (p.startsWith("/assets/") || PRECACHE.includes(p)) {
    e.respondWith(cacheFirst(SHELL, req));
  }
});

async function cacheFirst(name, req) {
  const c = await caches.open(name);
  const hit = await c.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  // Only whole, successful same-origin answers; never an HTML fallback for a binary.
  if (res.ok && res.status === 200 && !(res.headers.get("content-type") ?? "").includes("text/html")) {
    c.put(req, res.clone()).catch(() => {});
  }
  return res;
}
