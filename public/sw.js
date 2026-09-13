/* Service Worker — کش پوسته برای آفلاین + شبکه‌محور برای تازه‌ماندن */
const CACHE = "finanzierung-v5";
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
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== API_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // نوشتن‌ها را کلاینت صف می‌کند
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // منابع بیرونی (CDN/تلگرام) دست‌نخورده

  // مسیرهای حساس/پویا: فقط شبکه
  if (url.pathname.startsWith("/api/auth/") || url.pathname === "/api/config" || url.pathname === "/api/health") {
    event.respondWith(fetch(req).catch(() => new Response(JSON.stringify({ error: "آفلاین" }), { status: 503, headers: { "content-type": "application/json" } })));
    return;
  }

  const isApi = url.pathname.startsWith("/api/");
  const store = isApi ? API_CACHE : CACHE;

  // شبکه‌محور: همیشه تازه، و هنگام آفلاین از کش
  event.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(store).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((c) => c || (isApi
      ? new Response(JSON.stringify({ error: "آفلاین", offline: true }), { status: 503, headers: { "content-type": "application/json" } })
      : caches.match("/index.html"))))
  );
});
