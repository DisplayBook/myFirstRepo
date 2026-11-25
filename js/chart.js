/**
 * Weekly chart: two small panels sharing the same days, so there's no
 * dual axis:
 *   1. Sessions completed per day (bars)
 *   2. Daily average symptoms, 0 to 10 (toe pain = blue line, heat/redness = orange line)
 * Tapping or hovering a day shows the exact values. A data table is also provided.
 */

import { esc } from './util.js';

const W = 340;
const PAD_L = 28;
const PAD_R = 44; // room for direct labels
const plotW = W - PAD_L - PAD_R;

function xFor(i, n) {
  return PAD_L + (plotW / n) * (i + 0.5);
}

function sessionsPanel(data) {
  const H = 120, top = 10, bottom = 24, ph = H - top - bottom;
  const max = Math.max(3, ...data.map((d) => d.sessions));
  const n = data.length;
  const band = plotW / n;
  const bw = Math.min(26, band - 10);
  const y = (v) => top + ph - (v / max) * ph;
  const ticks = [0, Math.ceil(max / 2), max];
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Sessions completed each day, last 7 days">`;
  ticks.forEach((t) => {
    s += `<line class="grid" x1="${PAD_L}" x2="${W - PAD_R}" y1="${y(t)}" y2="${y(t)}"/>`;
    s += `<text x="${PAD_L - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`;
  });
  data.forEach((d, i) => {
    const x = xFor(i, n);
    if (d.sessions > 0) {
      const h = y(0) - y(d.sessions);
      const r = Math.min(4, h / 2);
      // Rounded top, square base anchored to the baseline.
      s += `<path class="bar" d="M${x - bw / 2} ${y(0)} V${y(d.sessions) + r} Q${x - bw / 2} ${y(d.sessions)} ${x - bw / 2 + r} ${y(d.sessions)} H${x + bw / 2 - r} Q${x + bw / 2} ${y(d.sessions)} ${x + bw / 2} ${y(d.sessions) + r} V${y(0)} Z"/>`;
    }
    s += `<text x="${x}" y="${H - 6}" text-anchor="middle">${esc(d.label)}</text>`;
    s += `<rect class="hit" data-day="${i}" x="${x - band / 2}" y="${top}" width="${band}" height="${ph}" rx="6"/>`;
  });
  s += `<line class="axis" x1="${PAD_L}" x2="${W - PAD_R}" y1="${y(0)}" y2="${y(0)}"/>`;
  return s + '</svg>';
}

function symptomsPanel(data) {
  const H = 150, top = 10, bottom = 24, ph = H - top - bottom;
  const n = data.length;
  const band = plotW / n;
  const y = (v) => top + ph - (v / 10) * ph;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Average little-toe pain and heat or redness each day, scale 0 to 10">`;
  [0, 5, 10].forEach((t) => {
    s += `<line class="grid" x1="${PAD_L}" x2="${W - PAD_R}" y1="${y(t)}" y2="${y(t)}"/>`;
    s += `<text x="${PAD_L - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`;
  });
  const series = [
    { key: 'toePain', cls: 1, name: 'Toe' },
    { key: 'heat', cls: 2, name: 'Heat' },
  ];
  series.forEach(({ key, cls, name }) => {
    // Lines break where a day has no log.
    let path = '';
    let pen = false;
    data.forEach((d, i) => {
      if (d[key] === null) { pen = false; return; }
      path += `${pen ? 'L' : 'M'}${xFor(i, n)} ${y(d[key])} `;
      pen = true;
    });
    if (path) s += `<path class="line-${cls}" d="${path}" fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    data.forEach((d, i) => {
      if (d[key] !== null) s += `<circle class="dot-${cls}" cx="${xFor(i, n)}" cy="${y(d[key])}" r="4.5"/>`;
    });
    // Direct label at the last logged point.
    const lastIdx = data.map((d) => d[key]).findLastIndex((v) => v !== null);
    if (lastIdx >= 0) {
      const ly = y(data[lastIdx][key]) + (cls === 1 ? -6 : 14);
      s += `<text class="label" x="${xFor(n - 1, n) + 12}" y="${Math.max(12, Math.min(H - bottom, ly))}">${name}</text>`;
    }
  });
  data.forEach((d, i) => {
    const x = xFor(i, n);
    s += `<text x="${x}" y="${H - 6}" text-anchor="middle">${esc(d.label)}</text>`;
    s += `<rect class="hit" data-day="${i}" x="${x - band / 2}" y="${top}" width="${band}" height="${ph}" rx="6"/>`;
  });
  s += `<line class="axis" x1="${PAD_L}" x2="${W - PAD_R}" y1="${y(0)}" y2="${y(0)}"/>`;
  return s + '</svg>';
}

export function tipText(d) {
  const v = (x) => (x === null ? 'not logged' : `${x}/10`);
  const date = new Date(d.date + 'T12:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
  return `${date}: ${d.sessions} session${d.sessions === 1 ? '' : 's'}. Toe pain ${v(d.toePain)}, heat/redness ${v(d.heat)}.`;
}

/** Full chart block (HTML string). Call `wireChart(root, data)` after inserting. */
export function weeklyChart(data) {
  const rows = data
    .map((d) => `<tr><td>${esc(d.label)} ${esc(d.date.slice(5))}</td><td class="num">${d.sessions}</td><td class="num">${d.toePain ?? '–'}</td><td class="num">${d.heat ?? '–'}</td></tr>`)
    .join('');
  return `
    <div class="chart-block">
      <h3>Sessions completed</h3>
      ${sessionsPanel(data)}
      <h3 style="margin-top:12px">Symptoms (daily average, 0 to 10)</h3>
      <div class="legend" aria-hidden="true">
        <span><i style="background:var(--series-1)"></i>Little-toe pain</span>
        <span><i style="background:var(--series-2)"></i>Heat / redness</span>
      </div>
      ${symptomsPanel(data)}
      <p class="chart-tip" aria-live="polite">Tap a day to see its numbers.</p>
      <details>
        <summary class="icon-btn" style="display:inline-flex">Show as a table</summary>
        <table class="data" style="margin-top:8px">
          <thead><tr><th>Day</th><th class="num">Sessions</th><th class="num">Toe pain</th><th class="num">Heat</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </details>
    </div>`;
}

/** Hover/tap handling for the chart's day columns. */
export function wireChart(root, data) {
  const tip = root.querySelector('.chart-tip');
  const show = (i) => {
    root.querySelectorAll('.hit').forEach((r) => r.classList.toggle('active', r.dataset.day === String(i)));
    tip.textContent = tipText(data[i]);
  };
  root.querySelectorAll('.hit').forEach((r) => {
    r.addEventListener('pointerenter', () => show(r.dataset.day));
    r.addEventListener('click', () => show(r.dataset.day));
  });
}
