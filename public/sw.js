const CACHE_NAME = "katulong-v5";
const PRECACHE = [
  "/",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  // Network-first for HTML and API calls, cache-first for static assets
  const url = new URL(e.request.url);

  // Skip WebSocket, API, auth, and dynamic manifest requests
  if (
    e.request.url.startsWith("ws") ||
    url.pathname.startsWith("/sessions") ||
    url.pathname.startsWith("/shortcuts") ||
    url.pathname === "/login" ||
    url.pathname === "/manifest.json" ||
    url.pathname.startsWith("/auth/") ||
    url.pathname.startsWith("/api/")
  ) {
    return;
  }

  // Network-first for HTML (always get latest)
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          // Only cache successful (non-redirect) responses
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Only cache GET requests (Cache API doesn't support POST/PUT/etc.)
  if (e.request.method !== "GET") return;

  // Cache-first for static assets (icons, fonts)
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((res) => {
        if (res.ok && url.origin === self.location.origin) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        }
        return res;
      });
    })
  );
});
