// Offline support. After changing any app file, bump VERSION so phones pick up the update.
const VERSION = 'runplan-v17';
const FILES = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'app.js', 'plan.js', 'adapt.js', 'vdot.js', 'dates.js', 'store.js', 'sync.js', 'charts.js', 'training.js', 'analysis.js', 'fitness.js',
  'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png',
];

// cache: 'reload' skips the phone's own saved copies, so a new version always stores fresh files.
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// App files: network first, so every open gets the latest version; the saved copy is used when offline.
// Anything else (the intervals.icu API) is left alone.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
