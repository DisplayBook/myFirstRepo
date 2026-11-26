// Reminder notifications on this phone: turning them on/off (Web Push) and
// sending the trip's reminder list to the trip server (workers/trip-ai).

import { ALL_KINDS } from './reminders.js';

const PREFS = 'tp:reminders';   // { [tripId]: kinds[] } for trips this phone gets reminders for
const SENT = 'tp:remhash';      // { [tripId]: hash } last list sent from this phone

const read = (k) => { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch { return {}; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

/**
 * 'ok' | 'denied' | 'ios-home' (iPhone: add to Home Screen first) | 'unsupported'
 */
export function support() {
  const hasPush = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!hasPush) return isIOS() && !standalone() ? 'ios-home' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return 'ok';
}

/** Kinds this phone wants for a trip, or null if reminders are off for it. */
export const tripKinds = (tripId) => read(PREFS)[tripId] || null;

async function registration() {
  const reg = await navigator.serviceWorker.ready;
  return reg;
}
export async function subscription() {
  if (!('serviceWorker' in navigator)) return null;
  try { return await (await registration()).pushManager.getSubscription(); } catch { return null; }
}

const b64urlToBytes = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

async function api(base, auth, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token}`, 'x-trip-id': auth.tripId },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error?.message || `Server error ${res.status}`).replace(/^Trip AI: /, ''));
  return data;
}

/**
 * Turn reminders on for a trip (asks for permission the first time).
 * auth: { base, token, tripId }. Returns the number of phones with reminders on.
 */
export async function enable(auth, kinds = ALL_KINDS, name = '') {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Notifications are blocked for this app. Allow them in your phone\'s Settings, then try again.' : 'Notifications weren\'t allowed.');
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  const { key } = await api(auth.base, auth, '/push/key');
  // A subscription made with another key can't be reused.
  if (sub && sub.options?.applicationServerKey) {
    const old = new Uint8Array(sub.options.applicationServerKey);
    const want = b64urlToBytes(key);
    if (old.length !== want.length || old.some((v, i) => v !== want[i])) { await sub.unsubscribe(); sub = null; }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(key) });
  const out = await api(auth.base, auth, '/push/subscribe', { subscription: sub.toJSON(), kinds, name });
  const prefs = read(PREFS); prefs[auth.tripId] = kinds; save(PREFS, prefs);
  forgetSent(auth.tripId);
  return out.phones;
}

/** Turn reminders off for a trip on this phone. */
export async function disable(auth) {
  const sub = await subscription();
  if (sub) await api(auth.base, auth, '/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  const prefs = read(PREFS); delete prefs[auth.tripId]; save(PREFS, prefs);
  // Keep the browser subscription if other trips still use it.
  if (sub && !Object.keys(prefs).length) await sub.unsubscribe().catch(() => {});
}

export async function sendTest(auth) {
  const sub = await subscription();
  if (!sub) throw new Error('Reminders aren\'t on for this phone');
  await api(auth.base, auth, '/push/test', { endpoint: sub.endpoint });
}

export const forgetSent = (tripId) => { const s = read(SENT); delete s[tripId]; save(SENT, s); };

/** Send the reminder list if it changed since this phone last sent it. Returns true if sent. */
export async function syncSchedule(auth, list, hash) {
  const sent = read(SENT);
  if (sent[auth.tripId] === hash) return false;
  const out = await api(auth.base, auth, '/push/schedule', { reminders: list, hash });
  sent[auth.tripId] = hash; save(SENT, sent);
  return out.stored;
}
