// Fluid Log: pure data logic (no DOM, no storage). Unit-tested in tests/unit/fluid-log.test.js.
// All volumes are stored in millilitres. Times are epoch milliseconds, shown in local time.

export const ML_PER_OZ = 29.5735; // US fluid ounce

export const DEFAULT_TYPES = [
  { name: 'Water', icon: '💧' },
  { name: 'Tea', icon: '🍵' },
  { name: 'Coffee', icon: '☕' },
  { name: 'Milk', icon: '🥛' },
  { name: 'Juice', icon: '🧃' },
  { name: 'Soft drink', icon: '🥤' },
  { name: 'Soup', icon: '🥣' },
  { name: 'Other', icon: '🫗' },
];

export const OUTPUT_TYPE = 'Urine';

export function defaultData(now = Date.now()) {
  return {
    version: 1,
    entries: [],
    // Target history: each item applies from its day onwards, so past days keep the target they had.
    targets: [{ from: '2000-01-01', ml: 2000 }],
    settings: {
      unit: 'ml',
      wake: '07:00',
      sleep: '22:00',
      types: DEFAULT_TYPES.map((t) => ({ ...t })),
      lastVol: {},
    },
    createdAt: now,
  };
}

const pad = (n) => String(n).padStart(2, '0');

/** Local calendar day, e.g. "2026-11-25". */
export function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight (ms) of a day key. */
export function dayStart(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

export function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d + n).getTime());
}

/** "YYYY-MM-DDTHH:MM" for <input type="datetime-local">. */
export function toLocalInput(t) {
  const d = new Date(t);
  return `${dayKey(t)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Parse "YYYY-MM-DDTHH:MM" as local time (avoids browser differences with Date parsing). */
export function fromLocalInput(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s || '');
  if (!m) return NaN;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
}

export function timeHM(t) {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function toUnit(ml, unit) {
  return unit === 'oz' ? ml / ML_PER_OZ : ml;
}

export function fromUnit(v, unit) {
  return unit === 'oz' ? v * ML_PER_OZ : v;
}

/** "1,250 ml" or "42.3 oz". */
export function fmtVol(ml, unit, withUnit = true) {
  const v = toUnit(ml, unit);
  const s = unit === 'oz'
    ? (Math.round(v * 10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 })
    : Math.round(v).toLocaleString('en-US');
  return withUnit ? `${s} ${unit === 'oz' ? 'oz' : 'ml'}` : s;
}

export function targetFor(targets, key) {
  let ml = 2000;
  for (const t of [...targets].sort((a, b) => a.from.localeCompare(b.from))) {
    if (t.from <= key) ml = t.ml;
  }
  return ml;
}

/** Set a new target from `fromKey` onwards (replaces any later changes). */
export function setTarget(targets, fromKey, ml) {
  const kept = targets.filter((t) => t.from < fromKey);
  return [...kept, { from: fromKey, ml: Math.round(ml) }];
}

export function entriesForDay(entries, key) {
  const start = dayStart(key);
  const end = dayStart(addDays(key, 1));
  return entries.filter((e) => e.t >= start && e.t < end).sort((a, b) => a.t - b.t);
}

export function summarize(entries, targets, key) {
  const list = entriesForDay(entries, key);
  let intake = 0, output = 0, drinks = 0, voids = 0;
  const byType = {};
  for (const e of list) {
    if (e.kind === 'in') {
      intake += e.ml; drinks += 1;
      byType[e.type] = (byType[e.type] || 0) + e.ml;
    } else {
      output += e.ml; voids += 1;
    }
  }
  const target = targetFor(targets, key);
  return {
    key, intake, output, drinks, voids, byType, target,
    balance: intake - output,
    pct: target > 0 ? intake / target : 0,
    met: intake >= target,
    remaining: Math.max(0, target - intake),
    entries: list,
  };
}

/** One summary per day from `fromKey` to `toKey` (inclusive), oldest first. */
export function dailySeries(entries, targets, fromKey, toKey) {
  const out = [];
  for (let k = fromKey; k <= toKey; k = addDays(k, 1)) out.push(summarize(entries, targets, k));
  return out;
}

const hm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

/**
 * How much you'd expect to have drunk by `now`, spreading the target evenly over waking hours.
 * Returns null when `now` isn't on `key` (past/future days have no pace).
 */
export function expectedByNow(target, key, now, wake = '07:00', sleep = '22:00') {
  if (dayKey(now) !== key) return null;
  const d = new Date(now);
  const mins = d.getHours() * 60 + d.getMinutes();
  const a = hm(wake), b = hm(sleep);
  if (b <= a) return target;
  const frac = Math.min(1, Math.max(0, (mins - a) / (b - a)));
  return Math.round(target * frac);
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Every entry as CSV, oldest first. */
export function entriesCSV(entries) {
  const rows = [['date', 'time', 'direction', 'type', 'volume_ml', 'volume_oz', 'note', 'timestamp_iso']];
  for (const e of [...entries].sort((a, b) => a.t - b.t)) {
    rows.push([
      dayKey(e.t), timeHM(e.t), e.kind === 'in' ? 'intake' : 'output', e.type,
      Math.round(e.ml), (e.ml / ML_PER_OZ).toFixed(1), e.note || '', new Date(e.t).toISOString(),
    ]);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** One row per day with totals vs target. */
export function dailyCSV(entries, targets) {
  const rows = [['date', 'intake_ml', 'output_ml', 'balance_ml', 'target_ml', 'percent_of_target', 'target_met', 'drinks', 'voids']];
  if (entries.length) {
    const ts = entries.map((e) => e.t);
    for (const s of dailySeries(entries, targets, dayKey(Math.min(...ts)), dayKey(Math.max(...ts)))) {
      rows.push([s.key, s.intake, s.output, s.balance, s.target, Math.round(s.pct * 100), s.met ? 'yes' : 'no', s.drinks, s.voids]);
    }
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Validate and normalise an imported JSON backup. Throws on bad input. */
export function parseBackup(text) {
  const obj = JSON.parse(text);
  if (!obj || !Array.isArray(obj.entries)) throw new Error('This file is not a Fluid Log backup.');
  const base = defaultData();
  const entries = obj.entries
    .filter((e) => e && (e.kind === 'in' || e.kind === 'out') && Number.isFinite(e.t) && Number.isFinite(e.ml) && e.ml >= 0)
    .map((e) => ({
      id: String(e.id || uid()),
      kind: e.kind,
      type: String(e.type || (e.kind === 'out' ? OUTPUT_TYPE : 'Water')).slice(0, 40),
      ml: Math.round(e.ml),
      t: e.t,
      note: e.note ? String(e.note).slice(0, 500) : '',
    }));
  const targets = Array.isArray(obj.targets)
    ? obj.targets.filter((t) => t && /^\d{4}-\d{2}-\d{2}$/.test(t.from) && t.ml > 0)
    : [];
  return {
    ...base,
    entries,
    targets: targets.length ? targets : base.targets,
    settings: { ...base.settings, ...(obj.settings || {}) },
  };
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
