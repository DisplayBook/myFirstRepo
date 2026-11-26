// Pure, DOM-free logic for Trip Planner: item types, day agendas, drive legs,
// formatting, geometry and calendar export. Everything here is unit-tested.
//
// Times are stored as local "wall clock" strings exactly as printed on a ticket
// ("2026-12-01T09:30"), with no time zone conversion. That is what travellers
// read and type, and it keeps every viewer seeing the same thing.

/** Item types, with the fields their form shows (in order). */
export const TYPES = {
  flight: {
    label: 'Flight', plural: 'flights', icon: '✈️', color: '#2563eb',
    fields: [
      { key: 'provider', label: 'Airline', kind: 'text', placeholder: 'e.g. British Airways' },
      { key: 'number', label: 'Flight number', kind: 'text', placeholder: 'e.g. BA 117' },
      { key: 'from', label: 'From airport', kind: 'place', required: true },
      { key: 'to', label: 'To airport', kind: 'place', required: true },
      { key: 'start', label: 'Departs (local time)', kind: 'datetime', required: true },
      { key: 'terminal', label: 'Departure terminal', kind: 'text', placeholder: 'e.g. 5' },
      { key: 'end', label: 'Arrives (local time)', kind: 'datetime' },
      { key: 'arrTerminal', label: 'Arrival terminal', kind: 'text', placeholder: 'e.g. 7' },
      { key: 'ref', label: 'Booking reference', kind: 'text' },
      { key: 'seat', label: 'Seats', kind: 'text' },
      { key: 'cost', label: 'Cost', kind: 'money' },
      { key: 'paid', label: 'Payment', kind: 'payment' },
      { key: 'notes', label: 'Notes', kind: 'textarea' },
    ],
  },
  hotel: {
    label: 'Hotel', plural: 'hotels', icon: '🛏️', color: '#7c3aed',
    fields: [
      { key: 'title', label: 'Hotel name', kind: 'text', required: true },
      { key: 'place', label: 'Address', kind: 'place' },
      { key: 'start', label: 'Check-in', kind: 'datetime', required: true },
      { key: 'end', label: 'Check-out', kind: 'datetime', required: true },
      { key: 'ref', label: 'Booking reference', kind: 'text' },
      { key: 'cost', label: 'Cost', kind: 'money' },
      { key: 'paid', label: 'Payment', kind: 'payment' },
      { key: 'notes', label: 'Notes', kind: 'textarea' },
    ],
  },
  car: {
    label: 'Car hire', plural: 'car hires', icon: '🚗', color: '#0f766e',
    fields: [
      { key: 'provider', label: 'Company', kind: 'text', required: true, placeholder: 'e.g. Hertz' },
      { key: 'from', label: 'Pick-up location', kind: 'place' },
      { key: 'start', label: 'Pick-up time', kind: 'datetime', required: true },
      { key: 'to', label: 'Drop-off location (leave empty if same)', kind: 'place' },
      { key: 'end', label: 'Drop-off time', kind: 'datetime', required: true },
      { key: 'ref', label: 'Booking reference', kind: 'text' },
      { key: 'cost', label: 'Cost', kind: 'money' },
      { key: 'paid', label: 'Payment', kind: 'payment' },
      { key: 'notes', label: 'Notes', kind: 'textarea' },
    ],
  },
  drive: {
    label: 'Drive', plural: 'drives', icon: '🛣️', color: '#d97706',
    fields: [
      { key: 'title', label: 'Name (optional)', kind: 'text', placeholder: 'e.g. Scenic route to Bath' },
      { key: 'from', label: 'From', kind: 'place', required: true },
      { key: 'to', label: 'To', kind: 'place', required: true },
      { key: 'start', label: 'Leave at', kind: 'datetime', required: true },
      { key: 'stopMin', label: 'Extra time for stops (minutes)', kind: 'number', placeholder: '0' },
      { key: 'cost', label: 'Fuel, tolls & parking', kind: 'money' },
      { key: 'paid', label: 'Payment', kind: 'payment' },
      { key: 'notes', label: 'Notes', kind: 'textarea' },
    ],
  },
  activity: {
    label: 'Activity', plural: 'activities', icon: '📍', color: '#db2777',
    fields: [
      { key: 'title', label: 'What', kind: 'text', required: true, placeholder: 'e.g. Museum tour, dinner' },
      { key: 'place', label: 'Where', kind: 'place' },
      { key: 'start', label: 'Starts', kind: 'datetime', required: true },
      { key: 'end', label: 'Ends', kind: 'datetime' },
      { key: 'ref', label: 'Booking reference', kind: 'text' },
      { key: 'cost', label: 'Cost', kind: 'money' },
      { key: 'paid', label: 'Payment', kind: 'payment' },
      { key: 'notes', label: 'Notes', kind: 'textarea' },
    ],
  },
  transport: {
    label: 'Train / bus / ferry', plural: 'trains, buses & ferries', icon: '🚆', color: '#4d7c0f',
    fields: [
      { key: 'title', label: 'Name', kind: 'text', required: true, placeholder: 'e.g. Eurostar to Paris' },
      { key: 'number', label: 'Service / ticket number', kind: 'text' },
      { key: 'from', label: 'From', kind: 'place', required: true },
      { key: 'to', label: 'To', kind: 'place', required: true },
      { key: 'start', label: 'Departs', kind: 'datetime', required: true },
      { key: 'end', label: 'Arrives', kind: 'datetime' },
      { key: 'ref', label: 'Booking reference', kind: 'text' },
      { key: 'cost', label: 'Cost', kind: 'money' },
      { key: 'paid', label: 'Payment', kind: 'payment' },
      { key: 'notes', label: 'Notes', kind: 'textarea' },
    ],
  },
};

// ---------- ids ----------

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** Random base62 id. Trip ids are 22 characters (~131 bits): the link is the key. */
export function uid(len = 22, rand = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const bytes = rand(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % 62];
  return s;
}

export const isTripId = (s) => typeof s === 'string' && /^[0-9A-Za-z]{20,40}$/.test(s);

// ---------- dates & times ----------

export const datePart = (s) => (s ? String(s).slice(0, 10) : '');
export const timePart = (s) => (s && String(s).length >= 16 ? String(s).slice(11, 16) : '');

function toUTC(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
function fromUTC(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
export function addDays(dateStr, n) {
  return fromUTC(toUTC(dateStr) + n * 86400000);
}
export function daysBetween(a, b) {
  return Math.round((toUTC(b) - toUTC(a)) / 86400000);
}
/** Minutes since epoch for a local "YYYY-MM-DDTHH:MM" string (treated as UTC, only used for differences). */
export function toMinutes(dt) {
  const d = datePart(dt);
  const t = timePart(dt) || '00:00';
  const [h, m] = t.split(':').map(Number);
  return toUTC(d) / 60000 + h * 60 + m;
}
export function fromMinutes(min) {
  const iso = new Date(min * 60000).toISOString();
  return iso.slice(0, 16);
}
export function addMinutes(dt, n) {
  return fromMinutes(toMinutes(dt) + Math.round(n));
}
export function diffMinutes(a, b) {
  return toMinutes(b) - toMinutes(a);
}
export function dateRange(start, end) {
  const out = [];
  if (!start || !end || end < start) return out;
  for (let d = start; d <= end && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}
/** Local "YYYY-MM-DD" and "YYYY-MM-DDTHH:MM" for a JS Date (device time zone). */
export function localDate(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}
export function localDateTime(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${localDate(now)}T${p(now.getHours())}:${p(now.getMinutes())}`;
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(dateStr, { long = false } = {}) {
  if (!dateStr) return '';
  const d = new Date(toUTC(dateStr));
  const s = `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
  return long ? `${s} ${d.getUTCFullYear()}` : s;
}
export function fmtTime(t, h12 = false) {
  if (!t) return '';
  if (!h12) return t;
  let [h, m] = t.split(':').map(Number);
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')}${ap}`;
}
export function fmtDuration(min) {
  if (min == null || !isFinite(min)) return '';
  min = Math.max(0, Math.round(min));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
export function fmtDistance(km, unit = 'km') {
  if (km == null || !isFinite(km)) return '';
  const v = unit === 'mi' ? km * 0.621371 : km;
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${unit}`;
}
/** "in 2 h 5 min" / "now" / "3 days" style relative label. */
export function fmtUntil(min) {
  if (min <= 0) return 'now';
  if (min < 60 * 24) return `in ${fmtDuration(min)}`;
  const d = Math.round(min / 1440);
  return `in ${d} day${d === 1 ? '' : 's'}`;
}

// ---------- places ----------

export const hasCoords = (p) => !!p && isFinite(p.lat) && isFinite(p.lon) && p.lat !== null && p.lon !== null;
export const shortName = (p) => (p && p.name ? String(p.name).split(',')[0].trim() : '');

export function haversineKm(a, b) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Points along the great circle from a to b (for drawing flight arcs). */
export function greatCircle(a, b, n = 48) {
  const rad = Math.PI / 180;
  const φ1 = a.lat * rad, λ1 = a.lon * rad, φ2 = b.lat * rad, λ2 = b.lon * rad;
  const d = 2 * Math.asin(Math.sqrt(Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2));
  if (d < 1e-9) return [[a.lat, a.lon], [b.lat, b.lon]];
  const pts = [];
  let prevLon = null;
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);
    const lat = Math.atan2(z, Math.sqrt(x * x + y * y)) / rad;
    let lon = Math.atan2(y, x) / rad;
    // Keep the line continuous across the antimeridian.
    if (prevLon !== null) {
      while (lon - prevLon > 180) lon -= 360;
      while (lon - prevLon < -180) lon += 360;
    }
    prevLon = lon;
    pts.push([lat, lon]);
  }
  return pts;
}

/** Decode a Google/OSRM encoded polyline (precision 5) to [[lat, lon], ...]. */
export function decodePolyline(str, precision = 5) {
  const out = [];
  if (!str) return out;
  const factor = 10 ** precision;
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let result = 0, shift = 0, b;
      do {
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20 && i < str.length);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta; else lon += delta;
    }
    out.push([lat / factor, lon / factor]);
  }
  return out;
}

/** Every distinct place used in the trip (for quick picking), most used first. */
export function knownPlaces(items) {
  const map = new Map();
  for (const it of items) {
    for (const p of [it.place, it.from, it.to]) {
      if (!hasCoords(p)) continue;
      const key = `${(+p.lat).toFixed(4)},${(+p.lon).toFixed(4)}`;
      const e = map.get(key);
      if (e) e.count++;
      else map.set(key, { place: { name: p.name, lat: +p.lat, lon: +p.lon }, count: 1 });
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.place.name.localeCompare(b.place.name)).map((e) => e.place);
}

// ---------- items ----------

export function itemTitle(it) {
  const f = shortName(it.from), t = shortName(it.to);
  switch (it.type) {
    case 'flight': {
      const head = [it.provider, it.number].filter(Boolean).join(' ') || 'Flight';
      return f && t ? `${head} · ${f} → ${t}` : head;
    }
    case 'car': return `Car hire${it.provider ? ` · ${it.provider}` : ''}`;
    case 'drive': return it.title || (t ? `Drive to ${t}` : 'Drive');
    default: return it.title || TYPES[it.type]?.label || 'Item';
  }
}

/** Planned drive minutes for a drive item, including traffic buffer and stops. */
export function driveMinutes(it, bufferPct = 0) {
  const base = Number(it.route?.durationMin);
  if (!isFinite(base) || base <= 0) return null;
  return Math.round(base * (1 + (Number(bufferPct) || 0) / 100) + (Number(it.stopMin) || 0));
}

export function itemEnd(it, bufferPct = 0) {
  if (it.type === 'drive') {
    const m = driveMinutes(it, bufferPct);
    return m != null && it.start ? addMinutes(it.start, m) : '';
  }
  return it.end || '';
}

/** Returns a list of problems with an item ([] = valid). */
export function validateItem(it) {
  const def = TYPES[it.type];
  if (!def) return ['Unknown type'];
  const errs = [];
  for (const f of def.fields) {
    if (!f.required) continue;
    const v = it[f.key];
    if (f.kind === 'place' ? !(v && v.name) : !String(v ?? '').trim()) errs.push(`${f.label.replace(/ \(.*\)$/, '')} is required`);
  }
  if (it.start && it.end && it.end < it.start) errs.push('End is before start');
  return errs;
}

/** Remove empty/undefined values (Firestore rejects undefined) and trim strings. */
export function cleanItem(it) {
  const out = {};
  for (const [k, v] of Object.entries(it)) {
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'string') { const s = v.trim(); if (s) out[k] = s; continue; }
    if (typeof v === 'object' && !Array.isArray(v)) {
      const o = cleanItem(v);
      if (Object.keys(o).length) out[k] = o;
      continue;
    }
    out[k] = v;
  }
  return out;
}

// ---------- agenda ----------

/**
 * Timed events an item creates. Each event:
 * { item, kind, at, endAt, place, endPlace, label }
 *   place:    where the event happens (where you need to be at `at`)
 *   endPlace: where you are afterwards, if different (flights, drives)
 */
export function eventsForItem(it, bufferPct = 0) {
  const ev = [];
  const push = (e) => e.at && ev.push({ item: it, endAt: '', place: null, endPlace: null, ...e });
  const f = it.from, t = it.to;
  switch (it.type) {
    case 'flight':
    case 'transport': {
      const what = it.type === 'flight' ? `Fly ${shortName(f) || '?'} → ${shortName(t) || '?'}` : itemTitle(it);
      push({ kind: 'depart', at: it.start, place: f, endPlace: t, label: what });
      if (it.end) push({ kind: 'arrive', at: it.end, place: t, label: `Arrive ${shortName(t) || ''}`.trim() });
      break;
    }
    case 'hotel':
      push({ kind: 'checkin', at: it.start, place: it.place, label: `Check in · ${it.title || 'Hotel'}` });
      push({ kind: 'checkout', at: it.end, place: it.place, label: `Check out · ${it.title || 'Hotel'}` });
      break;
    case 'car':
      push({ kind: 'pickup', at: it.start, place: f, label: `Pick up car${it.provider ? ` · ${it.provider}` : ''}` });
      push({ kind: 'dropoff', at: it.end, place: t && t.name ? t : f, label: `Return car${it.provider ? ` · ${it.provider}` : ''}` });
      break;
    case 'drive':
      push({ kind: 'drive', at: it.start, endAt: itemEnd(it, bufferPct), place: f, endPlace: t, label: itemTitle(it) });
      break;
    default:
      push({ kind: 'activity', at: it.start, endAt: it.end && datePart(it.end) === datePart(it.start) ? it.end : '', place: it.place, label: itemTitle(it) });
  }
  return ev;
}

const KIND_ORDER = { checkout: 0, dropoff: 1, arrive: 2, pickup: 3, drive: 4, depart: 5, activity: 6, checkin: 7 };

export function sortEvents(events) {
  return events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9)));
}

/** Hotel you sleep in on the night starting `date` (check-in date <= date < check-out date). */
export function hotelForNight(items, date) {
  return items.find((it) => it.type === 'hotel' && it.start && it.end && datePart(it.start) <= date && date < datePart(it.end)) || null;
}

/**
 * Everything for one day: timed events plus context (where you slept, where
 * you sleep tonight, car hire and multi-day activities in progress).
 */
export function dayAgenda(items, date, bufferPct = 0) {
  const events = [];
  for (const it of items) for (const e of eventsForItem(it, bufferPct)) if (datePart(e.at) === date) events.push(e);
  sortEvents(events);
  const lastNight = hotelForNight(items, addDays(date, -1));
  const tonight = hotelForNight(items, date);
  const ongoing = items.filter((it) => {
    if (!(it.start && it.end)) return false;
    const s = datePart(it.start), e = datePart(it.end);
    if (it.type === 'car') return s < date && date < e;
    if (it.type === 'activity') return s < date && date <= e;
    return false;
  });
  return { date, events, lastNight, tonight, ongoing };
}

/** First and last date covered by the trip (from settings, widened by items). */
export function tripSpan(meta = {}, items = []) {
  let start = meta.start || '';
  let end = meta.end || '';
  for (const it of items) {
    for (const v of [it.start, it.end]) {
      const d = datePart(v);
      if (!d) continue;
      if (!start || d < start) start = d;
      if (!end || d > end) end = d;
    }
  }
  if (start && !end) end = start;
  return { start, end };
}

/** The day to show on "Today": today if within the trip, else the nearest trip day. */
export function defaultDay(span, today) {
  if (!span.start) return today;
  if (today < span.start) return span.start;
  if (today > span.end) return span.end;
  return today;
}

/**
 * Places you'll need to get between on a day, with the time available.
 * Returns legs: { index, from, to, fromAt, toAt, availableMin, fromLabel, toLabel }
 *   index = position in agenda.events the leg comes before (events.length = end of day).
 * Legs already covered by a flight/train/drive item are not repeated.
 */
export function driveLegs(agenda, { minKm = 0.5, maxKm = 1500 } = {}) {
  const legs = [];
  const { date, events, lastNight, tonight } = agenda;
  let cur = lastNight && hasCoords(lastNight.place)
    ? { place: lastNight.place, at: '', label: lastNight.title || 'hotel' }
    : null;
  const near = (a, b) => haversineKm(a, b) < minKm;
  events.forEach((ev, index) => {
    if (cur && hasCoords(cur.place) && hasCoords(ev.place) && ev.kind !== 'arrive' && !near(cur.place, ev.place)) {
      const km = haversineKm(cur.place, ev.place);
      if (km <= maxKm) {
        legs.push({
          index, from: cur.place, to: ev.place, fromAt: cur.at, toAt: ev.at,
          availableMin: cur.at ? diffMinutes(cur.at, ev.at) : null,
          fromLabel: cur.label, toLabel: ev.label,
        });
      }
    }
    // Where you are afterwards. A named place counts even without map coordinates
    // (e.g. an airport that couldn't be placed): you're there, so no drive is
    // worked out from where you were before the flight/train.
    const named = (p) => p && (hasCoords(p) || p.name);
    const nextPlace = named(ev.endPlace) ? ev.endPlace : named(ev.place) ? ev.place : cur?.place;
    cur = nextPlace ? { place: nextPlace, at: ev.endAt || ev.at, label: ev.endPlace ? shortName(ev.endPlace) : ev.label } : cur;
  });
  const checkedInToday = events.some((e) => e.kind === 'checkin' && tonight && e.item.id === tonight.id);
  if (tonight && !checkedInToday && cur && hasCoords(tonight.place) && hasCoords(cur.place) && !near(cur.place, tonight.place)
      && haversineKm(cur.place, tonight.place) <= maxKm) {
    legs.push({
      index: events.length, from: cur.place, to: tonight.place, fromAt: cur.at, toAt: '',
      availableMin: null, fromLabel: cur.label, toLabel: `Back to ${tonight.title || 'hotel'}`,
    });
  }
  return legs.map((l) => ({ ...l, date }));
}

/** 'ok' | 'tight' | 'late' for a leg given estimated drive minutes. */
export function legStatus(availableMin, driveMin, tightMin = 15) {
  if (availableMin == null || driveMin == null) return 'ok';
  if (driveMin > availableMin) return 'late';
  if (availableMin - driveMin < tightMin) return 'tight';
  return 'ok';
}

// ---------- calendar (.ics) ----------

const icsEsc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (m) => `\\${m}`);
const icsDT = (dt) => `${dt.slice(0, 4)}${dt.slice(5, 7)}${dt.slice(8, 10)}T${dt.slice(11, 13)}${dt.slice(14, 16)}00`;

function fold(line) {
  const out = [];
  while (line.length > 74) { out.push(line.slice(0, 74)); line = ` ${line.slice(74)}`; }
  out.push(line);
  return out.join('\r\n');
}

/** Calendar file with one event per item, in floating (local wall-clock) time. */
export function toICS(tripName, items, bufferPct = 0, stamp = '20260101T000000Z') {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Trip Planner//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${icsEsc(tripName)}`];
  for (const it of items) {
    if (!it.start) continue;
    const add = (suffix, title, start, end, place) => {
      const e = end && end > start ? end : addMinutes(start, 60);
      lines.push('BEGIN:VEVENT', `UID:${it.id}${suffix}@trip-planner`, `DTSTAMP:${stamp}`,
        `DTSTART:${icsDT(start)}`, `DTEND:${icsDT(e)}`, fold(`SUMMARY:${icsEsc(title)}`));
      if (place?.name) lines.push(fold(`LOCATION:${icsEsc(place.name)}`));
      const desc = [it.ref && `Ref: ${it.ref}`, it.terminal && `Terminal ${it.terminal}`, it.arrTerminal && `Arrival terminal ${it.arrTerminal}`, it.seat && `Seat: ${it.seat}`, it.notes].filter(Boolean).join('\n');
      if (desc) lines.push(fold(`DESCRIPTION:${icsEsc(desc)}`));
      lines.push('END:VEVENT');
    };
    if (it.type === 'hotel') {
      add('-in', `Check in: ${it.title}`, it.start, '', it.place);
      if (it.end) add('-out', `Check out: ${it.title}`, it.end, '', it.place);
    } else if (it.type === 'car') {
      add('-pick', `Pick up car: ${it.provider || ''}`.trim(), it.start, '', it.from);
      if (it.end) add('-drop', `Return car: ${it.provider || ''}`.trim(), it.end, '', it.to?.name ? it.to : it.from);
    } else {
      add('', itemTitle(it), it.start, itemEnd(it, bufferPct), it.place || it.from);
    }
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

/** "ba117" / "BA-117" / "ba 0117" → "BA 117"; anything else is just trimmed and upper-cased. */
export function formatFlightNo(s) {
  const t = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = t.match(/^([A-Z0-9]{2}[A-Z]?)(\d{1,4}[A-Z]?)$/) && t.match(/^([A-Z]{2,3}|[A-Z]\d|\d[A-Z])(\d{1,4}[A-Z]?)$/);
  return m ? `${m[1]} ${m[2].replace(/^0+(?=\d)/, '')}` : String(s || '').trim().toUpperCase();
}

