// Builds a training plan. Pure functions only (no DOM, no storage) so it can be tested in Node.
import { addDays, weekday, mondayOf, daysBetween } from './dates.js';
import { DIST, paces, predict } from './vdot.js';

// Seconds per km for every zone used in steps.
export function zonePaces(vdot, goal, goalTime) {
  const p = paces(vdot);
  const goalPace = goalTime ? goalTime / (DIST[goal] / 1000) : predict(vdot, DIST[goal]) / (DIST[goal] / 1000);
  return {
    ...p, easy: (p.easySlow + p.easyFast) / 2, jog: p.easySlow + 20,
    race5k: p.fiveK, goal: goalPace, race: goalPace,
  };
}

// Per-goal settings: peak long run (km), weekly km range, taper weeks.
const GOALS = {
  '5k':     { peakLong: 12, minPeak: 20, maxPeak: 45, taper: 1, longStep: 1 },
  '10k':    { peakLong: 15, minPeak: 25, maxPeak: 50, taper: 1, longStep: 1 },
  half:     { peakLong: 19, minPeak: 35, maxPeak: 55, taper: 2, longStep: 1.5 },
  marathon: { peakLong: 32, minPeak: 40, maxPeak: 80, taper: 3, longStep: 2 },
};

export const TYPES = {
  easy:      { name: 'Easy run',        color: 'easy' },
  strides:   { name: 'Easy + strides',  color: 'easy' },
  long:      { name: 'Long run',        color: 'long' },
  fartlek:   { name: 'Fartlek',         color: 'tempo' },
  tempo:     { name: 'Tempo',           color: 'tempo' },
  intervals: { name: 'Intervals',       color: 'intervals' },
  pace:      { name: 'Race pace',       color: 'pace' },
  trial:     { name: '5K time trial',   color: 'trial' },
  shakeout:  { name: 'Shakeout',        color: 'easy' },
  race:      { name: 'Race day',        color: 'race' },
};
export const HARD = new Set(['fartlek', 'tempo', 'intervals', 'pace', 'trial', 'race']);

const round = (x, step = 0.5) => Math.round(x / step) * step;
const lerp = (a, b, t) => a + (b - a) * t;
const pick = (arr, t) => arr[Math.min(arr.length - 1, Math.floor(t * arr.length))];

// Step helpers. Zones are resolved to paces at display time, so pace changes apply everywhere.
const warm = (km = 2) => ({ kind: 'warm', km, zone: 'easy' });
const cool = (km = 1.5) => ({ kind: 'cool', km, zone: 'easy' });
const run = (km, zone, label) => ({ kind: 'run', km, zone, label });
const reps = (n, work, rest) => ({ kind: 'reps', n, work, rest });

// Rough km of a step list, using a guessed pace for timed steps (fixed later by real paces).
export function stepsKm(steps, secPerKm) {
  const kmOf = (s) => s.kind === 'note' ? 0 : s.km ?? (s.min * 60) / secPerKm[s.zone];
  return steps.reduce((sum, s) => sum + (s.kind === 'reps' ? s.n * kmOf(s.work) + (s.n - 1) * kmOf(s.rest) : kmOf(s)), 0);
}

// Quality sessions by goal, phase and progress through the phase (t: 0 to 1).
function quality(kind, goal, phase, t) {
  const short = goal === '5k' || goal === '10k';
  if (kind === 'fartlek') {
    const n = Math.round(lerp(6, 10, t));
    return { type: 'fartlek', steps: [warm(), reps(n, { min: 1, zone: 'tenK' }, { min: 1, zone: 'jog' }), cool()] };
  }
  if (kind === 'intervals') {
    if (goal === '5k') {
      const [n, km] = pick([[8, 0.4], [6, 0.6], [5, 0.8], [6, 0.8]], t);
      return { type: 'intervals', steps: [warm(), reps(n, { km, zone: phase === 'peak' ? 'fiveK' : 'interval' }, { min: 1.5, zone: 'jog' }), cool()] };
    }
    const n = Math.round(lerp(4, 6, t));
    return { type: 'intervals', steps: [warm(), reps(n, { km: 1, zone: 'interval' }, { min: 2, zone: 'jog' }), cool()] };
  }
  if (kind === 'tempo') {
    const [n, min] = pick([[3, 8], [3, 10], [2, 15], [1, 25]], t);
    const work = { min, zone: 'threshold' };
    return { type: 'tempo', steps: n === 1 ? [warm(), { kind: 'run', ...work }, cool()] : [warm(), reps(n, work, { min: 2, zone: 'jog' }), cool()] };
  }
  if (kind === 'pace') {
    if (short) {
      const [n, km] = goal === '5k' ? pick([[5, 1], [4, 1.2], [3, 1.6]], t) : pick([[4, 2], [3, 3], [2, 4]], t);
      return { type: 'pace', steps: [warm(), reps(n, { km, zone: 'goal' }, { min: 2, zone: 'jog' }), cool()] };
    }
    const [n, km] = goal === 'marathon' ? pick([[2, 5], [2, 7], [1, 14]], t) : pick([[2, 3], [3, 3], [2, 5], [1, 8]], t);
    const work = { km, zone: 'goal' };
    return { type: 'pace', steps: n === 1 ? [warm(), { kind: 'run', ...work }, cool()] : [warm(), reps(n, work, { min: 3, zone: 'jog' }), cool()] };
  }
  if (kind === 'sharpen') {
    return goal === '5k'
      ? { type: 'intervals', steps: [warm(), reps(6, { km: 0.4, zone: 'fiveK' }, { min: 1.5, zone: 'jog' }), cool()] }
      : { type: 'pace', steps: [warm(), reps(4, { km: 1, zone: 'goal' }, { min: 2, zone: 'jog' }), cool()] };
  }
  if (kind === 'trial') {
    return { type: 'trial', steps: [warm(2.5), run(5, 'race5k', 'Time trial, steady effort you can hold'), cool()] };
  }
  throw new Error('Unknown session ' + kind);
}

// Shrink the main set of a session (not warm-up, cool-down or a time trial) until it fits the km budget.
export function fit(session, budgetKm, zp) {
  if (session.type === 'trial' || stepsKm(session.steps, zp) <= budgetKm) return session;
  let best = session;
  for (const scale of [0.85, 0.7, 0.55, 0.4]) {
    best = { ...session, steps: session.steps.map((s) => {
      if (s.kind === 'reps') {
        // Short reps (1 km or 3 min and under) keep at least 3 reps, longer ones at least 2.
        const minN = (s.work.km ?? 0) <= 1 && (s.work.min ?? 0) <= 3 ? 3 : 2;
        const n = Math.round(s.n * scale);
        if (n >= minN) return { ...s, n };
        if (minN === 3) return { ...s, n: Math.min(3, s.n) };
        return { ...s, n: 2, work: shrinkWork(s.work, (s.n * scale) / 2) };
      }
      return s.kind === 'run' ? { ...s, ...shrinkWork(s, scale) } : s;
    }) };
    if (stepsKm(best.steps, zp) <= budgetKm) break;
  }
  return best;
}

const shrinkWork = (w, scale) => w.min
  ? { ...w, min: Math.max(5, Math.round(w.min * scale)) }
  : { ...w, km: Math.max(0.4, round(w.km * scale, w.km < 2 ? 0.1 : 0.5)) };

// Choose the best days for hard sessions: not next to each other or the long run,
// and away from other training (gym legs, football) where possible.
export function chooseHardDays(runDays, longDay, otherDays, count) {
  const options = runDays.filter((d) => d !== longDay);
  const near = (a, b) => Math.abs(a - b) === 1 || Math.abs(a - b) === 6;
  const cost = (set) => {
    let c = 0;
    for (const d of set) {
      if (d === (longDay + 6) % 7) c += 3;     // day before long run
      if (d === (longDay + 1) % 7) c += 2;     // day after long run
      if (otherDays.includes(d)) c += 2;       // same day as other training
      if (otherDays.includes((d + 6) % 7)) c += 1; // day after other training
    }
    for (let i = 0; i < set.length; i++) for (let j = i + 1; j < set.length; j++) if (near(set[i], set[j])) c += 5;
    return c;
  };
  const combos = (arr, k) => k === 0 ? [[]] : arr.flatMap((x, i) => combos(arr.slice(i + 1), k - 1).map((r) => [x, ...r]));
  let best = null;
  for (const set of combos(options, Math.min(count, options.length))) {
    const c = cost(set);
    if (!best || c < best.c) best = { set, c };
  }
  // Two hard days that would have to be back to back: do one instead.
  if (best && count === 2 && best.c >= 5) return chooseHardDays(runDays, longDay, otherDays, 1);
  return best ? best.set : [];
}

function phasesFor(n, taper) {
  const rest = n - taper;
  const base = Math.max(1, Math.round(rest * 0.35));
  const build = Math.max(1, Math.round(rest * 0.4));
  const peak = Math.max(0, rest - base - build);
  return [...Array(base).fill('base'), ...Array(build).fill('build'), ...Array(peak).fill('peak'), ...Array(taper).fill('taper')];
}

/**
 * profile: { goal, raceDate, vdot, goalTime, weeklyKm, longestKm, runDays[], longRunDay, otherDays[], timeTrials }
 * startDate: first day of the plan (any day; week 1 starts on its Monday)
 * weekOffset: number added to week numbers (used when rebuilding part of a plan)
 */
export function buildPlan(profile, startDate, weekOffset = 0) {
  const g = GOALS[profile.goal];
  const zp = zonePaces(profile.vdot, profile.goal, profile.goalTime);
  const first = mondayOf(startDate);
  const raceMonday = mondayOf(profile.raceDate);
  const n = daysBetween(first, raceMonday) / 7 + 1;
  if (n < 3) throw new Error('The race is less than 3 weeks away. Pick a later race date.');

  const runDays = [...new Set(profile.runDays)].sort((a, b) => a - b);
  if (profile.goal === 'marathon' && runDays.length < 3) throw new Error('Marathon plans need at least 3 run days.');
  if (runDays.length < 2) throw new Error('Pick at least 2 run days.');
  const longDay = runDays.includes(profile.longRunDay) ? profile.longRunDay : runDays[runDays.length - 1];
  const other = profile.otherDays || [];

  const startKm = Math.max(10, profile.weeklyKm || 0);
  const peakKm = Math.min(g.maxPeak, Math.max(g.minPeak, startKm * 1.6, startKm));
  let level = startKm;
  let long = Math.max(5, Math.min(profile.longestKm || 6, g.peakLong));

  const phases = phasesFor(n, g.taper);
  const phaseLen = (p) => phases.filter((x) => x === p).length;
  const phaseIdx = (i) => phases.slice(0, i).filter((x) => x === phases[i]).length;
  const nonTaper = n - g.taper;
  // Long run grows so it peaks at the end of the peak phase.
  const longStep = Math.min(g.longStep, Math.max(0.5, (g.peakLong - long) / Math.max(1, nonTaper * 0.75)));

  const weeks = [];
  let lastNormal = 0, lastLong = 0;
  for (let i = 0; i < n; i++) {
    const phase = phases[i];
    const start = addDays(first, i * 7);
    const t = phaseLen(phase) > 1 ? phaseIdx(i) / (phaseLen(phase) - 1) : 1;
    const isRaceWeek = i === n - 1;
    const recovery = phase !== 'taper' && i % 4 === 3 && i < nonTaper - 1;

    let km, longKm;
    if (phase === 'taper') {
      km = isRaceWeek ? level * 0.5 : level * (g.taper === 3 && i === n - 3 ? 0.85 : 0.7);
      longKm = isRaceWeek ? 0 : round(g.peakLong * (i === n - 3 ? 0.8 : 0.65));
    } else if (recovery) {
      km = level * 0.8;
      longKm = round(long * 0.75);
    } else {
      if (i > 0) { level = Math.min(peakKm, level * 1.08); long = Math.min(g.peakLong, long + longStep); }
      km = level;
      longKm = round(long);
    }
    // The long run is never more than half the week.
    longKm = Math.min(longKm, Math.max(6, round(km * 0.5)));

    // Which sessions this week.
    let hard = [];
    if (isRaceWeek) hard = [];
    else if (recovery) hard = [profile.timeTrials !== false && daysBetween(start, profile.raceDate) > 13 ? 'trial' : 'fartlek'];
    else if (phase === 'base') hard = runDays.length >= 4 && t > 0.5 ? ['fartlek', 'tempo'] : ['fartlek'];
    else if (phase === 'build') hard = runDays.length >= 4 ? ['intervals', 'tempo'] : [i % 2 ? 'tempo' : 'intervals'];
    else if (phase === 'peak') hard = runDays.length >= 4 ? ['pace', i % 2 ? 'intervals' : 'tempo'] : ['pace'];
    else hard = ['sharpen'];
    // Under 25 km a week, one hard session is plenty.
    if (hard.length === 2 && km < 25) hard = [hard[0]];

    const workouts = [];
    const add = (day, w) => {
      const date = addDays(start, day);
      workouts.push({ id: `w${i + 1 + weekOffset}-${day}`, date, ...w, km: round(w.km ?? stepsKm(w.steps, zp)) });
    };

    if (isRaceWeek) {
      const raceDay = weekday(profile.raceDate);
      const before = runDays.filter((d) => d < raceDay - 1).slice(-2);
      before.forEach((d, k) => add(d, k === before.length - 1
        ? { type: 'strides', steps: [run(5, 'easy'), { kind: 'note', text: '4 x 20 s strides, relaxed and quick' }] }
        : { type: 'easy', steps: [run(round(Math.min(8, km / 3)), 'easy')] }));
      if (raceDay > 0) add(raceDay - 1, { type: 'shakeout', steps: [run(3, 'easy', 'Very easy, legs loose')] });
      add(raceDay, { type: 'race', steps: [run(DIST[profile.goal] / 1000, 'race', 'Race! Start controlled, finish strong')] });
    } else {
      add(longDay, longRun(longKm, phase, profile.goal, i));
      const hardDays = chooseHardDays(runDays, longDay, other, hard.length).sort((a, b) => a - b);
      let easyDays = runDays.filter((d) => d !== longDay && !hardDays.includes(d));
      // Hard sessions shrink to fit the week, leaving at least 3 km for each easy run.
      const perSession = (km - longKm - easyDays.length * 3) / Math.max(1, hardDays.length);
      hardDays.forEach((d, k) => add(d, fit(quality(hard[k], profile.goal, phase, t), perSession, zp)));
      const used = workouts.reduce((s, w) => s + w.km, 0);
      // Not enough km left for proper easy runs: run fewer days this week instead.
      while (easyDays.length > 1 && (km - used) / easyDays.length < 3) easyDays = easyDays.slice(0, -1);
      const each = easyDays.length ? Math.min(12, Math.max(3, round((km - used) / easyDays.length))) : 0;
      easyDays.forEach((d, k) => add(d, k === 0 && phase !== 'taper' && !recovery
        ? { type: 'strides', steps: [run(each, 'easy'), { kind: 'note', text: '6 x 20 s strides at the end' }] }
        : { type: 'easy', steps: [run(each, 'easy')] }));
    }

    // Safety cap: a normal week is never more than 10% above the last normal week.
    const normal = !isRaceWeek && !recovery && phase !== 'taper';
    const total = () => workouts.reduce((s, w) => s + w.km, 0);
    if (normal && lastNormal && total() > lastNormal * 1.1) {
      const lr = workouts.find((w) => w.type === 'long');
      const cut = Math.min(round(total() - lastNormal * 1.1), lr.km - lastLong);
      if (cut > 0) {
        lr.steps = [{ ...lr.steps[0], km: round(lr.steps[0].km - cut) }, ...lr.steps.slice(1)];
        lr.km = round(stepsKm(lr.steps, zp));
      }
      // Still too much: the second hard session becomes an easy run.
      const hardOnes = workouts.filter((w) => HARD.has(w.type));
      if (total() > lastNormal * 1.1 && hardOnes.length > 1) {
        const h = hardOnes[1];
        const easyKm = Math.max(3, round(h.km - (total() - lastNormal * 1.1)));
        Object.assign(h, { type: 'easy', steps: [run(easyKm, 'easy')], km: easyKm });
      }
    }
    if (normal) { lastNormal = total(); lastLong = workouts.find((w) => w.type === 'long')?.km ?? lastLong; }

    workouts.sort((a, b) => a.date.localeCompare(b.date));
    weeks.push({
      n: i + 1 + weekOffset, start, phase, recovery, race: isRaceWeek,
      km: round(workouts.reduce((s, w) => s + w.km, 0)), workouts,
    });
  }
  return { goal: profile.goal, raceDate: profile.raceDate, created: startDate, weeks };
}

function longRun(km, phase, goal, i) {
  // In the peak phase every other long run finishes at goal pace (half and marathon only).
  if (phase === 'peak' && (goal === 'half' || goal === 'marathon') && i % 2 === 0 && km >= 12) {
    const fast = goal === 'half' ? 4 : 8;
    return { type: 'long', km, steps: [run(km - fast, 'easy'), run(fast, 'goal', 'Finish at race pace')] };
  }
  return { type: 'long', km, steps: [run(km, 'easy', 'Conversational pace')] };
}
