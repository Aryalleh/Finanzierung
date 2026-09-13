/* Service Worker — کش پوسته‌ی برنامه برای کار در حالت آفلاین */
const CACHE = "finanzierung-v4";
const API_CACHE = "finanzierung-api-v1";
const SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icons/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE && k !== API_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // نوشتن‌ها را کلاینت خودش صف می‌کند
  const url = new URL(req.url);

  // GET های API: ابتدا شبکه، هنگام آفلاین از کش (تا خواندن آفلاین کار کند).
  // مسیرهای auth/config کش نمی‌شوند (حساس/پویا).
  if (url.pathname.startsWith("/api/")) {
    if (url.pathname.startsWith("/api/auth/") || url.pathname === "/api/config" || url.pathname === "/api/health") {
      event.respondWith(fetch(req).catch(() => new Response(JSON.stringify({ error: "آفلاین" }), { status: 503, headers: { "content-type": "application/json" } })));
      return;
    }
    event.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok) { const copy = res.clone(); caches.open(API_CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req).then((c) => c || new Response(JSON.stringify({ error: "آفلاین", offline: true }), { status: 503, headers: { "content-type": "application/json" } })))
    );
    return;
  }

  // پوسته: ابتدا کش، سپس شبکه (stale-while-revalidate ساده).
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok && url.origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
