// Run analysis for the Progress tab. Pure functions, tested in Node.
import { addDays } from './dates.js';

const EASY = new Set(['easy', 'strides', 'long', 'shakeout', 'extra']);

// Every logged run, planned or extra, oldest first.
export function runList(plan, logs, extras) {
  const planned = plan.weeks.flatMap((w) => w.workouts)
    .filter((w) => logs[w.id]?.status === 'done')
    .map((w) => ({ id: w.id, date: w.date, type: w.type, ...logs[w.id] }));
  const extra = extras.map((e) => ({ type: 'extra', ...e }));
  return [...planned, ...extra].sort((a, b) => a.date.localeCompare(b.date));
}

export function filterRuns(runs, { where = 'all', kind = 'all' } = {}) {
  return runs.filter((r) =>
    (where === 'all' || (where === 'treadmill') === !!r.treadmill) &&
    (kind === 'all' || EASY.has(r.type)));
}

// Personal records. Races and time trials count exactly; other runs of about the
// right length are scaled to the exact distance and marked as estimates.
export function records(runs) {
  const best = (km, lo, hi) => {
    let top = null;
    for (const r of runs) {
      let sec = null, est = false;
      if (r.resultSec && r.type === 'trial' && km === 5) sec = r.resultSec;
      else if (r.resultSec && r.type === 'race' && r.km >= lo && r.km <= hi) sec = r.resultSec;
      else if (r.sec && r.km >= lo && r.km <= hi) { sec = (r.sec * km) / r.km; est = Math.abs(r.km - km) > 0.05; }
      if (sec && (!top || sec < top.sec)) top = { sec: Math.round(sec), date: r.date, est };
    }
    return top;
  };
  let longest = null, fastest = null;
  for (const r of runs) {
    if (r.km && (!longest || r.km > longest.km)) longest = { km: r.km, date: r.date };
    if (r.sec && r.km >= 3 && (!fastest || r.sec / r.km < fastest.pace)) fastest = { pace: r.sec / r.km, km: r.km, date: r.date };
  }
  return {
    fiveK: best(5, 4.95, 5.3), tenK: best(10, 9.9, 10.6),
    half: best(21.0975, 21, 21.6), marathon: best(42.195, 42, 43),
    longest, fastest,
  };
}

// Averages for a set of runs. Pace is total time / total km. Heart rate is time-weighted.
// Heartbeats per km = HR x minutes per km: lower means fitter (same distance, fewer beats).
export function averages(runs) {
  const timed = runs.filter((r) => r.sec && r.km);
  const withHr = timed.filter((r) => r.hr);
  const sum = (arr, f) => arr.reduce((s, r) => s + f(r), 0);
  const pace = timed.length ? sum(timed, (r) => r.sec) / sum(timed, (r) => r.km) : null;
  const hr = withHr.length ? sum(withHr, (r) => r.hr * r.sec) / sum(withHr, (r) => r.sec) : null;
  const beats = withHr.length ? sum(withHr, (r) => (r.hr * r.sec) / 60) / sum(withHr, (r) => r.km) : null;
  return { n: runs.length, pace, hr, beats };
}

// Last 28 days against the 28 days before.
export function compare(runs, today) {
  const a = addDays(today, -27), b = addDays(today, -55);
  return {
    recent: averages(runs.filter((r) => r.date >= a && r.date <= today)),
    before: averages(runs.filter((r) => r.date >= b && r.date < a)),
  };
}
