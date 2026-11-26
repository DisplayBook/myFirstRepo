// Trip Planner: screens, forms and wiring.
import {
  TYPES, uid, isTripId, datePart, timePart, addDays, daysBetween, dateRange, localDate, localDateTime,
  fmtDate, fmtTime, fmtDuration, fmtDistance, fmtUntil, diffMinutes, addMinutes, hasCoords, shortName,
  haversineKm, greatCircle, decodePolyline, knownPlaces, itemTitle, driveMinutes, itemEnd, validateItem,
  cleanItem, eventsForItem, dayAgenda, tripSpan, defaultDay, driveLegs, legStatus, hotelForNight, toICS, formatFlightNo,
} from './logic.js';
import * as store from './store.js';
import { aiProxyUrl } from './config.js';
import { searchPlaces, driveRoute, cachedRoute, currentPosition, routeRoads } from './geo.js';
import { showMap, destroyMap } from './map.js';
import { ACCEPT, prepareFile, fmtBytes, fileIcon, isImage } from './files.js';
import { CURRENCIES, homeCurrency, fmtMoney, hasCost, budgetSummary, parseAmount, payment } from './budget.js';
import { extractBookings, transcribe, normalizeBookings, placesToLocate, friendlyError, flightStatus, roadConditions, dayBrief, guessTime, askTrip, flightDetails, normalizeFlightLookup } from './ai.js';
import { buildTripContext, CHAT_SYSTEM, renderMarkdown, sourcesFrom, answerText, placesFrom, isSavedIdea } from './chat.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const main = $('#main');
const sheet = $('#sheet');
const sheetBody = $('#sheet-body');

const S = {
  settings: store.getSettings(),
  trip: null, // {id, kind}
  meta: {},
  items: [],
  files: [], // attached documents (metadata only)
  role: 'admin', // 'admin' can edit; 'viewer' opened a view-only link
  exists: null,
  status: { state: 'idle' },
  close: null,
  viewDay: '',
  sig: '',
};

const bufferPct = () => Number(S.meta.bufferPct ?? 10);
const t12 = (t) => fmtTime(t, S.settings.h12);
const dist = (km) => fmtDistance(km, S.settings.unit);
const isApple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);

/** Which maps app links open (Trip → On this device). Google Maps by default. */
const useApple = () => S.settings.maps === 'apple';
const placeQuery = (p) => (hasCoords(p) ? `${p.lat},${p.lon}` : String(p?.name || ''));

/**
 * Directions to a place. With no `from`, the maps app starts from the phone's
 * current location (it uses its own live location, so the app doesn't need
 * location permission). `mode` 'driving' for drive legs; none lets Maps choose.
 */
function directionsUrl(from, to, { mode = from ? 'driving' : '' } = {}) {
  const dest = encodeURIComponent(placeQuery(to));
  if (useApple()) {
    return `https://maps.apple.com/?${from ? `saddr=${encodeURIComponent(placeQuery(from))}&` : ''}daddr=${dest}${mode === 'driving' ? '&dirflg=d' : ''}`;
  }
  return `https://www.google.com/maps/dir/?api=1${from ? `&origin=${encodeURIComponent(placeQuery(from))}` : ''}&destination=${dest}${mode ? `&travelmode=${mode}` : ''}`;
}

// ---------- toast ----------

let toastTimer;
function toast(msg, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button" class="link">${esc(action.label)}</button>` : ''}`;
  el.hidden = false;
  if (action) $('button', el).onclick = () => { el.hidden = true; action.run(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 6000 : 2600);
}

// ---------- routing ----------

function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const [name = '', arg = '', arg2 = ''] = h.split('/');
  return { name, arg: decodeURIComponent(arg), arg2: decodeURIComponent(arg2) };
}
const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };
window.addEventListener('hashchange', () => {
  // Moving to another screen closes any open form or sheet.
  if (sheet.open) sheet.close();
  render();
});

// ---------- trips ----------

const prefetched = new Set();

function openTrip(id, kind) {
  if (S.close) S.close();
  S.trip = { id, kind };
  S.meta = {}; S.items = []; S.files = []; S.exists = null; S.sig = ''; S.role = kind === 'cloud' ? 'viewer' : 'admin';
  S.settings = store.setSettings({ currentTrip: id });
  S.close = store.backendFor(kind).open(id, (data) => {
    const roleChanged = S.role !== (data.role || 'admin');
    S.meta = data.meta; S.items = data.items; S.files = data.files || []; S.exists = data.exists;
    S.role = data.role || 'admin';
    S.onFiles?.();
    if (kind === 'cloud' && navigator.onLine && S.files.length && !prefetched.has(id)) {
      prefetched.add(id);
      setTimeout(() => store.backendFor('cloud').prefetch(id, S.files).catch(() => {}), 3000);
    }
    if (data.meta.name) store.rememberTrip({ id, name: data.meta.name, kind });
    const sig = JSON.stringify([data.meta, data.items, S.files.map((f) => [f.id, f.itemId])]);
    if (sig !== S.sig || roleChanged) { S.sig = sig; render({ fromData: true }); }
  }, (st) => { S.status = st; renderStatus(); });
  renderStatus();
}

function backend() { return store.backendFor(S.trip.kind); }

/** Admin devices can change the trip; view-only devices can't. */
const canEdit = () => S.role !== 'viewer';

/**
 * AI features: a key saved on this phone wins; otherwise shared trips use the
 * trip's AI server (workers/trip-ai), which holds the key for everyone.
 */
const sharedAi = () => !!(aiProxyUrl && S.trip?.kind === 'cloud');
const aiOn = () => !!S.settings.aiKey || sharedAi();
async function aiAuth() {
  if (S.settings.aiKey) return { apiKey: S.settings.aiKey };
  if (sharedAi()) return { baseURL: aiProxyUrl, apiKey: await store.idToken(), headers: { 'x-trip-id': S.trip.id } };
  throw new Error('AI features aren\'t set up on this phone');
}

/** Run a write. Local writes are awaited; cloud writes are optimistic (they also work offline). */
async function write(fn) {
  if (!canEdit()) { toast('This trip is view only on this device'); throw new Error('view only'); }
  const p = fn(backend(), S.trip.id);
  if (S.trip.kind === 'cloud') { p.catch((e) => toast(`Not saved: ${e.message}`)); return; }
  try { await p; } catch (e) { toast(e.message); throw e; }
}

async function createTrip({ name, start, end }) {
  const id = uid(22);
  const kind = store.cloudConfigured() ? 'cloud' : 'local';
  const meta = cleanItem({ name: name || 'My trip', start, end, bufferPct: 10, currency: homeCurrency({}), createdAt: new Date().toISOString() });
  store.rememberTrip({ id, name: meta.name, kind });
  const p = store.backendFor(kind).create(id, meta);
  if (kind === 'local') await p; else p.catch((e) => toast(`Not saved: ${e.message}`));
  openTrip(id, kind);
  go('#/today');
}

function joinTrip(id, code = '') {
  // Don't leave the admin code in the address bar or browser history.
  history.replaceState(null, '', `${location.pathname}#/today`);
  const known = store.myTrips().find((t) => t.id === id);
  if (known?.kind === 'local') { openTrip(known.id, 'local'); render(); return; }
  if (!store.cloudConfigured()) {
    go('#/trips');
    toast('This link is for a shared trip, but this copy of the app is not connected to shared sync.');
    return;
  }
  if (!known) store.rememberTrip({ id, name: 'Shared trip', kind: 'cloud' });
  openTrip(id, 'cloud');
  render();
  if (!code) { if (!known) toast('Trip added (view only)'); return; }
  store.backendFor('cloud').joinAsAdmin(id, code, S.settings.name)
    .then(() => toast('You can now edit this trip'))
    .catch((e) => toast(e.code === 'permission-denied'
      ? 'This admin link is no longer valid. You can still view the trip.'
      : `Couldn't add you as an admin: ${e.message}`));
}

const viewLink = () => `${location.origin}${location.pathname}#/join/${S.trip.id}`;
const adminLink = (code) => `${location.origin}${location.pathname}#/join/${S.trip.id}/${code}`;

// ---------- status pill ----------

function renderStatus() {
  const el = $('#sync');
  const name = $('#trip-name');
  name.textContent = S.trip ? (S.meta.name || store.myTrips().find((t) => t.id === S.trip.id)?.name || 'Trip') : 'Trip Planner';
  if (!S.trip) { el.hidden = true; return; }
  const map = {
    local: ['This device only', 'muted'],
    connecting: ['Connecting…', 'muted'],
    synced: ['Shared · synced', 'ok'],
    pending: ['Syncing…', 'muted'],
    offline: ['Offline · saved', 'warn'],
    error: [S.status.message || 'Sync error', 'bad'],
    idle: ['', 'muted'],
  };
  let [text, cls] = map[S.status.state] || map.idle;
  if (S.trip.kind === 'cloud' && !canEdit() && S.status.state !== 'error') [text, cls] = ['👁 View only', 'muted'];
  el.hidden = !text;
  el.className = `sync ${cls}`;
  el.textContent = text;
}

// ---------- render ----------

function render({ fromData = false } = {}) {
  const r = parseRoute();
  if (r.name === 'join') { if (isTripId(r.arg)) joinTrip(r.arg, /^[0-9A-Za-z]{20,40}$/.test(r.arg2) ? r.arg2 : ''); else go('#/trips'); return; }
  if (!S.trip && r.name !== 'trips') { go('#/trips'); return; }
  const name = r.name || 'today';
  // Don't rebuild the map for status-only updates while you're looking at it.
  if (fromData && name === 'map' && sheet.open) return;
  $$('.tabbar a').forEach((a) => a.toggleAttribute('aria-current', a.dataset.tab === name));
  $('#fab').hidden = name === 'trips' || !S.trip || !canEdit();
  $('#chat-btn').hidden = name === 'trips' || !S.trip;
  document.body.dataset.view = name;
  if (name !== 'map') destroyMap();
  const keepScroll = fromData ? window.scrollY : 0;
  switch (name) {
    case 'trips': renderTrips(); break;
    case 'plan': renderPlan(); break;
    case 'map': renderMap(r.arg); break;
    case 'trip': renderTripSettings(); break;
    case 'budget': renderBudget(); break;
    default: renderToday(r.arg);
  }
  renderStatus();
  if (fromData) window.scrollTo(0, keepScroll);
  else if (!sheet.open) { window.scrollTo(0, 0); }
}

function loadingOrMissing() {
  if (S.exists === null) { main.innerHTML = '<p class="empty">Loading trip…</p>'; return true; }
  if (S.exists === false && S.trip.kind === 'cloud' && !S.items.length) {
    main.innerHTML = `<section class="card"><h1>Trip not found yet</h1>
      <p>If you just opened a share link, it may still be loading. Otherwise the link may be wrong, or the trip was deleted.</p>
      <p><a class="btn" href="#/trips">Your trips</a></p></section>`;
    return true;
  }
  return false;
}

// ---------- Today ----------

function eventMeta(ev) {
  const it = ev.item;
  const bits = [];
  const placeName = shortName(ev.place);
  if (ev.kind === 'drive') {
    const m = driveMinutes(it, bufferPct());
    if (m != null) bits.push(`${fmtDuration(m)}${it.route?.distanceKm ? ` · ${dist(it.route.distanceKm)}` : ''}`);
    if (ev.endAt) bits.push(`arrive ~${t12(timePart(ev.endAt))}`);
    if (shortName(it.from)) bits.push(`from ${shortName(it.from)}`);
  } else if (placeName && !ev.label.includes(placeName)) bits.push(placeName);
  if (ev.kind === 'depart' && it.end) {
    const sameDay = datePart(it.end) === datePart(it.start);
    bits.push(`arrives ${t12(timePart(it.end))}${sameDay ? '' : ` (${fmtDate(datePart(it.end))})`}`);
  }
  if (ev.kind === 'checkin' && it.end) {
    const n = daysBetween(datePart(it.start), datePart(it.end));
    if (n > 0) bits.push(`${n} night${n === 1 ? '' : 's'} · check out ${fmtDate(datePart(it.end))}`);
  }
  if (ev.kind === 'activity' && ev.endAt) bits.push(fmtDuration(diffMinutes(ev.at, ev.endAt)));
  if (ev.kind === 'pickup' && it.end) {
    const back = it.to?.name ? shortName(it.to) : shortName(it.from);
    bits.push(`return ${fmtDate(datePart(it.end))} ${t12(timePart(it.end))}${back ? ` at ${back}` : ''}`);
  }
  if (it.ref && ['depart', 'checkin', 'pickup', 'activity'].includes(ev.kind)) bits.push(`Ref ${it.ref}`);
  if (it.terminal && ev.kind === 'depart') bits.push(`Terminal ${it.terminal}`);
  if (it.arrTerminal && ev.kind === 'arrive') bits.push(`Terminal ${it.arrTerminal}`);
  if (it.seat && ev.kind === 'depart') bits.push(`Seats ${it.seat}`);
  if (hasCost(it) && ['depart', 'checkin', 'pickup', 'activity', 'drive'].includes(ev.kind)) {
    const cur = it.currency || homeCurrency(S.meta);
    const pay = payment(it);
    bits.push(`${fmtMoney(Number(it.cost), cur)}${pay.status === 'full' ? ' · paid' : pay.status === 'deposit' ? ` · ${fmtMoney(pay.paid, cur)} deposit paid` : ''}`);
  }
  return bits;
}

/** Icon for a timeline event: flights show taking off 🛫 and landing 🛬. */
function evIcon(ev) {
  if (ev.item.type === 'flight') return ev.kind === 'arrive' ? '🛬' : '🛫';
  return TYPES[ev.item.type].icon;
}

const tilesToggle = ({ refresh = false } = {}) => `<div class="tiles-toggle">
  ${refresh ? '<button type="button" class="link small" data-refresh>↻ Refresh</button>' : ''}
  <button type="button" class="link small" data-tiles="${tilesFull() ? 'compact' : 'full'}">${tilesFull() ? '⌃ Collapse all' : '⌄ Expand all'}</button></div>`;

const docCount = (itemId) => S.files.filter((f) => f.itemId === itemId).length;

/** Where to go for an event (none for arrivals: you get there by the flight/train). */
function eventDestination(ev) {
  if (ev.kind === 'arrive') return null;
  const p = ev.kind === 'drive' ? ev.endPlace : ev.place;
  return p && (hasCoords(p) || p.name) ? p : null;
}

// ---------- compact / expanded tiles ----------
// Tiles show the essentials; ⌄ expands one, "Expand all" switches the mode.
// The mode is a per-phone setting; single tiles opened the other way are
// remembered in `tp:flipped` until the mode changes.
const FLIP_KEY = 'tp:flipped';
const flipped = new Set((() => { try { return JSON.parse(localStorage.getItem(FLIP_KEY)) || []; } catch { return []; } })());
const saveFlipped = () => { try { localStorage.setItem(FLIP_KEY, JSON.stringify([...flipped].slice(-300))); } catch { /* ignore */ } };
const tilesFull = () => S.settings.tiles === 'full';
const evKey = (ev) => `${ev.item.id}:${ev.kind}`;
const isExpanded = (ev) => tilesFull() !== flipped.has(evKey(ev));

/** One-line live headline for a compact tile, if a check has been run. */
function liveChip(ev) {
  const it = ev.item;
  const kind = it.type === 'flight' && ev.kind === 'depart' ? 'flight' : it.type === 'drive' ? 'road' : '';
  const c = kind && liveGet(liveKey(kind, it));
  if (!c) return '';
  const d = c.data;
  if (kind === 'flight') {
    if (!d.found) return '';
    const late = d.delayMinutes >= 15 || d.status === 'delayed';
    const map = { cancelled: ['🔴', 'Cancelled', 'bad'], diverted: ['🔴', 'Diverted', 'bad'], departed: ['🔵', 'Departed', ''], in_air: ['🔵', 'In the air', ''], landed: ['🔵', 'Landed', ''], boarding: ['🟢', 'Boarding', 'ok'] };
    const [dot, text, cls] = map[d.status] || (late ? ['🟠', `Delayed${d.delayMinutes ? ` ${fmtDuration(d.delayMinutes)}` : ''}`, 'warn'] : ['🟢', 'On time', 'ok']);
    return `<span class="ev-chip ${cls}">${dot} ${esc(text)}${d.depGate ? ` · Gate ${esc(d.depGate)}` : ''}</span>`;
  }
  const lv = { none: ['🟢', 'No known delays', 'ok'], minor: ['🟠', 'Some delays possible', 'warn'], major: ['🔴', 'Major disruption', 'bad'] }[d.level];
  return lv ? `<span class="ev-chip ${lv[2]}">${lv[0]} ${esc(lv[1])}</span>` : '';
}

function eventRow(ev, { live = false } = {}) {
  const def = TYPES[ev.item.type];
  const open = isExpanded(ev);
  const dest = live && open ? eventDestination(ev) : null;
  const goBox = dest ? `<div class="ev-go"><a href="${esc(directionsUrl(null, dest))}" target="_blank" rel="noopener" aria-label="Directions to ${esc(dest.name || 'this place')}">🧭 Directions${shortName(dest) ? ` to ${esc(shortName(dest))}` : ''}</a></div>` : '';
  const liveBox = live && open ? liveHtml(ev) : '';
  const time = timePart(ev.at);
  const meta = eventMeta(ev);
  const isMain = ['depart', 'checkin', 'pickup', 'activity', 'drive'].includes(ev.kind);
  const hasMore = meta.length > 1 || docCount(ev.item.id) || (ev.item.notes && isMain) || (live && (eventDestination(ev) || liveHtml(ev)));
  const endT = ev.endAt && ev.kind === 'activity' ? `–${t12(timePart(ev.endAt))}` : '';
  return `<li class="ev ${open ? 'open' : 'compact'}" style="--c:${def.color}" data-item="${esc(ev.item.id)}">
    ${canEdit() ? `<button type="button" class="swipe-del" data-item="${esc(ev.item.id)}" tabindex="-1" aria-label="Delete ${esc(itemTitle(ev.item))}">Delete</button>` : ''}
    <button type="button" class="ev-btn" data-edit="${esc(ev.item.id)}" aria-label="${esc(`${t12(time)} ${ev.label}. Edit`)}">
      <span class="ev-time">${esc(t12(time))}<small>${esc(endT)}</small></span>
      <span class="ev-icon" aria-hidden="true">${evIcon(ev)}</span>
      <span class="ev-body"><strong>${esc(ev.label)}</strong>
        ${(open ? meta : meta.slice(0, 1)).map((b) => `<span class="ev-meta">${esc(b)}</span>`).join('')}
        ${!open ? liveChip(ev) : ''}
        ${open && docCount(ev.item.id) && isMain ? `<span class="ev-docs">📎 ${docCount(ev.item.id)} document${docCount(ev.item.id) === 1 ? '' : 's'}</span>` : ''}
        ${open && ev.item.notes && isMain ? `<span class="ev-notes">${esc(ev.item.notes)}</span>` : ''}
      </span>
    </button>
    ${hasMore ? `<button type="button" class="ev-more" data-expand="${esc(evKey(ev))}" aria-expanded="${open}" aria-label="${open ? 'Show less' : 'Show more details'}">${open ? '⌃' : '⌄'}${!open && docCount(ev.item.id) && isMain ? '<small>📎</small>' : ''}</button>` : ''}
    ${goBox}${liveBox}</li>`;
}

function legRow(leg, i) {
  return `<li class="leg" data-leg="${i}">
    <span class="leg-icon" aria-hidden="true">🚗</span>
    <span class="leg-text"><span class="leg-main">Working out drive time…</span>
      <span class="leg-sub">${esc(shortName(leg.from) || 'here')} → ${esc(shortName(leg.to) || 'there')}</span></span>
    <a class="leg-go" href="${esc(directionsUrl(leg.from, leg.to))}" target="_blank" rel="noopener">Directions</a>
  </li>`;
}

function paintLeg(el, leg, r) {
  if (!el || !el.isConnected) return;
  const main = $('.leg-main', el);
  if (!r || r.error) {
    main.textContent = `No road route found (${dist(haversineKm(leg.from, leg.to))} away)`;
    el.dataset.status = 'none';
    return;
  }
  const m = Math.round(r.durationMin * (1 + bufferPct() / 100));
  const st = legStatus(leg.availableMin, m);
  el.dataset.status = st;
  let text = `About ${fmtDuration(m)} drive · ${dist(r.distanceKm)}`;
  if (leg.availableMin != null) {
    const free = fmtDuration(Math.max(0, leg.availableMin));
    text += st === 'late' ? ` — only ${free} free, you'd be late`
      : st === 'tight' ? ` — tight, ${free} free` : ` · ${free} free`;
  }
  main.textContent = text;
}

function fillLegs(legs, root) {
  legs.forEach((leg, i) => {
    const el = $(`[data-leg="${i}"]`, root);
    const c = cachedRoute(leg.from, leg.to);
    if (c) { paintLeg(el, leg, c); return; }
    driveRoute(leg.from, leg.to).then((r) => paintLeg(el, leg, r)).catch(() => {
      if (el?.isConnected) $('.leg-main', el).textContent = `${dist(haversineKm(leg.from, leg.to))} away · drive time needs a connection`;
    });
  });
}

function renderToday(arg) {
  if (loadingOrMissing()) return;
  const span = tripSpan(S.meta, S.items);
  const today = localDate();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : defaultDay(span, today);
  S.viewDay = day;
  const days = dateRange(span.start, span.end);
  const ag = dayAgenda(S.items, day, bufferPct());
  const legs = driveLegs(ag);
  const dayNo = days.indexOf(day) + 1;

  let banner = '';
  if (span.start && day === span.start && today < span.start) {
    const n = daysBetween(today, span.start);
    banner = `<p class="banner">Trip starts in ${n} day${n === 1 ? '' : 's'}. Showing the first day.</p>`;
  } else if (span.end && day === span.end && today > span.end) {
    banner = '<p class="banner">This trip is over. Showing the last day.</p>';
  }

  let next = '';
  if (day === today) {
    const now = localDateTime();
    const upcoming = ag.events.find((e) => e.at >= now);
    if (upcoming) {
      next = `<div class="next" style="--c:${TYPES[upcoming.item.type].color}">
        <span class="next-label">Next up · ${esc(fmtUntil(diffMinutes(now, upcoming.at)))}</span>
        <strong>${evIcon(upcoming)} ${esc(upcoming.label)}</strong>
        <span>${esc(t12(timePart(upcoming.at)))}${upcoming.place?.name ? ` · ${esc(shortName(upcoming.place))}` : ''}</span></div>`;
    }
  }

  const ctx = [];
  if (ag.lastNight && !ag.events.some((e) => e.kind === 'checkout' && e.item.id === ag.lastNight.id)) ctx.push(`🛏️ Staying at ${esc(ag.lastNight.title)}`);
  for (const it of ag.ongoing) ctx.push(`${TYPES[it.type].icon} ${esc(itemTitle(it))}${it.type === 'car' ? ` until ${esc(fmtDate(datePart(it.end)))}` : ' (continues)'}`);

  let rows = '';
  ag.events.forEach((ev, i) => {
    legs.forEach((l, li) => { if (l.index === i) rows += legRow(l, li); });
    rows += eventRow(ev, { live: true });
  });
  legs.forEach((l, li) => { if (l.index === ag.events.length) rows += legRow(l, li); });

  const strip = days.length > 1 && days.length <= 90 ? `<nav class="daystrip" aria-label="Trip days">${days.map((d, i) => `
      <a href="#/today/${d}" class="${d === day ? 'sel' : ''} ${d === today ? 'today' : ''}" ${d === day ? 'aria-current="date"' : ''}>
        <small>${esc(fmtDate(d).split(' ')[0])}</small><b>${Number(d.slice(8))}</b><small>Day ${i + 1}</small></a>`).join('')}</nav>` : '';

  main.innerHTML = `
    <div class="dayhead">
      <a class="iconbtn" href="#/today/${addDays(day, -1)}" aria-label="Previous day">‹</a>
      <div><h1>${day === today ? 'Today' : esc(fmtDate(day))}</h1>
        <p class="muted">${day === today ? esc(fmtDate(day, { long: true })) : esc(String(new Date(day).getUTCFullYear()))}${dayNo ? ` · Day ${dayNo} of ${days.length}` : ''}</p></div>
      <a class="iconbtn" href="#/today/${addDays(day, 1)}" aria-label="Next day">›</a>
    </div>
    ${strip}
    ${banner}
    ${next}
    ${ctx.length ? `<div class="ctx">${ctx.map((c) => `<span>${c}</span>`).join('')}</div>` : ''}
    ${ag.events.length ? tilesToggle({ refresh: true }) : ''}
    ${ag.events.length || legs.length ? `<ol class="timeline">${rows}</ol>` : `<div class="empty"><p>Nothing planned for this day.</p>${canEdit() ? '<button type="button" class="btn" data-add>Add something</button>' : ''}</div>`}
    ${ag.tonight ? `<p class="tonight">🌙 Tonight: <strong>${esc(ag.tonight.title)}</strong>${ag.tonight.place?.name ? ` · ${esc(shortName(ag.tonight.place))}` : ''}</p>` : ''}
    <p class="hint muted">Drive times are estimates without live traffic, plus ${bufferPct()}% buffer (change in Trip).</p>
    <section class="card brief" id="brief" data-day="${esc(day)}">${briefHtml(day)}</section>`;
  fillLegs(legs, main);
}

// ---------- live checks & day summary (Claude + web search) ----------

const LIVE_KEY = 'tp:live';
const liveBusy = new Set();
const liveErr = new Map();
function liveGet(k) {
  try { return JSON.parse(localStorage.getItem(LIVE_KEY))?.[k] || null; } catch { return null; }
}
function liveSet(k, data) {
  try {
    const all = JSON.parse(localStorage.getItem(LIVE_KEY)) || {};
    all[k] = { data, at: Date.now() };
    const keys = Object.keys(all);
    if (keys.length > 120) keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - 120).forEach((x) => delete all[x]);
    localStorage.setItem(LIVE_KEY, JSON.stringify(all));
  } catch { /* storage full: results just aren't kept */ }
}
const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const liveKey = (kind, it) => (kind === 'flight'
  ? `flight:${it.id}:${it.number}:${it.start}`
  : `road:${it.id}:${it.start}:${it.from?.lat},${it.from?.lon}>${it.to?.lat},${it.to?.lon}`);

/** Live box under a flight or drive tile on the Today screen. */
function liveHtml(ev) {
  const it = ev.item;
  const kind = it.type === 'flight' && ev.kind === 'depart' ? 'flight' : it.type === 'drive' ? 'road' : '';
  if (!kind) return '';
  const today = localDate();
  const date = datePart(it.start);
  const daysAway = daysBetween(today, date);
  if (daysAway < -1) return '';
  const wrap = (inner, cls = '') => `<div class="live ${cls}" data-live="${kind}" data-item="${esc(it.id)}">${inner}</div>`;
  if (kind === 'flight' && !it.number) return wrap('<span class="muted small">Add the flight number to check its live status.</span>');
  if (!aiOn()) {
    return wrap(`<span class="muted small">${kind === 'flight' ? 'Live flight status' : 'Road disruption checks'} need AI features. <a href="#/trip">Set up</a></span>`);
  }
  const k = liveKey(kind, it);
  if (liveBusy.has(k)) return wrap(`<span class="small" role="status">⏳ Checking ${kind === 'flight' ? 'flight status' : 'the route'}… (up to a minute)</span>`);
  const err = liveErr.get(k);
  const cached = liveGet(k);
  const btn = (label) => `<button type="button" class="link small" data-live-check="${kind}" data-item="${esc(it.id)}">${label}</button>`;
  if (kind === 'flight' && daysAway > 2 && !cached) {
    return wrap(`<span class="muted small">Live status is available from ${esc(fmtDate(addDays(date, -1)))}.</span>`);
  }
  if (!cached) {
    return wrap(`${err ? `<span class="error small">${esc(err)}</span>` : ''}${btn(kind === 'flight' ? '✈️ Check flight status' : '🚧 Check for delays on the route')}`);
  }
  const d = cached.data;
  const foot = `<span class="live-foot">${d.source ? `${esc(d.source)} · ` : ''}checked ${esc(ago(cached.at))} · ${btn('Refresh')}</span>`;
  if (kind === 'flight') {
    if (!d.found) return wrap(`<span class="small">No live status found yet. It usually appears closer to departure.</span>${foot}`);
    const map = {
      scheduled: ['🟢', 'Scheduled', 'ok'], on_time: ['🟢', 'On time', 'ok'], delayed: ['🟠', 'Delayed', 'warn'],
      boarding: ['🟢', 'Boarding', 'ok'], departed: ['🔵', 'Departed', 'info'], in_air: ['🔵', 'In the air', 'info'],
      landed: ['🔵', 'Landed', 'info'], cancelled: ['🔴', 'Cancelled', 'bad'], diverted: ['🔴', 'Diverted', 'bad'], unknown: ['⚪', 'Status unknown', ''],
    };
    let [dot, label, cls] = map[d.status] || map.unknown;
    if (d.status !== 'delayed' && d.delayMinutes >= 15 && ['scheduled', 'on_time', 'boarding'].includes(d.status)) [dot, label, cls] = ['🟠', 'Delayed', 'warn'];
    const head = `${label}${d.delayMinutes > 0 && cls === 'warn' ? ` ${fmtDuration(d.delayMinutes)}` : ''}${d.depEstimated && d.depEstimated !== d.depScheduled ? ` · departs ${t12(d.depEstimated)}` : ''}`;
    const details = [
      d.depTerminal && `Terminal ${d.depTerminal}`, d.depGate && `Gate ${d.depGate}`,
      (d.arrEstimated || d.arrScheduled) && `Arrives ${t12(d.arrEstimated || d.arrScheduled)}${d.arrTerminal ? ` (T${d.arrTerminal.replace(/^T(erminal)?\s*/i, '')})` : ''}`,
      d.baggage && `Baggage ${d.baggage}`,
    ].filter(Boolean).join(' · ');
    return wrap(`<strong class="small">${dot} ${esc(head)}</strong>${details ? `<span class="small">${esc(details)}</span>` : ''}${d.note ? `<span class="muted small">${esc(d.note)}</span>` : ''}${foot}`, cls);
  }
  const lv = { none: ['🟢', 'No known disruptions', 'ok'], minor: ['🟠', 'Some delays possible', 'warn'], major: ['🔴', 'Major disruption', 'bad'], unknown: ['⚪', 'Couldn\'t check', ''] }[d.level] || ['⚪', 'Unknown', ''];
  return wrap(`<strong class="small">${lv[0]} ${esc(lv[1])}${d.extraMinutes > 0 ? ` · allow ~${esc(fmtDuration(d.extraMinutes))} extra` : ''}</strong>
    ${d.summary ? `<span class="small">${esc(d.summary)}</span>` : ''}
    ${(d.issues || []).length ? `<ul class="live-issues">${d.issues.slice(0, 5).map((x) => `<li><b>${esc(x.road)}</b> ${esc(x.issue)}${x.when ? ` <span class="muted">(${esc(x.when)})</span>` : ''}</li>`).join('')}</ul>` : ''}
    ${d.roads?.length ? `<span class="muted small">Checked: ${esc(d.roads.join(', '))}. Live traffic: use Directions in Maps.</span>` : ''}${foot}`, lv[2]);
}

function refreshLive(kind, itemId) {
  const el = main.querySelector(`.live[data-live="${kind}"][data-item="${CSS.escape(itemId)}"]`);
  const it = S.items.find((i) => i.id === itemId);
  if (!el || !it) return;
  const ev = eventsForItem(it, bufferPct()).find((e) => (kind === 'flight' ? e.kind === 'depart' : e.kind === 'drive'));
  if (ev) el.outerHTML = liveHtml(ev);
}

// ---------- refresh (pull down on Today, or ↻ Refresh) ----------

let refreshing = false;
const ptr = document.createElement('div');
ptr.className = 'ptr';
ptr.setAttribute('role', 'status');
ptr.setAttribute('aria-live', 'polite');
document.body.append(ptr);

/** Re-check what can change: live statuses already checked for this day, times, and app updates. */
async function refreshToday() {
  if (refreshing || !S.trip) return;
  refreshing = true;
  ptr.textContent = '↻ Refreshing…';
  ptr.className = 'ptr show busy';
  navigator.serviceWorker?.getRegistration?.().then((r) => r?.update()).catch(() => {});
  const tasks = [];
  if (aiOn()) {
    for (const ev of dayAgenda(S.items, S.viewDay || localDate(), bufferPct()).events) {
      const kind = ev.item.type === 'flight' && ev.kind === 'depart' ? 'flight' : ev.item.type === 'drive' ? 'road' : '';
      if (kind && liveGet(liveKey(kind, ev.item))) tasks.push(checkLive(kind, ev.item.id));
    }
  }
  render({ fromData: true });
  await Promise.allSettled(tasks);
  refreshing = false;
  ptr.className = 'ptr';
  render({ fromData: true });
  toast(tasks.length ? `Updated · ${tasks.length} live check${tasks.length === 1 ? '' : 's'} refreshed` : 'Up to date');
}

// Pull down from the top of Today to refresh (iPhone home-screen apps have no built-in pull-to-refresh).
const PULL = 70;
let pull = null;
window.addEventListener('touchstart', (e) => {
  if (refreshing || sheet.open || (parseRoute().name || 'today') !== 'today' || window.scrollY > 0 || e.touches.length !== 1) { pull = null; return; }
  pull = { y0: e.touches[0].clientY, x0: e.touches[0].clientX, dy: 0 };
}, { passive: true });
window.addEventListener('touchmove', (e) => {
  if (!pull) return;
  const dy = e.touches[0].clientY - pull.y0;
  const dx = e.touches[0].clientX - pull.x0;
  if (dy <= 0 || Math.abs(dx) > Math.abs(dy) || window.scrollY > 0) { pull.dy = 0; ptr.className = 'ptr'; return; }
  pull.dy = dy;
  ptr.style.setProperty('--pull', `${Math.min(dy, PULL * 1.6)}px`);
  ptr.textContent = dy >= PULL ? '↑ Release to refresh' : '↓ Pull to refresh';
  ptr.className = `ptr show pulling${dy >= PULL ? ' ready' : ''}`;
}, { passive: true });
window.addEventListener('touchend', () => {
  if (!pull) return;
  const go = pull.dy >= PULL;
  pull = null;
  if (go) refreshToday(); else ptr.className = 'ptr';
});

async function checkLive(kind, itemId) {
  const it = S.items.find((i) => i.id === itemId);
  if (!it || !aiOn()) return;
  const k = liveKey(kind, it);
  if (liveBusy.has(k)) return;
  liveBusy.add(k); liveErr.delete(k);
  refreshLive(kind, itemId);
  try {
    if (kind === 'flight') {
      const data = await flightStatus(await aiAuth(), {
        // "117" + airline "BA" → "BA 117", so the search finds the right flight.
        number: /[A-Za-z]/.test(it.number) ? it.number : `${it.provider || ''} ${it.number}`.trim(),
        airline: it.provider, from: it.from?.name, to: it.to?.name,
        date: datePart(it.start), depTime: timePart(it.start), now: localDateTime(),
      });
      liveSet(k, data);
    } else {
      const roads = await routeRoads(it.from, it.to).catch(() => []);
      const data = await roadConditions(await aiAuth(), {
        from: it.from?.name, to: it.to?.name, date: datePart(it.start), time: timePart(it.start), roads, now: localDateTime(),
      });
      liveSet(k, { ...data, roads });
    }
  } catch (err) {
    liveErr.set(k, friendlyError(err));
  } finally {
    liveBusy.delete(k);
    refreshLive(kind, itemId);
  }
}

const briefKey = (day) => `brief:${S.trip?.id}:${day}`;

function briefHtml(day) {
  if (!aiOn()) {
    return `<h2>✨ Day summary</h2><p class="muted small">Get an AI overview of the day with weather, tips and nearby places to eat and visit. Needs AI features: <a href="#/trip">set them up in Trip</a>.</p>`;
  }
  const k = briefKey(day);
  if (liveBusy.has(k)) return '<h2>✨ Day summary</h2><p class="small" role="status">⏳ Looking at your day, the weather and what\'s nearby… (up to a minute)</p>';
  const err = liveErr.get(k);
  const cached = liveGet(k);
  if (!cached) {
    return `<h2>✨ Day summary</h2>
      <p class="muted small">An overview of this day with weather, tips and suggestions for places to visit or eat near your plans.</p>
      ${err ? `<p class="error small">${esc(err)}</p>` : ''}
      <button type="button" class="btn" data-brief>✨ Summarise this day</button>`;
  }
  const b = cached.data;
  const icon = { attraction: '🏛️', restaurant: '🍽️', cafe: '☕', bar: '🍸', shopping: '🛍️', event: '🎟️', outdoors: '🌳', other: '📍' };
  const mapUrl = mapSearchUrl;
  return `<h2>✨ Day summary</h2>
    ${b.weather ? `<p class="brief-weather">🌤️ ${esc(b.weather)}</p>` : ''}
    <p>${esc(b.overview)}</p>
    ${(b.tips || []).length ? `<h3>Tips</h3><ul class="brief-tips">${b.tips.slice(0, 5).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
    ${(b.suggestions || []).length ? `<h3>Ideas for the day</h3><ul class="brief-ideas">${b.suggestions.slice(0, 8).map((x, i) => `<li>
      <span class="idea-icon" aria-hidden="true">${icon[x.category] || '📍'}</span>
      <span class="idea-body"><strong>${esc(x.name)}</strong>${x.when ? ` <span class="muted small">· ${esc(x.when)}</span>` : ''}
        <span class="small">${esc(x.why)}</span>
        <span class="idea-actions"><a class="small" href="${esc(mapUrl(`${x.name}, ${x.address}`))}" target="_blank" rel="noopener">Map</a>
        ${canEdit() ? `${isSavedIdea(ideasList(), x.name) ? '<span class="small saved">✓ In Ideas</span>' : `<button type="button" class="link small" data-idea-save="${i}">☆ Save idea</button>`}
        <button type="button" class="link small" data-idea="${i}">＋ Add to plan</button>` : ''}</span></span></li>`).join('')}</ul>` : ''}
    ${err ? `<p class="error small">${esc(err)}</p>` : ''}
    <p class="muted small">AI suggestions: check opening times before you go. Updated ${esc(ago(cached.at))} · <button type="button" class="link small" data-brief>Refresh</button></p>`;
}

function dayContext(day) {
  const ag = dayAgenda(S.items, day, bufferPct());
  const span = tripSpan(S.meta, S.items);
  const days = dateRange(span.start, span.end);
  const lines = [`Trip: ${S.meta.name || 'Trip'}. This day: ${fmtDate(day, { long: true })}${days.includes(day) ? ` (day ${days.indexOf(day) + 1} of ${days.length})` : ''}. Today's date for the traveller: ${localDate()}.`];
  if (ag.lastNight) lines.push(`Woke up at: ${ag.lastNight.title}${ag.lastNight.place?.name ? `, ${ag.lastNight.place.name}` : ''}.`);
  if (ag.tonight) lines.push(`Sleeping tonight at: ${ag.tonight.title}${ag.tonight.place?.name ? `, ${ag.tonight.place.name}` : ''}.`);
  for (const it of ag.ongoing) lines.push(`Ongoing: ${itemTitle(it)}${it.type === 'car' ? ' (has a hire car)' : ''}.`);
  lines.push(ag.events.length ? 'Plans (local times):' : 'No fixed plans this day.');
  for (const ev of ag.events) {
    const p = ev.place?.name ? ` at ${ev.place.name}` : '';
    const to = ev.endPlace?.name ? ` to ${ev.endPlace.name}` : '';
    lines.push(`- ${timePart(ev.at)}${ev.endAt ? `–${timePart(ev.endAt)}` : ''} ${ev.label}${p}${to}${ev.item.notes ? ` (notes: ${ev.item.notes.slice(0, 200)})` : ''}`);
  }
  for (const leg of driveLegs(ag)) {
    const r = cachedRoute(leg.from, leg.to);
    if (r && !r.error) lines.push(`Travel: about ${fmtDuration(r.durationMin)} by car from ${leg.from.name} to ${leg.to.name}.`);
  }
  return lines.join('\n');
}

async function runBrief(day) {
  const k = briefKey(day);
  if (liveBusy.has(k) || !aiOn()) return;
  liveBusy.add(k); liveErr.delete(k);
  const paint = () => { const el = $('#brief'); if (el && el.dataset.day === day) el.innerHTML = briefHtml(day); };
  paint();
  try {
    liveSet(k, await dayBrief(await aiAuth(), dayContext(day)));
  } catch (err) {
    liveErr.set(k, friendlyError(err));
  } finally {
    liveBusy.delete(k);
    paint();
  }
}

function addIdea(day, i) {
  const x = liveGet(briefKey(day))?.data?.suggestions?.[i];
  if (x) placeToPlan(x, { day });
}

// ---------- ideas (places to maybe do) ----------

const PLACE_ICON = { attraction: '🏛️', restaurant: '🍽️', cafe: '☕', bar: '🍸', shopping: '🛍️', event: '🎟️', outdoors: '🌳', other: '📍' };
function mapSearchUrl(q) {
  return useApple() ? `https://maps.apple.com/?q=${encodeURIComponent(q)}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}
const ideasList = () => (Array.isArray(S.meta.ideas) ? S.meta.ideas : []);

/** Save a suggested place to the trip's shared Ideas list. */
async function saveIdea(p, source) {
  if (isSavedIdea(ideasList(), p.name)) { toast('Already in Ideas'); return false; }
  const idea = cleanItem({
    id: uid(12), name: p.name, category: p.category, why: p.why, when: p.when, address: p.address,
    source, addedBy: S.settings.name, addedAt: new Date().toISOString(),
  });
  try { await write((b, id) => b.addIdea(id, idea)); } catch { return false; }
  toast('Saved to Ideas (top of the Plan tab)');
  return true;
}

/** Open a new activity pre-filled from a suggested place (found on the map if possible). */
async function placeToPlan(x, { day, onSaved } = {}) {
  toast('Finding it on the map…');
  const label = x.address ? `${x.name}, ${x.address}` : x.name;
  let place = { name: label.slice(0, 200) };
  try {
    const [hit] = await searchPlaces(label);
    const hit2 = hit || (x.address ? (await searchPlaces(x.address))[0] : null);
    if (hit2) place = { name: `${x.name}, ${x.address || hit2.name}`.slice(0, 200), lat: hit2.lat, lon: hit2.lon };
  } catch { /* keep the name only */ }
  const d = day || S.viewDay || defaultDay(tripSpan(S.meta, S.items), localDate());
  openItemForm('activity', null, { title: x.name, place, start: `${d}T${guessTime(x.when)}`, notes: x.why }, { onSaved });
}

function ideasCard() {
  const ideas = ideasList();
  if (!ideas.length && !canEdit()) return '';
  return `<section class="card ideas-card" id="ideas">
    <h2><span>💡 Ideas${ideas.length ? ` <span class="muted small">${ideas.length}</span>` : ''}</span></h2>
    ${ideas.length ? `<ul class="ideas-list">${ideas.map((x) => `<li>
      <span class="idea-icon" aria-hidden="true">${PLACE_ICON[x.category] || '📍'}</span>
      <span class="idea-body"><strong>${esc(x.name)}</strong>${x.when ? ` <span class="muted small">· ${esc(x.when)}</span>` : ''}
        ${x.why ? `<span class="small">${esc(x.why)}</span>` : ''}
        ${x.address ? `<span class="muted small">${esc(x.address)}</span>` : ''}
        ${x.addedBy ? `<span class="muted small">Saved by ${esc(x.addedBy)}</span>` : ''}
        <span class="idea-actions"><a class="small" href="${esc(mapSearchUrl(x.address ? `${x.name}, ${x.address}` : x.name))}" target="_blank" rel="noopener">Map</a>
        ${canEdit() ? `<button type="button" class="link small" data-idea-plan="${esc(x.id)}">＋ Add to plan</button>
        <button type="button" class="link small danger-link" data-idea-remove="${esc(x.id)}">Remove</button>` : ''}</span></span></li>`).join('')}</ul>`
      : '<p class="muted small">Save restaurants, activities and places you might do from the 💬 chat or the day summary on Today. Everyone on the trip sees them here.</p>'}
  </section>`;
}

// ---------- Plan (whole itinerary) ----------

function renderPlan() {
  if (loadingOrMissing()) return;
  const span = tripSpan(S.meta, S.items);
  const days = dateRange(span.start, span.end);
  const today = localDate();
  if (!S.items.length) {
    main.innerHTML = `<h1>Plan</h1><div class="empty"><p>No plans yet. Add flights, hotels, car hire, drives and activities.</p>
      ${canEdit() ? '<button type="button" class="btn" data-add>Add the first item</button>' : ''}</div>${ideasCard()}`;
    return;
  }
  const counts = Object.fromEntries(Object.keys(TYPES).map((k) => [k, S.items.filter((i) => i.type === k).length]));
  main.innerHTML = `<h1>Plan</h1>
    <p class="muted">${esc(fmtDate(span.start, { long: true }))} – ${esc(fmtDate(span.end, { long: true }))} · ${days.length} day${days.length === 1 ? '' : 's'}</p>
    <div class="ctx">${Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `<span>${TYPES[k].icon} ${n} ${esc(n === 1 ? TYPES[k].label.toLowerCase() : TYPES[k].plural)}</span>`).join('')}</div>
    ${ideasCard()}
    ${tilesToggle()}
    ${days.map((d, i) => {
      const ag = dayAgenda(S.items, d, bufferPct());
      return `<section class="plan-day ${d === today ? 'is-today' : ''}">
        <a class="plan-head" href="#/today/${d}"><span>Day ${i + 1} · ${esc(fmtDate(d))}${d === today ? ' · Today' : ''}</span><span aria-hidden="true">›</span></a>
        ${ag.events.length ? `<ol class="timeline compact">${ag.events.map(eventRow).join('')}</ol>` : '<p class="muted free">Free day</p>'}
        ${ag.tonight ? `<p class="tonight small">🌙 ${esc(ag.tonight.title)}</p>` : ''}
      </section>`;
    }).join('')}`;
}

// ---------- Map ----------

function popupNode(title, lines, place) {
  const div = document.createElement('div');
  div.className = 'popup';
  const b = document.createElement('strong');
  b.textContent = title;
  div.append(b);
  for (const l of lines) { const p = document.createElement('div'); p.textContent = l; div.append(p); }
  if (hasCoords(place)) {
    const a = document.createElement('a');
    a.href = directionsUrl(null, place); a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Directions';
    div.append(a);
  }
  return div;
}

async function renderMap(arg) {
  if (loadingOrMissing()) return;
  const span = tripSpan(S.meta, S.items);
  const days = dateRange(span.start, span.end);
  const day = days.includes(arg) ? arg : '';
  main.innerHTML = `
    <div class="map-top">
      <nav class="chips" aria-label="Show on map">
        <a class="chip ${day ? '' : 'sel'}" href="#/map" ${day ? '' : 'aria-current="page"'}>Whole trip</a>
        ${days.map((d, i) => `<a class="chip ${d === day ? 'sel' : ''}" href="#/map/${d}" ${d === day ? 'aria-current="page"' : ''}>Day ${i + 1} · ${esc(fmtDate(d))}</a>`).join('')}
      </nav>
    </div>
    <div id="map" class="map" role="region" aria-label="Trip map"></div>
    <div class="map-bottom">
      <div class="legend">${['flight', 'drive', 'transport', 'hotel', 'activity', 'car'].map((k) => `<span><i style="--c:${TYPES[k].color}"></i>${esc(TYPES[k].label)}</span>`).join('')}<span><i class="dashed"></i>Drive between plans</span></div>
      <button type="button" class="btn" id="open-calc">🚗 Drive time calculator</button>
    </div>`;
  $('#open-calc').onclick = () => openDriveCalc();

  const onDay = (it) => !day || eventsForItem(it).some((e) => datePart(e.at) === day) || (it.type === 'hotel' && hotelForNight([it], day));
  const items = S.items.filter(onDay);
  const markers = new Map();
  const addMarker = (p, it, line, icon) => {
    if (!hasCoords(p)) return;
    const k = `${(+p.lat).toFixed(4)},${(+p.lon).toFixed(4)}`;
    const m = markers.get(k) || { lat: +p.lat, lon: +p.lon, color: TYPES[it.type].color, icon: icon || TYPES[it.type].icon, lines: [], title: p.name, place: p };
    m.lines.push(line);
    markers.set(k, m);
  };
  const lines = [];
  for (const it of items) {
    const when = (s) => (s ? `${fmtDate(datePart(s))} ${t12(timePart(s))}` : '');
    switch (it.type) {
      case 'flight':
      case 'transport':
        addMarker(it.from, it, `${itemTitle(it)} · departs ${when(it.start)}`, it.type === 'flight' ? '🛫' : '');
        addMarker(it.to, it, `${itemTitle(it)} · arrives ${when(it.end) || '?'}`, it.type === 'flight' ? '🛬' : '');
        if (hasCoords(it.from) && hasCoords(it.to)) {
          lines.push(it.type === 'flight'
            ? { points: greatCircle(it.from, it.to), color: TYPES.flight.color, dash: '8 8', weight: 3 }
            : { points: [[it.from.lat, it.from.lon], [it.to.lat, it.to.lon]], color: TYPES.transport.color, dash: '2 8', weight: 4 });
        }
        break;
      case 'drive':
        addMarker(it.from, it, `${itemTitle(it)} · leave ${when(it.start)}`);
        addMarker(it.to, it, `${itemTitle(it)} · arrive ~${when(itemEnd(it, bufferPct()))}`);
        if (it.route?.geometry) lines.push({ points: decodePolyline(it.route.geometry), color: TYPES.drive.color, weight: 5 });
        else if (hasCoords(it.from) && hasCoords(it.to)) lines.push({ points: [[it.from.lat, it.from.lon], [it.to.lat, it.to.lon]], color: TYPES.drive.color, dash: '4 8' });
        break;
      case 'car':
        addMarker(it.from, it, `Pick up car · ${when(it.start)}`);
        if (it.to?.name) addMarker(it.to, it, `Return car · ${when(it.end)}`);
        break;
      case 'hotel':
        addMarker(it.place, it, `${it.title} · ${fmtDate(datePart(it.start))} – ${fmtDate(datePart(it.end))}`);
        break;
      default:
        addMarker(it.place, it, `${itemTitle(it)} · ${when(it.start)}`);
    }
  }
  const mk = [...markers.values()].map((m) => ({ ...m, popup: popupNode(shortName(m.place), m.lines, m.place) }));
  const el = $('#map');
  let ctl;
  try {
    ctl = await showMap(el, { markers: mk, lines });
  } catch (e) {
    el.innerHTML = `<p class="empty">${esc(e.message)}</p>`;
    return;
  }
  if (!ctl) return;
  if (!mk.length) toast('Add places to your plans to see them on the map');

  // Road routes for the gaps between plans (e.g. hotel → museum), drawn as they arrive.
  const legDays = day ? [day] : days;
  const seen = new Set();
  for (const d of legDays) {
    for (const leg of driveLegs(dayAgenda(S.items, d, bufferPct()))) {
      const k = `${leg.from.lat},${leg.from.lon}>${leg.to.lat},${leg.to.lon}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const draw = (r) => { if (r?.geometry && el.isConnected) ctl.addLine({ points: decodePolyline(r.geometry), color: TYPES.drive.color, weight: 3, dash: '1 7' }); };
      const c = cachedRoute(leg.from, leg.to);
      if (c) draw(c); else driveRoute(leg.from, leg.to).then(draw).catch(() => {});
    }
  }
}

// ---------- Budget ----------

function renderBudget() {
  if (loadingOrMissing()) return;
  const b = budgetSummary(S.items, S.meta, localDate());
  const home = b.home;
  const money = (n) => fmtMoney(n, home);
  const pct = b.budget ? Math.min(100, Math.round((b.total / b.budget) * 100)) : null;
  const over = b.budget !== null && b.total > b.budget;
  const maxType = Math.max(1, ...Object.values(b.byType));
  const span = tripSpan(S.meta, S.items);
  const days = dateRange(span.start, span.end);
  const maxDay = Math.max(1, ...Object.values(b.byDay));
  const otherCurrencies = [...new Set([...b.rows.map((r) => r.currency), ...Object.keys(S.meta.rates || {})])].filter((c) => c !== home).sort();

  main.innerHTML = `<h1>Budget</h1>
    <section class="card budget-top">
      <div class="kpis">
        <div><span class="kpi-label">Planned spend</span><strong class="kpi">${esc(money(b.total))}</strong></div>
        ${b.budget !== null ? `<div><span class="kpi-label">${over ? 'Over budget' : 'Left in budget'}</span><strong class="kpi ${over ? 'bad' : 'ok'}">${esc(money(Math.abs(b.remaining)))}</strong></div>` : ''}
      </div>
      ${b.budget !== null ? `<div class="meter ${over ? 'over' : ''}" role="img" aria-label="${pct}% of the ${esc(money(b.budget))} budget planned"><span style="width:${pct}%"></span></div>
        <p class="muted small">${pct}% of ${esc(money(b.budget))} budget</p>` : '<p class="muted small">Set a total budget below to track what\'s left.</p>'}
      <div class="kpis small-kpis">
        <div><span class="kpi-label">Paid</span><strong>${esc(money(b.paid))}</strong></div>
        <div><span class="kpi-label">Still to pay</span><strong>${esc(money(b.unpaid))}</strong></div>
      </div>
      ${b.missingRates.length ? `<p class="warn-box">Not counted yet: costs in ${b.missingRates.map(esc).join(', ')}. Add the exchange rate below.</p>` : ''}
    </section>

    ${b.total > 0 ? `<section class="card">
      <h2>By category</h2>
      <ul class="bars">${Object.entries(b.byType).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]).map(([k, v]) => `
        <li><span class="bar-label">${TYPES[k].icon} ${esc(TYPES[k].plural.replace(/^./, (c) => c.toUpperCase()))}</span>
          <span class="bar" style="--c:${TYPES[k].color}"><span style="width:${Math.max(2, (v / maxType) * 100)}%"></span></span>
          <span class="bar-value">${esc(money(v))}</span></li>`).join('')}</ul>
    </section>
    <section class="card">
      <h2>By day</h2>
      <p class="muted small">Hotel and car hire costs are spread across the nights and days they cover.</p>
      <ul class="bars days">${days.map((d, i) => `
        <li><a class="bar-label" href="#/today/${d}">Day ${i + 1} · ${esc(fmtDate(d))}</a>
          <span class="bar" style="--c:var(--accent)"><span style="width:${b.byDay[d] ? Math.max(2, (b.byDay[d] / maxDay) * 100) : 0}%"></span></span>
          <span class="bar-value">${b.byDay[d] ? esc(money(b.byDay[d])) : '—'}</span></li>`).join('')}</ul>
      ${b.budget !== null && days.length ? `<p class="muted small">Average ${esc(money(b.total / days.length))} a day · budget allows ${esc(money(b.budget / days.length))} a day</p>` : ''}
    </section>` : ''}

    ${b.upcoming.length ? `<section class="card">
      <h2>Upcoming payments</h2>
      <ul class="costs">${b.upcoming.map((r) => `<li>
        <button type="button" class="cost-row" data-edit="${esc(r.item.id)}">
          <span aria-hidden="true">${TYPES[r.item.type].icon}</span>
          <span class="cost-name"><strong>${esc(r.title)}</strong>
            <span class="small ${r.overdue ? 'error' : 'muted'}">${r.overdue ? 'Overdue · ' : ''}${r.balanceDue ? `Balance due ${esc(fmtDate(r.balanceDue))}` : r.by ? `Not paid · booking ${esc(fmtDate(r.by))}` : 'Not paid'}${r.status === 'deposit' ? ` · ${esc(fmtMoney(r.paidLocal, r.currency))} deposit paid` : ''}</span></span>
          <span class="cost-amt">${esc(fmtMoney(r.dueLocal, r.currency))}${r.currency !== home && r.dueValue !== null ? `<span class="muted small">≈ ${esc(money(r.dueValue))}</span>` : ''}</span>
        </button></li>`).join('')}</ul>
    </section>` : ''}

    <section class="card">
      <h2>Bookings</h2>
      ${b.rows.length ? `<ul class="costs">${b.rows.map((r) => `<li>
        <button type="button" class="cost-row" data-edit="${esc(r.item.id)}">
          <span aria-hidden="true">${TYPES[r.item.type].icon}</span>
          <span class="cost-name"><strong>${esc(r.title)}</strong><span class="muted small">${esc(fmtDate(datePart(r.item.start)))}${r.currency !== home ? ` · ${esc(fmtMoney(r.cost, r.currency))}` : ''}</span></span>
          <span class="cost-amt">${r.value === null ? `<span class="muted">${esc(fmtMoney(r.cost, r.currency))}</span>` : esc(money(r.value))}
            <span class="badge ${r.status === 'full' ? 'paidb' : r.status === 'deposit' ? 'depb' : ''}">${r.status === 'full' ? 'Paid' : r.status === 'deposit' ? `Deposit ${esc(fmtMoney(r.paidLocal, r.currency))}` : 'To pay'}</span></span>
        </button></li>`).join('')}</ul>` : '<p class="muted">No costs yet. Open a booking and fill in its cost.</p>'}
      ${b.uncosted.length ? `<details class="uncosted"><summary>${b.uncosted.length} booking${b.uncosted.length === 1 ? '' : 's'} without a cost</summary>
        <ul class="costs">${b.uncosted.map((it) => `<li><button type="button" class="cost-row" data-edit="${esc(it.id)}">
          <span aria-hidden="true">${TYPES[it.type].icon}</span><span class="cost-name"><strong>${esc(itemTitle(it))}</strong><span class="muted small">${esc(fmtDate(datePart(it.start)))}</span></span>
          <span class="cost-amt link">Add cost</span></button></li>`).join('')}</ul></details>` : ''}
    </section>

    <section class="card" ${canEdit() ? '' : 'hidden'}>
      <h2>Budget settings</h2>
      <form id="budget-form" class="form">
        <div class="two">
          <label>Home currency<select name="currency">${[...new Set([home, ...CURRENCIES])].map((c) => `<option ${c === home ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
          <label>Total budget<input name="budget" inputmode="decimal" placeholder="optional" value="${esc(b.budget ?? '')}"></label>
        </div>
        ${otherCurrencies.length ? `<fieldset class="rates"><legend>Exchange rates</legend>
          ${otherCurrencies.map((c) => `<label class="rate">1 ${esc(c)} =<input name="rate-${esc(c)}" inputmode="decimal" value="${esc(S.meta.rates?.[c] ?? '')}" placeholder="?" aria-label="${esc(home)} for 1 ${esc(c)}"> ${esc(home)}</label>`).join('')}
          <p class="muted small">Look up today's rate in your bank app or a search engine.</p></fieldset>` : ''}
        <button class="btn">Save</button>
        <p class="muted small">Shared with everyone on the trip.</p>
      </form>
    </section>`;

  $('#budget-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const budget = parseAmount(fd.get('budget'));
    if (String(fd.get('budget')).trim() && budget === null) { toast('Budget must be a number'); return; }
    const rates = {};
    for (const c of otherCurrencies) {
      const r = parseAmount(fd.get(`rate-${c}`));
      if (r !== null && r > 0) rates[c] = r;
    }
    const currency = fd.get('currency');
    if (currency !== home && Object.keys(rates).length) {
      if (!confirm(`Changing the home currency to ${currency} — remember to update the exchange rates to be in ${currency}.`)) return;
    }
    await write((bk, id) => bk.saveMeta(id, { currency, budget: budget ?? 0, rates }));
    toast('Budget saved');
  };
}

// ---------- Trip settings ----------

function renderTripSettings() {
  if (loadingOrMissing()) return;
  const m = S.meta;
  const cloud = S.trip.kind === 'cloud';
  const configured = store.cloudConfigured();
  const admin = canEdit();
  const share = cloud ? `
      <h3>👁 View link</h3>
      <p>For family and friends. They see the whole plan, documents and budget, updated live, but can't change anything.</p>
      <div class="sharebox"><input id="view-link" readonly value="${esc(viewLink())}" aria-label="View link"></div>
      <div class="row"><button type="button" class="btn" data-share-link="view">Share view link</button><button type="button" class="btn ghost" data-copy-link="view">Copy</button></div>
      ${admin ? `<h3 class="mt">✏️ Admin link</h3>
      <p>Only for people who should edit the plan. Opening it makes that phone an admin of this trip.</p>
      <div id="admin-box"><button type="button" class="btn ghost" id="show-admin">Show admin link</button></div>
      <p class="muted small">If the admin link gets passed on by mistake, make a new one: the old link stops working (phones that are already admins stay admins).</p>`
      : `<p class="muted small mt">This phone can only view this trip. To edit, open the <strong>admin link</strong> from the person who manages it, from inside this app (Trips → Join a shared trip).</p>`}
      <p class="muted small">Anyone with either link can see the booking references and documents, so only send them to people you trust.</p>`
    : configured ? `
      <p>This trip is only on this device. Move it to shared sync to get a link you can send to others.</p>
      <button type="button" class="btn" id="move-cloud">Move to shared sync</button>`
      : `
      <p>This trip is only on this device. To share trips live with family or friends, connect the app to a free Firebase database once (about 5 minutes). See <strong>Turn on sharing</strong> in the README.</p>
      <p class="muted small">Until then you can send a backup file (below) and the other person can import it.</p>`;

  main.innerHTML = `<h1>Trip</h1>
    <section class="card">
      <h2>Details</h2>
      <form id="meta-form"><fieldset class="plain form" ${admin ? '' : 'disabled'}>
        <label>Trip name<input name="name" required value="${esc(m.name || '')}"></label>
        <div class="two">
          <label>First day<input type="date" name="start" value="${esc(m.start || '')}"></label>
          <label>Last day<input type="date" name="end" value="${esc(m.end || '')}"></label>
        </div>
        <label>Extra time added to drive estimates
          <select name="bufferPct">${[0, 10, 20, 30, 40].map((p) => `<option value="${p}" ${bufferPct() === p ? 'selected' : ''}>${p ? `+${p}%` : 'None'}</option>`).join('')}</select>
        </label>
        <p class="muted small">Dates fill in automatically from your plans. These settings are shared with everyone on the trip.</p>
        ${admin ? '<button class="btn">Save</button>' : ''}
      </fieldset></form>
    </section>
    <section class="card" id="share-card"><h2>Share</h2>${share}</section>
    <section class="card">
      <h2>On this device</h2>
      <form id="prefs" class="form">
        <label>Your name (shown to others when you edit)<input name="name" value="${esc(S.settings.name)}" autocomplete="given-name"></label>
        <div class="two">
          <label>Time format<select name="h12"><option value="0">24-hour</option><option value="1" ${S.settings.h12 ? 'selected' : ''}>12-hour</option></select></label>
          <label>Distances<select name="unit"><option value="km">km</option><option value="mi" ${S.settings.unit === 'mi' ? 'selected' : ''}>miles</option></select></label>
          <label>Directions open in<select name="maps"><option value="google">Google Maps</option><option value="apple" ${S.settings.maps === 'apple' ? 'selected' : ''}>Apple Maps</option></select></label>
        </div>
      </form>
    </section>
    <section class="card">
      <h2>Documents</h2>
      ${S.files.length ? `<div id="all-docs"></div>` : '<p class="muted">Tickets, booking confirmations and photos you attach to bookings appear here.</p>'}
    </section>
    <section class="card" id="scan-settings">
      <h2>AI features</h2>
      <p>Scan bookings, live flight status, road delays, day summaries and the trip chat use Claude (by Anthropic).</p>
      ${S.settings.aiKey ? `<p>✅ On for this phone with its own key (ending …${esc(S.settings.aiKey.slice(-4))}).</p>
        <button type="button" class="btn ghost danger" id="ai-off">Remove key from this phone</button>`
        : sharedAi() ? `<p>✅ On for everyone on this trip. The app uses the trip's shared AI key, so nobody needs their own.</p>
        <details class="small"><summary>Use my own key on this phone instead</summary>
          <form id="ai-form" class="form"><label>API key<input name="key" type="password" autocomplete="off" placeholder="sk-ant-…" required></label>
          <button class="btn ghost">Use my key</button></form></details>`
        : `${aiProxyUrl ? '<p class="muted small">The shared AI key works on shared trips. For a trip on this phone only, add a key here.</p>' : ''}<ol class="steps small">
          <li>Sign in at <a href="https://console.anthropic.com" target="_blank" rel="noopener">console.anthropic.com</a> and add some credit (each scan costs a few cents).</li>
          <li>Go to <strong>API keys → Create key</strong> and copy it.</li>
          <li>Paste it here. It stays on this phone only and is never shared with the trip.</li></ol>
        <form id="ai-form" class="form"><label>API key<input name="key" type="password" autocomplete="off" placeholder="sk-ant-…" required></label>
        <button class="btn">Turn on scanning</button></form>`}
    </section>
    <section class="card">
      <h2>Export</h2>
      <div class="stack">
        <button type="button" class="btn ghost" id="ics">📅 Add to my calendar (.ics)</button>
        <button type="button" class="btn ghost" id="backup">⬇️ Download backup (JSON)</button>
        ${admin ? '<label class="btn ghost filebtn">⬆️ Import a backup into this trip<input type="file" id="import" accept="application/json,.json"></label>' : ''}
      </div>
      ${S.files.length ? '<p class="muted small">The backup file contains your plans but not the attached documents.</p>' : ''}
    </section>
    <section class="card">
      <h2>Trips</h2>
      <div class="stack">
        <a class="btn ghost" href="#/trips">All trips / new trip</a>
        ${admin ? `<button type="button" class="btn danger" id="del-trip">Delete this trip${cloud ? ' for everyone' : ''}</button>` : ''}
        ${cloud ? '<button type="button" class="btn ghost" id="forget-trip">Remove from this device</button>' : ''}
      </div>
    </section>
    <p class="muted small center">Maps © OpenStreetMap contributors · Routes by OSRM · Place search by Nominatim</p>`;

  const all = $('#all-docs');
  if (all) {
    const byItem = new Map();
    for (const f of S.files) byItem.set(f.itemId, [...(byItem.get(f.itemId) || []), f]);
    const groups = [...byItem.entries()].map(([itemId, files]) => ({ item: S.items.find((i) => i.id === itemId), files }))
      .sort((a, b) => (a.item?.start || '~').localeCompare(b.item?.start || '~'));
    all.innerHTML = groups.map((g, i) => `<div class="docgroup"><h3>${g.item ? `${TYPES[g.item.type].icon} ${esc(itemTitle(g.item))} <span class="muted small">${esc(fmtDate(datePart(g.item.start)))}</span>` : 'Deleted booking'}</h3><ul class="doclist" data-group="${i}"></ul></div>`).join('');
    groups.forEach((g, i) => renderDocList($(`[data-group="${i}"]`, all), g.files));
  }
  $('#meta-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const patch = { name: fd.get('name').trim() || 'My trip', start: fd.get('start') || '', end: fd.get('end') || '', bufferPct: Number(fd.get('bufferPct')) };
    if (patch.start && patch.end && patch.end < patch.start) { toast('Last day is before the first day'); return; }
    await write((b, id) => b.saveMeta(id, patch));
    store.rememberTrip({ id: S.trip.id, name: patch.name, kind: S.trip.kind });
    toast('Trip saved');
  };
  const aiForm = $('#ai-form');
  if (aiForm) aiForm.onsubmit = (e) => {
    e.preventDefault();
    const key = new FormData(aiForm).get('key').trim();
    if (!/^sk-ant-[\w-]{10,}$/.test(key)) { toast('That doesn\'t look like an Anthropic API key (it starts with sk-ant-)'); return; }
    S.settings = store.setSettings({ aiKey: key });
    toast('Scanning is on');
    render();
  };
  const aiOff = $('#ai-off');
  if (aiOff) aiOff.onclick = () => { S.settings = store.setSettings({ aiKey: '' }); toast('Key removed from this device'); render(); };
  $('#prefs').onchange = (e) => {
    const fd = new FormData(e.currentTarget);
    S.settings = store.setSettings({ name: fd.get('name').trim(), h12: fd.get('h12') === '1', unit: fd.get('unit'), maps: fd.get('maps') });
  };
  if (cloud) {
    let code = '';
    const linkFor = (kind) => (kind === 'admin' ? adminLink(code) : viewLink());
    $('#share-card').addEventListener('click', async (e) => {
      const sh = e.target.closest('[data-share-link]');
      const cp = e.target.closest('[data-copy-link]');
      if (sh) {
        const kind = sh.dataset.shareLink;
        const data = {
          title: S.meta.name || 'Our trip',
          text: kind === 'admin' ? `Admin link to edit our trip plan: ${S.meta.name || ''}` : `Our trip plan: ${S.meta.name || ''}`,
          url: linkFor(kind),
        };
        if (navigator.share) { try { await navigator.share(data); } catch { /* cancelled */ } } else copy(data.url, kind);
      } else if (cp) copy(linkFor(cp.dataset.copyLink), cp.dataset.copyLink);
    });
    const showAdmin = async (reset) => {
      const box = $('#admin-box');
      box.innerHTML = '<p class="muted small" role="status">Loading…</p>';
      try {
        const b = store.backendFor('cloud');
        code = reset ? await b.resetAdminCode(S.trip.id) : await b.adminCode(S.trip.id);
        box.innerHTML = `<div class="sharebox"><input id="admin-link" readonly value="${esc(adminLink(code))}" aria-label="Admin link"></div>
          <div class="row"><button type="button" class="btn" data-share-link="admin">Share admin link</button><button type="button" class="btn ghost" data-copy-link="admin">Copy</button>
          <button type="button" class="btn ghost danger" id="reset-admin">Make a new admin link</button></div>`;
        $('#reset-admin').onclick = () => {
          if (confirm('Make a new admin link? The current admin link will stop working. Phones that are already admins stay admins.')) showAdmin(true);
        };
        if (reset) toast('New admin link made. The old one no longer works.');
      } catch (err) {
        box.innerHTML = `<p class="error small">Couldn't load the admin link: ${esc(err.message)}. Are you online?</p><button type="button" class="btn ghost" id="show-admin">Try again</button>`;
        $('#show-admin').onclick = () => showAdmin(false);
      }
    };
    const sa = $('#show-admin');
    if (sa) sa.onclick = () => showAdmin(false);
    $('#forget-trip').onclick = () => {
      if (!confirm(`Remove "${S.meta.name}" from this device? ${admin ? 'It stays shared for everyone else. You can open it again with your link.' : 'You can add it again with the view link.'}`)) return;
      const { id } = S.trip;
      if (S.close) S.close();
      store.forgetTrip(id);
      S.trip = null;
      store.setSettings({ currentTrip: '' });
      go('#/trips');
      toast('Trip removed from this device');
    };
  }
  if (!admin) {
    $('#ics').onclick = () => download(`${slug(S.meta.name)}.ics`, 'text/calendar', toICS(S.meta.name || 'Trip', S.items, bufferPct(), `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`));
    $('#backup').onclick = () => download(`${slug(S.meta.name)}-backup.json`, 'application/json', JSON.stringify({ app: 'trip-planner', version: 1, meta: S.meta, items: S.items }, null, 2));
    return;
  }
  const mv = $('#move-cloud');
  if (mv) mv.onclick = async () => {
    mv.disabled = true;
    try { await store.moveToCloud(S.trip.id); openTrip(S.trip.id, 'cloud'); toast('Trip moved to shared sync'); render(); } catch (e) { toast(e.message); mv.disabled = false; }
  };
  $('#ics').onclick = () => download(`${slug(S.meta.name)}.ics`, 'text/calendar', toICS(S.meta.name || 'Trip', S.items, bufferPct(), `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`));
  $('#backup').onclick = () => download(`${slug(S.meta.name)}-backup.json`, 'application/json',
    JSON.stringify({ app: 'trip-planner', version: 1, meta: S.meta, items: S.items }, null, 2));
  $('#import').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const items = Array.isArray(data.items) ? data.items.filter((i) => i && TYPES[i.type] && i.start) : [];
      if (!items.length) throw new Error('No trip items found in that file');
      if (!confirm(`Import ${items.length} item${items.length === 1 ? '' : 's'} into "${S.meta.name}"? Items with the same id are replaced.`)) return;
      for (const it of items) await write((b, id) => b.saveItem(id, cleanItem({ ...it, id: String(it.id || uid(16)).replace(/[^0-9A-Za-z]/g, '').slice(0, 40) || uid(16) })));
      toast(`Imported ${items.length} item${items.length === 1 ? '' : 's'}`);
    } catch (err) { toast(`Import failed: ${err.message}`); }
    e.target.value = '';
  };
  $('#del-trip').onclick = async () => {
    if (!confirm(`Delete "${S.meta.name}"${cloud ? ' for everyone who has the link' : ''}? This can't be undone.`)) return;
    const { id, kind } = S.trip;
    try { await store.backendFor(kind).deleteTrip(id); } catch (e) { toast(`Delete failed: ${e.message}`); return; }
    if (S.close) S.close();
    store.forgetTrip(id);
    S.trip = null;
    store.setSettings({ currentTrip: '' });
    go('#/trips');
    toast('Trip deleted');
  };
}

const slug = (s) => String(s || 'trip').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'trip';

function download(name, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function copy(text, kind = 'view') {
  try { await navigator.clipboard.writeText(text); toast(kind === 'admin' ? 'Admin link copied' : 'Link copied'); } catch {
    const el = $(kind === 'admin' ? '#admin-link' : '#view-link'); el?.select(); toast('Select the link and copy it');
  }
}

// ---------- Trips list ----------

function renderTrips() {
  const trips = store.myTrips();
  const configured = store.cloudConfigured();
  main.innerHTML = `<h1>Your trips</h1>
    ${trips.length ? `<ul class="trips">${trips.map((t) => `<li><button type="button" class="trip-btn ${S.trip?.id === t.id ? 'sel' : ''}" data-open="${esc(t.id)}" data-kind="${esc(t.kind)}">
      <strong>${esc(t.name || 'Trip')}</strong><span class="badge ${t.kind}">${t.kind === 'cloud' ? 'Shared' : 'This device'}</span></button></li>`).join('')}</ul>`
      : '<p class="muted">Plan flights, hotels, car hire, drives and activities in one place, see what\'s on today, and map the whole trip.</p>'}
    <section class="card">
      <h2>New trip</h2>
      <form id="new-trip" class="form">
        <label>Trip name<input name="name" required placeholder="e.g. California road trip"></label>
        <div class="two">
          <label>First day<input type="date" name="start"></label>
          <label>Last day<input type="date" name="end"></label>
        </div>
        <button class="btn">Create trip</button>
        ${configured ? '' : '<p class="muted small">Sharing is off in this copy of the app, so new trips stay on this device. See the README to turn on sharing.</p>'}
      </form>
    </section>
    ${configured ? `<section class="card">
      <h2>Join a shared trip</h2>
      <form id="join" class="form">
        <label>Paste the link someone sent you (view or admin link)<input name="link" required placeholder="https://…#/join/…" autocomplete="off"></label>
        <button class="btn ghost">Join</button>
      </form></section>` : ''}`;
  $('#new-trip').onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const start = fd.get('start'), end = fd.get('end');
    if (start && end && end < start) { toast('Last day is before the first day'); return; }
    createTrip({ name: fd.get('name').trim(), start, end });
  };
  const j = $('#join');
  if (j) j.onsubmit = (e) => {
    e.preventDefault();
    const v = new FormData(e.target).get('link').trim();
    const m = v.match(/join\/([0-9A-Za-z]{20,40})(?:\/([0-9A-Za-z]{20,40}))?/);
    const id = m?.[1] || (isTripId(v) ? v : '');
    if (!id) { toast('That doesn\'t look like a trip link'); return; }
    joinTrip(id, m?.[2] || '');
  };
}

main.addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]');
  if (open) { openTrip(open.dataset.open, open.dataset.kind); go('#/today'); return; }
  const edit = e.target.closest('[data-edit]');
  if (edit) { const it = S.items.find((i) => i.id === edit.dataset.edit); if (it) openItemForm(it.type, it); return; }
  if (e.target.closest('[data-add]')) { openAddChooser(); return; }
  const ex = e.target.closest('[data-expand]');
  if (ex) {
    const k = ex.dataset.expand;
    if (flipped.has(k)) flipped.delete(k); else flipped.add(k);
    saveFlipped();
    render({ fromData: true });
    return;
  }
  if (e.target.closest('[data-refresh]')) { refreshToday(); return; }
  const tm = e.target.closest('[data-tiles]');
  if (tm) {
    S.settings = store.setSettings({ tiles: tm.dataset.tiles });
    flipped.clear();
    saveFlipped();
    render({ fromData: true });
    return;
  }
  const lc = e.target.closest('[data-live-check]');
  if (lc) { checkLive(lc.dataset.liveCheck, lc.dataset.item); return; }
  if (e.target.closest('[data-brief]')) { runBrief(S.viewDay); return; }
  const idea = e.target.closest('[data-idea]');
  if (idea) { addIdea(S.viewDay, Number(idea.dataset.idea)); return; }
  const ideaSave = e.target.closest('[data-idea-save]');
  if (ideaSave) {
    const x = liveGet(briefKey(S.viewDay))?.data?.suggestions?.[Number(ideaSave.dataset.ideaSave)];
    if (x) saveIdea(x, 'summary');
    return;
  }
  const ideaPlan = e.target.closest('[data-idea-plan]');
  if (ideaPlan) {
    const x = ideasList().find((i) => i.id === ideaPlan.dataset.ideaPlan);
    if (x) {
      placeToPlan(x, {
        onSaved: () => {
          closeSheet();
          write((b, id) => b.removeIdea(id, x)).catch(() => {});
          toast('Added to the plan and removed from Ideas');
        },
      });
    }
    return;
  }
  const ideaRemove = e.target.closest('[data-idea-remove]');
  if (ideaRemove) {
    const x = ideasList().find((i) => i.id === ideaRemove.dataset.ideaRemove);
    if (x && confirm(`Remove "${x.name}" from Ideas?`)) write((b, id) => b.removeIdea(id, x)).catch(() => {});
  }
});

// ---------- sheet (dialog) ----------

function openSheet(html, label) {
  sheetBody.className = '';
  sheetBody.innerHTML = html;
  sheet.setAttribute('aria-label', label);
  if (!sheet.open) sheet.showModal();
  sheetBody.scrollTop = 0;
}
function closeSheet() { if (sheet.open) sheet.close(); }
sheet.addEventListener('click', (e) => {
  if (e.target === sheet || e.target.closest('[data-close]')) closeSheet();
});
sheet.addEventListener('close', () => { sheetBody.innerHTML = ''; S.onFiles = null; chatAbort?.abort(); chatAbort = null; });

$('#fab').onclick = () => openAddChooser();

function openAddChooser() {
  openSheet(`<div class="sheet-head"><h2>Add to the plan</h2><button type="button" class="iconbtn" data-close aria-label="Close">✕</button></div>
    <button type="button" class="scan-cta" data-scan><span aria-hidden="true">✨</span><span><strong>Scan a booking</strong><small>Photo, screenshot, PDF or pasted email — fills in the details for you</small></span></button>
    <div class="typegrid">${Object.entries(TYPES).map(([k, d]) => `<button type="button" data-type="${k}" style="--c:${d.color}"><span aria-hidden="true">${d.icon}</span>${esc(d.label)}</button>`).join('')}
    <button type="button" data-calc style="--c:${TYPES.drive.color}"><span aria-hidden="true">⏱️</span>Drive time calculator</button></div>`, 'Add to the plan');
  $$('[data-type]', sheetBody).forEach((b) => { b.onclick = () => openItemForm(b.dataset.type); });
  $('[data-calc]', sheetBody).onclick = () => openDriveCalc();
  $('[data-scan]', sheetBody).onclick = () => openScan();
}

// Place picker: search (Nominatim), places already in the trip, or current location.
function mountPlace(el, { label, value, required, onChange }) {
  let val = value && value.name ? value : null;
  let q = '';
  let results = null, busy = false, err = '';
  const known = knownPlaces(S.items).slice(0, 8);
  const set = (p) => { val = p; results = null; err = ''; draw(); onChange(p); };
  const doSearch = async () => {
    q = $('input', el)?.value.trim() || q;
    if (q.length < 2) { err = 'Type a place, address or airport'; draw(); return; }
    busy = true; err = ''; results = null; draw();
    try { results = await searchPlaces(q); if (!results.length) err = 'No matches. Try adding the town or country.'; } catch (e) { err = navigator.onLine ? e.message : 'You\'re offline. You can still save the name without a map location.'; results = []; }
    busy = false; draw();
    $('.place-results button', el)?.focus();
  };
  function draw() {
    const id = `pf-${Math.random().toString(36).slice(2, 8)}`;
    el.innerHTML = `<span class="lbl" id="${id}">${esc(label)}${required ? ' <span class="req">*</span>' : ''}</span>` + (val
      ? `<div class="place-chosen"><span>📍 ${esc(val.name)}${hasCoords(val) ? '' : ' <small class="muted">(no map location)</small>'}</span>
          <span class="place-actions"><a class="link" href="${esc(directionsUrl(null, val))}" target="_blank" rel="noopener">🧭 Directions</a>
          <button type="button" class="link" data-a="clear">Change</button></span></div>`
      : `<div class="place-search"><input type="search" enterkeyhint="search" autocomplete="off" aria-labelledby="${id}" placeholder="Search place, address or airport" value="${esc(q)}">
          <button type="button" class="btn small" data-a="search">Search</button></div>
        <div class="place-quick">${known.map((p, i) => `<button type="button" class="chip" data-a="known" data-i="${i}">${esc(shortName(p))}</button>`).join('')}
          <button type="button" class="chip" data-a="here">📍 My location</button></div>
        ${busy ? '<p class="muted small" role="status">Searching…</p>' : ''}
        ${err ? `<p class="error small" role="status">${esc(err)}</p>` : ''}
        ${results ? `<ul class="place-results">${results.map((r, i) => `<li><button type="button" data-a="pick" data-i="${i}">${esc(r.name)}</button></li>`).join('')}
          ${q ? `<li><button type="button" data-a="raw" class="muted">Use “${esc(q)}” without a map location</button></li>` : ''}</ul>` : ''}`);
    const input = $('input', el);
    if (input) {
      input.oninput = () => { q = input.value; };
      input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } };
    }
  }
  el.onclick = async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    if (a === 'clear') { q = val?.name && !hasCoords(val) ? val.name : ''; val = null; results = null; draw(); onChange(null); $('input', el)?.focus(); }
    else if (a === 'search') doSearch();
    else if (a === 'pick') set(results[+b.dataset.i]);
    else if (a === 'known') set(known[+b.dataset.i]);
    else if (a === 'raw') set({ name: q });
    else if (a === 'here') {
      busy = true; err = ''; draw();
      try { set(await currentPosition()); } catch (x) { busy = false; err = x.message; draw(); }
    }
  };
  draw();
}

function defaultTimes(type) {
  const d = S.viewDay || localDate();
  switch (type) {
    case 'hotel': return { start: `${d}T15:00`, end: `${addDays(d, 1)}T11:00` };
    case 'car': return { start: `${d}T10:00`, end: `${addDays(d, 1)}T10:00` };
    case 'activity': return { start: `${d}T10:00`, end: `${d}T12:00` };
    default: return { start: `${d}T09:00` };
  }
}

function openItemForm(type, existing, prefill = {}, { docs: prefillDocs = [], onSaved, lookup = null } = {}) {
  const def = TYPES[type];
  // Pre-filled (scanned) bookings keep only what was read; blank forms get sensible default times.
  const base = Object.keys(prefill).length ? {} : defaultTimes(type);
  // When editing, `prefill` holds changes not saved yet (e.g. a flight lookup).
  const draft = existing ? { ...JSON.parse(JSON.stringify(existing)), ...prefill } : { type, id: uid(16), ...base, ...prefill };
  const ro = !canEdit();
  const fieldHtml = def.fields.map((f) => {
    const v = draft[f.key] ?? '';
    // View only: show just what's filled in.
    if (ro && (f.kind === 'money' || f.kind === 'payment' ? !hasCost(draft) : f.kind === 'place' ? !v?.name : !v)) return '';
    const req = f.required && !ro ? ' required' : '';
    const lbl = `<span>${esc(f.label)}${f.required && !ro ? ' <span class="req" aria-hidden="true">*</span>' : ''}</span>`;
    switch (f.kind) {
      case 'place': return `<div class="place-field" data-place="${f.key}"></div>`;
      case 'datetime': return `<label>${lbl}<input type="datetime-local" name="${f.key}" value="${esc(v)}"${req}></label>`;
      case 'number': return `<label>${lbl}<input type="number" inputmode="numeric" min="0" step="5" name="${f.key}" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}"></label>`;
      case 'textarea': return `<label>${lbl}<textarea name="${f.key}" rows="3">${esc(v)}</textarea></label>`;
      case 'money': {
        const cur = draft.currency || homeCurrency(S.meta);
        const opts = [...new Set([homeCurrency(S.meta), cur, ...Object.keys(S.meta.rates || {}), ...CURRENCIES])];
        return `<div class="money"><label>${lbl}<input name="cost" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${esc(v)}"></label>
          <label><span>Currency</span><select name="currency">${opts.map((c) => `<option ${c === cur ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label></div>`;
      }
      case 'checkbox': return `<label class="check"><input type="checkbox" name="${f.key}" ${v ? 'checked' : ''}> <span>${esc(f.label)}</span></label>`;
      case 'payment': {
        const st = payment(draft).status;
        return `<div class="payment">
          <label><span>Payment</span><select name="payStatus">
            <option value="none" ${st === 'none' ? 'selected' : ''}>Not paid yet</option>
            <option value="deposit" ${st === 'deposit' ? 'selected' : ''}>Deposit paid</option>
            <option value="full" ${st === 'full' ? 'selected' : ''}>Paid in full</option></select></label>
          <div class="two deposit-fields" ${st === 'deposit' ? '' : 'hidden'}>
            <label><span>Deposit paid</span><input name="deposit" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${esc(draft.deposit ?? '')}"></label>
            <label><span>Balance due by</span><input type="date" name="balanceDue" value="${esc(draft.balanceDue || '')}"></label>
          </div>
          <p class="muted small balance-note" aria-live="polite"></p>
        </div>`;
      }
      default: return `<label>${lbl}<input name="${f.key}" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}"${req} autocomplete="off"></label>`;
    }
  }).join('');
  const edited = existing?.updatedAt ? `<p class="muted small">Last edited${existing.updatedBy ? ` by ${esc(existing.updatedBy)}` : ''} ${esc(fmtDate(existing.updatedAt.slice(0, 10)))} ${esc(existing.updatedAt.slice(11, 16))} UTC</p>` : '';

  openSheet(`<form class="form" id="item-form" novalidate>
    <div class="sheet-head"><h2><span aria-hidden="true">${def.icon}</span> ${esc(ro ? (existing ? itemTitle(existing) : def.label) : `${existing ? 'Edit' : 'Add'} ${def.label.toLowerCase()}`)}</h2>
      <button type="button" class="iconbtn" data-close aria-label="Close">✕</button></div>
    ${ro ? '<p class="muted small">👁 View only</p>' : ''}
    ${type === 'flight' && !ro ? flightLookupHtml(draft, existing, lookup) : ''}
    <fieldset class="plain form" ${ro ? 'disabled' : ''}>
    ${fieldHtml}
    ${type === 'drive' ? '<div class="routebox" id="routebox" role="status" aria-live="polite"></div>' : ''}
    </fieldset>
    <section class="docs" id="docs" aria-label="Documents"></section>
    <p class="error" id="form-err" role="alert" hidden></p>
    <div class="row sticky-actions">
      ${existing && !ro ? '<button type="button" class="btn danger ghost" id="del-item">Delete</button>' : ''}
      <span class="grow"></span>
      <button type="button" class="btn ghost" data-close>${ro ? 'Close' : 'Cancel'}</button>
      ${ro ? '' : '<button class="btn" id="save-item">Save</button>'}
    </div>
    ${edited}
  </form>`, `${ro ? 'View' : existing ? 'Edit' : 'Add'} ${def.label}`);

  const form = $('#item-form');
  // Payment: show the deposit fields only for "Deposit paid", with the balance left.
  const payBox = $('.payment', form);
  if (payBox) {
    const update = () => {
      const st = form.elements.payStatus.value;
      $('.deposit-fields', payBox).hidden = st !== 'deposit';
      const cost = parseAmount(form.elements.cost?.value);
      const dep = parseAmount(form.elements.deposit.value);
      const cur = form.elements.currency?.value || homeCurrency(S.meta);
      $('.balance-note', payBox).textContent = st === 'deposit' && cost !== null && dep !== null && dep <= cost
        ? `Balance to pay: ${fmtMoney(cost - dep, cur)}` : '';
    };
    form.addEventListener('input', (e) => { if (/^(payStatus|deposit|cost|currency)$/.test(e.target.name)) update(); });
    form.addEventListener('change', (e) => { if (/^(payStatus|currency)$/.test(e.target.name)) update(); });
    update();
  }
  const readInputs = () => {
    for (const f of def.fields) {
      if (f.kind === 'place') continue;
      if (f.kind === 'checkbox') { draft[f.key] = !!form.elements[f.key]?.checked; continue; }
      if (f.kind === 'payment') {
        const st = form.elements.payStatus.value;
        draft.paid = st === 'full';
        if (st === 'deposit') {
          const dep = parseAmount(form.elements.deposit.value);
          draft.deposit = dep === null ? '' : dep;
          draft.balanceDue = form.elements.balanceDue.value;
        } else {
          delete draft.deposit;
          delete draft.balanceDue;
        }
        continue;
      }
      if (f.kind === 'money') {
        const amt = parseAmount(form.elements.cost.value);
        draft.cost = amt === null ? '' : amt;
        draft.currency = form.elements.currency.value;
        continue;
      }
      const v = form.elements[f.key]?.value ?? '';
      draft[f.key] = f.kind === 'number' ? (v === '' ? '' : Number(v)) : v;
    }
  };

  // Drive: calculate the route whenever both ends are set.
  let routeSeq = 0;
  const updateRoute = async () => {
    if (type !== 'drive') return;
    const box = $('#routebox');
    readInputs();
    if (!(hasCoords(draft.from) && hasCoords(draft.to))) {
      box.innerHTML = '<p class="muted">Choose both places (from search or your saved places) to calculate the drive time.</p>';
      delete draft.route;
      return;
    }
    const showResult = () => {
      const r = draft.route;
      const m = driveMinutes(draft, bufferPct());
      const end = itemEnd(draft, bufferPct());
      box.innerHTML = `<p><strong>🚗 ${esc(fmtDuration(m))}</strong> · ${esc(dist(r.distanceKm))}${end ? ` · arrive about <strong>${esc(t12(timePart(end)))}</strong>${datePart(end) !== datePart(draft.start) ? ` (${esc(fmtDate(datePart(end)))})` : ''}` : ''}</p>
        <p class="muted small">${esc(fmtDuration(r.durationMin))} driving without traffic${bufferPct() ? ` + ${bufferPct()}% buffer` : ''}${Number(draft.stopMin) ? ` + ${esc(fmtDuration(draft.stopMin))} stops` : ''}.
        <a href="${esc(directionsUrl(draft.from, draft.to))}" target="_blank" rel="noopener">Open in Maps</a></p>`;
    };
    if (draft.route?.from === `${draft.from.lat},${draft.from.lon}` && draft.route?.to === `${draft.to.lat},${draft.to.lon}`) { showResult(); return; }
    const seq = ++routeSeq;
    box.innerHTML = '<p class="muted">Calculating drive time…</p>';
    try {
      const r = await driveRoute(draft.from, draft.to);
      if (seq !== routeSeq) return;
      if (r.error) { delete draft.route; box.innerHTML = `<p class="error">No road route found between these places (${esc(dist(haversineKm(draft.from, draft.to)))} apart).</p>`; return; }
      draft.route = { ...r, from: `${draft.from.lat},${draft.from.lon}`, to: `${draft.to.lat},${draft.to.lon}` };
      showResult();
    } catch {
      if (seq === routeSeq) box.innerHTML = '<p class="error">Couldn\'t reach the route service. You can save now and the time will be worked out later when you\'re online.</p>';
    }
  };

  $$('[data-place]', form).forEach((el) => {
    const f = def.fields.find((x) => x.key === el.dataset.place);
    mountPlace(el, { label: f.label, value: draft[f.key], required: f.required, onChange: (p) => { draft[f.key] = p; updateRoute(); } });
  });
  // Moving the start keeps the same duration, so the end never ends up before the start.
  if (form.elements.start && form.elements.end) {
    let prevStart = form.elements.start.value;
    form.elements.start.addEventListener('change', () => {
      const st = form.elements.start.value, en = form.elements.end.value;
      if (st && en && prevStart) form.elements.end.value = addMinutes(en, diffMinutes(prevStart, st));
      else if (st && en && en < st) form.elements.end.value = '';
      prevStart = st;
    });
  }

  // New bookings keep picked files until Save; existing ones upload straight away.
  const pending = prefillDocs.map((p) => ({ ...p, id: uid(8) }));

  // Flight lookup: flight number + date → fill in airports, times and terminals.
  const fl = $('#flight-lookup', form);
  if (fl) {
    fl.onsubmit = null;
    $('#fl-go', fl).onclick = async () => {
      const number = formatFlightNo($('#fl-number', fl).value);
      const date = $('#fl-date', fl).value;
      const status = $('#fl-status', fl);
      if (!number || !/\d/.test(number)) { status.textContent = 'Enter a flight number, e.g. BA 117.'; status.className = 'error small'; return; }
      if (!date) { status.textContent = 'Choose the date of the flight.'; status.className = 'error small'; return; }
      $('#fl-go', fl).disabled = true;
      status.className = 'small';
      status.textContent = `⏳ Looking up ${number} on ${fmtDate(date)}… (up to a minute)`;
      try {
        const raw = await flightDetails(await aiAuth(), { number, date, now: localDateTime() });
        const { usualSchedule, ...found } = normalizeFlightLookup(raw, date);
        if (!found.start) {
          status.className = 'error small';
          status.textContent = `Couldn't find ${number} on ${fmtDate(date)}. Check the number and date, or fill in the details below.`;
          $('#fl-go', fl).disabled = false;
          return;
        }
        status.textContent = 'Finding the airports on the map…';
        for (const k of ['from', 'to']) {
          if (!found[k]) continue;
          try {
            const [hit] = await searchPlaces(found[k].search || found[k].name);
            found[k] = hit ? { name: found[k].name, lat: hit.lat, lon: hit.lon } : { name: found[k].name };
          } catch { found[k] = { name: found[k].name }; }
        }
        readInputs();
        const keep = Object.fromEntries(Object.entries(draft).filter(([k]) => !['type', 'id'].includes(k)));
        const merged = { ...keep, ...found, number: found.number || number };
        if (found.notes && keep.notes && !keep.notes.includes(found.notes)) merged.notes = `${keep.notes}\n${found.notes}`;
        openItemForm('flight', existing, existing ? merged : { ...merged, id: draft.id }, {
          docs: pending.map(({ id, ...p }) => p), onSaved,
          lookup: { ok: true, source: raw.source, number: merged.number, date, usual: !!usualSchedule },
        });
      } catch (err) {
        status.className = 'error small';
        status.textContent = friendlyError(err);
        $('#fl-go', fl).disabled = false;
      }
    };
    $('#fl-number', fl).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#fl-go', fl).click(); } });
  }
  const docs = mountDocs($('#docs'), { itemId: draft.id, pending: existing ? null : pending });

  if (type === 'drive') {
    form.elements.start.addEventListener('change', updateRoute);
    form.elements.stopMin.addEventListener('change', updateRoute);
    updateRoute();
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    readInputs();
    const errs = validateItem(draft);
    const errEl = $('#form-err');
    if (form.elements.cost && form.elements.cost.value.trim() && parseAmount(form.elements.cost.value) === null) errs.push('Cost must be a number');
    if (form.elements.payStatus?.value === 'deposit') {
      const dep = parseAmount(form.elements.deposit.value);
      if (!hasCost(draft)) errs.push('Enter the total cost before the deposit');
      else if (dep === null || dep <= 0) errs.push('Enter the deposit amount');
      else if (dep > Number(draft.cost)) errs.push('The deposit is more than the cost');
    }
    if (!hasCost(draft)) { delete draft.currency; delete draft.deposit; delete draft.balanceDue; draft.paid = false; }
    if (errs.length) { errEl.textContent = errs.join('. '); errEl.hidden = false; errEl.scrollIntoView({ block: 'nearest' }); return; }
    if (type === 'drive' && !draft.route && hasCoords(draft.from) && hasCoords(draft.to)) await updateRoute().catch(() => {});
    if (type === 'car' && draft.to && draft.from && draft.to.name === draft.from.name) delete draft.to;
    const item = cleanItem({ ...draft, updatedAt: new Date().toISOString(), updatedBy: S.settings.name });
    $('#save-item').disabled = true;
    try { await write((b, id) => b.saveItem(id, item)); } catch { $('#save-item').disabled = false; return; }
    for (const p of pending) uploadDoc(item.id, p);
    // The scan flow continues in the same dialog, so it closes it itself.
    if (onSaved) { onSaved(item); return; }
    closeSheet();
    toast(existing ? 'Saved' : `${def.label} added`);
    const d = datePart(item.start);
    if (!existing && parseRoute().name === 'today' && d !== S.viewDay) go(`#/today/${d}`);
  };
  const del = $('#del-item');
  if (del) del.onclick = async () => {
    if (!confirm(`Delete "${itemTitle(existing)}"?`)) return;
    closeSheet();
    deleteWithUndo(existing);
  };
}

/** Delete a booking, offering Undo; its documents go once the undo chance has passed. */
async function deleteWithUndo(item) {
  try { await write((b, id) => b.deleteItem(id, item.id)); } catch { return; }
  let undone = false;
  const tripId = S.trip.id;
  // Short name for the message: "BA 178", "Hotel Penn", "Car hire · Hertz"…
  const name = (item.type === 'flight' && item.number) || itemTitle(item).split(' · ')[0] || 'booking';
  toast(`Deleted ${name.length > 32 ? `${name.slice(0, 31)}…` : name}`, { label: 'Undo', run: () => { undone = true; write((b, id) => b.saveItem(id, item)); } });
  setTimeout(() => {
    if (undone || S.trip?.id !== tripId || S.items.some((i) => i.id === item.id)) return;
    for (const f of S.files.filter((x) => x.itemId === item.id)) write((b, id) => b.deleteFile(id, f)).catch(() => {});
  }, 8000);
}

// ---------- swipe left to delete (timeline tiles) ----------

const SWIPE_OPEN = 96; // px the Delete button needs
let swipe = null; // { li, x0, y0, dx, horizontal, pointerId }
let swipeOpen = null; // li currently showing Delete
let swipeJustMoved = false;

function setSwipe(li, dx, animate) {
  li.classList.toggle('swipe-anim', !!animate);
  li.style.setProperty('--dx', `${dx}px`);
  li.classList.toggle('swiped', dx < 0);
}
function closeSwipe() {
  if (swipeOpen) { setSwipe(swipeOpen, 0, true); swipeOpen = null; }
}

main.addEventListener('pointerdown', (e) => {
  const li = e.target.closest('.ev');
  if (e.target.closest('.swipe-del')) return;
  swipeJustMoved = false;
  if (swipeOpen && swipeOpen !== li) closeSwipe();
  if (!li || !canEdit() || e.button > 0) return;
  swipe = { li, x0: e.clientX, y0: e.clientY, dx: 0, horizontal: null, pointerId: e.pointerId, start: swipeOpen === li ? -SWIPE_OPEN : 0 };
});
main.addEventListener('pointermove', (e) => {
  if (!swipe || e.pointerId !== swipe.pointerId) return;
  const dx = e.clientX - swipe.x0, dy = e.clientY - swipe.y0;
  if (swipe.horizontal === null) {
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    swipe.horizontal = Math.abs(dx) > Math.abs(dy);
    if (!swipe.horizontal) { swipe = null; return; } // a vertical scroll
    swipe.li.setPointerCapture?.(e.pointerId);
  }
  swipe.dx = Math.min(0, swipe.start + dx);
  setSwipe(swipe.li, swipe.dx, false);
});
function endSwipe(e) {
  if (!swipe || e.pointerId !== swipe.pointerId) return;
  const { li, dx, horizontal } = swipe;
  swipe = null;
  if (!horizontal) return;
  swipeJustMoved = true; // the click that follows this release is ignored (see below)
  const width = li.getBoundingClientRect().width;
  if (dx < -width * 0.6) { // long swipe: delete straight away
    setSwipe(li, -width, true);
    const it = S.items.find((i) => i.id === li.dataset.item);
    swipeOpen = null;
    if (it) setTimeout(() => deleteWithUndo(it), 150);
  } else if (dx < -SWIPE_OPEN / 2) {
    setSwipe(li, -SWIPE_OPEN, true);
    swipeOpen = li;
  } else {
    setSwipe(li, 0, true);
    if (swipeOpen === li) swipeOpen = null;
  }
}
main.addEventListener('pointerup', endSwipe);
main.addEventListener('pointercancel', endSwipe);
// After a swipe, don't treat the release as a tap that opens the booking.
main.addEventListener('click', (e) => {
  if (swipeJustMoved) {
    swipeJustMoved = false;
    if (e.target.closest('.ev')) { e.stopImmediatePropagation(); e.preventDefault(); return; }
  }
  const d = e.target.closest('.swipe-del');
  if (d) {
    e.stopImmediatePropagation();
    const it = S.items.find((i) => i.id === d.dataset.item);
    swipeOpen = null;
    if (it) deleteWithUndo(it);
    return;
  }
  if (swipeOpen) {
    // A tap anywhere while Delete is showing just closes it.
    if (swipeOpen.contains(e.target)) { e.stopImmediatePropagation(); e.preventDefault(); }
    closeSwipe();
  }
}, true);

// Stand-alone "how long to drive from A to B?" calculator.
function openDriveCalc() {
  const st = { from: null, to: null, start: `${S.viewDay || localDate()}T09:00` };
  openSheet(`<div class="form">
    <div class="sheet-head"><h2>⏱️ Drive time calculator</h2><button type="button" class="iconbtn" data-close aria-label="Close">✕</button></div>
    <div class="place-field" id="calc-from"></div>
    <div class="place-field" id="calc-to"></div>
    <label>Leave at (optional)<input type="datetime-local" id="calc-start" value="${esc(st.start)}"></label>
    <div class="routebox" id="calc-out" role="status" aria-live="polite"><p class="muted">Pick two places to see how long the drive takes.</p></div>
    <div class="row"><span class="grow"></span><button type="button" class="btn" id="calc-save" disabled ${canEdit() ? '' : 'hidden'}>Add this drive to the plan</button></div>
  </div>`, 'Drive time calculator');
  let route = null, seq = 0;
  const run = async () => {
    st.start = $('#calc-start').value;
    const out = $('#calc-out');
    route = null;
    $('#calc-save').disabled = true;
    if (!(hasCoords(st.from) && hasCoords(st.to))) { out.innerHTML = '<p class="muted">Pick two places to see how long the drive takes.</p>'; return; }
    const n = ++seq;
    out.innerHTML = '<p class="muted">Calculating…</p>';
    try {
      const r = await driveRoute(st.from, st.to);
      if (n !== seq) return;
      if (r.error) { out.innerHTML = `<p class="error">No road route found (${esc(dist(haversineKm(st.from, st.to)))} apart).</p>`; return; }
      route = r;
      const m = Math.round(r.durationMin * (1 + bufferPct() / 100));
      const arrive = st.start ? addMinutes(st.start, m) : '';
      out.innerHTML = `<p class="big"><strong>${esc(fmtDuration(m))}</strong> · ${esc(dist(r.distanceKm))}</p>
        ${arrive ? `<p>Leave ${esc(t12(timePart(st.start)))} → arrive about <strong>${esc(t12(timePart(arrive)))}</strong>${datePart(arrive) !== datePart(st.start) ? ` (${esc(fmtDate(datePart(arrive)))})` : ''}</p>` : ''}
        <p class="muted small">${esc(fmtDuration(r.durationMin))} without traffic${bufferPct() ? ` + ${bufferPct()}% buffer` : ''}. <a href="${esc(directionsUrl(st.from, st.to))}" target="_blank" rel="noopener">Open in Maps</a></p>`;
      $('#calc-save').disabled = false;
    } catch {
      if (n === seq) out.innerHTML = '<p class="error">Couldn\'t reach the route service. Check your connection and try again.</p>';
    }
  };
  mountPlace($('#calc-from'), { label: 'From', required: true, onChange: (p) => { st.from = p; run(); } });
  mountPlace($('#calc-to'), { label: 'To', required: true, onChange: (p) => { st.to = p; run(); } });
  $('#calc-start').onchange = run;
  $('#calc-save').onclick = () => {
    openItemForm('drive', null, {
      from: st.from, to: st.to, start: st.start || `${S.viewDay || localDate()}T09:00`,
      route: route && { ...route, from: `${st.from.lat},${st.from.lon}`, to: `${st.to.lat},${st.to.lon}` },
    });
  };
}

// ---------- scanning (Claude) ----------

let lastScan = null; // {drafts, docs, added:Set} kept while the app is open

function openScan() {
  if (!aiOn()) {
    openSheet(`<div class="sheet-head"><h2>✨ Scan a booking</h2><button type="button" class="iconbtn" data-close aria-label="Close">✕</button></div>
      <p>Scanning reads photos, screenshots, PDFs and confirmation emails and fills in the booking for you. It uses Claude with your own Anthropic API key, which you add once on this device.</p>
      <div class="row"><a class="btn" href="#/trip" data-close id="go-setup">Set up scanning</a></div>`, 'Scan a booking');
    $('#go-setup').onclick = () => { closeSheet(); go('#/trip'); setTimeout(() => $('#scan-settings')?.scrollIntoView({ block: 'start' }), 50); };
    return;
  }
  if (lastScan && lastScan.drafts.some((_, i) => !lastScan.added.has(i))) { showScanResults(); return; }
  openSheet(`<div class="form">
    <div class="sheet-head"><h2>✨ Scan a booking</h2><button type="button" class="iconbtn" data-close aria-label="Close">✕</button></div>
    <label class="btn filebtn scan-pick">📷 Take a photo or choose a screenshot / PDF<input type="file" id="scan-file" accept="image/*,application/pdf,.pdf,.txt,.eml,.html,.htm"></label>
    <p class="center muted small">or</p>
    <label>Paste a confirmation email<textarea id="scan-text" rows="6" placeholder="Paste the whole email here"></textarea></label>
    <button type="button" class="btn" id="scan-go">Read booking</button>
    <p class="muted small" id="scan-status" role="status" aria-live="polite"></p>
    <p class="muted small">The document is sent to Anthropic's Claude to read it. Check the details before saving.</p>
  </div>`, 'Scan a booking');
  const run = async (input, doc) => {
    const status = $('#scan-status');
    const btn = $('#scan-go');
    btn.disabled = true;
    status.textContent = 'Reading… this usually takes 10–30 seconds.';
    try {
      const span = tripSpan(S.meta, S.items);
      const res = await extractBookings(await aiAuth(), input, {
        tripName: S.meta.name, start: span.start, end: span.end, today: localDate(), currency: homeCurrency(S.meta),
      });
      const drafts = normalizeBookings(res.bookings, { currency: homeCurrency(S.meta) });
      if (doc && res.text) doc.text = res.text;
      if (!drafts.length) {
        status.textContent = res.text ? 'No bookings found in it. You can still attach it to a booking — its text has been read.' : 'No bookings found in it. Try a clearer photo, or paste the email text.';
        btn.disabled = false;
        return;
      }
      status.textContent = 'Finding places on the map…';
      for (const d of drafts) {
        for (const k of placesToLocate(d)) {
          try {
            const [hit] = await searchPlaces(d[k].search || d[k].name);
            if (hit) d[k] = { name: d[k].name, lat: hit.lat, lon: hit.lon };
          } catch { /* keep the name without a map location */ }
          if (d[k]) delete d[k].search;
        }
      }
      lastScan = { drafts, docs: doc ? [doc] : [], added: new Set() };
      showScanResults();
    } catch (err) {
      status.textContent = friendlyError(err);
      status.className = 'error small';
      btn.disabled = false;
    }
  };
  $('#scan-file').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let doc;
    try { doc = await prepareFile(file); } catch (err) { $('#scan-status').textContent = err.message; return; }
    run({ blob: file }, doc);
  };
  $('#scan-go').onclick = () => {
    const text = $('#scan-text').value.trim();
    if (text.length < 20) { $('#scan-status').textContent = 'Take a photo, choose a file, or paste the email text first.'; return; }
    const blob = new Blob([text], { type: 'text/plain' });
    run({ text }, { blob, name: 'Confirmation email.txt', type: 'text/plain', size: blob.size, text });
  };
}

function showScanResults() {
  const { drafts, docs, added } = lastScan;
  const left = drafts.map((d, i) => ({ d, i })).filter(({ i }) => !added.has(i));
  const ready = left.filter(({ d }) => !validateItem(d).length);
  openSheet(`<div class="form">
    <div class="sheet-head"><h2>✨ Found ${drafts.length} booking${drafts.length === 1 ? '' : 's'}</h2><button type="button" class="iconbtn" data-close aria-label="Close">✕</button></div>
    <ul class="scan-list">${drafts.map((d, i) => {
      const errs = validateItem(d);
      const missingMap = placesToLocate(d).length;
      return `<li class="${added.has(i) ? 'done' : ''}">
        <span class="scan-icon" aria-hidden="true">${TYPES[d.type].icon}</span>
        <span class="scan-body"><strong>${esc(itemTitle(d))}</strong>
          <span class="muted small">${d.start ? esc(`${fmtDate(datePart(d.start))} ${t12(timePart(d.start))}`) : 'No date'}${d.ref ? ` · Ref ${esc(d.ref)}` : ''}${hasCost(d) ? ` · ${esc(fmtMoney(d.cost, d.currency))}` : ''}</span>
          ${added.has(i) ? '<span class="ok small">✓ Added</span>' : errs.length ? `<span class="error small">Missing ${esc(errs.map((e) => e.replace(/ is required$/, '').toLowerCase()).join(', '))} — tap Review</span>` : missingMap ? '<span class="muted small">Some places aren\'t on the map yet</span>' : ''}</span>
        ${added.has(i) ? '' : `<button type="button" class="btn small ghost" data-review="${i}">Review</button>`}
      </li>`;
    }).join('')}</ul>
    ${docs.length ? `<p class="muted small">📎 ${esc(docs[0].name)} will be attached to each booking${docs[0].text && docs[0].type.startsWith('image/') ? ', with its text' : ''}.</p>` : ''}
    <div class="row">
      <button type="button" class="btn ghost" id="scan-new">Scan something else</button>
      <span class="grow"></span>
      ${ready.length ? `<button type="button" class="btn" id="scan-all">${ready.length === 1 ? 'Add booking' : ready.length === left.length ? `Add all ${ready.length}` : `Add the ${ready.length} ready`}</button>` : ''}
    </div>
  </div>`, 'Scanned bookings');
  $$('[data-review]', sheetBody).forEach((b) => {
    b.onclick = () => {
      const i = +b.dataset.review;
      openItemForm(drafts[i].type, null, drafts[i], {
        docs,
        onSaved: () => {
          added.add(i);
          toast('Booking added');
          if (drafts.some((_, j) => !added.has(j))) showScanResults();
          else { lastScan = null; closeSheet(); }
        },
      });
    };
  });
  $('#scan-new').onclick = () => { lastScan = null; openScan(); };
  const all = $('#scan-all');
  if (all) all.onclick = async () => {
    all.disabled = true;
    for (const { d, i } of ready) {
      const item = cleanItem({ ...d, id: uid(16), updatedAt: new Date().toISOString(), updatedBy: S.settings.name });
      try { await write((b, id) => b.saveItem(id, item)); } catch { all.disabled = false; return; }
      for (const doc of docs) uploadDoc(item.id, doc);
      added.add(i);
    }
    const n = ready.length;
    if (drafts.some((_, j) => !added.has(j))) showScanResults();
    else { lastScan = null; closeSheet(); }
    toast(`${n} booking${n === 1 ? '' : 's'} added`);
    const first = ready[0]?.d.start;
    if (first && parseRoute().name !== 'plan') go(`#/today/${datePart(first)}`);
  };
}

// ---------- flight lookup (in the flight form) ----------

function flightLookupHtml(draft, existing, lookup) {
  if (!aiOn()) {
    return `<p class="muted small lookup-off">Tip: with AI features on, you can just enter the flight number and date and the rest is filled in. <a href="#/trip">Set up</a></p>`;
  }
  const number = lookup?.number || draft.number || '';
  const date = lookup?.date || datePart(draft.start) || S.viewDay || localDate();
  const box = `<div class="lookup" id="flight-lookup">
      <div class="lookup-row">
        <label><span>Look up flight number</span><input id="fl-number" value="${esc(number)}" placeholder="e.g. BA 117" autocomplete="off" autocapitalize="characters" enterkeyhint="search"></label>
        <label><span>Flight date</span><input id="fl-date" type="date" value="${esc(date)}"></label>
      </div>
      <button type="button" class="btn" id="fl-go">🔎 Find flight</button>
      <p id="fl-status" class="${lookup?.ok ? (lookup.usual ? 'warn-text' : 'ok') : 'muted'} small" role="status" aria-live="polite">${lookup?.ok
        ? lookup.usual
          ? `✓ Filled in from the flight's usual schedule${lookup.source ? ` (${esc(lookup.source)})` : ''}. ${esc(fmtDate(lookup.date))} is too far ahead to be listed yet, so check the times against your booking.`
          : `✓ Filled in${lookup.source ? ` from ${esc(lookup.source)}` : ''}. Check the details below, then Save.`
        : 'Fills in the airline, airports, times and terminals from the web.'}</p>
    </div>`;
  if (existing && !lookup) return `<details class="lookup-wrap"><summary>🔎 Update from the flight number</summary>${box}</details>`;
  return box;
}

// ---------- trip chat ----------

let chatAbort = null;
const chatKey = () => `tp:chat:${S.trip?.id}`;
function chatLoad() { try { return JSON.parse(localStorage.getItem(chatKey())) || []; } catch { return []; } }
function chatSave(msgs) { try { localStorage.setItem(chatKey(), JSON.stringify(msgs.slice(-40))); } catch { /* full */ } }

const CHAT_STARTERS = [
  'What\'s on today?',
  'What time do we need to leave for the airport?',
  'How much have we paid so far, and what\'s still due?',
  'What\'s our hotel booking reference?',
  'Where could we eat near tomorrow\'s plans?',
];

/** Short notes from the latest live checks, so the chat can mention them. */
function liveNotes() {
  const notes = {};
  for (const it of S.items) {
    const kind = it.type === 'flight' ? 'flight' : it.type === 'drive' ? 'road' : '';
    const c = kind && liveGet(liveKey(kind, it));
    if (!c) continue;
    const d = c.data;
    notes[it.id] = kind === 'flight'
      ? `${d.found ? `${d.status}${d.delayMinutes ? `, ${d.delayMinutes} min late` : ''}${d.depEstimated ? `, departs ${d.depEstimated}` : ''}${d.depGate ? `, gate ${d.depGate}` : ''}` : 'no status found'} (checked ${ago(c.at)})`
      : `${d.level}: ${d.summary} (checked ${ago(c.at)})`;
  }
  return notes;
}

function chatBubble(m, mi) {
  if (m.role === 'user') return `<li class="msg me"><div class="bubble">${esc(m.text)}</div></li>`;
  const places = (m.places || []).length ? `<div class="places">${m.places.map((p, pi) => `<div class="place-card">
      <span class="idea-icon" aria-hidden="true">${PLACE_ICON[p.category] || '📍'}</span>
      <span class="idea-body"><strong>${esc(p.name)}</strong>${p.when ? ` <span class="muted small">· ${esc(p.when)}</span>` : ''}
        ${p.why ? `<span class="small">${esc(p.why)}</span>` : ''}
        <span class="idea-actions"><a class="small" href="${esc(mapSearchUrl(p.address ? `${p.name}, ${p.address}` : p.name))}" target="_blank" rel="noopener">Map</a>
        ${canEdit() ? `${isSavedIdea(ideasList(), p.name) ? '<span class="small saved">✓ In Ideas</span>' : `<button type="button" class="link small" data-chat-save="${mi}:${pi}">☆ Save idea</button>`}
        <button type="button" class="link small" data-chat-plan="${mi}:${pi}">＋ Add to plan</button>` : ''}</span></span></div>`).join('')}</div>` : '';
  return `<li class="msg bot"><div class="bubble">${m.error ? `<p class="error">${esc(m.text)}</p>` : renderMarkdown(m.text)}
    ${places}
    ${(m.sources || []).length ? `<div class="sources"><span class="muted small">Sources:</span> ${m.sources.map((x) => `<a class="small" href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a>`).join(' · ')}</div>` : ''}</div></li>`;
}

function openChat() {
  if (!S.trip) return;
  if (!aiOn()) {
    openSheet(`<div class="sheet-head"><h2>💬 Ask about this trip</h2><button type="button" class="iconbtn" data-close aria-label="Close">✕</button></div>
      <p>Ask anything about your trip: times, booking references, what's still to pay, where to eat near your plans. It uses Claude with your own Anthropic API key, which you add once on this phone.</p>
      <div class="row"><a class="btn" href="#/trip" id="go-setup-chat">Set up AI features</a></div>`, 'Ask about this trip');
    $('#go-setup-chat').onclick = () => { setTimeout(() => $('#scan-settings')?.scrollIntoView({ block: 'start' }), 80); };
    return;
  }
  openSheet(`<div class="chat">
    <div class="sheet-head"><h2>💬 Ask about this trip</h2>
      <span class="row"><button type="button" class="link small" id="chat-new">New chat</button>
      <button type="button" class="iconbtn" data-close aria-label="Close">✕</button></span></div>
    <ol class="chat-log" id="chat-log" aria-live="polite"></ol>
    <div class="chat-starters" id="chat-starters"></div>
    <form class="chat-input" id="chat-form">
      <textarea id="chat-q" rows="1" enterkeyhint="send" placeholder="Ask about your trip…" aria-label="Your question"></textarea>
      <button class="btn" id="chat-send" aria-label="Send">Send</button>
    </form>
    <p class="muted small chat-note">Answers use your trip details and the web, and can be wrong. Check anything important.</p>
  </div>`, 'Ask about this trip');
  sheetBody.classList.add('chat-mode');
  const log = $('#chat-log');
  const q = $('#chat-q');
  const draw = () => {
    const msgs = chatLoad();
    log.innerHTML = msgs.map((m, i) => chatBubble(m, i)).join('');
    $('#chat-starters').innerHTML = msgs.length ? '' : CHAT_STARTERS.map((t) => `<button type="button" class="chip" data-q="${esc(t)}">${esc(t)}</button>`).join('');
    log.scrollTop = log.scrollHeight;
  };
  draw();
  $('#chat-new').onclick = () => { chatAbort?.abort(); chatSave([]); draw(); q.focus(); };
  // Place cards: save to Ideas, or add to the plan (then come back to the chat).
  log.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-chat-save], [data-chat-plan]');
    if (!b) return;
    const [mi, pi] = (b.dataset.chatSave || b.dataset.chatPlan).split(':').map(Number);
    const p = chatLoad()[mi]?.places?.[pi];
    if (!p) return;
    if (b.dataset.chatSave) {
      b.disabled = true;
      if (await saveIdea(p, 'chat')) b.outerHTML = '<span class="small saved">✓ In Ideas</span>';
      else b.disabled = false;
    } else {
      placeToPlan(p, { onSaved: () => { toast(`${p.name} added to the plan`); openChat(); } });
    }
  });
  $('#chat-starters').onclick = (e) => { const b = e.target.closest('[data-q]'); if (b) send(b.dataset.q); };
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chat-form').requestSubmit(); } });
  q.addEventListener('input', () => { q.style.height = 'auto'; q.style.height = `${Math.min(q.scrollHeight, 140)}px`; });
  $('#chat-form').onsubmit = (e) => { e.preventDefault(); send(q.value); };

  async function send(text) {
    text = String(text || '').trim();
    if (!text || chatAbort) return;
    const tripId = S.trip.id;
    const before = chatLoad();
    const msgs = [...before, { role: 'user', text, at: Date.now() }];
    chatSave(msgs);
    q.value = ''; q.style.height = '';
    draw();
    const li = document.createElement('li');
    li.className = 'msg bot';
    li.innerHTML = '<div class="bubble"><p class="muted typing">Thinking…</p></div>';
    log.append(li);
    log.scrollTop = log.scrollHeight;
    $('#chat-send').disabled = true;
    chatAbort = new AbortController();
    try {
      const content = await askTrip(await aiAuth(), {
        system: CHAT_SYSTEM,
        context: buildTripContext({ meta: S.meta, items: S.items, files: S.files, now: localDateTime(), live: liveNotes() }),
        history: before.filter((m) => !m.error).slice(-20).map((m) => ({ role: m.role, text: m.text })),
        question: text,
        signal: chatAbort.signal,
        onText: (t) => { if (li.isConnected) { $('.bubble', li).innerHTML = renderMarkdown(t); log.scrollTop = log.scrollHeight; } },
      });
      if (S.trip?.id !== tripId) return;
      const places = placesFrom(content);
      chatSave([...msgs, {
        role: 'assistant', text: answerText(content) || (places.length ? 'Here are some ideas:' : 'Sorry, I don\'t have an answer for that.'),
        sources: sourcesFrom(content), places, at: Date.now(),
      }]);
    } catch (err) {
      if (err?.name === 'AbortError' || chatAbort?.signal.aborted) return;
      if (S.trip?.id === tripId) chatSave([...msgs, { role: 'assistant', text: friendlyError(err), error: true, at: Date.now() }]);
    } finally {
      chatAbort = null;
      if (log.isConnected) { $('#chat-send').disabled = false; draw(); }
    }
  }
}

$('#chat-btn').onclick = () => openChat();

// ---------- documents ----------

const blobCache = new Map(); // fileId -> Blob, for this session
const urlCache = new Map(); // fileId -> object URL (one per file, kept while the app is open)
function urlFor(f, blob) {
  if (!urlCache.has(f.id)) urlCache.set(f.id, URL.createObjectURL(blob));
  return urlCache.get(f.id);
}

async function loadDoc(f) {
  if (blobCache.has(f.id)) return blobCache.get(f.id);
  const blob = await backend().getFile(S.trip.id, f);
  blobCache.set(f.id, blob);
  return blob;
}

function uploadDoc(itemId, p) {
  const meta = cleanItem({
    id: uid(20), itemId, name: p.name, type: p.type, size: p.size, text: p.text ? String(p.text).slice(0, 50000) : '',
    addedBy: S.settings.name, addedAt: new Date().toISOString(),
  });
  blobCache.set(meta.id, p.blob);
  return write((b, id) => b.addFile(id, meta, p.blob)).catch(() => blobCache.delete(meta.id));
}

/** List of documents with View / Share / Delete. */
function renderDocList(ul, files, { onRemovePending } = {}) {
  ul.innerHTML = files.map((f, i) => `<li class="doc" data-i="${i}">
    <div class="doc-row">
      <span class="doc-icon" aria-hidden="true">${fileIcon(f.type, f.name)}</span>
      <span class="doc-name"><strong>${esc(f.name)}</strong>
        <span class="muted small">${esc(fmtBytes(f.size))}${f.pending ? ' · uploads when you save' : ''}${f.addedBy ? ` · added by ${esc(f.addedBy)}` : ''}</span></span>
      ${f.pending ? '' : `<button type="button" class="btn small ghost" data-doc="view" aria-label="View ${esc(f.name)}">View</button>`}
      ${canEdit() ? `<button type="button" class="iconbtn small" data-doc="del" aria-label="Remove ${esc(f.name)}">🗑</button>` : ''}
    </div>
    <div class="doc-view" hidden></div>
  </li>`).join('');
  ul.onclick = async (e) => {
    const b = e.target.closest('[data-doc]');
    if (!b) return;
    const li = b.closest('.doc');
    const f = files[+li.dataset.i];
    if (b.dataset.doc === 'del') {
      if (f.pending) { onRemovePending?.(f); return; }
      if (!confirm(`Remove "${f.name}" for everyone on this trip?`)) return;
      blobCache.delete(f.id);
      if (urlCache.has(f.id)) { URL.revokeObjectURL(urlCache.get(f.id)); urlCache.delete(f.id); }
      write((bk, id) => bk.deleteFile(id, f)).catch(() => {});
      toast('Document removed');
      return;
    }
    const view = $('.doc-view', li);
    if (!view.hidden) { view.hidden = true; return; }
    view.hidden = false;
    view.innerHTML = '<p class="muted small" role="status">Loading…</p>';
    try {
      const blob = await loadDoc(f);
      const url = urlFor(f, blob);
      const file = typeof File === 'function' ? new File([blob], f.name, { type: f.type }) : null;
      const canShare = !!(file && navigator.canShare && navigator.canShare({ files: [file] }));
      view.innerHTML = `${isImage(f.type) ? `<img src="${url}" alt="${esc(f.name)}">` : ''}
        <div class="row">
          <a class="btn small" href="${url}" target="_blank" rel="noopener">Open</a>
          ${canShare ? '<button type="button" class="btn small ghost" data-share>Share / Save to Files</button>' : `<a class="btn small ghost" href="${url}" download="${esc(f.name)}">Download</a>`}
        </div>`;
      const sh = $('[data-share]', view);
      if (sh) sh.onclick = () => navigator.share({ files: [file], title: f.name }).catch(() => {});
      renderDocText(view, f, blob);
    } catch (err) {
      view.innerHTML = `<p class="error small">${esc(err.message)}</p>`;
    }
  };
}

/** The document's text (from scanning), or a button to get it. */
function renderDocText(view, f, blob) {
  const box = document.createElement('div');
  box.className = 'doc-text';
  view.append(box);
  const canRead = /^image\/|application\/pdf/.test(f.type || '') || /\.pdf$/i.test(f.name);
  if (f.text) {
    box.innerHTML = `<details><summary>Text in this document</summary><pre></pre>
      <button type="button" class="btn small ghost" data-copy>Copy text</button></details>`;
    $('pre', box).textContent = f.text;
    $('[data-copy]', box).onclick = () => navigator.clipboard.writeText(f.text).then(() => toast('Text copied'), () => toast('Couldn\'t copy'));
  } else if (canRead && aiOn() && canEdit()) {
    box.innerHTML = '<button type="button" class="btn small ghost" data-gettext>📝 Get the text from this document</button>';
    $('[data-gettext]', box).onclick = async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Reading… (usually 10–30 seconds)';
      try {
        const text = (await transcribe(await aiAuth(), blob)).slice(0, 50000);
        f.text = text;
        await write((b, id) => b.updateFile(id, { id: f.id, text }));
        box.remove();
        renderDocText(view, f, blob);
        $('details', view)?.setAttribute('open', '');
      } catch (err) {
        e.target.disabled = false;
        e.target.textContent = '📝 Get the text from this document';
        toast(friendlyError(err));
      }
    };
  }
}

/** Documents section inside a booking form. */
function mountDocs(el, { itemId, pending }) {
  let lastSig = null;
  const draw = () => {
    const sig = JSON.stringify([S.files.filter((f) => f.itemId === itemId).map((f) => f.id), (pending || []).map((p) => p.id)]);
    if (sig === lastSig) return;
    lastSig = sig;
    const saved = S.files.filter((f) => f.itemId === itemId).sort((a, b) => (a.addedAt || '').localeCompare(b.addedAt || ''));
    const list = [...saved, ...(pending || []).map((p) => ({ ...p, pending: true }))];
    el.innerHTML = `<h3>Documents</h3>
      ${list.length ? '<ul class="doclist"></ul>' : '<p class="muted small">Attach tickets, booking confirmations or photos (PDF, images and more, up to 10 MB each).</p>'}
      <p class="muted small" data-busy role="status" hidden>Preparing…</p>
      ${canEdit() ? `<label class="btn ghost small filebtn">📎 Add document<input type="file" multiple accept="${ACCEPT}" aria-label="Add document"></label>` : ''}`;
    const ul = $('.doclist', el);
    if (ul) renderDocList(ul, list, { onRemovePending: (f) => { pending.splice(pending.findIndex((p) => p.id === f.id), 1); draw(); } });
    const picker = $('input[type=file]', el);
    if (!picker) return; // view only
    picker.onchange = async (e) => {
      const picked = [...e.target.files];
      e.target.value = '';
      if (!picked.length) return;
      $('[data-busy]', el).hidden = false;
      for (const file of picked) {
        try {
          const p = await prepareFile(file);
          if (pending) pending.push({ ...p, id: uid(8) });
          else { uploadDoc(itemId, p); toast(`Added ${p.name}`); }
        } catch (err) { toast(err.message); }
      }
      draw();
    };
  };
  S.onFiles = draw;
  draw();
  return { draw };
}

// ---------- start ----------

function start() {
  const r = parseRoute();
  if (r.name === 'join' && isTripId(r.arg)) { render(); return; }
  const trips = store.myTrips();
  const cur = trips.find((t) => t.id === S.settings.currentTrip) || trips[0];
  if (cur) openTrip(cur.id, cur.kind);
  render();
}

if ('serviceWorker' in navigator && location.protocol !== 'file:' && !navigator.webdriver) {
  // Check for a new version on every launch, bypassing the HTTP cache.
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => reg.update()).catch(() => {});
  // When a new version takes over, reload once so the page and its code match.
  if (navigator.serviceWorker.controller) {
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded || sheet.open) return;
      reloaded = true;
      location.reload();
    });
  }
}
// Refresh "Next up" and today's date while the app stays open.
setInterval(() => { if (!sheet.open && (parseRoute().name || 'today') === 'today' && S.trip) render({ fromData: true }); }, 60000);

start();
