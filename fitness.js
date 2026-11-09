// Auto fitness: keeps your fitness score (VDOT) in line with how your runs actually go.
// Pure functions, tested in Node.
//
// How it works:
// 1. Every steady run tells us two things: how fast you ran (which needs a known amount of oxygen)
//    and how hard it was (heart rate, or the effort score you logged).
// 2. Effort as a share of your maximum (heart rate reserve: resting to max) is roughly your share
//    of maximum oxygen use. So: fitness = oxygen needed for that pace / share of max you used.
// 3. Recent runs are averaged (newer count more, odd ones are ignored) and blended with your last
//    race or time trial. Then your Faster/Slower adjustment is added on top.
import { daysBetween } from './dates.js';

const vo2At = (mPerMin) => -4.6 + 0.182258 * mPerMin + 0.000104 * mPerMin * mPerMin;
const STEADY = new Set(['easy', 'strides', 'long', 'tempo', 'pace', 'shakeout', 'extra']);

// Max heart rate: what you set, else the higher of an age estimate (208 - 0.7 x age) and the highest you've recorded.
export function heartRates(profile, runs, syncedRest) {
  const seen = Math.max(0, ...runs.map((r) => r.maxHr || 0));
  const fromAge = profile.age ? Math.round(208 - 0.7 * profile.age) : 0;
  const max = profile.maxHr || (fromAge ? Math.max(fromAge, seen) : null);
  const rest = profile.restHr || syncedRest || 60;
  return { max, rest, maxSource: profile.maxHr ? 'set' : fromAge ? (seen > fromAge ? 'recorded' : 'age') : null,
    restSource: profile.restHr ? 'set' : syncedRest ? 'garmin' : 'default' };
}

// Effort score 1 to 10 as a share of maximum: 3 = 65%, 5 = 75%, 7 = 85%, 9 = 95%.
const rpeShare = (rpe) => 0.5 + 0.05 * rpe;

// One run's fitness estimate, or null if the run can't tell us much.
export function runEstimate(r, hr) {
  if (r.walk || !STEADY.has(r.type) || !r.km || r.km < 2 || !r.sec || r.sec < 900) return null;
  if (r.walkSec && r.runSec && r.walkSec > 0.15 * (r.runSec + r.walkSec)) return null; // lots of walking
  const speed = (r.km * 1000) / (r.sec / 60);
  const vo2 = vo2At(speed);
  let hrShare = null;
  if (r.hr && hr.max && hr.max > hr.rest + 40) {
    hrShare = (r.hr - hr.rest) / (hr.max - hr.rest);
    if (hrShare < 0.45 || hrShare > 0.97) hrShare = null;
  }
  const effort = r.rpe ? rpeShare(r.rpe) : null;
  const share = hrShare != null ? (effort != null ? 0.75 * hrShare + 0.25 * effort : hrShare) : effort;
  if (share == null) return null;
  const est = 3.5 + (vo2 - 3.5) / share;
  if (!(est > 25 && est < 85)) return null;
  // How much to trust it: heart rate beats effort alone; indoor heat and big hills push heart rate up.
  let weight = hrShare != null ? 1 : 0.4;
  if (r.treadmill) weight *= 0.6;
  if (r.elev && r.elev / r.km > 15) weight *= 0.5;
  return { est, weight, date: r.date, by: hrShare != null ? 'heart rate' : 'effort' };
}

// The score your paces use.
// base: { vdot, date, source } from setup, a time trial, a race or a result you entered.
// Garmin's VO2 max reads higher than race-based fitness (it can't see running economy), so only its
// CHANGE is used: the base score scaled by how much Garmin's number has moved since the base was set.
// vo2s: [{ date, v }] oldest first. Needs two different readings to say anything.
export function garminTrend(vo2s, base, today) {
  const list = (vo2s || []).filter((x) => x.v > 20 && x.v < 95 && x.date <= today);
  if (list.length < 2) return null;
  const now = list.at(-1);
  if (daysBetween(now.date, today) > 30) return null; // stale
  const atBase = [...list].reverse().find((x) => x.date <= base.date) || list[0];
  if (atBase.date === now.date) return null;
  const ratio = Math.min(1.1, Math.max(0.9, now.v / atBase.v));
  return { vdot: base.vdot * ratio, now: now.v, then: atBase.v, thenDate: atBase.date, weight: 0.2 };
}

export function autoFitness({ base, offset = 0 }, runs, hr, today, garmin = null) {
  const ests = runs.map((r) => runEstimate(r, hr))
    .filter((e) => e && daysBetween(e.date, today) <= 42)
    .slice(-10);
  let runVdot = null, total = 0;
  if (ests.length) {
    const sorted = ests.map((e) => e.est).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    let sum = 0;
    for (const e of ests) {
      if (Math.abs(e.est - median) > 4) continue; // ignore odd runs
      const w = e.weight * Math.pow(0.5, daysBetween(e.date, today) / 21); // halves every 3 weeks
      sum += e.est * w; total += w;
    }
    runVdot = total ? sum / total : null;
  }
  // Trust in runs grows with how many good ones there are (about 4 for full trust).
  // A recent race or time trial keeps more of the say, since it measures speed directly.
  const recentResult = base.source !== 'Setup' && base.date && daysBetween(base.date, today) <= 56;
  const trust = runVdot == null ? 0 : Math.min(recentResult ? 0.4 : 0.75, (total / 4) * 0.75);
  const g = garmin ? garmin.weight : 0;
  const auto = base.vdot * (1 - trust - g) + (runVdot ?? base.vdot) * trust + (garmin ? garmin.vdot * g : 0);
  const r1 = (x) => Math.round(x * 10) / 10;
  return { used: r1(auto + offset), auto: r1(auto), runVdot: runVdot && r1(runVdot), trust, runs: ests.length,
    base: base.vdot, offset, garmin: garmin && { ...garmin, vdot: r1(garmin.vdot) } };
}

// Heart rate ranges for a zone, as a share of heart rate reserve (Karvonen).
export function hrRange(hr, lo, hi) {
  if (!hr.max) return null;
  const at = (f) => Math.round(hr.rest + f * (hr.max - hr.rest));
  return [at(lo), at(hi)];
}
