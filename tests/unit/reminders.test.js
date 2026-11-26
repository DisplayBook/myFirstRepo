import { test } from 'node:test';
import assert from 'node:assert/strict';
import tzlookup from '../../travel-planner/vendor/tz-lookup/tz.js';
import { buildReminders, zonedToUtc, tzOffsetMin, estimateDriveMin, remindersHash, ALL_KINDS } from '../../travel-planner/js/reminders.js';

const LHR = { name: 'Heathrow Airport (LHR)', lat: 51.47, lon: -0.4543 };
const JFK = { name: 'JFK Airport (JFK)', lat: 40.6413, lon: -73.7781 };
const PENN = { name: 'Hotel Pennsylvania', lat: 40.7496, lon: -73.9913 };
const MOMA = { name: 'MoMA', lat: 40.7614, lon: -73.9776 };
const HOME = { name: 'Home, Reading', lat: 51.4543, lon: -0.9781 };
const iso = (ms) => new Date(ms).toISOString().slice(0, 16);

test('reminders: local times become real instants in the place\'s time zone', () => {
  assert.equal(iso(zonedToUtc('2026-12-01T09:30', 'Europe/London')), '2026-12-01T09:30');
  assert.equal(iso(zonedToUtc('2026-12-01T09:30', 'America/New_York')), '2026-12-01T14:30');
  assert.equal(iso(zonedToUtc('2026-07-01T09:30', 'Europe/London')), '2026-07-01T08:30', 'summer time');
  assert.equal(iso(zonedToUtc('2026-03-29T03:30', 'Europe/London')), '2026-03-29T02:30', 'just after clocks go forward');
  assert.equal(tzOffsetMin(Date.UTC(2026, 0, 1), 'Asia/Kolkata'), 330);
  assert.equal(tzlookup(JFK.lat, JFK.lon), 'America/New_York');
  assert.ok(estimateDriveMin(HOME, LHR) >= 30 && estimateDriveMin(HOME, LHR) <= 60);
});

test('reminders: flights, leaving, hotel, car, parking, payment, packing, morning', () => {
  const items = [
    { id: 'h0', type: 'hotel', title: 'Home', place: HOME, start: '2026-11-30T15:00', end: '2026-12-01T06:00' },
    { id: 'f1', type: 'flight', provider: 'British Airways', number: 'BA 117', from: LHR, to: JFK, start: '2026-12-01T09:30', end: '2026-12-01T12:30', terminal: '5', ref: 'ABC123' },
    { id: 'h1', type: 'hotel', title: 'Hotel Penn', place: PENN, start: '2026-12-01T15:00', end: '2026-12-04T11:00', cost: 900, deposit: 200, balanceDue: '2026-11-20', currency: 'USD' },
    { id: 'a1', type: 'activity', title: 'MoMA', place: MOMA, start: '2026-12-02T10:00', end: '2026-12-02T12:00' },
    { id: 'c1', type: 'car', provider: 'Hertz', from: JFK, start: '2026-12-03T10:00', end: '2026-12-04T15:00' },
    { id: 'p1', type: 'parking', title: 'T5 Meet & Greet', place: LHR, start: '2026-12-01T06:45', end: '2026-12-05T18:00', spot: 'B12' },
  ];
  const packing = [{ id: 'x', kind: 'item', name: 'Passport', who: 'shared' }];
  const list = buildReminders({ meta: { name: 'New York', currency: 'GBP' }, items, packing }, {
    now: Date.UTC(2026, 10, 1), tzlookup, deviceTz: 'Europe/London', bufferPct: 0, routeFor: () => null,
  });
  const by = (id) => list.find((r) => r.id === id);
  assert.ok(list.every((r) => ALL_KINDS.includes(r.kind) && r.title && r.at > 0));

  assert.equal(iso(by('f1:checkin').at), '2026-11-30T09:30');
  assert.equal(iso(by('f1:flight').at), '2026-12-01T06:30');
  assert.match(by('f1:flight').body, /Terminal 5/);
  // Leaving home (hotel "Home") for the parking at Heathrow, then the flight: estimated drive.
  const leave = by('p1:activity:leave');
  assert.ok(leave, 'leave for parking');
  assert.match(leave.title, /Leave by/);
  assert.match(leave.body, /estimate/);
  // New York times use New York's zone.
  assert.equal(iso(by('h1:checkout').at), '2026-12-04T13:00', '08:00 in New York');
  assert.equal(iso(by('day:2026-12-02:morning').at), '2026-12-02T12:30', '07:30 in New York');
  assert.match(by('day:2026-12-02:morning').body, /MoMA/);
  assert.equal(iso(by('c1:return').at), '2026-12-04T18:00', '2h before 15:00 New York');
  assert.equal(iso(by('p1:collect').at), '2026-12-05T16:00', '2h before 18:00 London');
  assert.equal(iso(by('h1:pay:2026-11-20').at), '2026-11-17T09:00');
  assert.match(by('h1:pay:2026-11-20').title, /700/);
  assert.equal(iso(by('trip:2026-11-30:packing').at), '2026-11-28T18:00');
  // MoMA: drive from the hotel, using a known route when there is one.
  const withRoute = buildReminders({ meta: {}, items, packing }, {
    now: Date.UTC(2026, 10, 1), tzlookup, deviceTz: 'Europe/London', bufferPct: 0, routeFor: (a, b) => (b.name === 'MoMA' ? { durationMin: 12 } : null),
  });
  const moma = withRoute.find((r) => r.id === 'a1:activity:leave');
  assert.match(moma.body, /About 12 min drive\./);
  assert.equal(iso(moma.at), '2026-12-02T14:23', '10:00 NY − 12 min − 10 spare − 15 notice');

  // Past reminders are dropped; the hash changes when the plan does.
  assert.equal(buildReminders({ meta: {}, items, packing }, { now: Date.UTC(2027, 0, 1), tzlookup, deviceTz: 'Europe/London' }).length, 0);
  const h = remindersHash(list);
  assert.equal(h, remindersHash(list.map((r) => ({ ...r }))));
  assert.notEqual(h, remindersHash(list.slice(1)));
});
