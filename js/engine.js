/**
 * Session engine: turns a list of exercises into a timeline of steps and
 * runs it with pause / resume / skip. It is completely DOM-free and takes an
 * injectable clock, so the timers and rep counter can be unit-tested.
 *
 * Step types:
 *   intro  – "get ready" screen before each exercise (short countdown)
 *   reps   – tempo-guided reps (auto-counted) or tap-to-count reps
 *   timed  – countdown, optionally with a rhythm cue or periodic prompt
 *   open   – stopwatch that counts up until the user taps Done
 *   rest   – rest between sets / sides
 */

import { cycleSeconds } from './exercises.js';

export const INTRO_SECONDS = 8;
export const SIDE_SWITCH_SECONDS = 6;

/**
 * Build the step list.
 * @param {Array<{ex: object, level: {reps,sets,duration}}>} items
 * @param {{manualReps?: boolean, introSeconds?: number}} opts
 */
export function buildSteps(items, opts = {}) {
  const introSeconds = opts.introSeconds ?? INTRO_SECONDS;
  const steps = [];
  items.forEach(({ ex, level }, exIndex) => {
    steps.push({ type: 'intro', exId: ex.id, exIndex, duration: introSeconds });
    const sides = ex.sides && ex.sides.length ? ex.sides : [null];
    const sets = Math.max(1, level.sets || 1);
    for (let set = 1; set <= sets; set++) {
      sides.forEach((side, sideIndex) => {
        const base = { exId: ex.id, exIndex, set, sets, side, sideIndex, sideCount: sides.length };
        if (ex.mode === 'reps') {
          const cycle = cycleSeconds(ex);
          steps.push({
            ...base,
            type: 'reps',
            work: true,
            reps: level.reps,
            tempo: ex.tempo,
            cycle,
            manual: !!opts.manualReps,
            duration: opts.manualReps ? null : level.reps * cycle,
          });
        } else if (ex.mode === 'timed') {
          steps.push({
            ...base,
            type: 'timed',
            work: true,
            duration: level.duration,
            tempo: ex.tempo || null,
            cycle: ex.tempo ? cycleSeconds(ex) : null,
            pumpEvery: ex.pumpEvery || null,
          });
        } else {
          steps.push({ ...base, type: 'open', work: true, duration: null, target: ex.target });
        }
        // Short pause to switch sides (not after the last side).
        if (sideIndex < sides.length - 1) {
          steps.push({
            type: 'rest', exId: ex.id, exIndex, duration: SIDE_SWITCH_SECONDS,
            reason: 'switch', nextSide: sides[sideIndex + 1],
          });
        }
      });
      if (set < sets && ex.rest > 0) {
        steps.push({ type: 'rest', exId: ex.id, exIndex, duration: ex.rest, reason: 'set', nextSet: set + 1 });
      }
    }
  });
  return steps;
}

/**
 * Where are we inside a tempo cycle at `t` seconds?
 * Returns the current rep (1-based), the phase index, the seconds left in that
 * phase, and whether all reps are finished.
 */
export function tempoPosition(tempo, reps, t) {
  const cycle = tempo.reduce((s, p) => s + p.s, 0);
  if (t >= reps * cycle) {
    return { rep: reps, repsDone: reps, phase: tempo.length - 1, phaseLeft: 0, done: true };
  }
  const repIdx = Math.floor(t / cycle);
  let inCycle = t - repIdx * cycle;
  let phase = 0;
  while (phase < tempo.length - 1 && inCycle >= tempo[phase].s) {
    inCycle -= tempo[phase].s;
    phase++;
  }
  return {
    rep: repIdx + 1,
    repsDone: repIdx,
    phase,
    phaseLeft: tempo[phase].s - inCycle,
    done: false,
  };
}

/**
 * Runs a step list. Call `tick()` frequently (e.g. 4–10× a second); it returns
 * a snapshot describing what to show. Listen with `on(event, fn)`:
 *   'step'   (snapshot)              – a new step began
 *   'phase'  (snapshot)              – a tempo phase changed (play the beat)
 *   'prompt' (snapshot)              – periodic prompt (e.g. ankle pumps)
 *   'done'   (summary)               – the whole session finished
 */
export class SessionRunner {
  constructor(steps, { now = () => Date.now() } = {}) {
    this.steps = steps;
    this.now = now;
    this.index = -1;
    this.elapsedBefore = 0; // ms accumulated in the current step before last resume
    this.resumedAt = null; // ms timestamp of last resume, null if paused
    this.manualCount = 0;
    this.listeners = {};
    this.lastPhaseKey = null;
    this.lastPromptN = 0;
    this.finished = false;
    /** per-step outcome: 'done' | 'skipped' */
    this.outcomes = new Array(steps.length).fill(null);
  }

  on(evt, fn) {
    (this.listeners[evt] ||= []).push(fn);
    return this;
  }

  emit(evt, payload) {
    (this.listeners[evt] || []).forEach((fn) => fn(payload));
  }

  get running() {
    return this.resumedAt !== null;
  }

  get current() {
    return this.steps[this.index];
  }

  /** Elapsed seconds in the current step (excludes paused time). */
  stepElapsed() {
    const live = this.resumedAt !== null ? this.now() - this.resumedAt : 0;
    return (this.elapsedBefore + live) / 1000;
  }

  start() {
    this.goTo(0);
    return this;
  }

  pause() {
    if (this.resumedAt === null || this.finished) return;
    this.elapsedBefore += this.now() - this.resumedAt;
    this.resumedAt = null;
  }

  resume() {
    if (this.resumedAt !== null || this.finished) return;
    this.resumedAt = this.now();
  }

  toggle() {
    this.running ? this.pause() : this.resume();
  }

  /** Add seconds to the current rest step ("+15 s" button). */
  extend(seconds) {
    const st = this.current;
    if (st && st.type === 'rest') st.duration += seconds;
  }

  /** Count one rep in tap-to-count mode. */
  tapRep() {
    const st = this.current;
    if (!st || st.type !== 'reps' || !st.manual) return;
    this.manualCount = Math.min(st.reps, this.manualCount + 1);
    this.emit('phase', this.snapshot());
    if (this.manualCount >= st.reps) this.advance('done');
  }

  /** Finish an open (stopwatch) step. */
  markDone() {
    const st = this.current;
    if (!st) return;
    this.advance('done');
  }

  /** Skip the current step. */
  skip() {
    if (!this.current) return;
    this.advance('skipped');
  }

  /** Skip the rest of the current exercise and jump to the next one. */
  skipExercise() {
    const st = this.current;
    if (!st) return;
    const exIndex = st.exIndex;
    let i = this.index;
    while (i < this.steps.length && this.steps[i].exIndex === exIndex) {
      if (this.outcomes[i] === null) this.outcomes[i] = 'skipped';
      i++;
    }
    this.goTo(i);
  }

  advance(outcome) {
    this.outcomes[this.index] = outcome;
    this.goTo(this.index + 1);
  }

  goTo(i) {
    const wasRunning = this.index === -1 ? true : this.running;
    this.index = i;
    this.elapsedBefore = 0;
    this.resumedAt = wasRunning ? this.now() : null;
    this.manualCount = 0;
    this.lastPhaseKey = null;
    this.lastPromptN = 0;
    if (i >= this.steps.length) {
      this.finished = true;
      this.resumedAt = null;
      this.emit('done', this.summary());
      return;
    }
    const snap = this.snapshot();
    this.emit('step', snap);
    this.emitPhaseIfChanged(snap);
  }

  /** Advance time: auto-complete steps and fire phase/prompt events. */
  tick() {
    if (this.finished) return this.snapshot();
    // Loop in case a long gap (e.g. tab throttled) crossed several steps.
    for (let guard = 0; guard < 500; guard++) {
      const st = this.current;
      if (!st || st.duration == null) break;
      const over = this.stepElapsed() - st.duration;
      if (over < 0) break;
      // Carry overflow into the next step so timing stays accurate.
      this.outcomes[this.index] = 'done';
      const carryMs = over * 1000;
      this.goTo(this.index + 1);
      if (this.finished) return this.snapshot();
      if (this.running) this.resumedAt -= carryMs;
      else this.elapsedBefore += carryMs;
    }
    const snap = this.snapshot();
    this.emitPhaseIfChanged(snap);
    if (snap.prompt && snap.promptN > this.lastPromptN) {
      this.lastPromptN = snap.promptN;
      this.emit('prompt', snap);
    }
    return snap;
  }

  emitPhaseIfChanged(snap) {
    if (snap.phaseKey && snap.phaseKey !== this.lastPhaseKey) {
      this.lastPhaseKey = snap.phaseKey;
      this.emit('phase', snap);
    }
  }

  /** Everything the UI needs to render the current moment. */
  snapshot() {
    const st = this.current;
    const base = {
      index: this.index,
      total: this.steps.length,
      running: this.running,
      finished: this.finished,
      step: st || null,
    };
    if (!st) return base;
    const t = this.stepElapsed();
    const remaining = st.duration != null ? Math.max(0, st.duration - t) : null;
    const snap = { ...base, elapsed: t, remaining };

    if (st.type === 'reps') {
      if (st.manual) {
        snap.rep = Math.min(st.reps, this.manualCount + 1);
        snap.repsDone = this.manualCount;
        snap.cue = 'Tap after each rep';
        snap.dir = 'hold';
        snap.phaseKey = `m${this.manualCount}`;
      } else {
        const pos = tempoPosition(st.tempo, st.reps, t);
        const ph = st.tempo[pos.phase];
        snap.rep = pos.rep;
        snap.repsDone = pos.repsDone;
        snap.cue = ph.cue;
        snap.dir = ph.dir;
        snap.phaseLeft = pos.phaseLeft;
        snap.phaseLen = ph.s;
        snap.phaseIndex = pos.phase;
        snap.phaseKey = `${pos.rep}:${pos.phase}`;
      }
    } else if (st.type === 'timed' && st.tempo) {
      const cycle = st.cycle;
      let inCycle = t % cycle;
      let phase = 0;
      while (phase < st.tempo.length - 1 && inCycle >= st.tempo[phase].s) {
        inCycle -= st.tempo[phase].s;
        phase++;
      }
      const ph = st.tempo[phase];
      snap.cue = ph.cue;
      snap.dir = ph.dir;
      snap.phaseLeft = ph.s - inCycle;
      snap.phaseLen = ph.s;
      snap.phaseKey = `${Math.floor(t / cycle)}:${phase}`;
    } else if (st.type === 'timed' && st.pumpEvery) {
      const n = Math.floor(t / st.pumpEvery);
      snap.promptN = n;
      snap.prompt = n > 0 ? 'Time for 10 slow ankle pumps' : null;
    }
    return snap;
  }

  /** Per-exercise result: 'done' (all work steps finished), 'partial', or 'skipped'. */
  summary() {
    const byEx = new Map();
    this.steps.forEach((st, i) => {
      if (!st.work) return;
      const rec = byEx.get(st.exIndex) || { exId: st.exId, done: 0, total: 0 };
      rec.total++;
      if (this.outcomes[i] === 'done') rec.done++;
      byEx.set(st.exIndex, rec);
    });
    return [...byEx.values()].map((r) => ({
      exId: r.exId,
      status: r.done === r.total ? 'done' : r.done > 0 ? 'partial' : 'skipped',
    }));
  }

  /** Total planned seconds (manual/open steps excluded). */
  static totalSeconds(steps) {
    return steps.reduce((s, st) => s + (st.duration || 0), 0);
  }
}
