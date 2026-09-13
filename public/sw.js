/* Service Worker — کش پوسته‌ی برنامه برای کار در حالت آفلاین */
const CACHE = "finanzierung-v1";
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
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // درخواست‌های API همیشه از شبکه (بدون کش) تا داده‌ها به‌روز باشند.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(req).catch(() => new Response(JSON.stringify({ error: "آفلاین" }), { status: 503, headers: { "content-type": "application/json" } })));
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
