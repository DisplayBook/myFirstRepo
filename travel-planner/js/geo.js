// Place search (OpenStreetMap Nominatim) and driving routes (OSRM).
// Both are free public services with fair-use limits, so requests are queued,
// spaced out and cached on the device.

import { hasCoords } from './logic.js';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const OSRM = 'https://router.project-osrm.org/route/v1/driving/';
const ROUTE_CACHE_KEY = 'tp:routes';
const ROUTE_CACHE_MAX = 400;

// Serial queue with a minimum gap between requests to the same service.
function makeQueue(gapMs) {
  let chain = Promise.resolve();
  let last = 0;
  return (fn) => {
    const run = chain.then(async () => {
      const wait = last + gapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      return fn();
    });
    chain = run.catch(() => {});
    return run;
  };
}
const searchQueue = makeQueue(1100); // Nominatim policy: max 1 request per second
const routeQueue = makeQueue(250);

/** Search for places by name or address. Returns [{name, lat, lon}]. */
export async function searchPlaces(q) {
  q = String(q || '').trim();
  if (q.length < 2) return [];
  const url = `${NOMINATIM}?format=jsonv2&limit=6&addressdetails=0&q=${encodeURIComponent(q)}`;
  const res = await searchQueue(() => fetch(url, { headers: { Accept: 'application/json' } }));
  if (!res.ok) throw new Error(`Place search failed (${res.status})`);
  const data = await res.json();
  return data.map((r) => {
    const parts = String(r.display_name || '').split(',').map((s) => s.trim()).filter(Boolean);
    const name = r.name && parts[0] !== r.name ? [r.name, ...parts.slice(0, 3)].join(', ') : parts.slice(0, 4).join(', ');
    return { name: name || q, lat: +(+r.lat).toFixed(6), lon: +(+r.lon).toFixed(6) };
  });
}

function loadCache() {
  try { return JSON.parse(localStorage.getItem(ROUTE_CACHE_KEY)) || {}; } catch { return {}; }
}
function saveCache(c) {
  try {
    const keys = Object.keys(c);
    if (keys.length > ROUTE_CACHE_MAX) {
      keys.sort((a, b) => (c[a].t || 0) - (c[b].t || 0)).slice(0, keys.length - ROUTE_CACHE_MAX).forEach((k) => delete c[k]);
    }
    localStorage.setItem(ROUTE_CACHE_KEY, JSON.stringify(c));
  } catch { /* storage full or blocked: cache is optional */ }
}
const key = (a, b) => [a.lat, a.lon, b.lat, b.lon].map((n) => (+n).toFixed(4)).join(',');

const inflight = new Map();

/**
 * Driving route between two places.
 * Resolves {durationMin, distanceKm, geometry} (geometry = encoded polyline),
 * or {error: 'no-route'} when there is no road route. Rejects on network errors.
 */
export function driveRoute(a, b) {
  if (!hasCoords(a) || !hasCoords(b)) return Promise.resolve({ error: 'no-place' });
  const k = key(a, b);
  const cache = loadCache();
  if (cache[k]) return Promise.resolve(cache[k].r);
  if (inflight.has(k)) return inflight.get(k);
  const url = `${OSRM}${(+a.lon).toFixed(6)},${(+a.lat).toFixed(6)};${(+b.lon).toFixed(6)},${(+b.lat).toFixed(6)}?overview=simplified&geometries=polyline`;
  const p = routeQueue(() => fetch(url)).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (data.code === 'NoRoute' || data.code === 'NoSegment' || (res.ok && !data.routes?.length)) return { error: 'no-route' };
    if (!res.ok || data.code !== 'Ok') throw new Error(`Route service error (${res.status})`);
    const r = data.routes[0];
    return { durationMin: Math.round(r.duration / 60), distanceKm: Math.round(r.distance / 100) / 10, geometry: r.geometry };
  }).then((r) => {
    const c = loadCache();
    c[k] = { r, t: Date.now() };
    saveCache(c);
    return r;
  }).finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

/** Cached route only (no network), or null. */
export function cachedRoute(a, b) {
  if (!hasCoords(a) || !hasCoords(b)) return null;
  return loadCache()[key(a, b)]?.r || null;
}

export function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('Location is not available on this device')); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ name: 'My location', lat: +pos.coords.latitude.toFixed(6), lon: +pos.coords.longitude.toFixed(6) }),
      (err) => reject(new Error(err.code === 1 ? 'Location permission was denied' : 'Could not get your location')),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 },
    );
  });
}

/** Main roads on a driving route, longest first (e.g. ["M4", "A46"]). Cached. */
export async function routeRoads(a, b, max = 6) {
  if (!hasCoords(a) || !hasCoords(b)) return [];
  const k = `roads:${key(a, b)}`;
  try { const c = JSON.parse(localStorage.getItem(k)); if (Array.isArray(c)) return c; } catch { /* ignore */ }
  const url = `${OSRM}${(+a.lon).toFixed(6)},${(+a.lat).toFixed(6)};${(+b.lon).toFixed(6)},${(+b.lat).toFixed(6)}?overview=false&steps=true`;
  const res = await routeQueue(() => fetch(url));
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.code !== 'Ok') return [];
  const byRoad = new Map();
  for (const leg of data.routes[0].legs || []) {
    for (const st of leg.steps || []) {
      const label = (st.ref || st.name || '').split(';')[0].trim();
      if (!label) continue;
      byRoad.set(label, (byRoad.get(label) || 0) + st.distance);
    }
  }
  const roads = [...byRoad.entries()].filter(([, m]) => m >= 2000).sort((x, y) => y[1] - x[1]).slice(0, max).map(([r]) => r);
  try { localStorage.setItem(k, JSON.stringify(roads)); } catch { /* ignore */ }
  return roads;
}
