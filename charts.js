// Small SVG charts. No library, so they work offline.
const W = 340, H = 170, L = 34, R = 8, T = 10, B = 24;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function axis(max, fmt, invertMin) {
  const ticks = [0, 0.5, 1];
  return ticks.map((f) => {
    const y = T + (H - T - B) * (1 - f);
    const v = invertMin != null ? invertMin + (max - invertMin) * f : max * f;
    return `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" class="grid"/><text x="${L - 6}" y="${y + 4}" text-anchor="end" class="tick">${esc(fmt(v))}</text>`;
  }).join('');
}

// rows: [{ label, planned, done, current }]
export function weeklyBars(rows) {
  if (!rows.length) return '';
  const max = Math.max(10, ...rows.map((r) => Math.max(r.planned, r.done))) * 1.1;
  const band = (W - L - R) / rows.length;
  const bw = Math.min(14, band * 0.38);
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const bars = rows.map((r, i) => {
    const x = L + band * i + band / 2;
    const step = Math.ceil(rows.length / 8);
    return `<rect x="${x - bw - 1}" y="${y(r.planned)}" width="${bw}" height="${H - B - y(r.planned)}" rx="2" class="bar-planned"><title>Week ${r.label}: ${r.planned} km planned</title></rect>
      <rect x="${x + 1}" y="${y(r.done)}" width="${bw}" height="${H - B - y(r.done)}" rx="2" class="bar-done"><title>Week ${r.label}: ${r.done} km done</title></rect>
      ${i % step === 0 || r.current ? `<text x="${x}" y="${H - 8}" text-anchor="middle" class="tick${r.current ? ' now' : ''}">${esc(r.label)}</text>` : ''}`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Weekly kilometres, planned and done">${axis(max, (v) => Math.round(v))}${bars}</svg>`;
}

// points: [{ label, y }]. lowerIsBetter flips the axis so "up" always means better.
export function line(points, { fmt = (v) => v.toFixed(1), lowerIsBetter = false, label = 'Trend' } = {}) {
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
  const labels = points.map((p, i) => (i % step === 0 || i === points.length - 1)
    ? `<text x="${x(i)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}" class="tick">${esc(p.label)}</text>` : '').join('');
  const dots = points.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.y)}" r="3" class="dot"><title>${esc(p.label)}: ${esc(fmt(p.y))}</title></circle>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${esc(label)}">${ticks}<path d="${path}" class="line"/>${dots}${labels}</svg>`;
}
