// Trip Planner service worker: offline cache for the app shell. Bump VERSION after changing files.
// Trip data is not handled here: shared trips are cached by Firestore itself,
// device-only trips live in localStorage.
const VERSION = 'trips-v1.23.0';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/logic.js',
  './js/store.js',
  './js/geo.js',
  './js/map.js',
  './js/files.js',
  './js/budget.js',
  './js/ai.js',
  './js/chat.js',
  './js/packing.js',
  './js/reminders.js',
  './js/notify.js',
  './js/voice.js',
  './vendor/tz-lookup/tz.js',
  './vendor/anthropic/anthropic-sdk.js',
  './js/config.js',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];
const TILES = 'trips-tiles';
const TILE_LIMIT = 600;

self.addEventListener('install', (event) => {
  // cache: 'reload' skips the browser's HTTP cache (GitHub Pages lets it keep files
  // for 10 minutes), so a new version never gets stored with old files mixed in.
  event.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('trips-v') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trimTiles() {
  const cache = await caches.open(TILES);
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - TILE_LIMIT))) await cache.delete(k);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Map tiles you've already looked at stay available offline.
  if (url.hostname === 'tile.openstreetmap.org') {
    event.respondWith(caches.open(TILES).then(async (cache) => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) { cache.put(req, res.clone()); trimTiles(); }
      return res;
    }));
    return;
  }
  if (url.origin !== self.location.origin) return;

  // App files: network first, always checking with the server (not the 10-minute
  // HTTP cache) so every file comes from the same version. Cache when offline.
  const fresh = req.mode === 'navigate'
    ? fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
    : fetch(new Request(req, { cache: 'no-cache' }));
  event.respondWith(
    fresh.then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.open(VERSION).then((c) => c.match(req, { ignoreSearch: true })).then((r) => r || caches.match('./index.html'))),
  );
});

// ---------- reminders (push notifications from the trip server) ----------

self.addEventListener('push', (event) => {
  let msg = {};
  try { msg = event.data ? event.data.json() : {}; } catch { msg = { body: event.data?.text() || '' }; }
  event.waitUntil(self.registration.showNotification(msg.title || 'Trip reminder', {
    body: msg.body || '',
    tag: msg.tag || undefined,
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    data: { url: msg.url || '#/today' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const hash = String(event.notification.data?.url || '#/today');
  const url = new URL(hash, self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => w.url.startsWith(self.registration.scope)) || wins[0];
    if (win) {
      await win.focus();
      win.postMessage({ type: 'open', hash });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
