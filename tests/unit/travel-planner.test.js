import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  uid, isTripId, addDays, daysBetween, addMinutes, diffMinutes, dateRange, fmtDate, fmtTime, fmtDuration, fmtDistance,
  haversineKm, greatCircle, decodePolyline, knownPlaces, itemTitle, driveMinutes, itemEnd, validateItem, cleanItem,
  eventsForItem, dayAgenda, tripSpan, defaultDay, driveLegs, legStatus, hotelForNight, toICS,
} from '../../travel-planner/js/logic.js';

const LHR = { name: 'Heathrow Airport, London', lat: 51.47, lon: -0.4543 };
const JFK = { name: 'JFK Airport, New York', lat: 40.6413, lon: -73.7781 };
const HOTEL = { name: 'Hotel Pennsylvania, Manhattan', lat: 40.7496, lon: -73.9911 };
const MOMA = { name: 'MoMA, Manhattan', lat: 40.7614, lon: -73.9776 };
const BOSTON = { name: 'Boston', lat: 42.3601, lon: -71.0589 };

const flight = { id: 'f1', type: 'flight', provider: 'BA', number: '117', from: LHR, to: JFK, start: '2026-12-01T08:25', end: '2026-12-01T11:20' };
const hotel = { id: 'h1', type: 'hotel', title: 'Hotel Penn', place: HOTEL, start: '2026-12-01T15:00', end: '2026-12-04T11:00' };
const moma = { id: 'a1', type: 'activity', title: 'MoMA', place: MOMA, start: '2026-12-02T10:00', end: '2026-12-02T12:30' };
const car = { id: 'c1', type: 'car', provider: 'Hertz', from: HOTEL, start: '2026-12-02T14:00', end: '2026-12-05T10:00' };
const drive = { id: 'd1', type: 'drive', from: HOTEL, to: BOSTON, start: '2026-12-04T12:00', route: { durationMin: 220, distanceKm: 346 } };
const items = [flight, hotel, moma, car, drive];

test('ids are long random base62 and recognised as trip ids', () => {
  const id = uid();
  assert.equal(id.length, 22);
  assert.ok(isTripId(id));
  assert.ok(!isTripId('short'));
  assert.ok(!isTripId('has spaces in it and is long enough'));
  assert.equal(uid(4, () => new Uint8Array([0, 61, 62, 10])), '0z0A');
});

test('date helpers', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(daysBetween('2026-12-01', '2026-12-05'), 4);
  assert.equal(addMinutes('2026-12-01T23:30', 45), '2026-12-02T00:15');
  assert.equal(diffMinutes('2026-12-01T10:00', '2026-12-01T12:30'), 150);
  assert.deepEqual(dateRange('2026-12-30', '2027-01-02'), ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  assert.deepEqual(dateRange('2026-12-03', '2026-12-01'), []);
  assert.equal(fmtDate('2026-12-01'), 'Tue 1 Dec');
  assert.equal(fmtDate('2026-12-01', { long: true }), 'Tue 1 Dec 2026');
  assert.equal(fmtTime('14:05', true), '2:05pm');
  assert.equal(fmtTime('00:30', true), '12:30am');
  assert.equal(fmtTime('14:05'), '14:05');
});

test('duration and distance formatting', () => {
  assert.equal(fmtDuration(45), '45 min');
  assert.equal(fmtDuration(60), '1 h');
  assert.equal(fmtDuration(135), '2 h 15 min');
  assert.equal(fmtDistance(5.26), '5.3 km');
  assert.equal(fmtDistance(100, 'mi'), '62 mi');
});

test('geometry: haversine, great circle and polyline decoding', () => {
  const km = haversineKm(LHR, JFK);
  assert.ok(km > 5500 && km < 5600, `LHR–JFK ${km}`);
  const arc = greatCircle(LHR, JFK, 10);
  assert.equal(arc.length, 11);
  assert.deepEqual(arc[0].map((n) => +n.toFixed(3)), [51.47, -0.454]);
  assert.deepEqual(arc[10].map((n) => +n.toFixed(3)), [40.641, -73.778]);
  assert.ok(arc[5][0] > 51.5, 'great circle bends north');
  // Crossing the antimeridian stays continuous.
  const pac = greatCircle({ lat: 35.5, lon: 139.8 }, { lat: 37.6, lon: -122.4 }, 20);
  for (let i = 1; i < pac.length; i++) assert.ok(Math.abs(pac[i][1] - pac[i - 1][1]) < 30);
  // Example from Google's polyline documentation.
  assert.deepEqual(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@'), [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
  assert.deepEqual(decodePolyline(''), []);
});

test('item titles', () => {
  assert.equal(itemTitle(flight), 'BA 117 · Heathrow Airport → JFK Airport');
  assert.equal(itemTitle(car), 'Car hire · Hertz');
  assert.equal(itemTitle(drive), 'Drive to Boston');
  assert.equal(itemTitle({ ...drive, title: 'Coast road' }), 'Coast road');
  assert.equal(itemTitle(moma), 'MoMA');
});

test('drive minutes include buffer and stops; end time follows', () => {
  assert.equal(driveMinutes(drive), 220);
  assert.equal(driveMinutes(drive, 10), 242);
  assert.equal(driveMinutes({ ...drive, stopMin: 30 }, 10), 272);
  assert.equal(driveMinutes({ ...drive, route: undefined }), null);
  assert.equal(itemEnd(drive, 10), '2026-12-04T16:02');
  assert.equal(itemEnd(hotel), '2026-12-04T11:00');
});

test('validation and cleaning', () => {
  assert.deepEqual(validateItem(flight), []);
  const errs = validateItem({ type: 'flight', start: '' });
  assert.ok(errs.includes('From airport is required'));
  assert.ok(errs.includes('Departs is required'));
  assert.deepEqual(validateItem({ ...hotel, end: '2026-11-30T10:00' }), ['End is before start']);
  assert.deepEqual(validateItem({ type: 'nope' }), ['Unknown type']);
  assert.deepEqual(cleanItem({ a: ' x ', b: '', c: null, d: undefined, e: { f: '' }, g: { h: 1 }, n: 0 }), { a: 'x', g: { h: 1 }, n: 0 });
});

test('events for each item type', () => {
  const f = eventsForItem(flight);
  assert.deepEqual(f.map((e) => e.kind), ['depart', 'arrive']);
  assert.equal(f[0].label, 'Fly Heathrow Airport → JFK Airport');
  assert.equal(f[0].endPlace, JFK);
  assert.deepEqual(eventsForItem(hotel).map((e) => e.kind), ['checkin', 'checkout']);
  const c = eventsForItem({ ...car, to: BOSTON });
  assert.equal(c[1].place, BOSTON);
  assert.equal(eventsForItem(car)[1].place, HOTEL, 'drop-off defaults to pick-up place');
  const d = eventsForItem(drive, 0);
  assert.equal(d[0].endAt, '2026-12-04T15:40');
  assert.equal(eventsForItem(moma)[0].endAt, '2026-12-02T12:30');
});

test('trip span and default day', () => {
  const span = tripSpan({}, items);
  assert.deepEqual(span, { start: '2026-12-01', end: '2026-12-05' });
  assert.deepEqual(tripSpan({ start: '2026-11-28' }, items), { start: '2026-11-28', end: '2026-12-05' });
  assert.deepEqual(tripSpan({}, []), { start: '', end: '' });
  assert.equal(defaultDay(span, '2026-11-25'), '2026-12-01');
  assert.equal(defaultDay(span, '2026-12-03'), '2026-12-03');
  assert.equal(defaultDay(span, '2027-01-10'), '2026-12-05');
});

test('day agenda: events sorted, hotel nights and ongoing car hire', () => {
  assert.equal(hotelForNight(items, '2026-12-03')?.id, 'h1');
  assert.equal(hotelForNight(items, '2026-12-04'), null);
  const d1 = dayAgenda(items, '2026-12-01');
  assert.deepEqual(d1.events.map((e) => e.kind), ['depart', 'arrive', 'checkin']);
  assert.equal(d1.lastNight, null);
  assert.equal(d1.tonight.id, 'h1');
  const d3 = dayAgenda(items, '2026-12-03');
  assert.equal(d3.events.length, 0);
  assert.deepEqual(d3.ongoing.map((i) => i.id), ['c1']);
  const d4 = dayAgenda(items, '2026-12-04');
  assert.deepEqual(d4.events.map((e) => e.kind), ['checkout', 'drive']);
  // Same-minute events: check-out comes before check-in.
  const swap = [{ ...hotel, id: 'h2', start: '2026-12-04T11:00', end: '2026-12-05T10:00' }, hotel];
  assert.deepEqual(dayAgenda(swap, '2026-12-04').events.map((e) => `${e.kind}:${e.item.id}`), ['checkout:h1', 'checkin:h2']);
});

test('drive legs: airport → hotel after landing, no leg across the flight itself', () => {
  const legs = driveLegs(dayAgenda(items, '2026-12-01'));
  assert.equal(legs.length, 1);
  assert.equal(legs[0].from, JFK);
  assert.equal(legs[0].to, HOTEL);
  assert.equal(legs[0].availableMin, diffMinutes('2026-12-01T11:20', '2026-12-01T15:00'));
  assert.equal(legs[0].index, 2);
});

test('drive legs: from last night\'s hotel, and back to the hotel at the end of the day', () => {
  const legs = driveLegs(dayAgenda(items, '2026-12-02'));
  // hotel → MoMA (morning), MoMA → hotel for car pick-up.
  assert.equal(legs.length, 2);
  assert.equal(legs[0].from, HOTEL);
  assert.equal(legs[0].to, MOMA);
  assert.equal(legs[0].availableMin, null, 'no fixed start time when leaving the hotel');
  assert.equal(legs[1].from, MOMA);
  assert.equal(legs[1].availableMin, 90, 'from activity end 12:30 to 14:00 pick-up');
  // A day out ending far from the hotel gets a "back to hotel" leg.
  const dayOut = [hotel, { ...moma, id: 'a2', place: BOSTON, start: '2026-12-03T10:00', end: '2026-12-03T16:00' }];
  const l3 = driveLegs(dayAgenda(dayOut, '2026-12-03'));
  assert.equal(l3.length, 2);
  assert.equal(l3[1].index, 1);
  assert.equal(l3[1].to, HOTEL);
  assert.match(l3[1].toLabel, /Back to Hotel Penn/);
});

test('drive legs: a planned drive replaces the gap leg', () => {
  const legs = driveLegs(dayAgenda(items, '2026-12-04'));
  assert.equal(legs.length, 0);
  // Places without coordinates are ignored.
  const noCoords = [{ ...moma, place: { name: 'Somewhere' } }, hotel];
  assert.equal(driveLegs(dayAgenda(noCoords, '2026-12-02')).length, 0);
});

test('leg status', () => {
  assert.equal(legStatus(null, 50), 'ok');
  assert.equal(legStatus(90, 50), 'ok');
  assert.equal(legStatus(60, 50), 'tight');
  assert.equal(legStatus(40, 50), 'late');
});

test('known places are de-duplicated and ranked by use', () => {
  const p = knownPlaces(items);
  assert.equal(p[0].name, HOTEL.name);
  assert.equal(p.length, 5);
  assert.equal(knownPlaces([{ type: 'activity', place: { name: 'x' } }]).length, 0);
});

test('calendar export', () => {
  const ics = toICS('NY, trip', items, 0, '20261125T120000Z');
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /X-WR-CALNAME:NY\\, trip/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1 + 2 + 1 + 2 + 1);
  assert.match(ics, /DTSTART:20261201T082500\r\nDTEND:20261201T112000\r\nSUMMARY:BA 117 · Heathrow Airport → JFK Airport/);
  assert.match(ics, /SUMMARY:Check in: Hotel Penn/);
  assert.match(ics, /UID:d1@trip-planner\r\nDTSTAMP:20261125T120000Z\r\nDTSTART:20261204T120000\r\nDTEND:20261204T154000/);
  assert.ok(ics.split('\r\n').every((l) => l.length <= 75));
});

// ---------- documents ----------
import { splitBytes, joinBytes, fmtBytes, safeName, isPdf, fileIcon, CHUNK_BYTES } from '../../travel-planner/js/files.js';

test('documents: bytes split into chunks under the Firestore limit and join back', () => {
  const data = new Uint8Array(CHUNK_BYTES * 2 + 123).map((_, i) => i % 251);
  const parts = splitBytes(data);
  assert.equal(parts.length, 3);
  assert.ok(parts.every((p) => p.length <= CHUNK_BYTES && p.length < 1000000));
  assert.deepEqual(joinBytes(parts), data);
  assert.equal(splitBytes(new Uint8Array(0)).length, 1, 'empty file still has one chunk');
  assert.deepEqual(splitBytes(new Uint8Array([1, 2, 3, 4, 5]), 2).map((p) => [...p]), [[1, 2], [3, 4], [5]]);
});

test('documents: names, sizes and icons', () => {
  assert.equal(fmtBytes(500), '500 B');
  assert.equal(fmtBytes(2048), '2 KB');
  assert.equal(fmtBytes(1.5 * 1024 * 1024), '1.5 MB');
  assert.equal(safeName('C:\\Users\\me\\boarding<pass>.pdf'), 'boardingpass.pdf');
  assert.equal(safeName(''), 'document');
  const long = safeName(`${'x'.repeat(200)}.pdf`);
  assert.equal(long.length, 80);
  assert.ok(long.endsWith('.pdf'));
  assert.ok(isPdf('', 'ticket.PDF'));
  assert.equal(fileIcon('image/jpeg', 'a.jpg'), '🖼️');
  assert.equal(fileIcon('application/pdf', 'a.pdf'), '📄');
});

// ---------- costs & budget ----------
import { toHome, spreadCost, budgetSummary, parseAmount, guessCurrency, fmtMoney, payment } from '../../travel-planner/js/budget.js';

test('budget: amounts parse in common formats', () => {
  assert.equal(parseAmount('1,234.50'), 1234.5);
  assert.equal(parseAmount('1.234,50'), 1234.5);
  assert.equal(parseAmount('12,5'), 12.5);
  assert.equal(parseAmount('£80'), 80);
  assert.equal(parseAmount('1,200'), 1200);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('abc'), null);
  assert.equal(guessCurrency('en-GB'), 'GBP');
  assert.equal(guessCurrency('de-DE'), 'EUR');
  assert.equal(guessCurrency('xx'), 'USD');
  assert.match(fmtMoney(12.5, 'GBP'), /12\.50/);
});

test('budget: currency conversion and spreading over nights', () => {
  assert.equal(toHome(100, 'GBP', 'GBP'), 100);
  assert.equal(toHome(100, 'EUR', 'GBP', { EUR: 0.85 }), 85);
  assert.equal(toHome(100, 'USD', 'GBP', {}), null);
  const s = spreadCost(hotel, 300);
  assert.deepEqual(s, [{ date: '2026-12-01', amount: 100 }, { date: '2026-12-02', amount: 100 }, { date: '2026-12-03', amount: 100 }]);
  assert.deepEqual(spreadCost(moma, 30), [{ date: '2026-12-02', amount: 30 }]);
  assert.equal(spreadCost(car, 120).length, 3);
});

test('budget: summary totals, paid, by type and day, missing rates', () => {
  const costed = [
    { ...flight, cost: 500, currency: 'GBP', paid: true },
    { ...hotel, cost: 300, currency: 'USD' },
    { ...moma, cost: 25, currency: 'EUR' },
    car, drive,
  ];
  const b = budgetSummary(costed, { currency: 'GBP', budget: 1000, rates: { USD: 0.8 } });
  assert.equal(b.total, 500 + 240);
  assert.equal(b.paid, 500);
  assert.equal(b.unpaid, 240);
  assert.equal(b.remaining, 260);
  assert.equal(b.byType.flight, 500);
  assert.equal(b.byType.hotel, 240);
  assert.equal(b.byDay['2026-12-01'], 500 + 80);
  assert.deepEqual(b.missingRates, ['EUR']);
  assert.deepEqual(b.uncosted.map((i) => i.id), ['c1', 'd1']);
  assert.equal(b.rows.length, 3);
  assert.equal(budgetSummary([], {}).budget, null);
});

// ---------- scanning ----------
import { normalizeBookings, normalizeDateTime, placesToLocate, EXTRACT_SCHEMA } from '../../travel-planner/js/ai.js';

test('scan: the extraction schema is strict (every property required, no extras)', () => {
  const check = (s, path) => {
    if (s.type === 'object') {
      assert.equal(s.additionalProperties, false, `${path} must forbid extra properties`);
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort(), `${path} must require every property`);
      for (const [k, v] of Object.entries(s.properties)) check(v, `${path}.${k}`);
    } else if (s.type === 'array') check(s.items, `${path}[]`);
  };
  check(EXTRACT_SCHEMA, 'root');
});

test('scan: dates and times are normalised with sensible defaults', () => {
  assert.equal(normalizeDateTime('2026-12-01T9:05'), '2026-12-01T09:05');
  assert.equal(normalizeDateTime('2026-12-01 14:30'), '2026-12-01T14:30');
  assert.equal(normalizeDateTime('2026-12-01', '15:00'), '2026-12-01T15:00');
  assert.equal(normalizeDateTime('1 Dec'), '');
});

test('scan: model output becomes booking drafts', () => {
  const blank = { title: '', provider: '', number: '', ref: '', seat: '', start: '', end: '', place: { name: '', search: '' }, from: { name: '', search: '' }, to: { name: '', search: '' }, cost: '', currency: '', paid: false, notes: '' };
  const drafts = normalizeBookings([
    { ...blank, type: 'flight', provider: 'British Airways', number: 'BA 117', ref: 'XK9P2L', start: '2026-12-01T08:25', end: '2026-12-01T11:20',
      from: { name: 'Heathrow Airport (LHR)', search: 'Heathrow Airport, London, UK' }, to: { name: 'JFK Airport (JFK)', search: 'JFK Airport, New York' }, cost: '1,240.00', currency: 'gbp', paid: true },
    { ...blank, type: 'hotel', title: 'Hotel Penn', start: '2026-12-01', place: { name: 'Hotel Penn', search: '401 7th Ave, New York' }, cost: '612.5' },
    { ...blank, type: 'car', provider: 'Hertz', start: '2026-12-02T14:00', from: { name: 'Hertz JFK', search: 'x' }, to: { name: 'Hertz JFK', search: 'x' } },
    { ...blank, type: 'spaceship' },
    { ...blank, type: 'activity', title: 'Show', start: '2026-12-02T19:30', end: '2026-12-02T18:00' },
  ], { currency: 'USD' });
  assert.equal(drafts.length, 4, 'unknown types are dropped');
  const [f, h, c, a] = drafts;
  assert.deepEqual(f.from, { name: 'Heathrow Airport (LHR)', search: 'Heathrow Airport, London, UK' });
  assert.equal(f.cost, 1240);
  assert.equal(f.currency, 'GBP');
  assert.equal(f.paid, true);
  assert.equal(f.ref, 'XK9P2L');
  assert.equal(f.title, undefined, 'empty strings are not kept');
  assert.equal(h.start, '2026-12-01T15:00');
  assert.equal(h.end, '2026-12-02T11:00', 'hotel without check-out gets one night');
  assert.equal(h.currency, 'USD', 'missing currency falls back to the trip currency');
  assert.equal(h.paid, false);
  assert.equal(c.to, undefined, 'same drop-off as pick-up is left empty');
  assert.equal(c.end, '2026-12-03T14:00');
  assert.equal(a.end, undefined, 'an end before the start is dropped');
  assert.deepEqual(placesToLocate(f), ['from', 'to']);
  assert.deepEqual(placesToLocate({ place: { name: 'x', lat: 1, lon: 2 } }), []);
  assert.deepEqual(normalizeBookings(null), []);
});

test('budget: deposits count as paid, the balance as still to pay', () => {
  assert.deepEqual(payment({ cost: 100, paid: true }), { status: 'full', paid: 100, due: 0, balanceDue: '' });
  assert.deepEqual(payment({ cost: 100, deposit: 30, balanceDue: '2026-11-20' }), { status: 'deposit', paid: 30, due: 70, balanceDue: '2026-11-20' });
  assert.deepEqual(payment({ cost: 100 }), { status: 'none', paid: 0, due: 100, balanceDue: '' });
  assert.equal(payment({ cost: 100, deposit: 150 }).paid, 100, 'deposit is capped at the cost');
  const items = [
    { ...hotel, cost: 300, currency: 'USD', deposit: 50, balanceDue: '2026-11-20' },
    { ...flight, cost: 500, currency: 'GBP', paid: true },
    { ...moma, cost: 40, currency: 'GBP' },
  ];
  const b = budgetSummary(items, { currency: 'GBP', rates: { USD: 0.8 } }, '2026-11-25');
  assert.equal(b.total, 240 + 500 + 40);
  assert.equal(b.paid, 40 + 500);
  assert.equal(b.unpaid, 200 + 40);
  assert.deepEqual(b.upcoming.map((r) => [r.item.id, r.dueLocal, r.by, r.overdue]), [
    ['h1', 250, '2026-11-20', true],
    ['a1', 40, '2026-12-02', false],
  ]);
  assert.equal(b.rows.find((r) => r.item.id === 'h1').status, 'deposit');
});

test('scan: deposits and balance-due dates are read from confirmations', () => {
  const blank = { title: '', provider: '', number: '', ref: '', seat: '', start: '', end: '', place: { name: '', search: '' }, from: { name: '', search: '' }, to: { name: '', search: '' }, cost: '', currency: '', paid: false, deposit: '', balanceDue: '', notes: '' };
  const [a, b, c] = normalizeBookings([
    { ...blank, type: 'hotel', title: 'Villa', start: '2026-12-01', cost: '1200', currency: 'EUR', deposit: '300', balanceDue: '2026-11-01' },
    { ...blank, type: 'hotel', title: 'B&B', start: '2026-12-03', cost: '200', deposit: '200' },
    { ...blank, type: 'activity', title: 'Tour', start: '2026-12-02', cost: '50', paid: true, deposit: '10', balanceDue: '2026-11-01' },
  ], { currency: 'GBP' });
  assert.equal(a.deposit, 300);
  assert.equal(a.balanceDue, '2026-11-01');
  assert.equal(a.paid, false);
  assert.equal(b.paid, true, 'a deposit of the whole price means paid in full');
  assert.equal(b.deposit, undefined);
  assert.equal(c.deposit, undefined, 'paid in full ignores the deposit');
  assert.equal(c.balanceDue, undefined);
});

// ---------- live checks & day summary ----------
import { FLIGHT_STATUS_TOOL, ROAD_TOOL, DAY_BRIEF_TOOL, guessTime } from '../../travel-planner/js/ai.js';

test('live checks: report tools are strict (every property required, no extras)', () => {
  const check = (s, path) => {
    if (s.type === 'object') {
      assert.equal(s.additionalProperties, false, `${path} must forbid extra properties`);
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort(), `${path} must require every property`);
      for (const [k, v] of Object.entries(s.properties)) check(v, `${path}.${k}`);
    } else if (s.type === 'array') check(s.items, `${path}[]`);
  };
  for (const t of [FLIGHT_STATUS_TOOL, ROAD_TOOL, DAY_BRIEF_TOOL]) {
    assert.equal(t.strict, true);
    assert.match(t.name, /^report_/);
    check(t.input_schema, t.name);
  }
});

test('day summary: suggestion times', () => {
  assert.equal(guessTime('Lunch'), '12:30');
  assert.equal(guessTime('After 16:00'), '16:00');
  assert.equal(guessTime('around 7pm'), '19:00');
  assert.equal(guessTime('12am'), '00:00');
  assert.equal(guessTime('Dinner'), '19:00');
  assert.equal(guessTime('Evening'), '18:00');
  assert.equal(guessTime('Breakfast'), '08:30');
  assert.equal(guessTime(''), '10:00');
});

// ---------- trip chat ----------
import { buildTripContext, renderMarkdown, sourcesFrom, answerText } from '../../travel-planner/js/chat.js';

test('chat: trip context includes bookings, refs, payments, budget and document text', () => {
  const its = [
    { ...hotel, ref: 'HP-778', cost: 600, currency: 'GBP', deposit: 100, balanceDue: '2026-11-28', notes: 'Late check-in arranged' },
    { ...flight, ref: 'XK9P2L', cost: 480, currency: 'GBP', paid: true },
    moma,
  ];
  const ctx = buildTripContext({
    meta: { name: 'NYC', currency: 'GBP', budget: 2000 }, items: its,
    files: [{ id: 'f1', itemId: 'h1', name: 'confirmation.pdf', text: 'Hotel Penn\nConfirmation HP-778\nBreakfast included' }],
    now: '2026-11-26T10:00', live: { f1x: 'ignored', f1: 'delayed' },
  });
  assert.match(ctx, /Trip name: NYC/);
  assert.match(ctx, /Day 1, Tue 1 Dec 2026-12-01:/);
  assert.match(ctx, /booking ref HP-778/);
  assert.match(ctx, /deposit £100\.00 paid, £500\.00 still due by 2026-11-28/);
  assert.match(ctx, /paid in full/);
  assert.match(ctx, /notes: Late check-in arranged/);
  assert.match(ctx, /Planned spend £1,080\.00; paid £580\.00; still to pay £500\.00; budget £2,000\.00, £920\.00 left/);
  assert.match(ctx, /Bookings without a cost: MoMA/);
  assert.match(ctx, /confirmation\.pdf \(for Hotel Penn\)/);
  assert.match(ctx, /Text: Hotel Penn \/ Confirmation HP-778 \/ Breakfast included/);
  assert.match(ctx, /current local date and time: 2026-11-26 10:00/);
});

test('chat: markdown is rendered safely', () => {
  assert.equal(renderMarkdown('Hi **there** and *you*'), '<p>Hi <strong>there</strong> and <em>you</em></p>');
  assert.equal(renderMarkdown('- one\n- two\n\n1. a\n2. b'), '<ul><li>one</li><li>two</li></ul><ol><li>a</li><li>b</li></ol>');
  assert.equal(renderMarkdown('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  assert.equal(renderMarkdown('[ok](https://a.com/x) [bad](javascript:alert(1))'),
    '<p><a href="https://a.com/x" target="_blank" rel="noopener">ok</a> [bad](javascript:alert(1))</p>');
  // A quote in a URL stays escaped inside the attribute, so it can't add attributes.
  const q = renderMarkdown('[x](https://a.com/"onmouseover=y)');
  assert.ok(!q.includes('" onmouseover') && !q.includes('"onmouseover'), q);
});

test('chat: sources from web citations, answer text joined', () => {
  const content = [
    { type: 'server_tool_use', id: 's1', name: 'web_search', input: {} },
    { type: 'text', text: 'It is ', citations: null },
    { type: 'text', text: 'sunny', citations: [
      { type: 'web_search_result_location', url: 'https://weather.example/nyc', title: 'NYC weather' },
      { type: 'web_search_result_location', url: 'https://weather.example/nyc', title: 'dup' },
      { type: 'web_search_result_location', url: 'http://insecure.example', title: 'no' },
    ] },
    { type: 'text', text: '.' },
  ];
  assert.deepEqual(sourcesFrom(content), [{ url: 'https://weather.example/nyc', title: 'NYC weather' }]);
  assert.equal(answerText(content), 'It is sunny.');
});

// ---------- ideas from the chat ----------
import { placesFrom, isSavedIdea } from '../../travel-planner/js/chat.js';
import { PLACES_TOOL } from '../../travel-planner/js/ai.js';

test('chat places: validated, cleaned and de-duplicated', () => {
  const content = [
    { type: 'text', text: 'Try these.' },
    { type: 'tool_use', id: 't1', name: 'report_places', input: { places: [
      { name: '  Joe\'s Pizza ', category: 'restaurant', why: 'Classic slice', when: 'Lunch', address: '1435 Broadway' },
      { name: "joe's pizza", category: 'restaurant', why: 'dup', when: '', address: '' },
      { name: 'Mystery', category: 'spaceship', why: 42, when: null, address: 'x'.repeat(500) },
      { name: '', category: 'cafe' },
      null,
    ] } },
  ];
  const p = placesFrom(content);
  assert.equal(p.length, 2);
  assert.deepEqual(p[0], { name: "Joe's Pizza", category: 'restaurant', why: 'Classic slice', when: 'Lunch', address: '1435 Broadway' });
  assert.equal(p[1].category, 'other');
  assert.equal(p[1].why, '');
  assert.equal(p[1].address.length, 200);
  assert.deepEqual(placesFrom([{ type: 'text', text: 'no places' }]), []);
  assert.deepEqual(placesFrom([{ type: 'tool_use', name: 'report_places', input: { places: 'nope' } }]), []);
  assert.ok(isSavedIdea([{ name: "Joe's Pizza" }], "JOE'S PIZZA"));
  assert.ok(!isSavedIdea([], 'x'));
  // The tool passes the AI server's allow-list (name report_*, no type) and is strict.
  assert.match(PLACES_TOOL.name, /^report_[a-z_]+$/);
  assert.equal(PLACES_TOOL.type, undefined);
  assert.equal(PLACES_TOOL.strict, true);
});

test('chat context lists saved ideas', () => {
  const ctx = buildTripContext({ meta: { name: 'NYC', ideas: [{ id: 'i1', name: 'Top of the Rock', category: 'attraction', address: '30 Rockefeller Plaza', why: 'Great views' }] }, items: [] });
  assert.match(ctx, /## Saved ideas[\s\S]*Top of the Rock \[attraction\], 30 Rockefeller Plaza — Great views/);
  assert.match(buildTripContext({ meta: {}, items: [] }), /## Saved ideas[^\n]*\n\(none\)/);
});

// ---------- flight lookup ----------
import { formatFlightNo } from '../../travel-planner/js/logic.js';
import { FLIGHT_LOOKUP_TOOL, normalizeFlightLookup } from '../../travel-planner/js/ai.js';

test('flight lookup: flight numbers are tidied', () => {
  assert.equal(formatFlightNo('ba117'), 'BA 117');
  assert.equal(formatFlightNo('BA-0117'), 'BA 117');
  assert.equal(formatFlightNo('u2 8123'), 'U2 8123');
  assert.equal(formatFlightNo('EZY8123'), 'EZY 8123');
  assert.equal(formatFlightNo('w6123'), 'W6 123');
  assert.equal(formatFlightNo(' BA '), 'BA');
});

test('flight lookup: report tool is strict and passes the AI server allow-list', () => {
  const check = (s) => {
    if (s.type === 'object') {
      assert.equal(s.additionalProperties, false);
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort());
      Object.values(s.properties).forEach(check);
    } else if (s.type === 'array') check(s.items);
  };
  check(FLIGHT_LOOKUP_TOOL.input_schema);
  assert.equal(FLIGHT_LOOKUP_TOOL.strict, true);
  assert.match(FLIGHT_LOOKUP_TOOL.name, /^report_[a-z_]+$/);
});

test('flight lookup: results become form fields', () => {
  const raw = {
    found: true, airline: 'British Airways', flightNumber: 'ba 178',
    from: { name: 'New York JFK (JFK)', search: 'JFK Airport, New York', terminal: 'Terminal 8', time: '19:00', date: '2026-12-05' },
    to: { name: 'London Heathrow (LHR)', search: 'Heathrow Airport, London', terminal: 'T5', time: '7:05', date: '' },
    aircraft: 'Boeing 777-300ER', note: '', source: 'FlightAware',
  };
  assert.deepEqual(normalizeFlightLookup(raw, '2026-12-05'), {
    provider: 'British Airways', number: 'BA 178',
    from: { name: 'New York JFK (JFK)', search: 'JFK Airport, New York' },
    to: { name: 'London Heathrow (LHR)', search: 'Heathrow Airport, London' },
    start: '2026-12-05T19:00', end: '2026-12-06T07:05', terminal: '8', arrTerminal: '5',
    notes: 'Aircraft: Boeing 777-300ER',
  });
  // An explicit arrival date wins (e.g. crossing the date line "backwards").
  const back = normalizeFlightLookup({ ...raw, from: { ...raw.from, date: '2026-12-05', time: '17:00' }, to: { ...raw.to, date: '2026-12-05', time: '10:30' } }, '2026-12-05');
  assert.equal(back.end, '2026-12-05T10:30');
  // TBA terminals are dropped; not found gives nothing.
  assert.equal(normalizeFlightLookup({ ...raw, from: { ...raw.from, terminal: 'TBA' } }, '2026-12-05').terminal, undefined);
  assert.equal(normalizeFlightLookup({ ...raw, to: { ...raw.to, terminal: '2E' } }, '2026-12-05').arrTerminal, '2E');
  assert.deepEqual(normalizeFlightLookup({ ...raw, found: false }, '2026-12-05'), {});
  assert.deepEqual(normalizeFlightLookup(null, '2026-12-05'), {});
});

test('flight lookup: a far-ahead date uses the usual schedule on the requested date', () => {
  const usual = {
    found: true, basis: 'regular_schedule', airline: 'Lufthansa', flightNumber: 'LH 2485',
    from: { name: 'Munich (MUC)', search: 'Munich Airport', terminal: '2', time: '21:40', date: '2026-11-24' },
    to: { name: 'London Heathrow (LHR)', search: 'Heathrow Airport', terminal: '2', time: '22:45', date: '2026-11-24' },
    aircraft: '', note: '', source: 'FlightAware',
  };
  const out = normalizeFlightLookup(usual, '2027-08-21');
  assert.equal(out.start, '2027-08-21T21:40', 'recent date is replaced by the requested one');
  assert.equal(out.end, '2027-08-21T22:45');
  assert.equal(out.usualSchedule, true);
  // Overnight usual flights keep their next-day arrival.
  const night = normalizeFlightLookup({ ...usual, from: { ...usual.from, time: '22:30' }, to: { ...usual.to, time: '06:10', date: '2026-11-25' } }, '2027-08-21');
  assert.equal(night.end, '2027-08-22T06:10');
  assert.equal(normalizeFlightLookup({ ...usual, basis: 'exact_date', from: { ...usual.from, date: '2027-08-21' }, to: { ...usual.to, date: '2027-08-21' } }, '2027-08-21').usualSchedule, undefined);
});

test('drive legs: never across a flight, even if the airport has no map position', () => {
  const lhr = { name: 'London Heathrow (LHR)', lat: 51.47, lon: -0.4543 };
  const its = [
    { id: 'h0', type: 'hotel', title: 'Airport hotel', place: lhr, start: '2027-08-20T15:00', end: '2027-08-21T05:00' },
    { id: 'f', type: 'flight', from: lhr, to: { name: 'Munich (MUC)' }, start: '2027-08-21T07:00', end: '2027-08-21T10:20' },
    { id: 'c', type: 'car', provider: 'Europcar', from: { name: 'Munich International Airport', lat: 48.3537, lon: 11.775 }, start: '2027-08-21T10:30', end: '2027-08-25T10:00' },
  ];
  const legs = driveLegs(dayAgenda(its, '2027-08-21'));
  assert.equal(legs.filter((l) => l.from === lhr && l.to.name === 'Munich International Airport').length, 0, 'no London → Munich drive');
});

// ---------- packing ----------
import { SHARED, PACK_CATEGORIES, TEMPLATES, splitPacking, expandItems, templateItems, progress as packProgress, groupByCategory, resolveWho } from '../../travel-planner/js/packing.js';
import { PACKING_TOOL } from '../../travel-planner/js/ai.js';

test('packing: items for each person, shared, or one person; duplicates skipped', () => {
  const people = [{ id: 'p1', kind: 'person', name: 'Alex', at: '1' }, { id: 'p2', kind: 'person', name: 'Sam', at: '2' }];
  const each = expandItems([{ name: 'Ski socks', category: 'clothes', who: 'each', qty: 3 }], people);
  assert.deepEqual(each.map((i) => [i.who, i.name, i.qty, i.done]), [['p1', 'Ski socks', 3, false], ['p2', 'Ski socks', 3, false]]);
  const existing = [{ kind: 'item', who: 'p1', name: 'ski SOCKS' }];
  assert.deepEqual(expandItems([{ name: 'Ski socks ', category: 'clothes', who: 'each' }], people, existing).map((i) => i.who), ['p2'], 'p1 already has them');
  assert.equal(expandItems([{ name: 'Sun cream', category: 'nope', who: SHARED, qty: 0 }], people)[0].category, 'other');
  assert.equal(expandItems([{ name: 'Sun cream', who: SHARED, qty: 0 }], people)[0].qty, 1);
  assert.deepEqual(expandItems([{ name: 'Gloves', who: 'each' }], []).map((i) => i.who), [SHARED], 'no people yet: shared');
  assert.deepEqual(expandItems([{ name: '  ', who: 'each' }], people), []);
});

test('packing: progress, grouping, who-matching, templates and tool', () => {
  const items = [
    { kind: 'item', who: 'p1', name: 'Helmet', category: 'gear', done: true },
    { kind: 'item', who: 'p1', name: 'Gloves', category: 'clothes', done: false },
    { kind: 'item', who: SHARED, name: 'Adapter', category: 'electronics', done: false },
    { kind: 'item', who: 'p1', name: 'Beanie', category: 'clothes', done: true },
  ];
  assert.deepEqual(packProgress(items), { done: 2, total: 4 });
  assert.deepEqual(packProgress(items, 'p1'), { done: 2, total: 3 });
  const g = groupByCategory(items);
  assert.deepEqual(g.map((x) => x.key), ['clothes', 'gear', 'electronics'], 'category order');
  assert.deepEqual(g[0].items.map((i) => i.name), ['Gloves', 'Beanie'], 'unpacked first');
  assert.deepEqual(splitPacking([{ kind: 'person', name: 'B', at: '2' }, { kind: 'item' }, { kind: 'person', name: 'A', at: '1' }]).people.map((p) => p.name), ['A', 'B']);
  const people = [{ id: 'p1', name: 'Alex Smith' }, { id: 'p2', name: 'Sam' }];
  assert.equal(resolveWho('Alex', people), 'p1');
  assert.equal(resolveWho('sam', people), 'p2');
  assert.equal(resolveWho('each', people), 'each');
  assert.equal(resolveWho('shared', people), SHARED);
  assert.equal(resolveWho('Nobody', people), SHARED);
  const cats = PACK_CATEGORIES.map(([k]) => k);
  for (const [key, t] of Object.entries(TEMPLATES)) {
    assert.ok(templateItems(key).length >= 8, key);
    for (const [name, cat, who] of t.items) assert.ok(cats.includes(cat) && ['each', 'shared'].includes(who), `${key}: ${name}`);
  }
  assert.equal(PACKING_TOOL.strict, true);
  assert.match(PACKING_TOOL.name, /^report_[a-z_]+$/);
  const ctx = buildTripContext({ meta: {}, items: [], packing: [{ kind: 'person', id: 'p1', name: 'Alex' }, ...items] });
  assert.match(ctx, /Alex: 2\/3 packed; still to pack: Gloves/);
});
