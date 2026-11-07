// Free auto-sync: Garmin -> intervals.icu -> this app.
// Uses your personal intervals.icu API key (Settings > Developer Settings on intervals.icu).
import { addDays } from './dates.js';

const RUN_TYPES = new Set(['Run', 'TrailRun', 'VirtualRun', 'TreadmillRun']);

export async function fetchRuns({ athleteId, apiKey }, oldest, newest) {
  const url = `https://intervals.icu/api/v1/athlete/${encodeURIComponent(athleteId || '0')}/activities?oldest=${oldest}&newest=${newest}`;
  const res = await fetch(url, { headers: { Authorization: 'Basic ' + btoa('API_KEY:' + apiKey) } });
  if (res.status === 401 || res.status === 403) throw new Error('intervals.icu rejected the key. Check the athlete ID and API key.');
  if (!res.ok) throw new Error(`intervals.icu error ${res.status}`);
  const list = await res.json();
  return list
    .filter((a) => RUN_TYPES.has(a.type) && a.distance > 0)
    .map((a) => ({
      extId: String(a.id),
      date: String(a.start_date_local).slice(0, 10),
      km: Math.round(a.distance / 100) / 10,
      sec: a.moving_time || a.elapsed_time || 0,
      hr: a.average_heartrate || null,
      name: a.name || 'Run',
    }));
}

// Match each new run to a planned workout on the same day, otherwise keep it as an extra run.
export function applyRuns(state, runs) {
  const imported = new Set(state.sync.imported);
  const byDate = {};
  for (const w of state.plan.weeks.flatMap((x) => x.workouts)) (byDate[w.date] ||= []).push(w);
  let matched = 0, extra = 0;
  for (const r of runs) {
    if (imported.has(r.extId)) continue;
    imported.add(r.extId);
    const target = (byDate[r.date] || []).find((w) => !state.logs[w.id] || state.logs[w.id].status === 'skipped');
    if (target) {
      state.logs[target.id] = { status: 'done', km: r.km, sec: r.sec, hr: r.hr, source: 'intervals', extId: r.extId };
      matched++;
    } else {
      state.extras.push({ id: 'x' + r.extId, date: r.date, km: r.km, sec: r.sec, hr: r.hr, name: r.name, source: 'intervals' });
      extra++;
    }
  }
  state.sync.imported = [...imported];
  return { matched, extra };
}

export const syncWindow = (today, lastSync) => [lastSync ? addDays(lastSync, -3) : addDays(today, -14), today];
