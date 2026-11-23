// Small SVG charts. No library, so they work offline.
// Every chart is interactive: tap or drag across it to pick a point, or use the ‹ › buttons to step through.
// The picked point's weekday, date and value show under the chart.
import { fmtDate } from './dates.js';

const W = 340, H = 170, L = 34, R = 8, T = 10, B = 24;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const r1 = (v) => Math.round(v * 10) / 10;

function axis(max, fmt, invertMin) {
  const ticks = [0, 0.5, 1];
  return ticks.map((f) => {
    const y = T + (H - T - B) * (1 - f);
    const v = invertMin != null ? invertMin + (max - invertMin) * f : max * f;
    return `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" class="grid"/><text x="${L - 6}" y="${y + 4}" text-anchor="end" class="tick">${esc(fmt(v))}</text>`;
  }).join('');
}

// The text under the chart for one point: "Mon 17 Nov · 6:14 /km · Easy + strides, 3.56 km".
const infoText = (p, value) => [p.date ? fmtDate(p.date) : p.label, value, p.note].filter(Boolean).join(' · ');

// Wraps a chart so it can be tapped, dragged and stepped through.
// pts: [{ x, y, text }] in chart units (y null for bars). band: highlight width (bars), 0 for a thin line.
function interactive(inner, pts, ariaLabel, band = 0) {
  const i = pts.length - 1; // start on the latest point
  const p = pts[i];
  const w = Math.max(2, band);
  const data = esc(JSON.stringify(pts.map((q) => [r1(q.x), q.y == null ? null : r1(q.y), q.text])));
  return `<div class="ichart" data-pts="${data}" data-i="${i}" data-band="${w}">
    <svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${esc(ariaLabel)}">
      <rect class="cursor" x="${r1(p.x - w / 2)}" y="${T}" width="${w}" height="${H - T - B}"/>
      ${inner}
      <circle class="sel" cx="${r1(p.x)}" cy="${p.y == null ? -20 : r1(p.y)}" r="6"/>
    </svg>
    <div class="cinfo">
      <button type="button" class="cstep" data-step="-1" aria-label="Previous point"${i === 0 ? ' disabled' : ''}>‹</button>
      <span class="ctext" aria-live="polite">${esc(p.text)}</span>
      <button type="button" class="cstep" data-step="1" aria-label="Next point" disabled>›</button>
    </div>
  </div>`;
}

// rows: [{ label, planned, done, current, start }]. start = the week's Monday (YYYY-MM-DD).
export function weeklyBars(rows) {
  if (!rows.length) return '';
  const max = Math.max(10, ...rows.map((r) => Math.max(r.planned, r.done))) * 1.1;
  const band = (W - L - R) / rows.length;
  const bw = Math.min(14, band * 0.38);
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const step = Math.ceil(rows.length / 8);
  const pts = [];
  const bars = rows.map((r, i) => {
    const x = L + band * i + band / 2;
    const when = r.start ? `from ${fmtDate(r.start)}` : '';
    pts.push({ x, y: null, text: [`Week ${r.label}`, when, `${r.done} of ${r.planned} km done`].filter(Boolean).join(' · ') });
    return `<rect x="${x - bw - 1}" y="${y(r.planned)}" width="${bw}" height="${H - B - y(r.planned)}" rx="2" class="bar-planned"/>
      <rect x="${x + 1}" y="${y(r.done)}" width="${bw}" height="${H - B - y(r.done)}" rx="2" class="bar-done"/>
      ${i % step === 0 || r.current ? `<text x="${x}" y="${H - 8}" text-anchor="middle" class="tick${r.current ? ' now' : ''}">${esc(r.label)}</text>` : ''}`;
  }).join('');
  return interactive(axis(max, (v) => Math.round(v)) + bars, pts, 'Weekly kilometres, planned and done', band * 0.9);
}

// points: [{ label, date, y, note }]. lowerIsBetter flips the axis so "up" always means better.
// prefix and unit go around the value in the text under the chart (not on the axis).
export function line(points, { fmt = (v) => v.toFixed(1), prefix = '', unit = '', lowerIsBetter = false, label = 'Trend' } = {}) {
  if (points.length < 2) return '';
  const ys = points.map((p) => p.y);
  let lo = Math.min(...ys), hi = Math.max(...ys);
  const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.05 || 1;
  lo -= pad; hi += pad;
  const x = (i) => L + ((W - L - R) * i) / (points.length - 1);
  const y = (v) => { const f = (v - lo) / (hi - lo); return T + (H - T - B) * (lowerIsBetter ? f : 1 - f); };
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join('');
  const ticks = [0, 0.5, 1].map((f) => {
    const v = lo + (hi - lo) * f;
    const yy = y(v);
    return `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" class="grid"/><text x="${L - 6}" y="${yy + 4}" text-anchor="end" class="tick">${esc(fmt(v))}</text>`;
  }).join('');
  const step = Math.ceil(points.length / 6);
  // Every step-th date plus the last one, skipping any that would crowd the last.
  const labels = points.map((p, i) => ((i % step === 0 && i <= points.length - 1 - step * 0.8) || i === points.length - 1)
    ? `<text x="${x(i)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}" class="tick">${esc(p.label)}</text>` : '').join('');
  const marks = points.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.y)}" r="3" class="dot"/>`).join('');
  const pts = points.map((p, i) => ({ x: x(i), y: y(p.y), text: infoText(p, prefix + fmt(p.y) + unit) }));
  return interactive(`${ticks}<path d="${path}" class="line"/>${marks}${labels}`, pts, label);
}

// One dot per run plus a straight trend line. points: [{ label, date, y, cls, note }].
export function dots(points, { fmt = (v) => v.toFixed(0), prefix = '', unit = '', lowerIsBetter = false, label = 'Per run' } = {}) {
  if (points.length < 2) return '';
  const ys = points.map((p) => p.y);
  let lo = Math.min(...ys), hi = Math.max(...ys);
  const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.05 || 1;
  lo -= pad; hi += pad;
  const n = points.length;
  const x = (i) => L + 6 + ((W - L - R - 12) * i) / (n - 1);
  const y = (v) => { const f = (v - lo) / (hi - lo); return T + (H - T - B) * (lowerIsBetter ? f : 1 - f); };
  // Least-squares trend line.
  const mx = (n - 1) / 2, my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  ys.forEach((v, i) => { num += (i - mx) * (v - my); den += (i - mx) ** 2; });
  const slope = den ? num / den : 0;
  const trend = `<line x1="${x(0)}" y1="${y(my - slope * mx)}" x2="${x(n - 1)}" y2="${y(my + slope * (n - 1 - mx))}" class="trend"/>`;
  const ticks = [0, 0.5, 1].map((f) => {
    const v = lo + (hi - lo) * f, yy = y(v);
    return `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" class="grid"/><text x="${L - 6}" y="${yy + 4}" text-anchor="end" class="tick">${esc(fmt(v))}</text>`;
  }).join('');
  const marks = points.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.y)}" r="4" class="pt ${p.cls || ''}"/>`).join('');
  const labels = `<text x="${x(0)}" y="${H - 8}" text-anchor="start" class="tick">${esc(points[0].label)}</text>
    <text x="${x(n - 1)}" y="${H - 8}" text-anchor="end" class="tick">${esc(points[n - 1].label)}</text>`;
  const pts = points.map((p, i) => ({ x: x(i), y: y(p.y), text: infoText(p, prefix + fmt(p.y) + unit) }));
  return interactive(`${ticks}${trend}${marks}${labels}`, pts, label);
}

// Picks point i on a chart: moves the highlight and updates the text and buttons.
function pick(box, i) {
  const pts = JSON.parse(box.dataset.pts);
  i = Math.max(0, Math.min(pts.length - 1, i));
  if (String(i) === box.dataset.i) return;
  box.dataset.i = i;
  const [x, y, text] = pts[i];
  const band = Number(box.dataset.band);
  const cur = box.querySelector('.cursor');
  cur.setAttribute('x', r1(x - band / 2));
  const sel = box.querySelector('.sel');
  sel.setAttribute('cx', x);
  sel.setAttribute('cy', y == null ? -20 : y);
  box.querySelector('.ctext').textContent = text;
  const [prev, next] = box.querySelectorAll('.cstep');
  prev.disabled = i === 0;
  next.disabled = i === pts.length - 1;
}

// The point nearest to where the finger is, across the chart.
function nearest(box, clientX) {
  const rect = box.querySelector('svg').getBoundingClientRect();
  const vx = ((clientX - rect.left) / rect.width) * W;
  const pts = JSON.parse(box.dataset.pts);
  let best = 0;
  pts.forEach((p, i) => { if (Math.abs(p[0] - vx) < Math.abs(pts[best][0] - vx)) best = i; });
  return best;
}

// Call once at startup. Works for every chart drawn later, since it listens on the whole page.
export function wireCharts(doc = document) {
  let drag = null;
  doc.addEventListener('pointerdown', (e) => {
    const svg = e.target.closest?.('.ichart svg');
    if (!svg) return;
    drag = svg.parentElement;
    pick(drag, nearest(drag, e.clientX));
  });
  doc.addEventListener('pointermove', (e) => { if (drag) pick(drag, nearest(drag, e.clientX)); });
  for (const t of ['pointerup', 'pointercancel']) doc.addEventListener(t, () => { drag = null; });
  doc.addEventListener('click', (e) => {
    const b = e.target.closest?.('.cstep');
    if (!b) return;
    const box = b.closest('.ichart');
    pick(box, Number(box.dataset.i) + Number(b.dataset.step));
  });
}
