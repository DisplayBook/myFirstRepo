import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dayKey, addDays, dayStart, fromLocalInput, toLocalInput, targetFor, setTarget, summarize,
  dailySeries, expectedByNow, entriesCSV, dailyCSV, parseBackup, fmtVol, defaultData,
} from '../../fluid-log/js/logic.js';

const at = (s) => fromLocalInput(s);
const E = (kind, type, ml, when, note) => ({ id: when + type, kind, type, ml, t: at(when), note });

test('day keys and local time round trip', () => {
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(dayKey(dayStart('2026-11-25')), '2026-11-25');
  assert.equal(toLocalInput(at('2026-11-25T07:05')), '2026-11-25T07:05');
  assert.ok(Number.isNaN(fromLocalInput('nope')));
});

test('targets apply from their day onwards', () => {
  let t = [{ from: '2000-01-01', ml: 2000 }];
  t = setTarget(t, '2026-11-20', 2500);
  assert.equal(targetFor(t, '2026-11-19'), 2000);
  assert.equal(targetFor(t, '2026-11-20'), 2500);
  t = setTarget(t, '2026-11-20', 1800); // same day replaces
  assert.equal(t.length, 2);
  assert.equal(targetFor(t, '2026-12-01'), 1800);
});

test('summarize totals intake, output and balance for one day only', () => {
  const entries = [
    E('in', 'Water', 500, '2026-11-25T08:00'),
    E('in', 'Coffee', 250, '2026-11-25T09:30'),
    E('out', 'Urine', 300, '2026-11-25T10:00'),
    E('in', 'Water', 400, '2026-11-24T23:59'), // previous day
    E('in', 'Tea', 300, '2026-11-26T00:00'),   // next day
  ];
  const s = summarize(entries, [{ from: '2000-01-01', ml: 2000 }], '2026-11-25');
  assert.equal(s.intake, 750);
  assert.equal(s.output, 300);
  assert.equal(s.balance, 450);
  assert.equal(s.remaining, 1250);
  assert.equal(s.met, false);
  assert.deepEqual(s.byType, { Water: 500, Coffee: 250 });
  assert.equal(s.entries.length, 3);
  const series = dailySeries(entries, [{ from: '2000-01-01', ml: 2000 }], '2026-11-24', '2026-11-26');
  assert.deepEqual(series.map((d) => d.intake), [400, 750, 300]);
});

test('pace spreads the target over waking hours', () => {
  const key = '2026-11-25';
  assert.equal(expectedByNow(2000, key, at('2026-11-25T06:00')), 0);
  assert.equal(expectedByNow(1500, key, at('2026-11-25T14:30'), '07:00', '22:00'), 750);
  assert.equal(expectedByNow(2000, key, at('2026-11-25T23:00')), 2000);
  assert.equal(expectedByNow(2000, key, at('2026-11-26T10:00')), null);
});

test('CSV exports quote awkward notes and list every entry', () => {
  const entries = [E('in', 'Water', 250, '2026-11-25T08:00', 'with "lemon", cold'), E('out', 'Urine', 200, '2026-11-25T09:00')];
  const csv = entriesCSV(entries).trim().split('\r\n');
  assert.equal(csv[0], 'date,time,direction,type,volume_ml,volume_oz,note,timestamp_iso');
  assert.match(csv[1], /^2026-11-25,08:00,intake,Water,250,8\.5,"with ""lemon"", cold",/);
  assert.match(csv[2], /^2026-11-25,09:00,output,Urine,200,/);
  const daily = dailyCSV(entries, [{ from: '2000-01-01', ml: 2000 }]).trim().split('\r\n');
  assert.equal(daily[1], '2026-11-25,250,200,50,2000,13,no,1,1');
});

test('backup round trip and validation', () => {
  const d = defaultData();
  d.entries.push(E('in', 'Tea', 300, '2026-11-25T08:00'), { kind: 'bad' });
  const back = parseBackup(JSON.stringify(d));
  assert.equal(back.entries.length, 1);
  assert.equal(back.entries[0].type, 'Tea');
  assert.throws(() => parseBackup('{"foo":1}'));
});

test('volume formatting', () => {
  assert.equal(fmtVol(1250, 'ml'), '1,250 ml');
  assert.equal(fmtVol(236.588, 'oz'), '8 oz');
});
