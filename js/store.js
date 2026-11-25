/**
 * Persistent state, kept entirely in localStorage on this device.
 * Nothing is ever sent anywhere.
 *
 * Shape (version 1):
 * {
 *   version, createdAt,
 *   acceptedDisclaimer: bool,
 *   settings: { tempUnit, sound, vibration, largeText, theme, reduceMotion,
 *               repPacing, unlockProgression, reminders: {...} },
 *   schedule: { template, slots: { [slotId]: { time, exercises: [id] } } },
 *   levels:   { [exerciseId]: { reps, sets, duration } },
 *   plan:     { startDate, lastReview, week, holdReason },
 *   reduceNext: bool,           // safety: next session is lighter
 *   history:  [ entry ],        // sessions + symptom logs
 *   reminderState: { lastFired, snoozeUntil }
 * }
 */

import { dateKey } from './util.js';

const KEY = 'calfcare.v1';
const listeners = new Set();

export function defaultSettings() {
  return {
    tempUnit: 'C',
    sound: true,
    vibration: true,
    largeText: false,
    theme: 'system', // 'system' | 'light' | 'dark'
    reduceMotion: 'system', // 'system' | 'on'
    repPacing: 'guided', // 'guided' | 'tap'
    unlockProgression: false,
    reminders: {
      enabled: false,
      mode: 'interval', // 'interval' | 'slots'
      start: '08:00',
      end: '20:00',
      every: 60, // minutes
      days: [0, 1, 2, 3, 4, 5, 6],
    },
  };
}

export function defaultState() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    acceptedDisclaimer: false,
    settings: defaultSettings(),
    schedule: null, // filled from a template on first run (see schedule.js)
    levels: {},
    plan: { startDate: dateKey(), lastReview: dateKey(), week: 1, holdReason: null },
    reduceNext: false,
    history: [],
    reminderState: { lastFired: null, snoozeUntil: null },
  };
}

/** Recursively fill missing keys from defaults (non-destructive migration). */
function fillDefaults(target, defaults) {
  for (const [k, v] of Object.entries(defaults)) {
    if (target[k] === undefined) target[k] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') {
      fillDefaults(target[k], v);
    }
  }
  return target;
}

let state = null;

function storage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export function load() {
  const ls = storage();
  let parsed = null;
  if (ls) {
    try {
      parsed = JSON.parse(ls.getItem(KEY) || 'null');
    } catch {
      parsed = null;
    }
  }
  state = fillDefaults(parsed && typeof parsed === 'object' ? parsed : {}, defaultState());
  return state;
}

export function get() {
  return state || load();
}

export function save() {
  const ls = storage();
  if (ls) {
    try {
      ls.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('Could not save to localStorage', e);
    }
  }
  listeners.forEach((fn) => fn(state));
}

/** Mutate state with a function, then persist. */
export function update(fn) {
  fn(get());
  save();
  return state;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Wipe everything (Settings, Reset). */
export function reset() {
  const ls = storage();
  if (ls) ls.removeItem(KEY);
  state = null;
  load();
  save();
}

/** Replace state from an imported backup (validated lightly). */
export function importBackup(obj) {
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.history)) {
    throw new Error('This file does not look like a Calf Care backup.');
  }
  state = fillDefaults(obj, defaultState());
  save();
}

/** Test hook: start from a given object without touching storage. */
export function _setForTest(obj) {
  state = fillDefaults(obj || {}, defaultState());
}
