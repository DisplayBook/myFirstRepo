import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../../js/store.js';
import {
  scheduleFromTemplate, slotExercises, effectiveLevel, nextLevel, proposeProgression, applyProgression,
  holdProgression, reviewDue, levelFor, easeBack,
} from '../../js/schedule.js';
import { getExercise, defaultLevel } from '../../js/exercises.js';
import { assessEntry, painInLastWeek } from '../../js/safety.js';
import { makeEntry } from '../../js/history.js';
import { dateKey, addDays } from '../../js/util.js';

function fresh() {
  store._setForTest({});
  const s = store.get();
  s.schedule = scheduleFromTemplate('gentle');
  return s;
}

test('locked standing calf raises only appear after unlocking', () => {
  const s = fresh();
  s.schedule = scheduleFromTemplate('building');
  assert.ok(!slotExercises(s, 'afternoon').some((e) => e.id === 'standing-calf-raise'));
  s.settings.unlockProgression = true;
  assert.ok(slotExercises(s, 'afternoon').some((e) => e.id === 'standing-calf-raise'));
});

test('progression: +2 reps, then +1 set at the rep cap', () => {
  const ex = getExercise('seated-calf-raise');
  assert.deepEqual(nextLevel(ex, { reps: 15, sets: 2 }), { reps: 17, sets: 2 });
  assert.deepEqual(nextLevel(ex, { reps: 25, sets: 2 }), { reps: 25, sets: 3 });
  assert.equal(nextLevel(ex, { reps: 25, sets: 3 }), null);
  const pad = getExercise('walking-pad');
  assert.equal(nextLevel(pad, defaultLevel(pad)).duration, 360);
});

test('weekly review is due after 7 days and accept applies changes', () => {
  const s = fresh();
  s.plan.lastReview = dateKey(addDays(new Date(), -7));
  assert.equal(reviewDue(s), true);
  const p = proposeProgression(s);
  assert.ok(p.changes.length > 0);
  applyProgression(s, p);
  assert.equal(levelFor(s, 'seated-calf-raise').reps, 17);
  assert.equal(reviewDue(s), false);
});

test('never increases when pain was reported in the last week', () => {
  const s = fresh();
  s.history.push(makeEntry({ toePain: 6, heat: 2 }, addDays(new Date(), -2)));
  const blocked = painInLastWeek(s.history);
  assert.equal(blocked, true);
  const p = proposeProgression(s, { painBlocked: blocked });
  applyProgression(s, p);
  assert.equal(levelFor(s, 'seated-calf-raise').reps, 15, 'level unchanged');
  holdProgression(s, 'pain');
  assert.equal(s.plan.holdReason, 'pain');
});

test('old pain (8+ days ago) does not block', () => {
  const s = fresh();
  s.history.push(makeEntry({ toePain: 8, heat: 2 }, addDays(new Date(), -8)));
  assert.equal(painInLastWeek(s.history), false);
});

test('safety thresholds: toe pain >= 5 or heat >= 7', () => {
  assert.equal(assessEntry({ toePain: 4, heat: 6 }).flagged, false);
  assert.equal(assessEntry({ toePain: 5, heat: 0 }).flagged, true);
  assert.equal(assessEntry({ toePain: 0, heat: 7 }).flagged, true);
  assert.equal(assessEntry({ toePain: null, heat: null, stoppedForPain: true }).flagged, true);
});

test('reduced next session lowers reps/sets but keeps elevation', () => {
  const s = fresh();
  s.reduceNext = true;
  assert.deepEqual(effectiveLevel(s, 'seated-calf-raise'), { reps: 9, sets: 1, duration: null });
  assert.equal(effectiveLevel(s, 'elevation').duration, 900);
  assert.equal(effectiveLevel(s, 'walking-pad').duration, 180);
});

test('ease back steps down but not below a gentle floor', () => {
  const s = fresh();
  s.levels['seated-calf-raise'] = { reps: 17, sets: 3, duration: null };
  easeBack(s);
  assert.deepEqual(levelFor(s, 'seated-calf-raise'), { reps: 17, sets: 2, duration: null });
  easeBack(s);
  assert.equal(levelFor(s, 'seated-calf-raise').reps, 15);
  for (let i = 0; i < 20; i++) easeBack(s);
  assert.ok(levelFor(s, 'seated-calf-raise').reps >= 5);
});
