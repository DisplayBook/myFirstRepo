/**
 * Daily schedule (slots + templates), exercise levels and the weekly
 * progression plan. DOM-free.
 */

import { EXERCISES, getExercise, defaultLevel } from './exercises.js';
import { dateKey, daysBetween, parseDateKey } from './util.js';

export const SLOTS = [
  { id: 'morning', label: 'Morning', time: '08:30' },
  { id: 'midmorning', label: 'Mid-morning', time: '10:30' },
  { id: 'afternoon', label: 'Afternoon', time: '14:00' },
  { id: 'evening', label: 'Evening', time: '18:00' },
  { id: 'bedtime', label: 'Bedtime', time: '21:00' },
];

export const SLOT_BY_ID = Object.fromEntries(SLOTS.map((s) => [s.id, s]));

/** Ready-made schedules. Each is short (about 4 to 8 minutes) and gentle. */
export const TEMPLATES = {
  gentle: {
    name: 'Gentle start',
    description: 'Week 1 to 2. Short seated sessions spread through the day, plus an evening elevation break.',
    slots: {
      morning: ['ankle-pumps', 'ankle-circles', 'seated-calf-raise', 'toe-wiggle'],
      midmorning: ['seated-march', 'heel-toe-rock', 'ankle-pumps'],
      afternoon: ['seated-calf-raise', 'knee-extension', 'ankle-pumps'],
      evening: ['wall-calf-stretch', 'heel-toe-rock', 'ankle-circles'],
      bedtime: ['elevation'],
    },
  },
  flare: {
    name: 'Flare day (very gentle)',
    description: 'For days when the feet are hot, swollen or sore: ankle pumps, circles and elevation only.',
    slots: {
      morning: ['ankle-pumps', 'ankle-circles'],
      midmorning: ['elevation'],
      afternoon: ['ankle-pumps', 'ankle-circles'],
      evening: ['elevation'],
      bedtime: ['ankle-pumps'],
    },
  },
  building: {
    name: 'Building',
    description: 'From week 3 or so. Adds a slow walking pad session. Standing calf raises appear once unlocked.',
    slots: {
      morning: ['ankle-pumps', 'ankle-circles', 'seated-calf-raise', 'toe-wiggle'],
      midmorning: ['walking-pad', 'wall-calf-stretch'],
      afternoon: ['seated-calf-raise', 'knee-extension', 'seated-march', 'standing-calf-raise'],
      evening: ['wall-calf-stretch', 'heel-toe-rock', 'ankle-pumps'],
      bedtime: ['elevation'],
    },
  },
};

/** Create a schedule object from a template id. */
export function scheduleFromTemplate(templateId) {
  const tpl = TEMPLATES[templateId] || TEMPLATES.gentle;
  const slots = {};
  for (const s of SLOTS) {
    slots[s.id] = { time: s.time, enabled: true, exercises: [...(tpl.slots[s.id] || [])] };
  }
  return { template: templateId, slots };
}

/** Is an exercise currently available (locked exercises need progression unlocked)? */
export function isAvailable(ex, settings) {
  return !ex.locked || !!settings.unlockProgression;
}

/** The exercises in a slot that are available right now. */
export function slotExercises(state, slotId) {
  const slot = state.schedule?.slots?.[slotId];
  if (!slot) return [];
  return slot.exercises
    .map(getExercise)
    .filter((ex) => ex && isAvailable(ex, state.settings));
}

/** The stored level for an exercise (or its default). */
export function levelFor(state, exId) {
  const ex = getExercise(exId);
  return { ...defaultLevel(ex), ...(state.levels[exId] || {}) };
}

/**
 * The level to actually use in a session. If the safety rule has asked for a
 * lighter next session, reps and durations are reduced by ~40% and sets to 1.
 * The elevation break is never shortened (it helps).
 */
export function effectiveLevel(state, exId) {
  const lv = levelFor(state, exId);
  if (!state.reduceNext || exId === 'elevation') return lv;
  return {
    reps: lv.reps ? Math.max(5, Math.round(lv.reps * 0.6)) : lv.reps,
    sets: 1,
    duration: lv.duration ? Math.max(15, Math.round((lv.duration * 0.6) / 5) * 5) : lv.duration,
  };
}

/** One step up for an exercise, following "add 2 reps or one extra set". */
export function nextLevel(ex, lv) {
  const p = ex.progression;
  if (!p) return null;
  if (ex.mode === 'reps') {
    if (lv.reps + p.reps <= p.maxReps) return { ...lv, reps: lv.reps + p.reps };
    if (lv.sets < p.maxSets) return { ...lv, sets: lv.sets + 1 };
    return null;
  }
  if (ex.mode === 'timed') {
    if (lv.duration + p.seconds <= p.maxDuration) return { ...lv, duration: lv.duration + p.seconds };
    if (lv.sets < (p.maxSets || 1)) return { ...lv, sets: lv.sets + 1 };
    return null;
  }
  return null;
}

/** One step down (used for "ease back"). */
export function prevLevel(ex, lv) {
  const d = defaultLevel(ex);
  const p = ex.progression;
  if (!p) return null;
  if (lv.sets > d.sets) return { ...lv, sets: lv.sets - 1 };
  if (ex.mode === 'reps' && lv.reps - p.reps >= Math.min(d.reps, 6)) return { ...lv, reps: lv.reps - p.reps };
  if (ex.mode === 'timed' && lv.duration - p.seconds >= Math.min(d.duration, 15)) {
    return { ...lv, duration: lv.duration - p.seconds };
  }
  return null;
}

/** Exercise ids that appear anywhere in the active schedule. */
export function scheduledExerciseIds(state) {
  const ids = new Set();
  for (const s of SLOTS) {
    for (const ex of slotExercises(state, s.id)) ids.add(ex.id);
  }
  return [...ids];
}

/** Current programme week (1-based). */
export function currentWeek(state, today = new Date()) {
  return Math.floor(daysBetween(parseDateKey(state.plan.startDate), today) / 7) + 1;
}

/** Is a weekly review due (7+ days since the last one)? */
export function reviewDue(state, today = new Date()) {
  return daysBetween(parseDateKey(state.plan.lastReview), today) >= 7;
}

/**
 * Build this week's progression proposal.
 * `blocked` is set when recent symptoms mean we must hold (never auto-increase).
 */
export function proposeProgression(state, { painBlocked = false } = {}) {
  const changes = [];
  for (const id of scheduledExerciseIds(state)) {
    const ex = getExercise(id);
    const cur = levelFor(state, id);
    const next = nextLevel(ex, cur);
    if (next) changes.push({ id, from: cur, to: next });
  }
  return { changes, blocked: painBlocked };
}

/** Apply an accepted proposal. */
export function applyProgression(state, proposal, today = new Date()) {
  if (proposal.blocked) return state;
  for (const c of proposal.changes) state.levels[c.id] = { ...c.to };
  state.plan.lastReview = dateKey(today);
  state.plan.holdReason = null;
  return state;
}

/** Hold at the current level for another week. */
export function holdProgression(state, reason, today = new Date()) {
  state.plan.lastReview = dateKey(today);
  state.plan.holdReason = reason || 'You chose to hold.';
  return state;
}

/** Ease back one step on every scheduled exercise. */
export function easeBack(state, today = new Date()) {
  for (const id of scheduledExerciseIds(state)) {
    const ex = getExercise(id);
    const p = prevLevel(ex, levelFor(state, id));
    if (p) state.levels[id] = p;
  }
  state.plan.lastReview = dateKey(today);
  return state;
}

export { EXERCISES };
