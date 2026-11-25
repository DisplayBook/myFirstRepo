/**
 * Session/symptom history: recording, today's progress, streaks, weekly
 * chart data, CSV export and the printable summary. DOM-free.
 *
 * Entry shape:
 * { id, ts, date, time, slot, kind: 'session'|'check-in',
 *   completed: [exId], partial: [exId], skipped: [exId],
 *   stoppedEarly, stoppedForPain, reduced,
 *   toePain, heat, roomTemp, tempUnit, notes }
 */

import { addDays, dateKey, parseDateKey, uid, daysBetween } from './util.js';
import { getExercise } from './exercises.js';
import { SLOT_BY_ID } from './schedule.js';

export function makeEntry(fields, now = new Date()) {
  return {
    id: uid(),
    ts: now.toISOString(),
    date: dateKey(now),
    time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    slot: null,
    kind: 'session',
    completed: [],
    partial: [],
    skipped: [],
    stoppedEarly: false,
    stoppedForPain: false,
    reduced: false,
    toePain: null,
    heat: null,
    roomTemp: null,
    tempUnit: 'C',
    notes: '',
    ...fields,
  };
}

/** A session "counts" if at least one exercise was fully or partly done. */
export function isCompletedSession(e) {
  return e.kind === 'session' && (e.completed.length > 0 || e.partial.length > 0);
}

/** Slot ids already completed on a given day. */
export function slotsDoneOn(history, day = new Date()) {
  const key = dateKey(day);
  return new Set(history.filter((e) => e.date === key && isCompletedSession(e) && e.slot).map((e) => e.slot));
}

/** Set of dates (keys) with at least one completed session. */
export function activeDays(history) {
  return new Set(history.filter(isCompletedSession).map((e) => e.date));
}

/**
 * Kind streak stats that never punish a missed day:
 *  - totalActiveDays only ever goes up
 *  - activeThisWeek counts the last 7 days
 *  - weeksInARow: consecutive 7-day blocks (ending today) with any activity;
 *    the current block counts even if you haven't exercised yet today.
 */
export function streakStats(history, today = new Date()) {
  const days = activeDays(history);
  let activeThisWeek = 0;
  for (let i = 0; i < 7; i++) if (days.has(dateKey(addDays(today, -i)))) activeThisWeek++;
  let weeks = 0;
  for (let w = 0; w < 520; w++) {
    let any = false;
    for (let i = 0; i < 7; i++) if (days.has(dateKey(addDays(today, -(w * 7 + i))))) any = true;
    if (any) weeks++;
    else if (w > 0) break;
    else continue; // the current week can still be empty without breaking the run
  }
  return { totalActiveDays: days.size, activeThisWeek, weeksInARow: weeks };
}

/** Per-day data for the 7 days ending on `endDay`. Symptom values are daily means (null if none logged). */
export function weekSeries(history, endDay = new Date()) {
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDays(endDay, -i);
    const key = dateKey(d);
    const dayEntries = history.filter((e) => e.date === key);
    const mean = (field) => {
      const vals = dayEntries.map((e) => e[field]).filter((v) => v !== null && v !== '' && v !== undefined).map(Number);
      return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
    };
    out.push({
      date: key,
      label: d.toLocaleDateString(undefined, { weekday: 'short' }),
      sessions: dayEntries.filter(isCompletedSession).length,
      toePain: mean('toePain'),
      heat: mean('heat'),
    });
  }
  return out;
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = Array.isArray(v) ? v.join('; ') : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_COLUMNS = [
  'date', 'time', 'slot', 'kind', 'exercises_completed', 'exercises_partial', 'exercises_skipped',
  'stopped_early', 'stopped_for_pain', 'reduced_session', 'toe_pain_0_10', 'heat_redness_0_10',
  'room_temp', 'temp_unit', 'notes',
];

/** CSV text of the whole history (oldest first). */
export function toCSV(history) {
  const names = (ids) => ids.map((id) => getExercise(id)?.name || id);
  const rows = [...history]
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .map((e) => [
      e.date, e.time, e.slot ? SLOT_BY_ID[e.slot]?.label || e.slot : '', e.kind,
      names(e.completed), names(e.partial), names(e.skipped),
      e.stoppedEarly ? 'yes' : 'no', e.stoppedForPain ? 'yes' : 'no', e.reduced ? 'yes' : 'no',
      e.toePain, e.heat, e.roomTemp, e.roomTemp !== null && e.roomTemp !== '' ? e.tempUnit : '', e.notes,
    ].map(csvCell).join(','));
  return [CSV_COLUMNS.join(','), ...rows].join('\r\n') + '\r\n';
}

/** Summary numbers for the printable report over the last `days` days. */
export function reportSummary(history, days = 28, today = new Date()) {
  const from = dateKey(addDays(today, -(days - 1)));
  const entries = history.filter((e) => e.date >= from).sort((a, b) => a.ts.localeCompare(b.ts));
  const avg = (f) => {
    const v = entries.map((e) => e[f]).filter((x) => x !== null && x !== '' && x !== undefined).map(Number);
    return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
  };
  const max = (f) => {
    const v = entries.map((e) => e[f]).filter((x) => x !== null && x !== '' && x !== undefined).map(Number);
    return v.length ? Math.max(...v) : null;
  };
  const exCount = {};
  entries.forEach((e) => e.completed.forEach((id) => (exCount[id] = (exCount[id] || 0) + 1)));
  return {
    from,
    to: dateKey(today),
    days,
    sessions: entries.filter(isCompletedSession).length,
    activeDays: new Set(entries.filter(isCompletedSession).map((e) => e.date)).size,
    stoppedForPain: entries.filter((e) => e.stoppedForPain).length,
    avgToePain: avg('toePain'),
    maxToePain: max('toePain'),
    avgHeat: avg('heat'),
    maxHeat: max('heat'),
    exerciseCounts: Object.entries(exCount).sort((a, b) => b[1] - a[1]),
    entries,
  };
}

export { daysBetween, parseDateKey };
