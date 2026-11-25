/**
 * Calf Care service worker
 *  - Offline support: precaches the app shell (cache-first, refreshed in the background).
 *  - Notifications: handles "Start now" / "Snooze 10 min" actions.
 *  - Periodic Background Sync (Chrome/Android, installed app only): occasionally
 *    checks whether a reminder is due while the app is closed.
 *
 * The SW cannot read localStorage, so the page shares reminder settings via
 * the Cache API ("calfcare-config"). Nothing ever leaves the device.
 */

const VERSION = 'calfcare-v1.0.0';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/store.js',
  './js/util.js',
  './js/exercises.js',
  './js/illustrations.js',
  './js/engine.js',
  './js/schedule.js',
  './js/safety.js',
  './js/history.js',
  './js/chart.js',
  './js/reminders.js',
  './js/feedback.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/badge-96.png',
];
const CONFIG_CACHE = 'calfcare-config';
const SNOOZE_MS = 10 * 60 * 1000;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== CONFIG_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Cache-first for our own files; refresh the cache in the background.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res.ok && res.type === 'basic') cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) {
        event.waitUntil(network);
        return cached;
      }
      const res = await network;
      if (res) return res;
      if (req.mode === 'navigate') return cache.match('./index.html');
      return new Response('Offline', { status: 503 });
    }),
  );
});

/* ---------- Shared config helpers ---------- */
async function readJSON(name) {
  const cache = await caches.open(CONFIG_CACHE);
  const res = await cache.match(name);
  return res ? res.json() : null;
}
async function writeJSON(name, obj) {
  const cache = await caches.open(CONFIG_CACHE);
  await cache.put(name, new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } }));
}

async function notify(body) {
  return self.registration.showNotification('Calf Care', {
    body,
    tag: 'calf-reminder',
    renotify: true,
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-96.png',
    data: { url: './#/today' },
    actions: [
      { action: 'start', title: 'Start now' },
      { action: 'snooze', title: 'Snooze 10 min' },
    ],
  });
}

/* ---------- Notification actions ---------- */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (event.action === 'snooze') {
      if (clients.length) {
        clients.forEach((c) => c.postMessage({ type: 'snooze' }));
      } else {
        // App closed: remember the snooze; the app picks it up when opened,
        // and periodic sync (where available) can deliver it.
        const st = (await readJSON('./__sw-state.json')) || {};
        st.snoozeUntil = new Date(Date.now() + SNOOZE_MS).toISOString();
        await writeJSON('./__sw-state.json', st);
      }
      return;
    }
    const target = event.action === 'start' ? './#/start' : './#/today';
    const client = clients[0];
    if (client) {
      await client.focus();
      if (event.action === 'start') client.postMessage({ type: 'start' });
      return;
    }
    await self.clients.openWindow(target);
  })());
});

/* ---------- Periodic background sync (best effort) ---------- */
function due(cfg, st, now) {
  const rem = cfg.rem;
  if (!rem || !rem.enabled) return false;
  const snooze = st.snoozeUntil || cfg.snoozeUntil;
  if (snooze) return now >= new Date(snooze);
  if (!rem.days.includes(now.getDay())) return false;
  const last = [st.lastFired, cfg.lastFired].filter(Boolean).sort().pop();
  const lastD = last ? new Date(last) : null;
  for (const hm of [...cfg.times].reverse()) {
    const [h, m] = hm.split(':').map(Number);
    const t = new Date(now);
    t.setHours(h, m, 0, 0);
    if (t > now) continue;
    if (now - t > 30 * 60000) return false;
    return !lastD || lastD < t;
  }
  return false;
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag !== 'calfcare-reminders') return;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window' });
    if (clients.some((c) => c.visibilityState === 'visible')) return; // the open app handles it
    const cfg = await readJSON('./__config.json');
    if (!cfg) return;
    const st = (await readJSON('./__sw-state.json')) || {};
    const now = new Date();
    if (!due(cfg, st, now)) return;
    st.lastFired = now.toISOString();
    st.snoozeUntil = null;
    await writeJSON('./__sw-state.json', st);
    await notify('Time for a short, gentle exercise break. Stop if anything hurts.');
  })());
});
