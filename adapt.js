// How the plan reacts to what you actually ran. Pure functions, tested in Node.
import { addDays, mondayOf } from './dates.js';
import { buildPlan, HARD } from './plan.js';
import { vdotFromRace } from './vdot.js';

export const weekOf = (plan, date) => plan.weeks.find((w) => date >= w.start && date <= addDays(w.start, 6));

export function weekStats(week, logs, extras = []) {
  const end = addDays(week.start, 6);
  let done = 0, plannedDone = 0, count = 0;
  for (const w of week.workouts) {
    const log = logs[w.id];
    if (log?.status === 'done') { done += log.km || 0; plannedDone += w.km; count++; }
  }
  for (const e of extras) if (!e.walk && e.date >= week.start && e.date <= end) done += e.km || 0;
  return { planned: week.km, done: Math.round(done * 10) / 10, count, total: week.workouts.length };
}

// Average km over the last two finished weeks, and the longest run in the last three.
export function recentVolume(plan, logs, extras, today) {
  const thisMonday = mondayOf(today);
  const past = plan.weeks.filter((w) => w.start < thisMonday).slice(-2);
  if (!past.length) return null;
  const km = past.reduce((s, w) => s + weekStats(w, logs, extras).done, 0) / past.length;
  const since = addDays(thisMonday, -21);
  let longest = 0;
  for (const w of plan.weeks) for (const x of w.workouts) {
    const log = logs[x.id];
    if (log?.status === 'done' && x.date >= since) longest = Math.max(longest, log.km || 0);
  }
  for (const e of extras) if (!e.walk && e.date >= since) longest = Math.max(longest, e.km || 0);
  return { km: Math.round(km), longest };
}

// Suggest a rebuild when last week was well off plan.
export function volumeCheck(plan, logs, extras, today) {
  const last = weekOf(plan, addDays(mondayOf(today), -1));
  if (!last || last.race || (plan.created && last.start < plan.created)) return null; // skip a part week at the start
  const s = weekStats(last, logs, extras);
  if (!s.planned) return null;
  const ratio = s.done / s.planned;
  if (ratio < 0.7) return { week: last.n, ...s, direction: 'under' };
  if (ratio > 1.2) return { week: last.n, ...s, direction: 'over' };
  return null;
}

// Rebuild every week from next Monday, starting from what you really ran. Keeps the race date.
// Rebuild the plan from what you really ran. Keeps the race date and everything before the rebuild point.
// fromToday: also replans the rest of this week, keeping days already gone and any run you've logged.
export function rebuild(profile, plan, logs, extras, today, fromToday = false) {
  const thisMonday = mondayOf(today);
  const next = fromToday ? thisMonday : addDays(thisMonday, 7);
  const kept = plan.weeks.filter((w) => w.start < next);
  const vol = recentVolume(plan, logs, extras, today);
  const p = { ...profile };
  if (vol && vol.km > 0) p.weeklyKm = vol.km;
  // Your recent runs can raise the starting long run, but never drop it below the longest run you set in Settings.
  if (vol && vol.longest > 0) p.longestKm = Math.max(vol.longest, profile.longestKm || 0);
  const fresh = buildPlan(p, fromToday ? today : next, kept.length);
  if (fromToday) {
    const cur = plan.weeks.find((w) => w.start === thisMonday);
    const wk = fresh.weeks[0];
    if (cur && wk) {
      const keep = cur.workouts.filter((w) => w.date < today || logs[w.id]);
      wk.workouts = [...keep, ...wk.workouts.filter((x) => !keep.some((k) => k.date === x.date))].sort((a, b) => a.date.localeCompare(b.date));
      wk.km = Math.round(wk.workouts.reduce((sum, w) => sum + w.km, 0) * 2) / 2;
    }
  }
  return { ...plan, weeks: [...kept, ...fresh.weeks], rebuilt: today };
}

// After 3 hard sessions: all felt easy -> suggest faster paces, 2 of 3 very hard -> slower.
export function paceCheck(plan, logs, seenId) {
  const done = plan.weeks.flatMap((w) => w.workouts)
    .filter((w) => HARD.has(w.type) && w.type !== 'trial' && w.type !== 'race' && logs[w.id]?.status === 'done' && logs[w.id].rpe)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-3);
  if (done.length < 3 || done[2].id === seenId) return null;
  const rpe = done.map((w) => logs[w.id].rpe);
  if (rpe.every((r) => r <= 5)) return { change: +1, lastId: done[2].id };
  if (rpe.filter((r) => r >= 9).length >= 2) return { change: -1, lastId: done[2].id };
  return null;
}

// A time trial or race result gives a new fitness score.
export function vdotFromResult(km, sec) {
  if (!km || km < 3 || !sec) return null;
  const v = vdotFromRace(km * 1000, sec);
  return v > 20 && v < 85 ? Math.round(v * 10) / 10 : null;
}
