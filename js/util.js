/**
 * Small, DOM-free helpers shared across modules.
 */

/** Local calendar date key, e.g. "2026-11-25". */
export function dateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse a "YYYY-MM-DD" key into a local Date at midnight. */
export function parseDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Add whole days to a Date (returns a new Date). */
export function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** Whole local days between two dates (b - a). */
export function daysBetween(a, b) {
  const ms = parseDateKey(dateKey(b)) - parseDateKey(dateKey(a));
  return Math.round(ms / 86400000);
}

/** "HH:MM" -> minutes after midnight. */
export function hmToMinutes(hm) {
  const [h, m] = String(hm).split(':').map(Number);
  return h * 60 + (m || 0);
}

/** minutes after midnight -> "HH:MM". */
export function minutesToHm(mins) {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Seconds -> "m:ss" (or "h:mm:ss"). */
export function fmtClock(totalSec) {
  const s = Math.max(0, Math.ceil(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** Human duration, e.g. 90 -> "1 min 30 s". */
export function fmtDuration(sec) {
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
}

/** Escape text for safe insertion into HTML templates. */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Short random id (not cryptographic; fine for local records). */
export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export const cToF = (c) => Math.round((c * 9) / 5 + 32);
export const fToC = (f) => Math.round(((f - 32) * 5) / 9);
