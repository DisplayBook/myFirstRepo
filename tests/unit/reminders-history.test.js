import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reminderTimes, checkDue, nextReminder, buildICS } from '../../js/reminders.js';
import { scheduleFromTemplate } from '../../js/schedule.js';
import { makeEntry, toCSV, streakStats, weekSeries, slotsDoneOn } from '../../js/history.js';
import { addDays } from '../../js/util.js';

const rem = (o = {}) => ({ enabled: true, mode: 'interval', start: '08:00', end: '20:00', every: 60, days: [0, 1, 2, 3, 4, 5, 6], ...o });
const at = (h, m = 0) => { const d = new Date(2026, 10, 25, h, m, 0); return d; };

test('interval reminder times 08:00 to 20:00 every 45 min', () => {
  const t = reminderTimes(rem({ every: 45 }));
  assert.equal(t[0], '08:00');
  assert.equal(t[1], '08:45');
  assert.equal(t.at(-1), '20:00');
  assert.equal(t.length, 17);
});

test('slot-based reminder times follow the schedule', () => {
  assert.deepEqual(reminderTimes(rem({ mode: 'slots' }), scheduleFromTemplate('gentle')), ['08:30', '10:30', '14:00', '18:00', '21:00']);
});

test('checkDue fires once per time and respects lastFired', () => {
  const r = rem();
  assert.equal(checkDue({ rem: r, now: at(9, 0, 30), lastFired: null }).due, true);
  assert.equal(checkDue({ rem: r, now: at(9, 5), lastFired: at(9, 0).toISOString() }).due, false);
  assert.equal(checkDue({ rem: r, now: at(10, 1), lastFired: at(9, 0).toISOString() }).due, true);
  // too late (> 20 min grace): don't fire a stale reminder
  assert.equal(checkDue({ rem: r, now: at(10, 40), lastFired: at(9, 0).toISOString() }).due, false);
  assert.equal(checkDue({ rem: { ...r, enabled: false }, now: at(9, 0) }).due, false);
});

test('snooze holds reminders, then fires after 10 minutes', () => {
  const r = rem();
  const snoozeUntil = at(9, 10).toISOString();
  assert.equal(checkDue({ rem: r, now: at(9, 5), lastFired: at(9, 0).toISOString(), snoozeUntil }).due, false);
  const res = checkDue({ rem: r, now: at(9, 10), lastFired: at(9, 0).toISOString(), snoozeUntil });
  assert.equal(res.due, true);
  assert.equal(res.reason, 'snooze');
});

test('days filter and nextReminder', () => {
  const wed = at(9, 0); // 2026-11-25 is a Wednesday
  assert.equal(checkDue({ rem: rem({ days: [1] }), now: wed }).due, false);
  const n = nextReminder({ rem: rem(), now: at(20, 30) });
  assert.equal(n.getDate(), 26);
  assert.equal(n.getHours(), 8);
});

test('ICS has a daily repeating event with an alarm per time', () => {
  const ics = buildICS(['08:00', '12:30'], [1, 2, 3, 4, 5], at(7));
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.match(ics, /DTSTART:20261125T123000/);
  assert.match(ics, /RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR/);
  assert.match(ics, /BEGIN:VALARM/);
});

test('CSV export escapes commas, quotes and newlines', () => {
  const e = makeEntry({ slot: 'morning', completed: ['ankle-pumps'], toePain: 2, heat: 3, roomTemp: 19, notes: 'felt "ok", a bit\nwarm' }, at(9));
  const csv = toCSV([e]);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0].split(',')[0], 'date');
  assert.match(csv, /Ankle pumps/);
  assert.match(csv, /"felt ""ok"", a bit\nwarm"/);
});

test('streaks never punish missed days', () => {
  const today = at(12);
  const h = [
    makeEntry({ completed: ['ankle-pumps'] }, addDays(today, -1)),
    makeEntry({ completed: ['ankle-pumps'] }, addDays(today, -3)),
    makeEntry({ completed: ['ankle-pumps'] }, addDays(today, -10)),
    makeEntry({ completed: ['ankle-pumps'] }, addDays(today, -30)),
  ];
  const s = streakStats(h, today);
  assert.equal(s.totalActiveDays, 4);
  assert.equal(s.activeThisWeek, 2);
  assert.equal(s.weeksInARow, 2);
});

test('weekSeries averages symptoms per day and counts sessions', () => {
  const today = at(18);
  const h = [
    makeEntry({ slot: 'morning', completed: ['ankle-pumps'], toePain: 2, heat: 4 }, at(9)),
    makeEntry({ slot: 'afternoon', completed: ['ankle-pumps'], toePain: 4, heat: 2 }, at(14)),
    makeEntry({ kind: 'check-in', toePain: 3, heat: 3 }, at(16)),
  ];
  const w = weekSeries(h, today);
  assert.equal(w.length, 7);
  assert.equal(w[6].sessions, 2);
  assert.equal(w[6].toePain, 3);
  assert.equal(w[5].toePain, null);
  assert.deepEqual([...slotsDoneOn(h, today)].sort(), ['afternoon', 'morning']);
});
