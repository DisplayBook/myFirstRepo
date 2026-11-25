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
