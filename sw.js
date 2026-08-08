/**
 * sw.js — Service worker.
 *
 * The entire physics model runs on the device, so once the app shell is cached
 * there is genuinely nothing left to fetch. That matters for this app in
 * particular: you are most likely to need a range prediction exactly where
 * mobile coverage is worst.
 *
 * Strategy: cache-first for the shell, with a background refresh so updates
 * land the next time the app is opened.
 */

// Bump this string whenever a shell file changes, otherwise returning users
// keep getting the previously cached version.
const CACHE = 'wattsleft-v13';

// EVERY module must be listed. They are ES modules loaded by static import, so
// a missing entry does not degrade gracefully — offline, that import fails and
// the app does not start at all. If you add a file under js/, add it here.
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.json',
  './icon.svg',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './js/app.js',
  './js/geometry.js',
  './js/physics.js',
  './js/cars.js',
  './js/geo.js',
  './js/navigation.js',
  './js/dom.js',
  './js/state.js',
  './js/picker.js',
  './js/conditions.js',
  './js/maps.js',
  './js/persistence.js',
  './js/setup-screen.js',
  './js/planner.js',
  './js/tracking.js',
  './js/trip.js',
  './vendor/leaflet.js',
  './vendor/leaflet.css',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  // Drop caches from previous versions so an update does not leave stale files.
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((res) => {
          // Only cache same-origin successful responses.
          if (res.ok && new URL(event.request.url).origin === location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(event.request, copy));
          }
          return res;
        })
        .catch(() => cached);

      return cached || network;
    }),
  );
});
