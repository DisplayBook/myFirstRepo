/**
 * Calf Care: app shell, router and screens.
 *
 * Screens are rendered as HTML strings into <main> on every route change.
 * The guided session screen is rendered once and then updated in place on
 * every timer tick. All data lives in localStorage (see store.js).
 */

import * as store from './store.js';
import { EXERCISES, getExercise, describeDose, defaultLevel } from './exercises.js';
import { illustration } from './illustrations.js';
import { buildSteps, SessionRunner } from './engine.js';
import {
  SLOTS, SLOT_BY_ID, TEMPLATES, scheduleFromTemplate, slotExercises, levelFor, effectiveLevel,
  isAvailable, currentWeek, reviewDue, proposeProgression, applyProgression, holdProgression, easeBack,
} from './schedule.js';
import { assessEntry, painInLastWeek, MEDICAL_HELP, TOE_PAIN_LIMIT, HEAT_LIMIT } from './safety.js';
import {
  makeEntry, slotsDoneOn, streakStats, weekSeries, toCSV, reportSummary, isCompletedSession,
} from './history.js';
import { weeklyChart, wireChart } from './chart.js';
import {
  reminderTimes, checkDue, nextReminder, buildICS, notificationSupport, requestPermission,
  showReminderNotification, syncToServiceWorker, SNOOZE_MINUTES,
} from './reminders.js';
import { unlockAudio, phaseBeat, beat, chime, vibrate, keepAwake, allowSleep, wakeLockSupported } from './feedback.js';
import { esc, dateKey, addDays, fmtClock, fmtDuration, hmToMinutes, cToF, fToC } from './util.js';

/* ------------------------------------------------------------------ */
/* Icons (inline SVG, stroke = currentColor)                           */
/* ------------------------------------------------------------------ */
const I = (d) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  today: I('<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>'),
  list: I('<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>'),
  calendar: I('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'),
  chart: I('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  settings: I('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  check: I('<path d="M5 12l5 5 9-10"/>'),
  play: I('<path d="M7 4l13 8-13 8z"/>'),
  pause: I('<path d="M8 4v16M16 4v16"/>'),
  skip: I('<path d="M5 4l10 8-10 8zM19 5v14"/>'),
  plus: I('<path d="M12 5v14M5 12h14"/>'),
  minus: I('<path d="M5 12h14"/>'),
  up: I('<path d="M12 19V5M5 12l7-7 7 7"/>'),
  down: I('<path d="M12 5v14M5 12l7 7 7-7"/>'),
  x: I('<path d="M6 6l12 12M18 6L6 18"/>'),
  heart: I('<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z"/>'),
  alert: I('<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>'),
  lock: I('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  bell: I('<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/>'),
  back: I('<path d="M15 18l-6-6 6-6"/>'),
};

/* ------------------------------------------------------------------ */
/* State & boot                                                        */
/* ------------------------------------------------------------------ */
const main = () => document.getElementById('main');
let state = store.load();
if (!state.schedule) {
  state.schedule = scheduleFromTemplate('gentle');
  store.save();
}

/** The in-progress guided session (null when idle). */
let active = null;
/** The just-finished session waiting to be logged. */
let pendingLog = null;
/** Week offset for the Log chart (0 = this week). */
let chartWeekOffset = 0;
let reportDays = 28;

function applyDisplaySettings() {
  const s = state.settings;
  const root = document.documentElement;
  if (s.theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', s.theme);
  root.setAttribute('data-large-text', String(!!s.largeText));
  root.setAttribute('data-reduce-motion', String(s.reduceMotion === 'on'));
  const dark =
    s.theme === 'dark' || (s.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0e1513' : '#f3f6f5');
}

function save(mutator) {
  if (mutator) mutator(state);
  store.save();
  pushReminderConfig();
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */
const ROUTES = {
  today: renderToday,
  exercises: renderExercises,
  exercise: renderExercise,
  schedule: renderSchedule,
  log: renderLog,
  report: renderReport,
  settings: renderSettings,
  safety: renderSafety,
  session: () => {
    // The session view is driven by the runner; only build it if missing.
    if (!document.getElementById('s-body')) renderSessionStep(active.runner.snapshot());
  },
  after: renderAfter,
  checkin: renderCheckin,
  start: () => startNext(),
};

function parseRoute() {
  const [name, ...rest] = (location.hash.replace(/^#\/?/, '') || 'today').split('/');
  return { name: ROUTES[name] ? name : 'today', param: rest.join('/') };
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function render() {
  const { name, param } = parseRoute();
  if (name === 'session' && !active) return go('#/today');
  if (name === 'after' && !pendingLog) return go('#/today');
  document.body.classList.toggle('in-session', name === 'session');
  const tab = { exercise: 'exercises', report: 'log', checkin: 'log', after: 'today', safety: 'today' }[name] || name;
  document.querySelectorAll('.tabbar a').forEach((a) => {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const out = ROUTES[name](param);
  if (typeof out === 'string') {
    main().innerHTML = out;
    afterRender[name]?.(param);
  }
  // Move focus to the page heading for screen-reader and keyboard users.
  const h1 = main().querySelector('h1');
  if (h1) {
    h1.setAttribute('tabindex', '-1');
    h1.focus({ preventScroll: true });
  }
  if (name !== 'session') window.scrollTo(0, 0);
}

const afterRender = {};

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */
function estimateSeconds(exIds) {
  const items = exIds.map((id) => ({ ex: getExercise(id), level: effectiveLevel(state, id) }));
  const steps = buildSteps(items);
  return SessionRunner.totalSeconds(steps) + items.filter(({ ex }) => ex.mode === 'open').length * 180;
}

function minutesLabel(sec) {
  return `about ${Math.max(1, Math.round(sec / 60))} min`;
}

function reducedNotice() {
  if (!state.reduceNext) return '';
  return `<div class="notice notice-warn" role="status">
    <strong>Lighter session next.</strong> You recently reported pain or heat, so your next session uses fewer reps, one set and shorter holds.
    The elevation break stays the same.
  </div>`;
}

function medicalHelpCard(compact = false) {
  return `<section class="notice notice-danger" aria-labelledby="medhelp-h">
    <h2 id="medhelp-h">When to get medical help</h2>
    <p><strong>Call emergency services (999 / 112 / 911) or go to A&amp;E/ER now if you have:</strong></p>
    <ul>${MEDICAL_HELP.urgent.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    ${compact ? '<a class="btn btn-quiet btn-block" href="#/safety">See all warning signs</a>' : `
    <p><strong>Contact your doctor, podiatrist or urgent care the same day if you notice:</strong></p>
    <ul>${MEDICAL_HELP.soon.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`}
  </section>`;
}

const DISCLAIMER = `This app is a personal exercise helper. It is <strong>not medical advice</strong> and does not diagnose or treat anything.
  Always follow guidance from your doctors and physiotherapist, and check with them before starting or changing exercises.`;

function nextSlot(day = new Date()) {
  const done = slotsDoneOn(state.history, day);
  const candidates = SLOTS.filter((s) => {
    const slot = state.schedule.slots[s.id];
    return slot?.enabled !== false && slotExercises(state, s.id).length && !done.has(s.id);
  });
  if (!candidates.length) return null;
  const nowMin = day.getHours() * 60 + day.getMinutes();
  // Prefer the latest slot whose time has arrived (or is within the hour), else the first remaining.
  const due = candidates.filter((s) => hmToMinutes(state.schedule.slots[s.id].time) <= nowMin + 60);
  return due.length ? due[due.length - 1] : candidates[0];
}

function weeklyReviewCard() {
  if (!reviewDue(state)) return '';
  return progressionCard(true);
}

function progressionCard(due) {
  const blocked = painInLastWeek(state.history);
  const proposal = proposeProgression(state, { painBlocked: blocked });
  const changes = proposal.changes
    .map((c) => {
      const ex = getExercise(c.id);
      return `<li><strong>${esc(ex.name)}</strong>: ${esc(describeDose(ex, c.from))} → ${esc(describeDose(ex, c.to))}</li>`;
    })
    .join('');
  return `<section class="card" aria-labelledby="prog-h">
    <h2 id="prog-h">${due ? 'Weekly check-in: ' : ''}Week ${currentWeek(state)} progression</h2>
    ${blocked ? `<div class="notice notice-warn" role="status"><strong>Holding at your current level.</strong>
      You reported little-toe pain of ${TOE_PAIN_LIMIT}+ or heat/redness of ${HEAT_LIMIT}+ in the last 7 days, so the app will not increase anything this week.</div>`
      : changes ? `<p>If last week felt comfortable, here is a small step up. Nothing changes unless you accept.</p><ul>${changes}</ul>`
      : '<p>You are at the top level for everything in your schedule. Well done. Holding here is great.</p>'}
    ${state.plan.holdReason && !due ? `<p class="muted small">Last choice: ${esc(state.plan.holdReason)}</p>` : ''}
    <div class="btn-row">
      ${!blocked && changes ? '<button class="btn btn-primary" data-action="prog-accept">Accept step up</button>' : ''}
      <button class="btn" data-action="prog-hold">Hold at current level</button>
      <button class="btn btn-quiet" data-action="prog-ease">Ease back a step</button>
    </div>
  </section>`;
}

/* ------------------------------------------------------------------ */
/* Today                                                               */
/* ------------------------------------------------------------------ */
function renderToday() {
  const now = new Date();
  const done = slotsDoneOn(state.history, now);
  const plannedSlots = SLOTS.filter(
    (s) => state.schedule.slots[s.id]?.enabled !== false && slotExercises(state, s.id).length,
  );
  const doneCount = plannedSlots.filter((s) => done.has(s.id)).length;
  const pct = plannedSlots.length ? Math.round((doneCount / plannedSlots.length) * 100) : 0;
  const next = nextSlot(now);
  const stats = streakStats(state.history, now);

  const rows = plannedSlots
    .map((s) => {
      const exs = slotExercises(state, s.id);
      const isDone = done.has(s.id);
      return `<li>
        <span class="check ${isDone ? 'done' : ''}" aria-hidden="true">${isDone ? ICON.check : ''}</span>
        <div>
          <div class="slot-name">${esc(s.label)} <span class="muted small">${esc(state.schedule.slots[s.id].time)}</span>
            <span class="sr-only">${isDone ? '(done)' : '(not done yet)'}</span></div>
          <div class="slot-sub">${exs.map((e) => esc(e.name)).join(', ')} · ${minutesLabel(estimateSeconds(exs.map((e) => e.id)))}</div>
        </div>
        <button class="icon-btn" data-action="start-slot" data-slot="${s.id}" aria-label="${isDone ? 'Do again' : 'Start'}: ${esc(s.label)} session">${isDone ? 'Again' : ICON.play}</button>
      </li>`;
    })
    .join('');

  return `<div class="stack">
    <div>
      <h1>Today</h1>
      <p class="muted">${now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} · Week ${currentWeek(state)}</p>
    </div>
    ${reducedNotice()}
    ${weeklyReviewCard()}
    <section class="card" aria-labelledby="progress-h">
      <h2 id="progress-h">${doneCount} of ${plannedSlots.length} sessions done</h2>
      <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${plannedSlots.length}" aria-valuenow="${doneCount}" aria-label="Today's sessions"><span style="width:${pct}%"></span></div>
      <div style="margin-top:16px">
        ${next
          ? `<button class="btn btn-primary btn-big" data-action="start-slot" data-slot="${next.id}">${ICON.play} Start ${esc(next.label.toLowerCase())} session</button>
             <p class="muted small" style="margin-top:6px;text-align:center">${minutesLabel(estimateSeconds(slotExercises(state, next.id).map((e) => e.id)))} · in a cool room, sitting comfortably</p>`
          : `<p><strong>All of today's sessions are done.</strong> Rest your feet up, or do an extra elevation break if they feel warm.</p>`}
      </div>
    </section>
    <section class="card" aria-labelledby="plan-h">
      <h2 id="plan-h">Today's plan</h2>
      <ul class="checklist">${rows || '<li>No sessions planned. Set some up in Schedule.</li>'}</ul>
    </section>
    <div class="btn-row">
      <button class="btn" data-action="start-elevation">Elevation break now</button>
      <a class="btn btn-quiet" href="#/checkin">Log how my feet feel</a>
    </div>
    <section class="card" aria-label="Your consistency">
      <div class="stats">
        <div class="stat"><b>${stats.activeThisWeek}</b><span>active days, last 7</span></div>
        <div class="stat"><b>${stats.totalActiveDays}</b><span>active days in total</span></div>
        <div class="stat"><b>${stats.weeksInARow}</b><span>weeks in a row</span></div>
      </div>
      <p class="muted small" style="margin:10px 0 0">Missed a day? That's okay. Rest days never reset your totals.</p>
    </section>
    ${medicalHelpCard(true)}
    <p class="muted small">${DISCLAIMER}</p>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Exercises                                                           */
/* ------------------------------------------------------------------ */
function renderExercises() {
  const items = EXERCISES.map((ex) => {
    const locked = !isAvailable(ex, state.settings);
    return `<li class="ex-item ${locked ? 'locked' : ''}">
      <a href="#/exercise/${ex.id}">
        <span aria-hidden="true">${illustration(ex.id)}</span>
        <span><span class="ex-name">${esc(ex.name)} ${locked ? `<span class="pill">${ICON.lock.replace('<svg', '<svg width="14" height="14"')} Locked</span>` : ''}</span>
        <span class="ex-dose">${esc(describeDose(ex, levelFor(state, ex.id)))}</span></span>
      </a>
    </li>`;
  }).join('');
  return `<div class="stack">
    <h1>Exercises</h1>
    <p class="muted">All seated or supported, gentle, and kind to your toes. Tap one to read the steps or try it on its own.</p>
    <ul class="ex-list">${items}</ul>
  </div>`;
}

function renderExercise(id) {
  const ex = getExercise(id);
  if (!ex) return renderExercises();
  const locked = !isAvailable(ex, state.settings);
  return `<div class="stack">
    <a class="icon-btn" href="#/exercises">${ICON.back} All exercises</a>
    <h1>${esc(ex.name)}</h1>
    <div class="ill-wrap">${illustration(ex.id)}</div>
    <p><span class="pill pill-ok">${esc(describeDose(ex, levelFor(state, ex.id)))}</span></p>
    <p>${esc(ex.summary)}</p>
    <section class="card"><h2>How to do it</h2><ol class="steps">${ex.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
      ${ex.tempo ? `<p class="muted small">Rhythm: ${ex.tempo.map((p) => `${esc(p.cue.toLowerCase())} ${p.s} s`).join(', then ')}.</p>` : ''}
    </section>
    <div class="notice notice-info"><strong>Go gently:</strong> ${esc(ex.tip)}</div>
    <div class="notice notice-warn"><strong>Stop if:</strong> ${esc(ex.stop)}</div>
    ${locked
      ? `<div class="notice notice-info">${ICON.lock.replace('<svg', '<svg width="18" height="18"')} This is a progression exercise. When your physio agrees, unlock it in <a href="#/settings">Settings, then Progression</a>.</div>`
      : `<button class="btn btn-primary btn-big" data-action="start-one" data-ex="${ex.id}">${ICON.play} Try it now</button>`}
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Schedule builder                                                    */
/* ------------------------------------------------------------------ */
function stepper(exId, field, value, label, step, min, max) {
  return `<div class="field-row" role="group" aria-label="${esc(label)}">
    <button class="icon-btn" data-action="level" data-ex="${exId}" data-field="${field}" data-delta="${-step}" data-min="${min}" data-max="${max}" aria-label="Decrease ${esc(label)}">${ICON.minus}</button>
    <span style="min-width:6ch;text-align:center;font-weight:700">${field === 'duration' ? fmtDuration(value) : value} <span class="sr-only">${esc(label)}</span></span>
    <button class="icon-btn" data-action="level" data-ex="${exId}" data-field="${field}" data-delta="${step}" data-min="${min}" data-max="${max}" aria-label="Increase ${esc(label)}">${ICON.plus}</button>
    <span class="muted small">${esc(label)}</span>
  </div>`;
}

function renderSchedule() {
  const slotsHtml = SLOTS.map((s) => {
    const slot = state.schedule.slots[s.id];
    const exs = slot.exercises;
    const options = EXERCISES.filter((e) => !exs.includes(e.id))
      .map((e) => `<option value="${e.id}">${esc(e.name)}${!isAvailable(e, state.settings) ? ' (locked)' : ''}</option>`)
      .join('');
    return `<details class="card slot-card" ${exs.length ? '' : ''}>
      <summary><span><strong>${esc(s.label)}</strong> <span class="muted">${esc(slot.time)} · ${exs.length} exercise${exs.length === 1 ? '' : 's'}${slot.enabled === false ? ' · off' : ''}</span></span></summary>
      <div class="field-row" style="margin:8px 0">
        <label class="field" style="flex:1;margin:0"><span class="label">Time</span>
          <input type="time" value="${esc(slot.time)}" data-slot-time="${s.id}"></label>
        <label class="switch" style="flex:1"><span>Include today</span>
          <input type="checkbox" role="switch" data-slot-enabled="${s.id}" ${slot.enabled !== false ? 'checked' : ''}></label>
      </div>
      ${exs.map((id, i) => {
        const ex = getExercise(id);
        const locked = !isAvailable(ex, state.settings);
        return `<div class="slot-ex"><span class="names">${esc(ex.name)}${locked ? ' <span class="pill">Locked</span>' : ''}<br><span class="muted small">${esc(describeDose(ex, levelFor(state, id)))}</span></span>
          <span class="actions">
            <button class="icon-btn" data-action="slot-move" data-slot="${s.id}" data-i="${i}" data-dir="-1" aria-label="Move ${esc(ex.name)} up" ${i === 0 ? 'disabled' : ''}>${ICON.up}</button>
            <button class="icon-btn" data-action="slot-move" data-slot="${s.id}" data-i="${i}" data-dir="1" aria-label="Move ${esc(ex.name)} down" ${i === exs.length - 1 ? 'disabled' : ''}>${ICON.down}</button>
            <button class="icon-btn" data-action="slot-remove" data-slot="${s.id}" data-i="${i}" aria-label="Remove ${esc(ex.name)} from ${esc(s.label)}">${ICON.x}</button>
          </span></div>`;
      }).join('')}
      <div class="field-row" style="margin-top:10px">
        <label class="sr-only" for="add-${s.id}">Add an exercise to ${esc(s.label)}</label>
        <select id="add-${s.id}" style="flex:1">${options}</select>
        <button class="btn" data-action="slot-add" data-slot="${s.id}">Add</button>
      </div>
    </details>`;
  }).join('');

  const scheduledIds = new Set(SLOTS.flatMap((s) => state.schedule.slots[s.id].exercises));
  const levelsHtml = EXERCISES.filter((e) => scheduledIds.has(e.id) && e.mode !== 'open')
    .map((ex) => {
      const lv = levelFor(state, ex.id);
      const p = ex.progression || {};
      return `<div class="slot-ex" style="display:block;padding:10px 0"><strong>${esc(ex.name)}</strong>
        ${ex.mode === 'reps'
          ? stepper(ex.id, 'reps', lv.reps, 'reps', 1, 3, p.maxReps || 30)
          : stepper(ex.id, 'duration', lv.duration, 'time', ex.duration >= 120 ? 60 : 5, ex.duration >= 120 ? 60 : 10, p.maxDuration || 600)}
        ${(p.maxSets || 1) > 1 ? stepper(ex.id, 'sets', lv.sets, 'sets', 1, 1, p.maxSets) : ''}
      </div>`;
    })
    .join('');

  return `<div class="stack">
    <h1>Schedule</h1>
    <p class="muted">Short, frequent sessions spread through the day. Week ${currentWeek(state)} of your plan.</p>
    ${reducedNotice()}
    <section class="card" aria-labelledby="tpl-h">
      <h2 id="tpl-h">Start from a template</h2>
      ${Object.entries(TEMPLATES).map(([id, t]) => `
        <div class="slot-ex" style="padding:8px 0"><span class="names"><strong>${esc(t.name)}</strong>${state.schedule.template === id ? ' <span class="pill pill-ok">current</span>' : ''}<br><span class="muted small">${esc(t.description)}</span></span>
        <button class="btn" data-action="apply-template" data-tpl="${id}">Use</button></div>`).join('')}
      <p class="muted small" style="margin-top:8px">Using a template replaces your slots. Your reps and sets levels are kept.</p>
    </section>
    <h2>Daily slots</h2>
    ${slotsHtml}
    ${progressionCard(false)}
    <section class="card" aria-labelledby="levels-h">
      <h2 id="levels-h">Current levels</h2>
      <p class="muted small">Adjust any exercise by hand. Lower is always fine.</p>
      ${levelsHtml}
    </section>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Guided session                                                      */
/* ------------------------------------------------------------------ */
let tickTimer = null;

function startSession({ exIds, slot = null, label }) {
  const ids = exIds.filter((id) => getExercise(id) && isAvailable(getExercise(id), state.settings));
  if (!ids.length) return;
  const items = ids.map((id) => ({ ex: getExercise(id), level: effectiveLevel(state, id) }));
  const steps = buildSteps(items, { manualReps: state.settings.repPacing === 'tap' });
  const runner = new SessionRunner(steps);
  active = { runner, items, slot, label, reduced: !!state.reduceNext, stoppedForPain: false, startedAt: new Date() };
  if (state.settings.sound) unlockAudio();
  keepAwake().then((ok) => {
    const el = document.getElementById('wake-status');
    if (el) el.textContent = ok ? 'Screen will stay on during this session.' : 'Tip: keep the screen on manually (this browser cannot hold it awake).';
  });

  runner.on('step', (snap) => {
    renderSessionStep(snap);
    if (snap.step.type === 'rest' || snap.step.type === 'intro') {
      if (state.settings.vibration) vibrate([30, 60, 30]);
    }
  });
  runner.on('phase', (snap) => {
    if (state.settings.sound) phaseBeat(snap.dir);
    if (state.settings.vibration) vibrate(snap.dir === 'hold' ? 15 : 35);
    const pulse = document.getElementById('pulse');
    if (pulse) {
      pulse.style.transitionDuration = `${snap.phaseLen || 0.3}s`;
      pulse.dataset.dir = snap.dir;
    }
    announce(snap.step.type === 'reps' ? `${snap.cue}. Rep ${snap.rep}` : snap.cue);
  });
  runner.on('prompt', (snap) => {
    if (state.settings.sound) { beat(523); setTimeout(() => beat(523), 300); }
    if (state.settings.vibration) vibrate([60, 80, 60]);
    const el = document.getElementById('session-card');
    el?.classList.remove('prompt-flash');
    void el?.offsetWidth;
    el?.classList.add('prompt-flash');
    announce(snap.prompt);
  });
  runner.on('done', () => finishSession(false));

  go('#/session');
  runner.start();
  clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    if (active) updateSessionView(active.runner.tick());
  }, 100);
}

function startNext() {
  const s = nextSlot();
  if (s) startSlot(s.id);
  else go('#/today');
}

function startSlot(slotId) {
  const exs = slotExercises(state, slotId).map((e) => e.id);
  startSession({ exIds: exs, slot: slotId, label: `${SLOT_BY_ID[slotId].label} session` });
}

function finishSession(early) {
  if (!active) return;
  clearInterval(tickTimer);
  allowSleep();
  const summary = active.runner.summary();
  if (!early && state.settings.sound) chime();
  pendingLog = {
    slot: active.slot,
    label: active.label,
    summary,
    reduced: active.reduced,
    stoppedEarly: early,
    stoppedForPain: active.stoppedForPain,
  };
  active = null;
  go('#/after');
}

function announce(text) {
  const el = document.getElementById('live');
  if (el) el.textContent = text;
}

function renderSession() {
  if (!active) return '';
  return `<div class="session" id="session-card">
    <h1 class="sr-only">Guided session</h1>
    <div class="session-top">
      <div><p class="session-title" id="s-title"></p><div class="session-sub" id="s-sub"></div></div>
      <span class="pill" id="s-count"></span>
    </div>
    <div class="session-progress" id="s-progress" aria-hidden="true"></div>
    <div id="s-body"></div>
    <div class="session-controls" id="s-controls"></div>
    <div class="btn-row">
      <button class="btn btn-danger" data-action="stop-pain">Stop: it hurts</button>
      <button class="btn btn-quiet" data-action="end-session">End session</button>
    </div>
    <p class="session-hint" id="wake-status">${wakeLockSupported() ? '' : 'Tip: keep the screen on manually (this browser cannot hold it awake).'}</p>
  </div>`;
}

/** Called when a new step starts: rebuild the step-specific parts. */
function renderSessionStep(snap) {
  if (!document.getElementById('s-body')) {
    main().innerHTML = renderSession();
    window.scrollTo(0, 0);
  }
  const st = snap.step;
  const ex = getExercise(st.exId);
  const total = active.items.length;
  document.getElementById('s-title').textContent = st.type === 'rest' ? (st.reason === 'switch' ? 'Switch sides' : 'Rest') : ex.name;
  const subBits = [];
  if (st.type === 'intro') subBits.push('Get ready');
  if (st.sets > 1) subBits.push(`Set ${st.set} of ${st.sets}`);
  if (st.side) subBits.push(st.side);
  if (st.type === 'rest' && st.reason === 'switch') subBits.push(`Next: ${st.nextSide}`);
  if (st.type === 'rest' && st.reason === 'set') subBits.push(`Next: set ${st.nextSet} of ${ex.name}`);
  document.getElementById('s-sub').textContent = subBits.join(' · ');
  document.getElementById('s-count').textContent = `Exercise ${st.exIndex + 1} of ${total}`;
  document.getElementById('s-progress').innerHTML = active.items
    .map((_, i) => `<span class="${i < st.exIndex ? 'done' : i === st.exIndex ? 'now' : ''}"></span>`)
    .join('');

  let body = '';
  let controls = `<button class="btn" data-action="toggle-pause" id="btn-pause">${ICON.pause} Pause</button>`;
  if (st.type === 'intro') {
    body = `<div class="ill-wrap">${illustration(ex.id)}</div>
      <p style="text-align:left"><strong>${esc(describeDose(ex, active.items[st.exIndex].level))}</strong>. ${esc(ex.summary)}</p>
      <details style="text-align:left"><summary class="icon-btn" style="display:inline-flex">Show steps</summary><ol class="steps">${ex.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></details>
      <div class="notice notice-info" style="text-align:left"><strong>Go gently:</strong> ${esc(ex.tip)}</div>
      <p class="muted" style="margin:8px 0 0">Starting in</p>
      <div class="timer-big" id="s-timer" role="timer" aria-live="off"></div>`;
    controls += `<button class="btn btn-primary" data-action="skip-step">${ICON.play} Start now</button>
      <button class="btn btn-quiet span-2" data-action="skip-exercise">Skip this exercise</button>`;
  } else if (st.type === 'rest') {
    body = `<p class="cue">${st.reason === 'switch' ? 'Get into position' : 'Relax, breathe, feet flat'}</p>
      <div class="timer-big" id="s-timer" role="timer" aria-live="off"></div>`;
    controls += `<button class="btn" data-action="extend-rest">+15 s</button>
      <button class="btn btn-primary span-2" data-action="skip-step">${ICON.skip} Skip rest</button>`;
  } else if (st.type === 'reps') {
    body = `<div class="ill-wrap">${illustration(ex.id)}</div>
      ${st.manual ? '' : `<div class="pulse-wrap"><div class="pulse" id="pulse" data-dir="down" aria-hidden="true"><span class="timer-big" id="s-phase"></span></div></div>`}
      <p class="cue" id="s-cue" aria-hidden="true"></p>
      <p class="rep-counter" id="s-reps"></p>
      <p class="muted" id="s-left"></p>`;
    controls += `<button class="btn" data-action="skip-step">${ICON.skip} Skip</button>`;
    if (st.manual) controls = `<button class="btn btn-primary btn-big span-2" data-action="tap-rep">Done a rep</button>` + controls;
  } else if (st.type === 'timed') {
    body = `<div class="ill-wrap">${illustration(ex.id)}</div>
      ${st.tempo ? `<div class="pulse-wrap"><div class="pulse" id="pulse" data-dir="down" aria-hidden="true"><span class="timer-big" id="s-phase"></span></div></div>` : ''}
      <p class="cue" id="s-cue" aria-hidden="true">${st.pumpEvery ? 'Relax with your feet up' : ''}</p>
      <div class="timer-big" id="s-timer" role="timer" aria-live="off"></div>
      ${st.pumpEvery ? `<p class="muted">Every ${st.pumpEvery / 60} minutes you'll be prompted to do 10 slow ankle pumps.</p>` : ''}`;
    controls += `<button class="btn" data-action="skip-step">${ICON.skip} Skip</button>`;
  } else if (st.type === 'open') {
    body = `<div class="ill-wrap">${illustration(ex.id)}</div>
      <p class="cue">Goal: ${esc(st.target)}</p>
      <div class="timer-big" id="s-timer" role="timer" aria-live="off"></div>
      <p class="muted">Take your time. Tap Done when you have finished.</p>`;
    controls += `<button class="btn btn-primary" data-action="mark-done">${ICON.check} Done</button>`;
  }
  document.getElementById('s-body').innerHTML = body;
  document.getElementById('s-controls').innerHTML = controls;
  announce(
    st.type === 'intro' ? `Next exercise: ${ex.name}. ${describeDose(ex, active.items[st.exIndex].level)}.`
      : st.type === 'rest' ? `${st.reason === 'switch' ? 'Switch sides' : 'Rest'} for ${st.duration} seconds.`
      : `${ex.name}${st.side ? `, ${st.side}` : ''}${st.sets > 1 ? `, set ${st.set} of ${st.sets}` : ''}. Begin.`,
  );
  updateSessionView(snap);
}

/** Called on every tick: update numbers only. */
function updateSessionView(snap) {
  if (!snap.step || !document.getElementById('s-body')) return;
  const st = snap.step;
  const set = (id, txt) => {
    const el = document.getElementById(id);
    if (el && el.textContent !== txt) el.textContent = txt;
  };
  if (st.type === 'open') set('s-timer', fmtClock(Math.floor(snap.elapsed)));
  else if (snap.remaining != null) set('s-timer', fmtClock(snap.remaining));
  if (st.type === 'reps') {
    set('s-cue', snap.cue);
    if (snap.phaseLeft != null) set('s-phase', String(Math.ceil(snap.phaseLeft)));
    const repsEl = document.getElementById('s-reps');
    const html = `Rep <b>${snap.rep}</b> of ${st.reps}`;
    if (repsEl && repsEl.innerHTML !== html) repsEl.innerHTML = html;
    if (!st.manual) set('s-left', `${fmtClock(snap.remaining)} left in this set`);
    else set('s-left', `${snap.repsDone} done`);
  } else if (st.type === 'timed' && st.tempo) {
    set('s-cue', snap.cue);
    set('s-phase', String(Math.ceil(snap.phaseLeft)));
  } else if (st.type === 'timed' && snap.prompt && snap.elapsed - snap.promptN * st.pumpEvery < 20) {
    set('s-cue', snap.prompt);
  } else if (st.type === 'timed' && st.pumpEvery) {
    set('s-cue', 'Relax with your feet up');
  }
  const pauseBtn = document.getElementById('btn-pause');
  const wantLabel = snap.running ? 'Pause' : 'Resume';
  if (pauseBtn && pauseBtn.dataset.label !== wantLabel) {
    pauseBtn.dataset.label = wantLabel;
    pauseBtn.innerHTML = `${snap.running ? ICON.pause : ICON.play} ${wantLabel}`;
    pauseBtn.setAttribute('aria-pressed', String(!snap.running));
  }
}

/* ------------------------------------------------------------------ */
/* After-session log & check-in                                        */
/* ------------------------------------------------------------------ */
function sliderField(id, label, help, value = 0) {
  return `<div class="field slider ${value >= (id === 'toePain' ? TOE_PAIN_LIMIT : HEAT_LIMIT) ? 'high' : ''}" data-slider="${id}">
    <div class="slider-head"><label for="${id}">${esc(label)}</label><output class="slider-value" for="${id}" id="${id}-out">${value}</output></div>
    <input type="range" id="${id}" name="${id}" min="0" max="10" step="1" value="${value}" aria-describedby="${id}-help">
    <div class="slider-scale" aria-hidden="true"><span>0 none</span><span>5</span><span>10 worst</span></div>
    <p class="muted small" id="${id}-help" style="margin:0">${esc(help)}</p>
  </div>`;
}

function logForm(kind) {
  const unit = state.settings.tempUnit;
  return `<form id="log-form" class="card" novalidate>
    ${sliderField('toePain', 'Little-toe pain or discomfort', 'How sore is the little toe right now?')}
    ${sliderField('heat', 'Heat or redness in the feet', 'How hot or red do your feet look and feel?')}
    <div class="field">
      <label for="roomTemp">Room temperature (optional, °${unit})</label>
      <input type="number" inputmode="decimal" id="roomTemp" name="roomTemp" min="${unit === 'C' ? 5 : 40}" max="${unit === 'C' ? 40 : 104}" step="0.5" placeholder="${unit === 'C' ? 'e.g. 19' : 'e.g. 66'}">
    </div>
    <div class="field">
      <label for="notes">Notes (optional)</label>
      <textarea id="notes" name="notes" placeholder="How did it feel? Anything to tell your physio?"></textarea>
    </div>
    <button class="btn btn-primary btn-big" type="submit">Save ${kind === 'check-in' ? 'check-in' : 'log'}</button>
  </form>`;
}

function renderAfter() {
  const p = pendingLog;
  const names = (status) => p.summary.filter((s) => s.status === status).map((s) => getExercise(s.exId).name);
  const done = names('done');
  const partial = names('partial');
  const skipped = names('skipped');
  return `<div class="stack">
    <h1>${p.stoppedForPain ? 'Stopped. Good call.' : p.stoppedEarly ? 'Session ended' : 'Well done'}</h1>
    ${p.stoppedForPain ? `<div class="notice notice-warn" role="alert"><strong>Listening to your body is the right thing to do.</strong>
      Rest now. An elevation break (feet above heart level, gentle ankle pumps) may help. Your next session will be lighter.</div>` : ''}
    <section class="card">
      <h2>${esc(p.label || 'Session')}</h2>
      ${done.length ? `<p><strong>Completed:</strong> ${done.map(esc).join(', ')}</p>` : ''}
      ${partial.length ? `<p><strong>Partly done:</strong> ${partial.map(esc).join(', ')}</p>` : ''}
      ${skipped.length ? `<p class="muted"><strong>Skipped:</strong> ${skipped.map(esc).join(', ')}</p>` : ''}
      ${p.reduced ? '<p class="muted small">This was a lighter session.</p>' : ''}
    </section>
    <h2>How do your feet feel?</h2>
    ${logForm('session')}
    <button class="btn btn-quiet btn-block" data-action="skip-log">Save without symptoms</button>
  </div>`;
}

function renderCheckin() {
  return `<div class="stack">
    <a class="icon-btn" href="#/log">${ICON.back} Log</a>
    <h1>How do your feet feel?</h1>
    <p class="muted">A quick symptom check-in without a session.</p>
    ${logForm('check-in')}
  </div>`;
}

function wireLogForm(kind) {
  const form = document.getElementById('log-form');
  form.querySelectorAll('input[type=range]').forEach((r) => {
    const update = () => {
      document.getElementById(`${r.id}-out`).textContent = r.value;
      const limit = r.id === 'toePain' ? TOE_PAIN_LIMIT : HEAT_LIMIT;
      r.closest('.slider').classList.toggle('high', Number(r.value) >= limit);
    };
    r.addEventListener('input', update);
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const temp = fd.get('roomTemp');
    saveLog(kind, {
      toePain: Number(fd.get('toePain')),
      heat: Number(fd.get('heat')),
      roomTemp: temp === '' ? null : Number(temp),
      notes: String(fd.get('notes') || '').trim(),
    });
  });
}
afterRender.after = () => wireLogForm('session');
afterRender.checkin = () => wireLogForm('check-in');

function saveLog(kind, symptoms) {
  const base = { kind, tempUnit: state.settings.tempUnit, ...(symptoms || {}) };
  if (kind === 'session' && pendingLog) {
    const by = (st) => pendingLog.summary.filter((s) => s.status === st).map((s) => s.exId);
    Object.assign(base, {
      slot: pendingLog.slot,
      completed: by('done'),
      partial: by('partial'),
      skipped: by('skipped'),
      stoppedEarly: pendingLog.stoppedEarly,
      stoppedForPain: pendingLog.stoppedForPain,
      reduced: pendingLog.reduced,
    });
  }
  const entry = makeEntry(base);
  const verdict = assessEntry(entry);
  const wasReduced = !!entry.reduced;
  save((s) => {
    s.history.push(entry);
    if (verdict.flagged) s.reduceNext = true;
    else if (wasReduced && symptoms) s.reduceNext = false; // a comfortable lighter session clears the flag
  });
  pendingLog = null;
  if (verdict.flagged) showSafetyDialog(verdict.reasons);
  else toast('Saved. Nice work.');
  go(kind === 'check-in' ? '#/log' : '#/today');
}

function showSafetyDialog(reasons) {
  const dlg = document.getElementById('safety-dialog');
  dlg.querySelector('#safety-reasons').textContent = `You reported ${reasons.join(' and ')}.`;
  dlg.showModal();
}

/* ------------------------------------------------------------------ */
/* Log (history, chart, export)                                        */
/* ------------------------------------------------------------------ */
function renderLog() {
  const end = addDays(new Date(), chartWeekOffset * 7);
  const data = weekSeries(state.history, end);
  const stats = streakStats(state.history);
  const recent = [...state.history].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 30);
  const fmtTemp = (e) => (e.roomTemp === null || e.roomTemp === '' ? '' : ` · room ${e.roomTemp}°${e.tempUnit}`);
  const list = recent
    .map((e) => {
      const flagged = assessEntry(e).flagged;
      const title = e.kind === 'session' ? `${e.slot ? SLOT_BY_ID[e.slot]?.label : 'Extra'} session` : 'Check-in';
      return `<li class="slot-ex" style="align-items:flex-start;padding:10px 0">
        <span class="names"><strong>${esc(title)}</strong> <span class="muted small">${esc(e.date)} ${esc(e.time)}</span><br>
        <span class="small">${e.kind === 'session' ? `${e.completed.length} done${e.partial.length ? `, ${e.partial.length} partly` : ''}${e.skipped.length ? `, ${e.skipped.length} skipped` : ''}` : ''}
        ${e.toePain !== null ? ` · toe ${e.toePain}/10 · heat ${e.heat}/10` : ''}${fmtTemp(e)}${e.stoppedForPain ? ' · stopped for pain' : ''}</span>
        ${flagged ? `<br><span class="pill" style="background:var(--danger-bg)">${ICON.alert.replace('<svg', '<svg width="14" height="14"')} above safety limit</span>` : ''}
        ${e.notes ? `<br><span class="muted small">“${esc(e.notes)}”</span>` : ''}</span>
        <button class="icon-btn" data-action="delete-entry" data-id="${e.id}" aria-label="Delete entry from ${esc(e.date)} ${esc(e.time)}">${ICON.x}</button>
      </li>`;
    })
    .join('');
  return `<div class="stack">
    <h1>Log</h1>
    <section class="card" aria-label="Your consistency">
      <div class="stats">
        <div class="stat"><b>${stats.activeThisWeek}</b><span>active days, last 7</span></div>
        <div class="stat"><b>${stats.totalActiveDays}</b><span>active days in total</span></div>
        <div class="stat"><b>${stats.weeksInARow}</b><span>weeks in a row</span></div>
      </div>
    </section>
    <section class="card" aria-labelledby="week-h">
      <div class="field-row" style="justify-content:space-between">
        <button class="icon-btn" data-action="week-prev" aria-label="Previous week">${ICON.back}</button>
        <h2 id="week-h" style="margin:0">${chartWeekOffset === 0 ? 'Last 7 days' : `${esc(data[0].date)} to ${esc(data[6].date)}`}</h2>
        <button class="icon-btn" data-action="week-next" aria-label="Next week" ${chartWeekOffset >= 0 ? 'disabled' : ''}><span style="transform:scaleX(-1);display:inline-flex">${ICON.back}</span></button>
      </div>
      <div id="chart-root">${weeklyChart(data)}</div>
    </section>
    <div class="btn-row">
      <a class="btn btn-primary" href="#/checkin">Log how my feet feel</a>
    </div>
    <section class="card" aria-labelledby="export-h">
      <h2 id="export-h">Share with your doctor or physio</h2>
      <div class="btn-row">
        <button class="btn" data-action="export-csv">Download CSV</button>
        <a class="btn" href="#/report">Printable summary</a>
      </div>
      <p class="muted small" style="margin-top:8px">Files are created on your phone. Nothing is uploaded.</p>
    </section>
    <section class="card" aria-labelledby="hist-h">
      <h2 id="hist-h">Recent entries</h2>
      ${list ? `<ul style="list-style:none;margin:0;padding:0">${list}</ul>` : '<p class="muted">Nothing logged yet. Your sessions and check-ins will appear here.</p>'}
    </section>
  </div>`;
}
afterRender.log = () => {
  const root = document.getElementById('chart-root');
  wireChart(root, weekSeries(state.history, addDays(new Date(), chartWeekOffset * 7)));
};

function renderReport() {
  const r = reportSummary(state.history, reportDays);
  const v = (x) => (x === null ? '–' : x);
  const scheduleRows = SLOTS.map((s) => {
    const slot = state.schedule.slots[s.id];
    if (slot.enabled === false || !slot.exercises.length) return '';
    return `<tr><td>${esc(s.label)} (${esc(slot.time)})</td><td>${slot.exercises.map((id) => `${esc(getExercise(id).name)}: ${esc(describeDose(getExercise(id), levelFor(state, id)))}`).join('<br>')}</td></tr>`;
  }).join('');
  const rows = r.entries.map((e) => `<tr>
      <td>${esc(e.date)} ${esc(e.time)}</td>
      <td>${e.kind === 'session' ? esc(e.slot ? SLOT_BY_ID[e.slot]?.label : 'Extra') : 'Check-in'}</td>
      <td class="num">${e.kind === 'session' ? e.completed.length : ''}</td>
      <td class="num">${v(e.toePain)}</td><td class="num">${v(e.heat)}</td>
      <td>${e.roomTemp !== null && e.roomTemp !== '' ? `${esc(e.roomTemp)}°${esc(e.tempUnit)}` : ''}</td>
      <td>${[e.stoppedForPain ? 'Stopped for pain.' : '', e.reduced ? 'Lighter session.' : '', esc(e.notes)].filter(Boolean).join(' ')}</td>
    </tr>`).join('');
  return `<div class="stack">
    <div class="no-print btn-row">
      <a class="icon-btn" href="#/log">${ICON.back} Log</a>
      <label class="sr-only" for="report-days">Period</label>
      <select id="report-days" data-action-change="report-days" style="flex:1">
        ${[14, 28, 56, 90].map((d) => `<option value="${d}" ${d === reportDays ? 'selected' : ''}>Last ${d} days</option>`).join('')}
      </select>
      <button class="btn btn-primary" data-action="print">Print / save PDF</button>
    </div>
    <h1>Exercise and symptom summary</h1>
    <p>${esc(r.from)} to ${esc(r.to)} · generated ${esc(new Date().toLocaleString())}</p>
    <section class="card">
      <h2>Overview</h2>
      <table class="data"><tbody>
        <tr><th>Sessions completed</th><td class="num">${r.sessions}</td></tr>
        <tr><th>Days with exercise</th><td class="num">${r.activeDays} of ${r.days}</td></tr>
        <tr><th>Little-toe pain (0 to 10): average / highest</th><td class="num">${v(r.avgToePain)} / ${v(r.maxToePain)}</td></tr>
        <tr><th>Heat/redness (0 to 10): average / highest</th><td class="num">${v(r.avgHeat)} / ${v(r.maxHeat)}</td></tr>
        <tr><th>Sessions stopped because of pain</th><td class="num">${r.stoppedForPain}</td></tr>
        <tr><th>Programme week</th><td class="num">${currentWeek(state)}</td></tr>
      </tbody></table>
    </section>
    <section class="card">
      <h2>Current routine</h2>
      <table class="data"><tbody>${scheduleRows}</tbody></table>
    </section>
    <section class="card">
      <h2>Exercises completed (count)</h2>
      <table class="data"><tbody>${r.exerciseCounts.map(([id, n]) => `<tr><td>${esc(getExercise(id)?.name || id)}</td><td class="num">${n}</td></tr>`).join('') || '<tr><td>None yet</td></tr>'}</tbody></table>
    </section>
    <section class="card">
      <h2>Log entries</h2>
      <table class="data">
        <thead><tr><th>When</th><th>Type</th><th class="num">Exercises</th><th class="num">Toe</th><th class="num">Heat</th><th>Room</th><th>Notes</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7">No entries in this period.</td></tr>'}</tbody>
      </table>
    </section>
    <p class="small muted">Made with Calf Care, a personal exercise helper. Not medical advice. Symptom scores are self-reported.</p>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Safety page                                                         */
/* ------------------------------------------------------------------ */
function renderSafety() {
  return `<div class="stack">
    <a class="icon-btn" href="#/today">${ICON.back} Today</a>
    <h1>Safety</h1>
    ${medicalHelpCard(false)}
    <section class="card">
      <h2>Built-in safety rules</h2>
      <ul>
        <li>If you log little-toe pain of <strong>${TOE_PAIN_LIMIT} or more</strong>, or heat/redness of <strong>${HEAT_LIMIT} or more</strong>, the app suggests stopping and doing an elevation break instead, and makes your next session lighter.</li>
        <li>The weekly step-up is never applied automatically. It is held for any week in which you reported pain.</li>
        <li>Use the <strong>Stop: it hurts</strong> button in any session to stop straight away.</li>
      </ul>
    </section>
    <section class="card">
      <h2>Everyday tips</h2>
      <ul>
        <li>Exercise in a cool room. Bare feet or loose socks on a cool floor can help with heat.</li>
        <li>Nothing should hurt. Mild effort in the calves is fine, but pain is not.</li>
        <li>Keep pressure off the toes. Wear roomy shoes and keep the toes free of tight bedding.</li>
        <li>Short and often beats long and hard.</li>
      </ul>
    </section>
    <div class="notice notice-info"><strong>Disclaimer:</strong> ${DISCLAIMER}</div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */
function seg(name, value, options) {
  return `<div class="segmented" role="radiogroup">${options
    .map(([v, label]) => `<label><input type="radio" name="${name}" value="${v}" data-setting="${name}" ${String(value) === String(v) ? 'checked' : ''}><span>${esc(label)}</span></label>`)
    .join('')}</div>`;
}
function toggle(name, label, checked, help = '') {
  return `<label class="switch"><span>${esc(label)}${help ? `<br><span class="muted small">${esc(help)}</span>` : ''}</span>
    <input type="checkbox" role="switch" data-setting="${name}" ${checked ? 'checked' : ''}></label>`;
}

function renderSettings() {
  const s = state.settings;
  const r = s.reminders;
  const sup = notificationSupport();
  const times = reminderTimes(r, state.schedule);
  const next = nextReminder({ rem: r, schedule: state.schedule, now: new Date(), snoozeUntil: state.reminderState.snoozeUntil });
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `<div class="stack">
    <h1>Settings</h1>

    <section class="card" aria-labelledby="rem-h">
      <h2 id="rem-h">${ICON.bell.replace('<svg', '<svg width="22" height="22" style="vertical-align:-4px"')} Reminders</h2>
      ${toggle('reminders.enabled', 'Remind me to exercise', r.enabled)}
      <p class="small muted" id="perm-status">Notifications: ${esc(sup.permission === 'unsupported' ? 'not supported in this browser' : sup.permission)}.</p>
      <div class="field"><span class="label">Remind me</span>
        ${seg('reminders.mode', r.mode, [['interval', 'Every…'], ['slots', 'At my slot times']])}</div>
      ${r.mode === 'interval' ? `
      <div class="field-row">
        <label class="field" style="flex:1"><span class="label">From</span><input type="time" value="${esc(r.start)}" data-setting="reminders.start"></label>
        <label class="field" style="flex:1"><span class="label">Until</span><input type="time" value="${esc(r.end)}" data-setting="reminders.end"></label>
      </div>
      <div class="field"><label for="rem-every">Every</label>
        <select id="rem-every" data-setting="reminders.every">${[30, 45, 60, 75, 90, 120].map((m) => `<option value="${m}" ${Number(r.every) === m ? 'selected' : ''}>${m} minutes</option>`).join('')}</select></div>` : ''}
      <div class="field"><span class="label">Days</span>
        <div class="chips">${dayNames.map((d, i) => `<button class="chip" data-action="toggle-day" data-day="${i}" aria-pressed="${r.days.includes(i)}">${d}</button>`).join('')}</div></div>
      <p class="small"><strong>${times.length} reminders a day:</strong> ${times.map(esc).join(', ') || 'none'}</p>
      ${r.enabled && next ? `<p class="small">Next: <strong>${esc(next.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }))}</strong>${state.reminderState.snoozeUntil ? ' (snoozed)' : ''}</p>` : ''}
      <div class="btn-row">
        <button class="btn" data-action="test-reminder">Send a test reminder</button>
        <button class="btn" data-action="download-ics">Add to my calendar (.ics)</button>
      </div>
      <details class="notice notice-info" style="margin-top:12px">
        <summary><strong>How reliable are reminders? (please read)</strong></summary>
        <ul class="small">
          <li>Web apps can't wake themselves at exact times once they're fully closed. That would need a server, and this app deliberately has none.</li>
          <li><strong>Reminders work best while Calf Care is open or in the background.</strong> When it's open you'll see a banner at the top with <em>Start</em> and <em>Snooze ${SNOOZE_MINUTES} min</em>.</li>
          <li><strong>Android (Chrome):</strong> install the app (Add to Home screen) and allow notifications. Chrome may also check in the background now and then, but timing is up to Chrome.</li>
          <li><strong>iPhone/iPad:</strong> notifications only work after you <em>Add to Home Screen</em> from Safari (iOS 16.4 or later) and open the app from there. iOS still won't deliver timed reminders while the app is closed.${sup.isIOS && !sup.standalone ? ' <strong>You are not using the installed app yet.</strong>' : ''}</li>
          <li><strong>Most reliable option:</strong> tap <em>Add to my calendar</em>. Your phone's calendar will alert you at each reminder time, every day, even when this app is closed.</li>
        </ul>
      </details>
    </section>

    <section class="card" aria-labelledby="session-set-h">
      <h2 id="session-set-h">Sessions</h2>
      ${toggle('sound', 'Soft beat sounds', s.sound, 'Higher note = lift, lower note = lower')}
      ${toggle('vibration', 'Vibration', s.vibration, 'Not available on iPhone')}
      <div class="field"><span class="label">Rep counting</span>
        ${seg('repPacing', s.repPacing, [['guided', 'Guided tempo'], ['tap', 'I tap each rep']])}</div>
      <div class="field"><span class="label">Temperature units</span>
        ${seg('tempUnit', s.tempUnit, [['C', '°C'], ['F', '°F']])}</div>
    </section>

    <section class="card" aria-labelledby="display-h">
      <h2 id="display-h">Display</h2>
      <div class="field"><span class="label">Theme</span>
        ${seg('theme', s.theme, [['system', 'Auto'], ['light', 'Light'], ['dark', 'Dark']])}</div>
      ${toggle('largeText', 'Large text', s.largeText)}
      ${toggle('reduceMotion', 'Reduce motion', s.reduceMotion === 'on', 'Stops animations. Your device setting is always respected.')}
    </section>

    <section class="card" aria-labelledby="prog-set-h">
      <h2 id="prog-set-h">Progression</h2>
      ${toggle('unlockProgression', 'Unlock standing calf raises', s.unlockProgression, 'Only when you and your physio feel ready')}
    </section>

    <section class="card" aria-labelledby="data-h">
      <h2 id="data-h">Your data</h2>
      <p class="small">Everything is stored only on this device. There are no accounts, no tracking and no analytics.</p>
      <div class="btn-row">
        <button class="btn" data-action="backup">Download backup</button>
        <label class="btn" for="restore-file">Restore backup</label>
        <input type="file" id="restore-file" accept="application/json,.json" class="sr-only">
      </div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn btn-danger btn-block" data-action="reset">Reset all data</button>
      </div>
    </section>

    <section class="card" aria-labelledby="about-h">
      <h2 id="about-h">About</h2>
      <p class="small">${DISCLAIMER}</p>
      <div class="btn-row"><a class="btn btn-quiet" href="#/safety">Safety and medical help</a></div>
    </section>
  </div>`;
}
afterRender.settings = () => {
  document.getElementById('restore-file')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      store.importBackup(JSON.parse(await file.text()));
      state = store.get();
      applyDisplaySettings();
      toast('Backup restored.');
      render();
    } catch (err) {
      alert(err.message || 'Could not read that file.');
    }
  });
};

function setSetting(path, value) {
  save((s) => {
    const keys = path.split('.');
    let obj = s.settings;
    while (keys.length > 1) obj = obj[keys.shift()];
    obj[keys[0]] = value;
  });
  applyDisplaySettings();
}

/* ------------------------------------------------------------------ */
/* Reminders runtime                                                   */
/* ------------------------------------------------------------------ */
function pushReminderConfig() {
  syncToServiceWorker({
    rem: state.settings.reminders,
    times: reminderTimes(state.settings.reminders, state.schedule),
    lastFired: state.reminderState.lastFired,
    snoozeUntil: state.reminderState.snoozeUntil,
  });
}

/** Read snooze/lastFired the service worker may have written while we were closed. */
async function pullServiceWorkerState() {
  try {
    const cache = await caches.open('calfcare-config');
    const res = await cache.match('./__sw-state.json');
    if (!res) return;
    const sw = await res.json();
    save((s) => {
      const rs = s.reminderState;
      if (sw.lastFired && (!rs.lastFired || sw.lastFired > rs.lastFired)) rs.lastFired = sw.lastFired;
      if (sw.snoozeUntil && (!rs.snoozeUntil || sw.snoozeUntil > rs.snoozeUntil)) rs.snoozeUntil = sw.snoozeUntil;
    });
    await cache.delete('./__sw-state.json');
  } catch {
    /* caches unavailable */
  }
}

function checkReminders() {
  const now = new Date();
  const rs = state.reminderState;
  const result = checkDue({ rem: state.settings.reminders, schedule: state.schedule, now, lastFired: rs.lastFired, snoozeUntil: rs.snoozeUntil });
  if (!result.due) return;
  save((s) => {
    s.reminderState.lastFired = now.toISOString();
    s.reminderState.snoozeUntil = null;
  });
  if (active) return; // already exercising: no need to nag
  const next = nextSlot();
  const body = next
    ? `Time for your ${next.label.toLowerCase()} session (${minutesLabel(estimateSeconds(slotExercises(state, next.id).map((e) => e.id)))}). Gentle and cool.`
    : 'Time for a gentle movement break: a few ankle pumps or an elevation break.';
  showBanner(body);
  if (document.visibilityState !== 'visible') {
    showReminderNotification({ title: 'Calf Care', body });
  } else {
    if (state.settings.sound) { unlockAudio(); beat(523, 0.3, 0.08); }
    if (state.settings.vibration) vibrate([80, 80, 80]);
  }
}

function showBanner(text) {
  const b = document.getElementById('reminder-banner');
  b.querySelector('#banner-text').textContent = text;
  b.hidden = false;
}

function hideBanner() {
  document.getElementById('reminder-banner').hidden = true;
}

function snooze() {
  const until = new Date(Date.now() + SNOOZE_MINUTES * 60000);
  save((s) => (s.reminderState.snoozeUntil = until.toISOString()));
  hideBanner();
  toast(`Snoozed until ${until.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}.`);
}

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */
let toastTimer;
function toast(text) {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ------------------------------------------------------------------ */
/* Event handling (delegated)                                          */
/* ------------------------------------------------------------------ */
const ACTIONS = {
  'start-slot': (el) => startSlot(el.dataset.slot),
  'start-one': (el) => startSession({ exIds: [el.dataset.ex], label: getExercise(el.dataset.ex).name }),
  'start-elevation': () => startSession({ exIds: ['elevation'], label: 'Elevation break' }),
  'toggle-pause': () => {
    active?.runner.toggle();
    if (active) updateSessionView(active.runner.snapshot());
  },
  'skip-step': () => active?.runner.skip(),
  'skip-exercise': () => active?.runner.skipExercise(),
  'extend-rest': () => active?.runner.extend(15),
  'tap-rep': () => active?.runner.tapRep(),
  'mark-done': () => active?.runner.markDone(),
  'end-session': () => {
    if (!active) return;
    active.runner.pause();
    if (confirm('End this session now? What you have done so far will be saved.')) finishSession(true);
    else active.runner.resume();
  },
  'stop-pain': () => {
    if (!active) return;
    active.runner.pause();
    active.stoppedForPain = true;
    finishSession(true);
  },
  'skip-log': () => saveLog('session', null),
  'prog-accept': () => {
    save((s) => applyProgression(s, proposeProgression(s, { painBlocked: painInLastWeek(s.history) })));
    toast('Step up accepted. Go gently.');
    render();
  },
  'prog-hold': () => {
    const blocked = painInLastWeek(state.history);
    save((s) => holdProgression(s, blocked ? 'Held because pain or heat was reported.' : 'You chose to hold.'));
    toast('Holding at your current level.');
    render();
  },
  'prog-ease': () => {
    save((s) => easeBack(s));
    toast('Eased back one step.');
    render();
  },
  'apply-template': (el) => {
    if (!confirm(`Replace your daily slots with the "${TEMPLATES[el.dataset.tpl].name}" template?`)) return;
    save((s) => {
      const times = Object.fromEntries(SLOTS.map((x) => [x.id, s.schedule.slots[x.id]?.time]));
      s.schedule = scheduleFromTemplate(el.dataset.tpl);
      SLOTS.forEach((x) => times[x.id] && (s.schedule.slots[x.id].time = times[x.id]));
    });
    render();
  },
  'slot-add': (el) => {
    const sel = document.getElementById(`add-${el.dataset.slot}`);
    if (!sel.value) return;
    save((s) => s.schedule.slots[el.dataset.slot].exercises.push(sel.value));
    renderKeepOpen(el.dataset.slot);
  },
  'slot-remove': (el) => {
    save((s) => s.schedule.slots[el.dataset.slot].exercises.splice(Number(el.dataset.i), 1));
    renderKeepOpen(el.dataset.slot);
  },
  'slot-move': (el) => {
    save((s) => {
      const arr = s.schedule.slots[el.dataset.slot].exercises;
      const i = Number(el.dataset.i);
      const j = i + Number(el.dataset.dir);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    });
    renderKeepOpen(el.dataset.slot);
  },
  level: (el) => {
    const { ex, field } = el.dataset;
    save((s) => {
      const lv = levelFor(s, ex);
      lv[field] = Math.min(Number(el.dataset.max), Math.max(Number(el.dataset.min), lv[field] + Number(el.dataset.delta)));
      s.levels[ex] = lv;
    });
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  },
  'week-prev': () => { chartWeekOffset--; render(); },
  'week-next': () => { chartWeekOffset = Math.min(0, chartWeekOffset + 1); render(); },
  'export-csv': () => download(`calf-care-log-${dateKey()}.csv`, toCSV(state.history), 'text/csv'),
  print: () => window.print(),
  'delete-entry': (el) => {
    if (!confirm('Delete this entry?')) return;
    save((s) => (s.history = s.history.filter((e) => e.id !== el.dataset.id)));
    render();
  },
  'toggle-day': (el) => {
    const d = Number(el.dataset.day);
    save((s) => {
      const days = s.settings.reminders.days;
      s.settings.reminders.days = days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort();
    });
    render();
  },
  'test-reminder': async () => {
    const sup = notificationSupport();
    if (sup.supported && Notification.permission === 'default') await requestPermission();
    const ok = await showReminderNotification({ title: 'Calf Care (test)', body: 'This is how your exercise reminders will look.' });
    showBanner('Test reminder: time for a gentle exercise break.');
    if (!ok) toast('System notifications are off or unsupported here, so you will see the in-app banner instead.');
    render();
  },
  'download-ics': () => {
    const r = state.settings.reminders;
    download('calf-care-reminders.ics', buildICS(reminderTimes(r, state.schedule), r.days), 'text/calendar');
  },
  backup: () => download(`calf-care-backup-${dateKey()}.json`, JSON.stringify(state, null, 2), 'application/json'),
  reset: () => {
    if (!confirm('Delete ALL your data (logs, schedule, settings) from this device? This cannot be undone.')) return;
    if (!confirm('Are you sure? You may want to download a backup first.')) return;
    store.reset();
    state = store.get();
    state.schedule = scheduleFromTemplate('gentle');
    store.save();
    applyDisplaySettings();
    toast('All data deleted.');
    go('#/today');
    showDisclaimer();
  },
  'banner-start': () => { hideBanner(); startNext(); },
  'banner-snooze': () => snooze(),
  'banner-dismiss': () => hideBanner(),
  'safety-elevation': () => {
    document.getElementById('safety-dialog').close();
    startSession({ exIds: ['elevation'], label: 'Elevation break' });
  },
  'safety-close': (el) => {
    document.getElementById('safety-dialog').close();
    if (el.tagName === 'A') go(el.getAttribute('href'));
  },
  'accept-disclaimer': () => {
    save((s) => (s.acceptedDisclaimer = true));
    document.getElementById('disclaimer-dialog').close();
  },
};

function renderKeepOpen(slotId) {
  const y = window.scrollY;
  render();
  const idx = SLOTS.findIndex((s) => s.id === slotId);
  document.querySelectorAll('.slot-card')[idx]?.setAttribute('open', '');
  window.scrollTo(0, y);
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.action];
  if (fn) {
    e.preventDefault();
    fn(el);
  }
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.actionChange === 'report-days') {
    reportDays = Number(el.value);
    render();
    return;
  }
  if (el.dataset.slotTime) {
    save((s) => (s.schedule.slots[el.dataset.slotTime].time = el.value));
    return;
  }
  if (el.dataset.slotEnabled) {
    save((s) => (s.schedule.slots[el.dataset.slotEnabled].enabled = el.checked));
    renderKeepOpen(el.dataset.slotEnabled);
    return;
  }
  const key = el.dataset.setting;
  if (!key) return;
  let value = el.type === 'checkbox' ? el.checked : el.value;
  if (key === 'reduceMotion') value = el.checked ? 'on' : 'system';
  if (key === 'reminders.every') value = Number(value);
  if (key === 'reminders.enabled' && value) {
    requestPermission().then(() => render());
  }
  setSetting(key, value);
  if (['reminders.mode', 'reminders.enabled', 'theme', 'largeText', 'tempUnit', 'unlockProgression'].includes(key)) render();
});

function showDisclaimer() {
  if (state.acceptedDisclaimer) return;
  const dlg = document.getElementById('disclaimer-dialog');
  if (!dlg.open) dlg.showModal();
}

/* ------------------------------------------------------------------ */
/* Service worker                                                      */
/* ------------------------------------------------------------------ */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').then(() => pushReminderConfig()).catch((e) => console.warn('SW registration failed', e));
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'snooze') snooze();
    if (e.data?.type === 'start') startNext();
  });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */
applyDisplaySettings();
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyDisplaySettings);
window.addEventListener('hashchange', render);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    pullServiceWorkerState().then(checkReminders);
    if (parseRoute().name === 'today') render();
  }
});
render();
showDisclaimer();
registerServiceWorker();
pullServiceWorkerState().then(checkReminders);
setInterval(checkReminders, 15000);

// Expose a tiny hook for automated tests (no effect on normal use).
window.__calfcare = { checkReminders, get state() { return state; }, get active() { return active; } };

export { cToF, fToC, defaultLevel, isCompletedSession };
