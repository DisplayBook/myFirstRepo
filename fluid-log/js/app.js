// Fluid Log: UI. Views: #/day[/YYYY-MM-DD], #/history, #/settings.
import {
  defaultData, dayKey, addDays, toLocalInput, fromLocalInput, timeHM, toUnit, fromUnit, fmtVol,
  targetFor, setTarget, summarize, dailySeries, expectedByNow, entriesCSV, dailyCSV, parseBackup,
  uid, OUTPUT_TYPE,
} from './logic.js';

const KEY = 'fluidlog.v1';
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- storage ----------
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return parseBackup(raw);
  } catch (e) { console.warn('Could not read saved data', e); }
  return defaultData();
}
let data = load();
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(data)); }
  catch (e) { toast('Could not save. Storage may be full or blocked.'); }
}
// Ask the browser not to evict our data (best effort).
navigator.storage?.persist?.().catch(() => {});

const unit = () => data.settings.unit;
const typeIcon = (name) => data.settings.types.find((t) => t.name === name)?.icon || (name === OUTPUT_TYPE ? '🚽' : '🫗');
const today = () => dayKey(Date.now());

// ---------- toast ----------
let toastTimer;
function toast(msg, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button" class="link-btn">${esc(action.label)}</button>` : ''}`;
  el.hidden = false;
  if (action) el.querySelector('button').onclick = () => { action.run(); el.hidden = true; };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), action ? 6000 : 2500);
}

// ---------- router ----------
function route() {
  const [, view = 'day', arg] = (location.hash || '#/day').split('/');
  document.querySelectorAll('.tabbar a').forEach((a) => a.setAttribute('aria-current', a.dataset.tab === view ? 'page' : 'false'));
  const main = $('#main');
  if (view === 'history') main.innerHTML = historyView();
  else if (view === 'settings') main.innerHTML = settingsView();
  else main.innerHTML = dayView(/^\d{4}-\d{2}-\d{2}$/.test(arg || '') ? arg : today());
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

// ---------- day view ----------
function prettyDay(key) {
  const t = today();
  const label = key === t ? 'Today' : key === addDays(t, -1) ? 'Yesterday' : '';
  const d = new Date(`${key}T12:00`);
  const date = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  return label ? `${label} · ${date}` : date;
}

function ring(pct) {
  const r = 52, c = 2 * Math.PI * r;
  const p = Math.min(1, pct);
  return `<svg class="ring" viewBox="0 0 120 120" aria-hidden="true">
    <circle class="ring-track" cx="60" cy="60" r="${r}"/>
    <circle class="ring-fill ${pct >= 1 ? 'met' : ''}" cx="60" cy="60" r="${r}"
      stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - p)}" transform="rotate(-90 60 60)"/>
  </svg>`;
}

function dayView(key) {
  const s = summarize(data.entries, data.targets, key);
  const u = unit();
  const isToday = key === today();
  const exp = expectedByNow(s.target, key, Date.now(), data.settings.wake, data.settings.sleep);
  let status;
  if (s.met) status = `<span class="ok">Target reached${s.intake > s.target ? ` · ${fmtVol(s.intake - s.target, u)} over` : ''}</span>`;
  else if (exp != null) {
    const diff = s.intake - exp;
    status = `${fmtVol(s.remaining, u)} to go · ` + (diff >= 0
      ? `<span class="ok">on pace</span>`
      : `<span class="warn">${fmtVol(-diff, u)} behind pace</span>`);
  } else status = `${fmtVol(s.remaining, u)} short of target`;

  const quick = data.settings.types.map((t) => `
    <button type="button" class="quick" data-add="in" data-type="${esc(t.name)}">
      <span class="q-icon" aria-hidden="true">${esc(t.icon)}</span><span>${esc(t.name)}</span>
    </button>`).join('');

  const list = s.entries.length ? [...s.entries].reverse().map((e) => `
    <li><button type="button" class="entry ${e.kind}" data-edit="${esc(e.id)}">
      <span class="e-time">${timeHM(e.t)}</span>
      <span class="e-icon" aria-hidden="true">${esc(e.kind === 'out' ? '🚽' : typeIcon(e.type))}</span>
      <span class="e-main">${esc(e.kind === 'out' ? 'Urine output' : e.type)}${e.note ? `<small>${esc(e.note)}</small>` : ''}</span>
      <span class="e-vol">${e.kind === 'out' ? '−' : '+'}${fmtVol(e.ml, u)}</span>
    </button></li>`).join('')
    : `<li class="empty">Nothing logged ${isToday ? 'yet today' : 'on this day'}.</li>`;

  const byType = Object.entries(s.byType).sort((a, b) => b[1] - a[1])
    .map(([n, ml]) => `<span class="pill">${esc(typeIcon(n))} ${esc(n)} ${fmtVol(ml, u)}</span>`).join('');

  return `
  <header class="day-nav">
    <a class="icon-btn" href="#/day/${addDays(key, -1)}" aria-label="Previous day">‹</a>
    <h1>${esc(prettyDay(key))}</h1>
    ${isToday ? '<span class="icon-btn placeholder"></span>' : `<a class="icon-btn" href="#/day/${addDays(key, 1)}" aria-label="Next day">›</a>`}
  </header>

  <section class="card progress" aria-label="Progress against target">
    <div class="ring-wrap">
      ${ring(s.pct)}
      <div class="ring-text">
        <strong>${Math.round(s.pct * 100)}%</strong>
        <span>${fmtVol(s.intake, u, false)} / ${fmtVol(s.target, u)}</span>
      </div>
    </div>
    <p class="status">${status}</p>
    <div class="stats">
      <div><span>Intake</span><strong class="c-in">${fmtVol(s.intake, u)}</strong><small>${s.drinks} drink${s.drinks === 1 ? '' : 's'}</small></div>
      <div><span>Output</span><strong class="c-out">${fmtVol(s.output, u)}</strong><small>${s.voids} time${s.voids === 1 ? '' : 's'}</small></div>
      <div><span>Balance</span><strong>${s.balance >= 0 ? '+' : '−'}${fmtVol(Math.abs(s.balance), u)}</strong><small>in − out</small></div>
    </div>
    ${byType ? `<div class="pills">${byType}</div>` : ''}
  </section>

  <section>
    <h2>Add a drink</h2>
    <div class="quick-grid">${quick}</div>
    <button type="button" class="btn btn-out btn-block" data-add="out">🚽 Log urine output</button>
  </section>

  <section>
    <h2>Entries <small>tap to edit</small></h2>
    <ul class="entries" data-day="${key}">${list}</ul>
  </section>`;
}

// ---------- history view ----------
let range = 14;
function chart(series) {
  const u = unit();
  const W = 340, H = 180, padL = 34, padB = 22, padT = 8;
  const max = Math.max(1, ...series.map((s) => Math.max(s.intake, s.output, s.target))) * 1.1;
  const bw = (W - padL) / series.length;
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const step = Math.ceil(series.length / 7);
  const ticks = [0, max / 2, max / 1.1].map((v) => `
    <line class="grid" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/>
    <text class="axis" x="${padL - 4}" y="${y(v) + 3}" text-anchor="end">${fmtVol(v, u, false)}</text>`).join('');
  const bars = series.map((s, i) => {
    const x = padL + i * bw;
    const w = Math.max(2, bw * 0.38);
    return `<g>
      <title>${s.key}: intake ${fmtVol(s.intake, u)}, output ${fmtVol(s.output, u)}, target ${fmtVol(s.target, u)}</title>
      <rect class="bar-in ${s.met ? 'met' : ''}" x="${x + bw * 0.1}" y="${y(s.intake)}" width="${w}" height="${y(0) - y(s.intake)}" rx="2"/>
      <rect class="bar-out" x="${x + bw * 0.1 + w + 1}" y="${y(s.output)}" width="${w}" height="${y(0) - y(s.output)}" rx="2"/>
      <line class="target" x1="${x + bw * 0.05}" x2="${x + bw * 0.95}" y1="${y(s.target)}" y2="${y(s.target)}"/>
      ${i % step === 0 ? `<text class="axis" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${+s.key.slice(8)}</text>` : ''}
    </g>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily intake and output for the last ${series.length} days">${ticks}${bars}</svg>
    <div class="legend"><span><i class="sw sw-in"></i>Intake</span><span><i class="sw sw-out"></i>Output</span><span><i class="sw sw-target"></i>Target</span></div>`;
}

function historyView() {
  const u = unit();
  const t = today();
  const series = dailySeries(data.entries, data.targets, addDays(t, -(range - 1)), t);
  const logged = series.filter((s) => s.drinks || s.voids);
  const avg = (f) => (logged.length ? logged.reduce((a, s) => a + f(s), 0) / logged.length : 0);
  const met = logged.filter((s) => s.met).length;

  const rows = [...series].reverse().map((s) => `
    <li><a class="day-row" href="#/day/${s.key}">
      <span class="d-date">${esc(new Date(`${s.key}T12:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }))}</span>
      <span class="d-bar"><i style="width:${Math.min(100, s.pct * 100)}%" class="${s.met ? 'met' : ''}"></i></span>
      <span class="d-nums"><b class="c-in">${fmtVol(s.intake, u, false)}</b> / <b class="c-out">${fmtVol(s.output, u, false)}</b></span>
      <span class="d-flag" aria-label="${s.met ? 'Target met' : 'Target not met'}">${s.met ? '✓' : ''}</span>
    </a></li>`).join('');

  return `
  <header class="page-head"><h1>History</h1></header>
  <div class="segmented small" role="group" aria-label="Range">
    ${[7, 14, 30, 90].map((n) => `<button type="button" data-range="${n}" aria-pressed="${n === range}">${n} days</button>`).join('')}
  </div>
  <section class="card">
    ${chart(series)}
    <div class="stats">
      <div><span>Avg intake</span><strong class="c-in">${fmtVol(avg((s) => s.intake), u)}</strong></div>
      <div><span>Avg output</span><strong class="c-out">${fmtVol(avg((s) => s.output), u)}</strong></div>
      <div><span>Target met</span><strong>${met}/${logged.length}</strong><small>days logged</small></div>
    </div>
  </section>
  <section>
    <h2>Days <small>intake / output (${u})</small></h2>
    <ul class="days">${rows}</ul>
  </section>
  <section class="card">
    <h2>Export</h2>
    <p class="muted">Download everything to open in Excel, Numbers or Google Sheets.</p>
    <div class="btn-col">
      <button type="button" class="btn" data-export="entries">All entries (CSV)</button>
      <button type="button" class="btn" data-export="daily">Daily totals (CSV)</button>
    </div>
  </section>`;
}

// ---------- settings view ----------
function settingsView() {
  const u = unit();
  const tgt = targetFor(data.targets, today());
  const types = data.settings.types.map((t, i) => `
    <li><span>${esc(t.icon)} ${esc(t.name)}</span>
      <span class="row-actions">
        <button type="button" class="icon-btn" data-move="${i}" data-dir="-1" aria-label="Move ${esc(t.name)} up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="icon-btn" data-remove-type="${i}" aria-label="Remove ${esc(t.name)}">✕</button>
      </span></li>`).join('');
  return `
  <header class="page-head"><h1>Settings</h1></header>

  <form class="card" id="target-form">
    <h2>Daily intake target</h2>
    <label class="vol-input">
      <span class="sr-only">Daily target</span>
      <input name="target" type="number" inputmode="decimal" min="1" step="any" value="${u === 'oz' ? (Math.round(toUnit(tgt, u) * 10) / 10) : tgt}" required>
      <span>${u}</span>
    </label>
    <p class="muted">Applies from today. Earlier days keep the target they had.</p>
    <button class="btn btn-primary btn-block" type="submit">Save target</button>
  </form>

  <section class="card">
    <h2>Units</h2>
    <div class="segmented" role="group" aria-label="Units">
      <button type="button" data-unit="ml" aria-pressed="${u === 'ml'}">Millilitres (ml)</button>
      <button type="button" data-unit="oz" aria-pressed="${u === 'oz'}">US fl oz</button>
    </div>
  </section>

  <form class="card" id="hours-form">
    <h2>Waking hours</h2>
    <p class="muted">Used to tell you if you're on pace through the day.</p>
    <div class="two">
      <label class="field"><span>Wake</span><input type="time" name="wake" value="${esc(data.settings.wake)}" required></label>
      <label class="field"><span>Sleep</span><input type="time" name="sleep" value="${esc(data.settings.sleep)}" required></label>
    </div>
    <button class="btn btn-block" type="submit">Save hours</button>
  </form>

  <section class="card">
    <h2>Drink types</h2>
    <ul class="type-list">${types}</ul>
    <form id="type-form" class="add-type">
      <input name="icon" maxlength="4" placeholder="🍹" aria-label="Icon (emoji)">
      <input name="name" maxlength="30" placeholder="New drink, e.g. Smoothie" aria-label="Drink name" required>
      <button class="btn" type="submit">Add</button>
    </form>
  </section>

  <section class="card">
    <h2>Your data</h2>
    <p class="muted">${data.entries.length} entries stored on this device only. Back up now and then, and keep the backup file somewhere safe (e.g. Files → iCloud Drive).</p>
    <div class="btn-col">
      <button type="button" class="btn" data-export="entries">Export all entries (CSV)</button>
      <button type="button" class="btn" data-export="daily">Export daily totals (CSV)</button>
      <button type="button" class="btn" data-export="backup">Back up (JSON)</button>
      <label class="btn">Restore from backup…<input type="file" id="import-file" accept="application/json,.json" hidden></label>
      <button type="button" class="btn btn-danger" data-wipe>Delete all data</button>
    </div>
  </section>

  <section class="card muted small-print">
    <h2>About</h2>
    <p>For best results on iPhone: open in Safari, tap <b>Share → Add to Home Screen</b>, and use it from the home-screen icon. It then works offline and your data is kept safely.</p>
    <p>Fluid Log is a personal tracker, not medical advice. Follow your clinician's guidance on fluid targets.</p>
  </section>`;
}

// ---------- entry sheet ----------
const dlg = $('#entry-dialog');
const form = $('#entry-form');
let editing = null; // entry id or null
let sheetType = 'Water';

const PRESETS = {
  in: { ml: [100, 150, 200, 250, 330, 500, 750], oz: [4, 6, 8, 12, 16, 20, 24] },
  out: { ml: [100, 150, 200, 300, 400, 500], oz: [3, 5, 7, 10, 14, 17] },
};

function sheetKind() { return form.kind.value; }

function renderSheet() {
  const kind = sheetKind();
  const u = unit();
  $('#entry-title').textContent = `${editing ? 'Edit' : 'Add'} ${kind === 'in' ? 'drink' : 'output'}`;
  $('#type-field').hidden = kind !== 'in';
  $('#type-chips').innerHTML = data.settings.types.map((t) => `
    <button type="button" class="chip" data-type="${esc(t.name)}" aria-pressed="${t.name === sheetType}">${esc(t.icon)} ${esc(t.name)}</button>`).join('');
  $('#vol-chips').innerHTML = PRESETS[kind][u].map((v) => `<button type="button" class="chip" data-vol="${v}">${v}</button>`).join('');
  $('#vol-unit').textContent = u;
  markVolChip();
}

function markVolChip() {
  const v = parseFloat($('#vol').value);
  document.querySelectorAll('#vol-chips .chip').forEach((c) => c.setAttribute('aria-pressed', String(+c.dataset.vol === v)));
}

function defaultVol(kind, type) {
  const last = data.settings.lastVol[kind === 'in' ? type : OUTPUT_TYPE];
  const ml = last ?? (kind === 'in' ? 250 : 300);
  const v = toUnit(ml, unit());
  return unit() === 'oz' ? Math.round(v * 10) / 10 : Math.round(v);
}

function openSheet({ kind = 'in', type, entry, dayKeyForNew } = {}) {
  editing = entry ? entry.id : null;
  form.reset();
  const k = entry ? entry.kind : kind;
  form.kind.value = k;
  sheetType = entry?.kind === 'in' ? entry.type : type || data.settings.types[0]?.name || 'Water';
  if (entry) {
    const v = toUnit(entry.ml, unit());
    $('#vol').value = unit() === 'oz' ? Math.round(v * 10) / 10 : entry.ml;
    $('#when').value = toLocalInput(entry.t);
    $('#note').value = entry.note || '';
  } else {
    $('#vol').value = defaultVol(k, sheetType);
    // On a past day, default to that day at the current clock time.
    const now = new Date();
    let t = now.getTime();
    if (dayKeyForNew && dayKeyForNew !== today()) t = fromLocalInput(`${dayKeyForNew}T${timeHM(now)}`);
    $('#when').value = toLocalInput(t);
  }
  $('#delete-entry').hidden = !entry;
  renderSheet();
  dlg.showModal();
}

form.addEventListener('change', (e) => {
  if (e.target.name === 'kind') {
    $('#vol').value = defaultVol(sheetKind(), sheetType);
    renderSheet();
  }
});
$('#vol').addEventListener('input', markVolChip);
form.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip?.dataset.type) {
    sheetType = chip.dataset.type;
    if (!editing) $('#vol').value = defaultVol('in', sheetType);
    renderSheet();
  } else if (chip?.dataset.vol) {
    $('#vol').value = chip.dataset.vol;
    markVolChip();
  } else if (e.target.closest('[data-close]')) dlg.close();
});
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // tap backdrop

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const kind = sheetKind();
  const ml = Math.round(fromUnit(parseFloat($('#vol').value), unit()));
  const t = fromLocalInput($('#when').value);
  if (!(ml > 0) || !Number.isFinite(t)) { toast('Please enter a volume and time.'); return; }
  const entry = {
    id: editing || uid(),
    kind,
    type: kind === 'in' ? sheetType : OUTPUT_TYPE,
    ml, t,
    note: $('#note').value.trim(),
  };
  if (editing) data.entries = data.entries.map((x) => (x.id === editing ? entry : x));
  else data.entries.push(entry);
  data.settings.lastVol[entry.type] = ml;
  save();
  dlg.close();
  toast(`${editing ? 'Updated' : 'Logged'} ${fmtVol(ml, unit())} ${kind === 'in' ? entry.type.toLowerCase() : 'output'}`);
  // Jump to the entry's day so the user sees it land.
  const k = dayKey(t);
  if (location.hash.startsWith('#/day') || !location.hash) {
    if (k === today()) { if (location.hash !== '#/day') location.hash = '#/day'; else route(); }
    else if (location.hash !== `#/day/${k}`) location.hash = `#/day/${k}`; else route();
  } else route();
});

$('#delete-entry').addEventListener('click', () => {
  const removed = data.entries.find((x) => x.id === editing);
  if (!removed) return;
  data.entries = data.entries.filter((x) => x.id !== editing);
  save(); dlg.close(); route();
  toast('Entry deleted', { label: 'Undo', run: () => { data.entries.push(removed); save(); route(); } });
});

// ---------- export / import ----------
async function deliver(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const file = new File([blob], filename, { type: mime });
  // iOS: the share sheet lets you save to Files, AirDrop, Mail, etc.
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function doExport(kind) {
  const stamp = today();
  if (kind === 'entries') deliver(`fluid-log-entries-${stamp}.csv`, entriesCSV(data.entries), 'text/csv');
  else if (kind === 'daily') deliver(`fluid-log-daily-${stamp}.csv`, dailyCSV(data.entries, data.targets), 'text/csv');
  else deliver(`fluid-log-backup-${stamp}.json`, JSON.stringify({ app: 'fluid-log', exportedAt: new Date().toISOString(), ...data }, null, 2), 'application/json');
}

// ---------- global click / submit handlers ----------
document.addEventListener('click', (e) => {
  const el = e.target.closest('button, a');
  if (!el || dlg.contains(el)) return;
  const d = el.dataset;
  if (d.add) {
    const day = $('.entries')?.dataset.day;
    openSheet({ kind: d.add, type: d.type, dayKeyForNew: day });
  } else if (d.edit) {
    const entry = data.entries.find((x) => x.id === d.edit);
    if (entry) openSheet({ entry });
  } else if (d.range) { range = +d.range; route(); }
  else if (d.export) doExport(d.export);
  else if (d.unit) { data.settings.unit = d.unit; save(); route(); }
  else if (d.removeType != null) {
    const t = data.settings.types[+d.removeType];
    if (data.settings.types.length <= 1) { toast('Keep at least one drink type.'); return; }
    data.settings.types.splice(+d.removeType, 1); save(); route();
    toast(`Removed ${t.name}. Past entries are kept.`);
  } else if (d.move != null) {
    const i = +d.move, j = i + +d.dir, arr = data.settings.types;
    if (j >= 0 && j < arr.length) { [arr[i], arr[j]] = [arr[j], arr[i]]; save(); route(); }
  } else if ('wipe' in d) {
    if (confirm('Delete ALL entries and settings from this device? Export a backup first if you might need it.')
      && confirm('Are you sure? This cannot be undone.')) {
      data = defaultData(); save(); route(); toast('All data deleted');
    }
  }
});

document.addEventListener('submit', (e) => {
  const f = e.target;
  if (f.id === 'target-form') {
    e.preventDefault();
    const ml = fromUnit(parseFloat(f.target.value), unit());
    if (!(ml > 0)) return;
    data.targets = setTarget(data.targets, today(), ml); save();
    toast(`Daily target set to ${fmtVol(ml, unit())}`);
  } else if (f.id === 'hours-form') {
    e.preventDefault();
    data.settings.wake = f.wake.value; data.settings.sleep = f.sleep.value; save();
    toast('Waking hours saved');
  } else if (f.id === 'type-form') {
    e.preventDefault();
    const name = f.name.value.trim();
    if (!name) return;
    if (data.settings.types.some((t) => t.name.toLowerCase() === name.toLowerCase())) { toast('That drink already exists.'); return; }
    data.settings.types.push({ name, icon: f.icon.value.trim() || '🫗' }); save(); route();
    toast(`Added ${name}`);
  }
});

document.addEventListener('change', async (e) => {
  if (e.target.id !== 'import-file') return;
  const file = e.target.files[0];
  if (!file) return;
  try {
    const next = parseBackup(await file.text());
    if (!confirm(`Replace the data on this device with ${next.entries.length} entries from the backup?`)) return;
    data = next; save(); route(); toast('Backup restored');
  } catch (err) { toast(err.message || 'Could not read that file.'); }
  finally { e.target.value = ''; }
});

// Re-render "today" if the app is reopened on a new day or after a while.
document.addEventListener('visibilitychange', () => { if (!document.hidden && !dlg.open) route(); });

route();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
