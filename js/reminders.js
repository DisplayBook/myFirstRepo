/**
 * Reminders.
 *
 * Pure helpers (reminder times, "is one due?", .ics calendar export) plus the
 * browser glue that shows notifications through the service worker and an
 * in-app banner as a fallback.
 *
 * LIMITATIONS (also explained in the app):
 * - Without a server, a web app cannot reliably wake itself up at an exact time
 *   once it is fully closed. Reminders fire while the app is open or running
 *   in the background. On Android Chrome (installed app), Periodic Background
 *   Sync may sometimes deliver reminders while closed, but timing is up to
 *   the browser.
 * - iOS / iPadOS (16.4+) only allows notifications for web apps added to the
 *   Home Screen, and still cannot schedule them while closed.
 * - The calendar (.ics) export is the most reliable backup. Your phone's
 *   calendar app will alert you even when this app is closed.
 */

import { hmToMinutes, minutesToHm } from './util.js';
import { SLOTS } from './schedule.js';

export const SNOOZE_MINUTES = 10;

/** List of "HH:MM" reminder times for the settings. */
export function reminderTimes(rem, schedule) {
  if (rem.mode === 'slots' && schedule) {
    return SLOTS.filter((s) => schedule.slots[s.id]?.enabled !== false && schedule.slots[s.id]?.exercises.length)
      .map((s) => schedule.slots[s.id].time || s.time)
      .sort();
  }
  const start = hmToMinutes(rem.start);
  const end = hmToMinutes(rem.end);
  const every = Math.max(15, Number(rem.every) || 60);
  const out = [];
  for (let m = start; m <= end; m += every) out.push(minutesToHm(m));
  return out;
}

/** Date objects for today's reminders. */
export function timesOnDay(times, day) {
  return times.map((hm) => {
    const d = new Date(day);
    const mins = hmToMinutes(hm);
    d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
    return d;
  });
}

/**
 * Should a reminder fire now?
 * Fires when a scheduled time has passed since the last fired time (within a
 * grace window, so we don't spam old reminders after the phone was asleep),
 * or when a snooze has expired.
 *
 * @returns {{due: boolean, reason?: 'scheduled'|'snooze', at?: Date}}
 */
export function checkDue({ rem, schedule, now, lastFired, snoozeUntil, graceMinutes = 20 }) {
  if (!rem.enabled) return { due: false };
  if (snoozeUntil) {
    const s = new Date(snoozeUntil);
    if (now >= s) return { due: true, reason: 'snooze', at: s };
    return { due: false }; // snoozed: hold everything until it expires
  }
  if (!rem.days.includes(now.getDay())) return { due: false };
  const last = lastFired ? new Date(lastFired) : null;
  const todays = timesOnDay(reminderTimes(rem, schedule), now);
  for (let i = todays.length - 1; i >= 0; i--) {
    const t = todays[i];
    if (t > now) continue;
    if (now - t > graceMinutes * 60000) return { due: false };
    if (!last || last < t) return { due: true, reason: 'scheduled', at: t };
    return { due: false };
  }
  return { due: false };
}

/** Next reminder after `now` (for display), or null. */
export function nextReminder({ rem, schedule, now, snoozeUntil }) {
  if (!rem.enabled) return null;
  if (snoozeUntil && new Date(snoozeUntil) > now) return new Date(snoozeUntil);
  const times = reminderTimes(rem, schedule);
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const day = new Date(now);
    day.setDate(day.getDate() + dayOffset);
    if (!rem.days.includes(day.getDay())) continue;
    const next = timesOnDay(times, day).find((t) => t > now);
    if (next) return next;
  }
  return null;
}

const ICS_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** Build an .ics calendar with a daily repeating event + alarm for each time. */
export function buildICS(times, days, today = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = `${today.getFullYear()}${pad(today.getMonth() + 1)}${pad(today.getDate())}`;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const byDay = days.length === 7 ? '' : `;BYDAY=${days.map((d) => ICS_DAYS[d]).join(',')}`;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Calf Care//Reminders//EN', 'CALSCALE:GREGORIAN'];
  times.forEach((hm, i) => {
    const [h, m] = hm.split(':');
    lines.push(
      'BEGIN:VEVENT',
      `UID:calfcare-${ymd}-${i}-${h}${m}@local`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${ymd}T${h}${m}00`,
      'DURATION:PT5M',
      `RRULE:FREQ=DAILY${byDay}`,
      'SUMMARY:Calf Care: gentle exercise break',
      'DESCRIPTION:Time for a short\\, gentle session. Open Calf Care. Stop if anything hurts.',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'DESCRIPTION:Calf Care exercise break',
      'TRIGGER:PT0M',
      'END:VALARM',
      'END:VEVENT',
    );
  });
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------------ */
/* Browser glue                                                        */
/* ------------------------------------------------------------------ */

export function notificationSupport() {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Mac') && typeof document !== 'undefined' && 'ontouchend' in document);
  const standalone =
    (typeof matchMedia !== 'undefined' && matchMedia('(display-mode: standalone)').matches) ||
    (typeof navigator !== 'undefined' && navigator.standalone === true);
  return {
    supported: typeof Notification !== 'undefined' && 'serviceWorker' in navigator,
    permission: typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
    isIOS,
    standalone,
    periodicSync: typeof ServiceWorkerRegistration !== 'undefined' && 'periodicSync' in ServiceWorkerRegistration.prototype,
  };
}

export async function requestPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.requestPermission();
}

/** Show a notification via the service worker (falls back to the Notification constructor). */
export async function showReminderNotification({ title, body, tag = 'calf-reminder' }) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
  const options = {
    body,
    tag,
    renotify: true,
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-96.png',
    data: { url: './#/today' },
    actions: [
      { action: 'start', title: 'Start now' },
      { action: 'snooze', title: `Snooze ${SNOOZE_MINUTES} min` },
    ],
  };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) {
      await reg.showNotification(title, options);
      return true;
    }
  } catch (e) {
    console.warn('SW notification failed', e);
  }
  try {
    delete options.actions; // not allowed outside a service worker
    new Notification(title, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * Share the reminder config with the service worker (which cannot read
 * localStorage) via the Cache API, and register periodic background sync
 * where the browser supports it.
 */
export async function syncToServiceWorker(payload) {
  try {
    if (typeof caches === 'undefined') return;
    const cache = await caches.open('calfcare-config');
    await cache.put('./__config.json', new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } }));
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg && 'periodicSync' in reg && payload.rem.enabled) {
      const status = await navigator.permissions?.query({ name: 'periodic-background-sync' }).catch(() => null);
      if (!status || status.state === 'granted') {
        await reg.periodicSync.register('calfcare-reminders', { minInterval: 15 * 60 * 1000 }).catch(() => {});
      }
    } else if (reg && 'periodicSync' in reg) {
      await reg.periodicSync.unregister('calfcare-reminders').catch(() => {});
    }
  } catch (e) {
    console.warn('Could not sync reminder config', e);
  }
}
