import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSteps, SessionRunner, tempoPosition, INTRO_SECONDS } from '../../js/engine.js';
import { getExercise, defaultLevel } from '../../js/exercises.js';

const item = (id, level) => ({ ex: getExercise(id), level: level || defaultLevel(getExercise(id)) });

/** A fake clock we can move forward by hand. */
function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (s) => (t += s * 1000) };
}

test('tempoPosition follows 1 s up, 1 s hold, 3 s down', () => {
  const tempo = getExercise('seated-calf-raise').tempo;
  assert.deepEqual(tempoPosition(tempo, 15, 0).phase, 0);
  assert.equal(tempoPosition(tempo, 15, 0.5).phaseLeft, 0.5);
  assert.equal(tempoPosition(tempo, 15, 1.2).phase, 1);
  assert.equal(tempoPosition(tempo, 15, 2.1).phase, 2);
  const p = tempoPosition(tempo, 15, 5.1);
  assert.equal(p.rep, 2);
  assert.equal(p.repsDone, 1);
  assert.equal(p.phase, 0);
  assert.equal(tempoPosition(tempo, 15, 75).done, true);
});

test('buildSteps: sets, rests and sides', () => {
  const steps = buildSteps([item('seated-calf-raise'), item('knee-extension')]);
  const types = steps.map((s) => s.type);
  // calf raise: intro, set1, rest, set2 ; knee ext: intro, left, switch, right
  assert.deepEqual(types, ['intro', 'reps', 'rest', 'reps', 'intro', 'reps', 'rest', 'reps']);
  assert.equal(steps[1].duration, 15 * 5);
  assert.equal(steps[2].duration, 45);
  assert.equal(steps[5].side, 'Left leg');
  assert.equal(steps[6].reason, 'switch');
  assert.equal(steps[7].side, 'Right leg');
});

test('runner counts reps and fires a phase event per tempo phase', () => {
  const c = clock();
  const steps = buildSteps([item('seated-calf-raise', { reps: 3, sets: 1 })]);
  const r = new SessionRunner(steps, { now: c.now });
  const phases = [];
  r.on('phase', (s) => phases.push(`${s.rep}:${s.cue}`));
  r.start();
  c.advance(INTRO_SECONDS);
  let snap = r.tick();
  assert.equal(snap.step.type, 'reps');
  assert.equal(snap.rep, 1);
  assert.equal(snap.cue, 'Lift heels');
  for (let i = 0; i < 30; i++) { c.advance(0.5); snap = r.tick(); if (snap.finished) break; }
  assert.equal(snap.finished, true);
  assert.deepEqual(phases, [
    '1:Lift heels', '1:Pause', '1:Lower slowly',
    '2:Lift heels', '2:Pause', '2:Lower slowly',
    '3:Lift heels', '3:Pause', '3:Lower slowly',
  ]);
  assert.deepEqual(r.summary(), [{ exId: 'seated-calf-raise', status: 'done' }]);
});

test('pause freezes the countdown; resume continues', () => {
  const c = clock();
  const r = new SessionRunner(buildSteps([item('walking-pad')]), { now: c.now }).start();
  r.skip(); // past intro
  c.advance(10);
  assert.equal(Math.round(r.tick().remaining), 290);
  r.pause();
  c.advance(120);
  assert.equal(Math.round(r.tick().remaining), 290);
  assert.equal(r.running, false);
  r.resume();
  c.advance(5);
  assert.equal(Math.round(r.tick().remaining), 285);
});

test('rest timer runs between sets and can be extended / skipped', () => {
  const c = clock();
  const r = new SessionRunner(buildSteps([item('seated-calf-raise', { reps: 2, sets: 2 })]), { now: c.now }).start();
  c.advance(INTRO_SECONDS + 10); // intro + 2 reps of 5 s
  let snap = r.tick();
  assert.equal(snap.step.type, 'rest');
  assert.equal(Math.round(snap.remaining), 45);
  r.extend(15);
  assert.equal(Math.round(r.tick().remaining), 60);
  r.skip();
  snap = r.tick();
  assert.equal(snap.step.type, 'reps');
  assert.equal(snap.step.set, 2);
});

test('overflow time carries over so a long gap does not lose time', () => {
  const c = clock();
  const r = new SessionRunner(buildSteps([item('ankle-pumps', { reps: 2, sets: 1 })]), { now: c.now }).start();
  c.advance(INTRO_SECONDS + 4); // 1 s into... intro(8) + 3 s rep1 + 1 s of rep2
  const s = r.tick();
  assert.equal(s.step.type, 'reps');
  assert.equal(s.rep, 2);
  assert.ok(Math.abs(s.elapsed - 4) < 1e-9);
});

test('tap-to-count mode advances only on taps', () => {
  const c = clock();
  const r = new SessionRunner(buildSteps([item('toe-wiggle', { reps: 3, sets: 1 })], { manualReps: true }), { now: c.now }).start();
  r.skip();
  c.advance(100);
  assert.equal(r.tick().rep, 1);
  r.tapRep(); r.tapRep();
  assert.equal(r.tick().repsDone, 2);
  r.tapRep();
  assert.equal(r.finished, true);
});

test('elevation break prompts ankle pumps every 2 minutes', () => {
  const c = clock();
  const r = new SessionRunner(buildSteps([item('elevation')]), { now: c.now }).start();
  const prompts = [];
  r.on('prompt', (s) => prompts.push(s.promptN));
  r.skip();
  for (let i = 0; i < 15 * 60; i += 5) { c.advance(5); r.tick(); }
  assert.deepEqual(prompts, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(r.finished, true);
});

test('skipping marks exercises skipped / partial in the summary', () => {
  const c = clock();
  const r = new SessionRunner(buildSteps([item('knee-extension', { reps: 2, sets: 1 }), item('ankle-pumps')]), { now: c.now }).start();
  r.skip(); // intro
  c.advance(14); r.tick(); // left leg done (2 reps x 7 s)
  r.skip(); // switch rest
  r.skip(); // right leg skipped
  r.skipExercise(); // skip all of ankle pumps (from intro)
  assert.equal(r.finished, true);
  assert.deepEqual(r.summary(), [
    { exId: 'knee-extension', status: 'partial' },
    { exId: 'ankle-pumps', status: 'skipped' },
  ]);
});

test('open (stopwatch) step waits for Done', () => {
  const c = clock();
  const r = new SessionRunner(buildSteps([item('stairs')]), { now: c.now }).start();
  r.skip();
  c.advance(600);
  const s = r.tick();
  assert.equal(s.step.type, 'open');
  assert.equal(Math.round(s.elapsed), 600);
  r.markDone();
  assert.equal(r.finished, true);
});
