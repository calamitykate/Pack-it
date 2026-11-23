// Offline support. When online, always fetch the latest version (so updates show
// straight away); when offline or the connection is very slow, use the saved copy.
const CACHE = 'packit-v4';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.webmanifest',
  './vendor/exceljs.min.js',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's HTTP cache so we store the newest files.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const network = fetch(req, { cache: 'no-cache' }).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    });
    const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS));
    try {
      const res = await Promise.race([network, timeout]);
      if (res) return res;
    } catch (_) { /* offline */ }
    const cached = await cache.match(req, { ignoreSearch: true });
    return cached || network;
  })());
});
