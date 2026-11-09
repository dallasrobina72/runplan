// Free auto-sync: Garmin -> intervals.icu -> this app.
// Uses your personal intervals.icu API key (Settings > Developer Settings on intervals.icu).
import { addDays } from './dates.js';

const RUN_TYPES = new Set(['Run', 'TrailRun', 'VirtualRun', 'TreadmillRun']);
const WALK_TYPES = new Set(['Walk', 'Hike']);

// Cadence in steps per minute. Some sources give one leg only (half the steps):
// a run under 110 or a walk under 75 can only be one leg, so it is doubled.
export const normCad = (v, walk) => (!v ? null : v < (walk ? 75 : 110) ? v * 2 : v);

export async function fetchRuns({ athleteId, apiKey }, oldest, newest) {
  const url = `https://intervals.icu/api/v1/athlete/${encodeURIComponent(athleteId || '0')}/activities?oldest=${oldest}&newest=${newest}`;
  const res = await fetch(url, { headers: { Authorization: 'Basic ' + btoa('API_KEY:' + apiKey) } });
  if (res.status === 401 || res.status === 403) throw new Error('intervals.icu rejected the key. Check the athlete ID and API key.');
  if (!res.ok) throw new Error(`intervals.icu error ${res.status}`);
  const list = await res.json();
  const num = (v) => (Number.isFinite(v) && v > 0 ? v : null);
  return list
    .filter((a) => (RUN_TYPES.has(a.type) || WALK_TYPES.has(a.type)) && (a.icu_distance || a.distance) > 0)
    .map((a) => ({
      walk: WALK_TYPES.has(a.type),
      cad: normCad(num(a.average_cadence), WALK_TYPES.has(a.type)),
      extId: String(a.id),
      date: String(a.start_date_local).slice(0, 10),
      km: Math.round((a.icu_distance || a.distance) / 10) / 100, // 2 decimals, so short runs aren't 0 km
      sec: a.moving_time || a.elapsed_time || 0,
      hr: num(a.average_heartrate),
      maxHr: num(a.max_heartrate),
      elev: num(a.total_elevation_gain),
      cal: num(a.calories),
      load: num(a.icu_training_load),
      treadmill: a.type === 'VirtualRun' || a.type === 'TreadmillRun' || a.trainer === true || /treadmill/i.test(a.name || ''),
      name: a.name || 'Run',
    }));
}

// The numbers a synced run carries. Refreshed on every sync, so older runs gain new fields.
const DATA = ['km', 'sec', 'hr', 'maxHr', 'elev', 'cal', 'load', 'cad'];
const pickData = (r) => Object.fromEntries(DATA.map((k) => [k, r[k] ?? null]));

// Match each new run to a planned workout on the same day, otherwise keep it as an extra run.
// Runs seen before are refreshed if you still have them, and never re-added if you deleted them.
export function applyRuns(state, runs) {
  const imported = new Set(state.sync.imported);
  const byDate = {};
  for (const w of state.plan.weeks.flatMap((x) => x.workouts)) (byDate[w.date] ||= []).push(w);
  let matched = 0, extra = 0, updated = 0;
  for (const r of runs) {
    if (imported.has(r.extId)) {
      const rec = Object.values(state.logs).find((l) => l.extId === r.extId) || state.extras.find((e) => e.extId === r.extId || e.id === 'x' + r.extId);
      if (rec) {
        Object.assign(rec, pickData(r), { extId: r.extId });
        if (!rec.treadmillSet) rec.treadmill = r.treadmill;
        updated++;
      }
      continue;
    }
    imported.add(r.extId);
    const target = r.walk ? null : (byDate[r.date] || []).find((w) => !state.logs[w.id] || state.logs[w.id].status === 'skipped');
    if (target) {
      state.logs[target.id] = { status: 'done', ...pickData(r), treadmill: r.treadmill, source: 'intervals', extId: r.extId };
      matched++;
    } else {
      state.extras.push({ id: 'x' + r.extId, extId: r.extId, date: r.date, ...pickData(r), treadmill: r.treadmill, walk: r.walk || undefined, name: r.name, source: 'intervals' });
      extra++;
    }
  }
  state.sync.imported = [...imported];
  return { matched, extra, updated };
}

export const syncWindow = (today, lastSync) => [lastSync ? addDays(lastSync, -3) : addDays(today, -14), today];

// Second-by-second data for one activity. The response shape isn't documented, so both
// an array of { type, data } and an object keyed by stream name are accepted.
export async function fetchStreams({ apiKey }, extId) {
  const headers = { Authorization: 'Basic ' + btoa('API_KEY:' + apiKey) };
  let res = await fetch(`https://intervals.icu/api/v1/activity/${encodeURIComponent(extId)}/streams?types=time,cadence,heartrate`, { headers });
  if (res.status === 404) res = await fetch(`https://intervals.icu/api/v1/activity/${encodeURIComponent(extId)}/streams.json?types=time,cadence,heartrate`, { headers });
  if (!res.ok) throw new Error(`streams ${res.status}`);
  return parseStreams(await res.json());
}

export function parseStreams(body) {
  const out = {};
  if (Array.isArray(body)) for (const st of body) { if (st && st.type) out[st.type] = st.data; }
  else if (body && typeof body === 'object') for (const [k, v] of Object.entries(body)) out[k] = Array.isArray(v) ? v : v?.data;
  return { time: out.time || [], cadence: out.cadence || [], heartrate: out.heartrate || [] };
}

// Seconds spent at each heart rate (bpm -> seconds). Stored raw so zones can be redrawn if your max or resting HR changes.
export function hrHistogram({ time, heartrate }) {
  const n = Math.min(time.length, heartrate.length);
  if (n < 10) return null;
  const hist = {};
  for (let i = 0; i < n; i++) {
    const bpm = Math.round(heartrate[i]);
    if (!(bpm > 40 && bpm < 230)) continue;
    const dt = Math.min(10, Math.max(0, (time[i + 1] ?? time[i] + 1) - time[i]));
    hist[bpm] = (hist[bpm] || 0) + dt;
  }
  return Object.keys(hist).length ? hist : null;
}

// Running vs walking time from cadence: 140+ steps a minute is running, 40 to 139 is walking.
// Gaps between samples (pauses, smart recording) are capped at 10 s.
export function runWalk({ time, cadence }, walk = false) {
  const n = Math.min(time.length, cadence.length);
  if (n < 10) return null;
  const nz = cadence.filter((c) => c > 0).sort((a, b) => a - b);
  if (!nz.length) return null;
  const median = nz[Math.floor(nz.length / 2)];
  const k = median < (walk ? 75 : 110) ? 2 : 1; // one leg -> both legs
  let runSec = 0, walkSec = 0, maxCad = 0;
  for (let i = 0; i < n - 1; i++) {
    const dt = Math.min(10, Math.max(0, time[i + 1] - time[i]));
    const c = (cadence[i] || 0) * k;
    if (c >= 140) runSec += dt; else if (c >= 40) walkSec += dt;
    if (c <= 250) maxCad = Math.max(maxCad, c);
  }
  return { runSec: Math.round(runSec), walkSec: Math.round(walkSec), maxCad: maxCad || null };
}
