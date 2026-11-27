// Reminders: what to notify, and when, for a trip. Pure functions (no DOM).
//
// Plans are stored in local "wall clock" time as printed on tickets. To send a
// notification at the right moment, each one is turned into a real instant
// using the time zone of the place it happens (looked up offline from the map
// location; tz-lookup is passed in so this file stays dependency free).
// The phone works the list out and sends it to the trip's server (the
// Cloudflare Worker), which sends each notification when it is due.

import { shapeOf, datePart, timePart, addDays, addMinutes, dayAgenda, driveLegs, tripSpan, dateRange,
  hasCoords, haversineKm, shortName, itemTitle, fmtTime, fmtDate } from './logic.js';
import { payment, fmtMoney } from './budget.js';

/** The kinds of reminder, in the order shown in settings. */
export const REMINDER_KINDS = [
  ['leave', '🧭 Time to leave', 'When to set off for flights, trains and bookings, using the drive time'],
  ['flight', '✈️ Flight day', '3 hours before a flight, with the terminal'],
  ['checkin', '🛂 Online check-in', '24 hours before a flight'],
  ['stay', '🛏️ Hotel check-out', 'On the morning you check out'],
  ['car', '🚗 Car return & parking', '2 hours before returning a hire car or collecting from parking'],
  ['payment', '💷 Payments due', '3 days before a balance is due'],
  ['packing', '🎒 Packing', '2 days before the trip'],
  ['morning', '☀️ Morning summary', 'At 7:30 each trip day: the day\'s first plans'],
  ['todo', '✅ To-dos due', 'At 9:00 on the day a to-do is due'],
];
export const ALL_KINDS = REMINDER_KINDS.map(([k]) => k);

const MAX_REMINDERS = 300;
const HORIZON_DAYS = 120;

// ---------- time zones ----------

/** Offset of a time zone from UTC, in minutes, at instant `ms`. */
export function tzOffsetMin(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+v.year, +v.month - 1, +v.day, +v.hour % 24, +v.minute, +v.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** "2026-12-01T09:30" in zone `tz` → epoch ms. */
export function zonedToUtc(local, tz) {
  const [d, t = '00:00'] = String(local).split('T');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi] = t.split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, da, h || 0, mi || 0);
  if (!tz) return wall - new Date(wall).getTimezoneOffset() * -60000; // device zone
  let utc = wall - tzOffsetMin(wall, tz) * 60000;
  utc = wall - tzOffsetMin(utc, tz) * 60000; // settle around clock changes
  return utc;
}

const validZone = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

/**
 * A function giving the time zone for a place; places without map coordinates
 * use the zone of the trip's nearest earlier place, else `fallback`.
 */
export function zoneFinder(tzlookup, fallback) {
  return (place) => {
    if (!tzlookup || !hasCoords(place)) return fallback;
    try { const z = tzlookup(+place.lat, +place.lon); return validZone(z) ? z : fallback; } catch { return fallback; }
  };
}

// ---------- helpers ----------

/** Rough drive minutes when no route has been worked out yet: road ≈ 1.3× straight line. */
export function estimateDriveMin(a, b) {
  const km = haversineKm(a, b) * 1.3;
  const kmh = km < 30 ? 40 : km < 100 ? 65 : 85;
  return Math.max(5, Math.round(km / kmh * 60 / 5) * 5);
}

const clip = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));

/** Where an event's local time is read from. */
const eventPlace = (ev) => ev.place || ev.endPlace || null;

/**
 * Build the reminder list for a trip.
 * opts: { now (ms), tzlookup, deviceTz, h12, bufferPct, routeFor(a, b) → {durationMin} | null, currency }
 * Returns [{ id, kind, at (ms), title, body, day }] sorted by time, future only.
 */
export function buildReminders({ meta = {}, items = [], packing = [], todos = [] }, opts = {}) {
  const now = opts.now ?? Date.now();
  const deviceTz = opts.deviceTz || undefined;
  const h12 = !!opts.h12;
  const bufferPct = Number(opts.bufferPct ?? meta.bufferPct ?? 10) || 0;
  const routeFor = opts.routeFor || (() => null);
  const t = (s) => fmtTime(timePart(s), h12);

  // Time zone for each item: its own place, else the last one before it.
  const zoneOf = zoneFinder(opts.tzlookup, deviceTz);
  const sorted = [...items].filter((i) => i.start).sort((a, b) => a.start.localeCompare(b.start));
  const itemZone = new Map();
  let lastZone = deviceTz;
  for (const it of sorted) {
    const p = [it.from, it.place, it.to].find(hasCoords);
    const z = p ? zoneOf(p) : lastZone;
    itemZone.set(it.id, { start: z, end: hasCoords(it.to) ? zoneOf(it.to) : z });
    lastZone = hasCoords(it.to) ? zoneOf(it.to) : z;
  }
  const zone = (it, which = 'start') => itemZone.get(it.id)?.[which] || deviceTz;
  const at = (local, tz) => zonedToUtc(local, tz);

  const out = [];
  const add = (r) => {
    if (!(r.at > now && r.at < now + HORIZON_DAYS * 86400000)) return;
    out.push({ ...r, title: clip(r.title, 80), body: clip(r.body, 220) });
  };

  const span = tripSpan(meta, items);
  const days = span.start ? dateRange(span.start, span.end) : [];

  for (const day of days) {
    const ag = dayAgenda(items, day, bufferPct);

    // ☀️ Morning summary: 7:30 where you are that day.
    const first = ag.events[0];
    const dayTz = first ? zone(first.item, first.kind === 'arrive' ? 'end' : 'start')
      : ag.lastNight ? zone(ag.lastNight) : deviceTz;
    if (ag.events.length) {
      const list = ag.events.slice(0, 3).map((e) => `${t(e.at)} ${e.label}`).join(' · ');
      const more = ag.events.length > 3 ? ` (+${ag.events.length - 3} more)` : '';
      add({ id: `day:${day}:morning`, kind: 'morning', day, at: at(`${day}T07:30`, dayTz),
        title: `☀️ Today: ${ag.events.length} plan${ag.events.length === 1 ? '' : 's'}`, body: `${list}${more}` });
    }

    // 🧭 Time to leave: drive time from where you were before.
    const legs = driveLegs(ag);
    const covered = new Set();
    for (const leg of legs) {
      const ev = ag.events[leg.index];
      if (!ev || !leg.toAt) continue;
      const route = routeFor(leg.from, leg.to);
      const base = Number(route?.durationMin) || estimateDriveMin(leg.from, leg.to);
      const drive = Math.round(base * (1 + bufferPct / 100));
      const isFlight = ev.item.type === 'flight' && ev.kind === 'depart';
      const margin = isFlight ? 120 : shapeOf(ev.item.type) === 'journey' ? 30 : 10;
      const leaveLocal = addMinutes(ev.at, -(drive + margin));
      const tz = zone(ev.item);
      covered.add(`${ev.item.id}:${ev.kind}`);
      add({ id: `${ev.item.id}:${ev.kind}:leave`, kind: 'leave', day, at: at(leaveLocal, tz) - 15 * 60000,
        title: `🧭 Leave by ${t(leaveLocal)} for ${clip(shortName(leg.to) || ev.label, 40)}`,
        body: `${ev.label} at ${t(ev.at)}. About ${drive} min drive${route ? '' : ' (estimate)'}${isFlight ? ', plus 2 hours at the airport' : margin > 10 ? `, plus ${margin} min to spare` : ''}.` });
    }
    // Plans with no drive worked out: a heads-up an hour before.
    for (const ev of ag.events) {
      if (covered.has(`${ev.item.id}:${ev.kind}`)) continue;
      const kind = ev.kind;
      const shape = shapeOf(ev.item.type);
      if (ev.item.type === 'flight' || ev.item.type === 'note' || ev.item.type === 'map') continue;
      if (!(kind === 'activity' || kind === 'pickup' || (kind === 'depart' && shape === 'journey'))) continue;
      const where = shortName(eventPlace(ev));
      add({ id: `${ev.item.id}:${kind}:soon`, kind: 'leave', day, at: at(ev.at, zone(ev.item)) - 60 * 60000,
        title: `⏰ In 1 hour: ${clip(ev.label, 60)}`, body: `${t(ev.at)}${where && !ev.label.includes(where) ? ` · ${where}` : ''}${ev.item.ref ? ` · Ref ${ev.item.ref}` : ''}` });
    }
  }

  for (const it of items) {
    if (!it.start) continue;
    const title = itemTitle(it);
    if (it.type === 'flight') {
      const dep = at(it.start, zone(it));
      const from = shortName(it.from);
      add({ id: `${it.id}:checkin`, kind: 'checkin', day: datePart(it.start), at: dep - 24 * 3600000,
        title: `🛂 Check in online: ${clip([it.provider, it.number].filter(Boolean).join(' ') || 'flight', 40)}`,
        body: `Online check-in should be open now for ${title}, departing ${fmtDate(datePart(it.start))} at ${t(it.start)}.${it.ref ? ` Booking ref ${it.ref}.` : ''}` });
      add({ id: `${it.id}:flight`, kind: 'flight', day: datePart(it.start), at: dep - 3 * 3600000,
        title: `✈️ ${clip(it.number || 'Flight', 20)} departs at ${t(it.start)}`,
        body: `${title}${from ? ` from ${from}` : ''}${it.terminal ? `, Terminal ${it.terminal}` : ''}.${it.seat ? ` Seats ${it.seat}.` : ''} Tap for live status.` });
    }
    if (it.type === 'hotel' && it.end) {
      const out8 = `${datePart(it.end)}T08:00`;
      const local = timePart(it.end) > '08:30' ? out8 : addMinutes(it.end, -60);
      add({ id: `${it.id}:checkout`, kind: 'stay', day: datePart(it.end), at: at(local, zone(it)),
        title: `🛏️ Check out by ${t(it.end)}`, body: `${it.title || 'Hotel'}${it.ref ? ` · Ref ${it.ref}` : ''}` });
    }
    if (it.type === 'car' && it.end) {
      const back = it.to?.name ? it.to : it.from;
      add({ id: `${it.id}:return`, kind: 'car', day: datePart(it.end), at: at(it.end, zone(it)) - 2 * 3600000,
        title: `🚗 Return the car by ${t(it.end)}`, body: `${title}${shortName(back) ? ` at ${shortName(back)}` : ''}. Remember to refuel if needed.` });
    }
    if (it.type === 'parking' && it.end && datePart(it.end) !== datePart(it.start)) {
      add({ id: `${it.id}:collect`, kind: 'car', day: datePart(it.end), at: at(it.end, zone(it)) - 2 * 3600000,
        title: `🅿️ Collect the car by ${t(it.end)}`, body: `${title}${it.spot ? ` · Space ${it.spot}` : ''}${it.ref ? ` · Ref ${it.ref}` : ''}` });
    }
    const pay = payment(it);
    if (pay.due > 0 && pay.balanceDue) {
      const cur = it.currency || opts.currency || meta.currency || 'GBP';
      add({ id: `${it.id}:pay:${pay.balanceDue}`, kind: 'payment', day: pay.balanceDue, at: at(`${addDays(pay.balanceDue, -3)}T09:00`, deviceTz),
        title: `💷 ${fmtMoney(pay.due, cur)} due in 3 days`, body: `Balance for ${title} is due by ${fmtDate(pay.balanceDue)}.` });
    }
  }

  // ✅ To-dos: 9:00 on the day they're due, all due that day in one reminder.
  const dueDays = new Map();
  for (const t of todos) if (!t.done && /^\d{4}-\d{2}-\d{2}$/.test(t.due || '')) dueDays.set(t.due, [...(dueDays.get(t.due) || []), t]);
  for (const [day, list] of dueDays) {
    add({ id: `todo:${day}`, kind: 'todo', day, at: at(`${day}T09:00`, deviceTz),
      title: list.length === 1 ? `✅ To do today: ${list[0].text}` : `✅ ${list.length} to-dos due today`,
      body: list.length === 1 ? (list[0].note || (list[0].who ? `For ${list[0].who}` : 'Tap to see the to-do list.')) : list.map((t) => t.text).join(' · ') });
  }

  // 🎒 Packing: 2 days before the trip, if there's a list.
  const packItems = packing.filter((p) => p.kind === 'item');
  if (span.start && packItems.length) {
    const firstIt = sorted[0];
    add({ id: `trip:${span.start}:packing`, kind: 'packing', day: span.start, at: at(`${addDays(span.start, -2)}T18:00`, firstIt ? zone(firstIt) : deviceTz),
      title: `🎒 ${meta.name || 'Your trip'} starts in 2 days`, body: 'Time to check the packing list and tick off what\'s packed.' });
  }

  out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  return out.slice(0, MAX_REMINDERS);
}

/** Short, stable fingerprint of a reminder list (to skip re-sending unchanged lists). */
export function remindersHash(list) {
  const s = JSON.stringify(list.map((r) => [r.id, r.kind, r.at, r.title, r.body, r.day]));
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${s.length.toString(36)}-${h.toString(36)}`;
}

export const kindLabel = (k) => REMINDER_KINDS.find(([x]) => x === k)?.[1] || k;
