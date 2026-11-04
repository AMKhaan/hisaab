// Opens the app instantly from saved files, even with no signal.
// Files refresh in the background, so an update shows on the next open.
const CACHE = 'hisaab-v5';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'config.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const key = url.origin + url.pathname; // an invite link opens the same saved page
  const fresh = fetch(e.request).then(async (res) => {
    if (res.ok && res.type === 'basic') {
      const cache = await caches.open(CACHE);
      await cache.put(key, res.clone());
    }
    return res;
  });
  e.respondWith(caches.match(key).then((hit) => {
    if (!hit) return fresh;
    e.waitUntil(fresh.catch(() => {}));
    return hit;
  }));
});
