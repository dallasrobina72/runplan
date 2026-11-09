import { load, save, exportFile, importFile, reset } from './store.js';
import { buildPlan, zonePaces, TYPES, HARD, stepsKm, DEFAULT_PEAK_LONG } from './plan.js';
import { weekOf, weekStats, volumeCheck, rebuild, paceCheck, vdotFromResult } from './adapt.js';
import { vdotFromRace, predict, DIST, fmtPace, fmtTime, parseTime } from './vdot.js';
import { addDays, weekday, mondayOf, daysBetween, today, fmtDate, fmtShort, DAY } from './dates.js';
import { fetchRuns, applyRuns, syncWindow, fetchStreams, runWalk } from './sync.js';
import { weeklyBars, line, dots } from './charts.js';
import { ensureTraining, sessionsOn, isHard, hardDays, addSession, removeSession, moveSession, applyHardDays, clashFor, swapOption } from './training.js';
import { runList, filterRuns, records, compare, averages } from './analysis.js';
import { heartRates, autoFitness, hrRange, garminTrend } from './fitness.js';

let S = load();
let tab = 'today';
let scrollToWeek = false;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const persist = () => { if (!save(S)) toast('Could not save. Is storage full?'); };
const GOAL_NAME = { '5k': '5K', '10k': '10K', half: 'Half marathon', marathon: 'Marathon' };
const ZONE_NAME = { easy: 'Easy', jog: 'Jog', threshold: 'Threshold', tenK: '10K pace', interval: 'Interval pace', fiveK: '5K pace', race5k: '5K effort', goal: 'Race pace', race: 'Race pace', hill: 'Hill effort' };
const allWorkouts = () => S.plan.weeks.flatMap((w) => w.workouts);
const findWorkout = (id) => allWorkouts().find((w) => w.id === id);
// Race-pace sessions use your goal time, unless you've chosen to follow your current fitness.
const usesGoal = () => !!S.profile.goalTime && S.profile.paceFrom !== 'fitness';
const zp = () => zonePaces(S.profile.vdot, S.profile.goal, usesGoal() ? S.profile.goalTime : null);

// ---------- small UI helpers ----------
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3200);
}

function openSheet(html, mount) {
  const sheet = $('#sheet');
  $('.sheet-body', sheet).innerHTML = html;
  sheet.hidden = false;
  requestAnimationFrame(() => sheet.classList.add('open'));
  mount?.($('.sheet-body', sheet));
}
function closeSheet() {
  const sheet = $('#sheet');
  sheet.classList.remove('open');
  setTimeout(() => { sheet.hidden = true; }, 200);
}

const dayChips = (name, selected) => `<div class="chips" role="group">${DAY.map((d, i) =>
  `<label class="chip"><input type="checkbox" name="${name}" value="${i}" ${selected.includes(i) ? 'checked' : ''}><span>${d}</span></label>`).join('')}</div>`;
const checked = (form, name) => $$(`input[name="${name}"]:checked`, form).map((x) => Number(x.value));

// Treadmill speed for a pace.
const kmh = (secPerKm) => (3600 / secPerKm).toFixed(1);

function paceText(zone) {
  const p = zp();
  if (zone === 'easy') {
    const hr = hrRange(HR(), 0.6, 0.72);
    return `${fmtPace(p.easyFast)} to ${fmtPace(p.easySlow)} /km <span class="muted">(${kmh(p.easySlow)} to ${kmh(p.easyFast)} km/h)</span>${hr ? `<div class="hrguide">Heart rate ${hr[0]} to ${hr[1]}. Higher? Slow down.</div>` : ''}`;
  }
  if (zone === 'hill') return 'hard effort (ignore pace on hills)';
  if (zone === 'threshold') {
    const hr = hrRange(HR(), 0.84, 0.9);
    return `${fmtPace(p[zone])} /km <span class="muted">(${kmh(p[zone])} km/h)</span>${hr ? `<div class="hrguide">Heart rate settles around ${hr[0]} to ${hr[1]}</div>` : ''}`;
  }
  return `${fmtPace(p[zone])} /km <span class="muted">(${kmh(p[zone])} km/h)</span>`;
}

// ---------- fitness ----------
const HR = () => heartRates(S.profile, runList(S.plan, S.logs, S.extras), S.sync.restHr);

// Older saves had one fitness number. Split it into a base (last race, time trial or setup) and your adjustment.
function migrateFitness() {
  const p = S.profile;
  if (!p.base) p.base = { vdot: p.vdot, date: S.plan?.created || today(), source: 'Setup' };
  if (p.offset == null) p.offset = 0;
  if (p.autoFitness == null) p.autoFitness = true;
}

function fitnessNow() {
  migrateFitness();
  const p = S.profile;
  if (!p.autoFitness) return { used: Math.round((p.base.vdot + p.offset) * 10) / 10, auto: p.base.vdot, runVdot: null, trust: 0, runs: 0, base: p.base.vdot, offset: p.offset };
  const vo2s = (S.sync.wellness || []).filter((d) => d.vo2).map((d) => ({ date: d.date, v: d.vo2 }));
  return autoFitness(p, runList(S.plan, S.logs, S.extras), HR(), today(), garminTrend(vo2s, p.base, today()));
}

const latestVo2 = () => [...(S.sync.wellness || [])].reverse().find((d) => d.vo2);

// Keep the score your paces use up to date. Logs a history point when it moves.
function refreshFitness(source = 'Auto') {
  const f = fitnessNow();
  if (f.used === S.profile.vdot) return f;
  S.profile.vdot = f.used;
  const last = S.vdotHistory.at(-1);
  if (last && last.date === today() && last.source === source) last.vdot = f.used;
  else S.vdotHistory.push({ date: today(), vdot: f.used, source });
  persist();
  return f;
}

// A real result (time trial, race, or one you enter) resets the base and clears manual adjustments.
function setBase(v, source) {
  const old = S.profile.vdot;
  migrateFitness();
  S.profile.base = { vdot: Math.round(v * 10) / 10, date: today(), source };
  S.profile.offset = 0;
  refreshFitness(source);
  setTimeout(() => toast(`Paces updated (fitness ${old} to ${S.profile.vdot})`), 400);
}

// Faster/Slower and the pace check move your adjustment on top of the automatic score.
function nudge(delta, source) {
  const old = S.profile.vdot;
  migrateFitness();
  S.profile.offset = Math.round((S.profile.offset + delta) * 10) / 10;
  refreshFitness(source);
  setTimeout(() => toast(`Paces updated (fitness ${old} to ${S.profile.vdot})`), 400);
}
const amount = (s) => (s.km != null ? `${+s.km.toFixed(2)} km` : `${s.min} min`);

function stepHtml(s) {
  if (s.kind === 'note') return `<li class="note">${esc(s.text)}</li>`;
  if (s.kind === 'reps') {
    return `<li><b>${s.n} x ${amount(s.work)}</b> at ${paceText(s.work.zone)} <span class="muted">(${ZONE_NAME[s.work.zone]})</span>
      ${s.work.label ? `<div class="muted">${esc(s.work.label)}</div>` : ''}
      <div class="muted">${amount(s.rest)}: ${s.rest.label ? esc(s.rest.label.toLowerCase()) : 'easy jog between'}</div></li>`;
  }
  const label = { warm: 'Warm up', cool: 'Cool down' }[s.kind];
  return `<li>${label ? `<b>${label}</b> ` : ''}<b>${amount(s)}</b> at ${paceText(s.zone)} <span class="muted">(${ZONE_NAME[s.zone]})</span>${s.label ? `<div class="muted">${esc(s.label)}</div>` : ''}</li>`;
}

function estimate(w) {
  const p = zp();
  const secOf = (s) => s.kind === 'note' ? 0 : s.km != null ? s.km * p[s.zone] : s.min * 60;
  return w.steps.reduce((t, s) => t + (s.kind === 'reps' ? s.n * secOf(s.work) + (s.n - 1) * secOf(s.rest) : secOf(s)), 0);
}

function duration(sec) {
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

// Pace text, or '-' when the distance is too short to mean anything.
const paceOf = (sec, km) => (sec && km >= 0.1 ? `${fmtPace(sec / km)} /km` : '-');

// Every number we have for a logged run.
function runStats(r) {
  const rows = [
    ['Distance', `${r.km} km`],
    ['Time', r.sec ? fmtTime(r.sec) : null],
    ['Avg pace', r.sec ? paceOf(r.sec, r.km) : null],
    ['Avg heart rate', r.hr ? `${Math.round(r.hr)} bpm` : null],
    ['Max heart rate', r.maxHr ? `${Math.round(r.maxHr)} bpm` : null],
    ['Heartbeats per km', r.hr && r.sec && r.km >= 0.5 ? Math.round((r.hr * r.sec) / 60 / r.km) : null],
    ['Climb', r.elev ? `${Math.round(r.elev)} m` : null],
    ['Calories', r.cal ? Math.round(r.cal) : null],
    ['Training load', r.load ? Math.round(r.load) : null],
    ['Avg cadence', r.cad ? `${Math.round(r.cad)} spm` : null],
    ['Max cadence', r.maxCad ? `${Math.round(r.maxCad)} spm` : null],
    ['Running time', r.walkSec >= 30 && r.runSec ? `${fmtTime(r.runSec)} (${Math.round((100 * r.runSec) / (r.runSec + r.walkSec))}%)` : null],
    ['Walking time', r.walkSec >= 30 ? `${fmtTime(r.walkSec)} (${Math.round((100 * r.walkSec) / (r.runSec + r.walkSec))}%)` : null],
    ['Effort', r.rpe ? `${r.rpe}/10` : null],
    ['Type', r.walk ? 'Walk (not counted in running stats)' : r.treadmill ? 'Treadmill run' : 'Outdoor run'],
    ['From', r.source === 'intervals' ? 'Garmin via intervals.icu' : r.source === 'old plan' ? 'An older plan' : 'Logged by hand'],
  ].filter(([, v]) => v != null);
  return `<table class="table stats">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>${r.note ? `<p class="muted">${esc(r.note)}</p>` : ''}`;
}

function openRun(src, id) {
  const r = src === 'extra' ? S.extras.find((x) => x.id === id) : S.logs[id];
  if (!r) return;
  if (src !== 'extra') return openWorkout(id);
  openSheet(`<div class="sheet-head"><div><p class="eyebrow">${fmtDate(r.date)}</p><h2>${esc(r.name || (r.walk ? 'Walk' : 'Extra run'))}</h2></div></div>
    ${runStats(r)}
    <div class="actions">
      ${r.walk ? '' : `<button class="btn" data-act="tread" data-src="extra" data-id="${r.id}">Count as ${r.treadmill ? 'outdoor' : 'treadmill'} run</button>`}
      <button class="btn" data-act="walk" data-id="${r.id}">${r.walk ? 'Count as a run' : 'This was a walk'}</button>
      <button class="btn danger" data-act="del-extra" data-id="${r.id}">Delete this run</button>
    </div>`);
}

function statusIcon(w) {
  const log = S.logs[w.id];
  if (log?.status === 'done') return '<span class="status done" aria-label="Done">&#10003;</span>';
  if (log?.status === 'skipped') return '<span class="status skipped" aria-label="Skipped">&ndash;</span>';
  if (w.date < today()) return '<span class="status missed" aria-label="Not logged">!</span>';
  return '';
}

function workoutCard(w, big = false) {
  const t = TYPES[w.type];
  const log = S.logs[w.id];
  const sub = log?.status === 'done'
    ? `Done: ${log.km} km${log.sec ? ` in ${fmtTime(log.sec)} (${paceOf(log.sec, log.km)})` : ''}${log.hr ? ` · ${Math.round(log.hr)} bpm` : ''}`
    : `${w.km} km · about ${duration(estimate(w))}`;
  return `<button class="card workout ${big ? 'big' : ''}" data-open="${w.id}" style="--type: var(--c-${t.color})">
    <span class="type-bar"></span>
    <span class="grow"><span class="eyebrow">${fmtDate(w.date)}${w.adjusted ? ' · adjusted' : ''}</span>
    <span class="title">${esc(t.name)}</span><span class="muted">${sub}</span></span>${statusIcon(w)}</button>`;
}

// ---------- onboarding ----------
function renderSetup(prefill) {
  const p = prefill || {
    goal: 'half', raceDate: '2027-02-28', raceDist: '5k', raceTime: '', goalTime: '',
    weeklyKm: 20, longestKm: 10, runDays: [1, 3, 5, 6], longRunDay: 6, otherDays: S.training ? hardDays(S.training) : [], timeTrials: true,
  };
  $('#tabs').hidden = true;
  $('#view').innerHTML = `
  <section class="setup">
    <h1>Build your plan</h1>
    <p class="muted">Takes a minute. You can change all of this later.</p>
    <form id="setup" novalidate>
      <fieldset><legend>What are you training for?</legend>
        <div class="seg">${Object.entries(GOAL_NAME).map(([k, v]) =>
          `<label><input type="radio" name="goal" value="${k}" ${p.goal === k ? 'checked' : ''}><span>${v}</span></label>`).join('')}</div>
      </fieldset>
      <label class="field">Race date<input type="date" name="raceDate" value="${esc(p.raceDate)}" required></label>
      <fieldset><legend>Start the plan</legend>
        <div class="seg">
          <label><input type="radio" name="startWhen" value="today" checked><span>Today</span></label>
          <label><input type="radio" name="startWhen" value="monday"><span>Next Monday</span></label>
        </div>
        <p class="hint">Starting mid-week gives you the rest of this week's runs only.</p>
      </fieldset>
      <fieldset><legend>A recent race or hard effort</legend>
        <p class="hint">A parkrun counts. A best guess is fine: your first time trial will correct it.</p>
        <div class="row">
          <select name="raceDist" aria-label="Distance">${Object.entries(GOAL_NAME).map(([k, v]) => `<option value="${k}" ${p.raceDist === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
          <input name="raceTime" inputmode="numeric" placeholder="mm:ss or h:mm:ss" value="${esc(p.raceTime)}" aria-label="Time" required>
        </div>
        <p class="hint" id="predict"></p>
      </fieldset>
      <label class="field">Goal time for race day (optional)<input name="goalTime" placeholder="e.g. 1:45:00" value="${esc(p.goalTime)}"></label>
      <div class="row">
        <label class="field">Km per week now<input type="number" name="weeklyKm" min="0" max="200" value="${p.weeklyKm}" inputmode="decimal"></label>
        <label class="field">Longest recent run (km)<input type="number" name="longestKm" min="0" max="50" value="${p.longestKm}" inputmode="decimal"></label>
      </div>
      <fieldset><legend>Days you can run</legend>${dayChips('runDays', p.runDays)}</fieldset>
      <label class="field">Long run day<select name="longRunDay">${DAY.map((d, i) => `<option value="${i}" ${p.longRunDay === i ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
      <fieldset><legend>Other hard training days</legend>
        <p class="hint">Leg day, football, padel. Hard runs are kept off these days and the day after where possible.</p>
        ${dayChips('otherDays', p.otherDays)}</fieldset>
      <label class="toggle"><input type="checkbox" name="timeTrials" ${p.timeTrials ? 'checked' : ''}> 5K time trial every 4th week (updates your paces)</label>
      <p class="error" id="setup-error" role="alert"></p>
      <button class="btn primary wide" type="submit">Build my plan</button>
      ${S.plan ? '<button class="btn ghost wide" type="button" id="cancel-setup">Cancel</button>' : ''}
    </form>
  </section>`;
  const form = $('#setup');
  const showPredict = () => {
    const sec = parseTime(form.raceTime.value);
    const goal = form.goal.value;
    $('#predict').textContent = sec
      ? `That predicts about ${fmtTime(predict(vdotFromRace(DIST[form.raceDist.value], sec), DIST[goal]))} for the ${GOAL_NAME[goal].toLowerCase()} today.`
      : '';
  };
  form.addEventListener('input', showPredict);
  showPredict();
  $('#cancel-setup')?.addEventListener('click', () => { $('#tabs').hidden = false; render(); });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const err = (m) => { $('#setup-error').textContent = m; };
    const sec = parseTime(form.raceTime.value);
    const runDays = checked(form, 'runDays');
    const longRunDay = Number(form.longRunDay.value);
    const goalTime = form.goalTime.value.trim() ? parseTime(form.goalTime.value) : null;
    if (!form.raceDate.value) return err('Add your race date.');
    if (!sec) return err('Add a recent time, like 25:30.');
    if (form.goalTime.value.trim() && !goalTime) return err('Goal time should look like 1:45:00.');
    if (runDays.length < 2) return err('Pick at least 2 run days.');
    if (!runDays.includes(longRunDay)) return err('Your long run day must be one of your run days.');
    const vdot = Math.round(vdotFromRace(DIST[form.raceDist.value], sec) * 10) / 10;
    const T = ensureTraining(S);
    applyHardDays(T, checked(form, 'otherDays'));
    const profile = {
      goal: form.goal.value, raceDate: form.raceDate.value, vdot, goalTime,
      base: { vdot, date: today(), source: 'Setup' }, offset: 0, autoFitness: S.profile?.autoFitness ?? true,
      age: S.profile?.age, maxHr: S.profile?.maxHr, restHr: S.profile?.restHr,
      weeklyKm: Number(form.weeklyKm.value) || 0, longestKm: Number(form.longestKm.value) || 0,
      runDays, longRunDay, otherDays: hardDays(T), timeTrials: form.timeTrials.checked,
      raceDist: form.raceDist.value, raceTime: form.raceTime.value,
    };
    const t = today();
    const start = form.startWhen.value === 'today' || weekday(t) === 0 ? t : addDays(mondayOf(t), 7);
    try {
      const plan = buildPlan(profile, start);
      const archived = S.plan ? allWorkouts().filter((w) => S.logs[w.id]?.status === 'done')
        .map((w) => ({ id: 'a' + w.id + w.date, date: w.date, type: w.type === 'race' || w.type === 'trial' ? w.type : 'extra', source: 'old plan', ...S.logs[w.id] })) : [];
      if (S.plan) snapshot('Before starting a new plan', S.profile, archived.map((x) => x.id));
      S = { ...S, profile, plan, logs: {}, extras: [...S.extras, ...archived], vdotHistory: [...S.vdotHistory, { date: t, vdot, source: 'Setup' }], seen: {} };
      persist();
      $('#tabs').hidden = false;
      tab = 'today';
      render();
      toast(`${plan.weeks.length} week plan ready`);
    } catch (ex) { err(ex.message); }
  });
}

// ---------- today ----------
function banners() {
  const out = [];
  const t = today();
  const vc = volumeCheck(S.plan, S.logs, S.extras, t);
  if (vc && S.seen.volume !== vc.week) {
    const msg = vc.direction === 'under'
      ? `Last week you ran ${vc.done} of ${vc.planned} km. Rebuild the coming weeks from what you're really running?`
      : `Last week you ran ${vc.done} km against ${vc.planned} planned. Rebuild the coming weeks to match?`;
    out.push(`<div class="banner"><p>${msg}</p><div class="row"><button class="btn primary" data-act="rebuild">Rebuild</button><button class="btn ghost" data-act="dismiss-volume" data-week="${vc.week}">Keep plan</button></div></div>`);
  }
  const pc = paceCheck(S.plan, S.logs, S.seen.pace);
  if (pc) {
    const msg = pc.change > 0 ? 'Your last 3 hard sessions felt easy. Make paces a little faster?' : 'Your last hard sessions felt very hard. Ease paces off a little?';
    out.push(`<div class="banner"><p>${msg}</p><div class="row"><button class="btn primary" data-act="pace" data-change="${pc.change}" data-last="${pc.lastId}">Yes, adjust</button><button class="btn ghost" data-act="dismiss-pace" data-last="${pc.lastId}">No</button></div></div>`);
  }
  const nc = nextClash();
  if (nc) out.push(clashNote(nc));
  const hasData = Object.keys(S.logs).length > 0;
  if (hasData && (!S.lastBackup || daysBetween(S.lastBackup, t) > 14)) {
    out.push(`<div class="banner quiet"><p>Your runs are only saved on this phone. Save a backup file now and then.</p><div class="row"><button class="btn" data-act="backup">Save backup</button></div></div>`);
  }
  return out.join('');
}

function renderToday() {
  const t = today();
  const p = S.profile;
  const first = S.plan.weeks[0].start;
  const raceIn = daysBetween(t, p.raceDate);
  const wk = weekOf(S.plan, t);
  const todays = allWorkouts().filter((w) => w.date === t);
  const upcoming = allWorkouts().filter((w) => w.date > t).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 3);
  const predicted = predict(p.vdot, DIST[p.goal]);

  let main;
  if (t < first) main = `<div class="card empty"><p class="title">Plan starts ${fmtDate(first)}</p><p class="muted">Rest up, or log an easy run if you go out before then.</p></div>`;
  else if (raceIn < 0) main = `<div class="card empty"><p class="title">Race done</p><p class="muted">Log your result on race day, then start a new plan in Settings (a 5K block works well next).</p></div>`;
  else if (todays.length) main = todays.map((w) => workoutCard(w, true)).join('');
  else if (sessionsOn(T(), t).length) main = '';
  else main = `<div class="card empty"><p class="title">Rest day</p><p class="muted">Recovery is training too.</p></div>`;
  main += sessionsOn(T(), t).map((n) => gymCard(t, n)).join('');

  let week = '';
  if (wk) {
    const s = weekStats(wk, S.logs, S.extras);
    const pct = Math.min(100, Math.round((s.done / (s.planned || 1)) * 100));
    week = `<section><h2>Week ${wk.n} <span class="muted">· ${phaseName(wk)}</span></h2>
      <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>
      <p class="muted small">${s.done} of ${s.planned} km · ${s.count} of ${s.total} runs</p>
      ${weekStrip(wk)}</section>`;
  }

  $('#view').innerHTML = `
    <section class="hero">
      <p class="eyebrow">${fmtDate(t)}</p>
      <h1>${raceIn > 0 ? `${raceIn} days to go` : raceIn === 0 ? 'Race day!' : 'Nice work'}</h1>
      <p class="muted">${GOAL_NAME[p.goal]} · ${fmtShort(p.raceDate)} · predicted ${fmtTime(predicted)}${p.goalTime ? ` · goal ${fmtTime(p.goalTime)}` : ''}</p>
    </section>
    ${banners()}
    <section><h2>Today</h2>${main}</section>
    ${week}
    ${upcoming.length ? `<section><h2>Coming up</h2>${upcoming.map((w) => workoutCard(w)).join('')}</section>` : ''}
    <button class="btn wide" data-act="log-extra">+ Log a run that wasn't planned</button>
    ${S.sync.apiKey ? `<p class="muted small center">Synced ${S.sync.lastSync ? fmtShort(S.sync.lastSync) : 'never'} · <button class="link" data-act="sync">Sync now</button></p>` : ''}`;
}

const phaseName = (wk) => wk.race ? 'Race week' : wk.recovery ? `${cap(wk.phase)} · easier` : cap(wk.phase);
const cap = (s) => s[0].toUpperCase() + s.slice(1);

function weekStrip(wk) {
  return `<div class="strip">${DAY.map((d, i) => {
    const date = addDays(wk.start, i);
    const w = wk.workouts.find((x) => x.date === date);
    const log = w && S.logs[w.id];
    const cls = w ? `has ${log?.status || ''}` : '';
    const gym = sessionsOn(T(), date).length;
    const target = w ? `data-open="${w.id}"` : `data-day="${date}"`;
    return `<button class="strip-day ${cls} ${date === today() ? 'today' : ''}" ${target} style="${w ? `--type: var(--c-${TYPES[w.type].color})` : ''}">
      <span class="small">${d}</span><span class="dot"></span><span class="small">${w ? w.km : ''}</span><span class="gymbar ${gym ? 'on' : ''}"></span></button>`;
  }).join('')}</div>`;
}

// ---------- plan ----------
function renderPlan() {
  const t = today();
  const wkNow = weekOf(S.plan, t);
  const phases = S.plan.weeks.map((w) => `<span class="ph ${w.phase} ${wkNow === w ? 'now' : ''}" title="Week ${w.n}: ${w.phase}"></span>`).join('');
  $('#view').innerHTML = `
    <section><h1>Your plan</h1>
      <p class="muted">${S.plan.weeks.length} weeks to ${GOAL_NAME[S.profile.goal].toLowerCase()} on ${fmtDate(S.profile.raceDate)}</p>
      <div class="phases" aria-hidden="true">${phases}</div>
      <p class="legend small"><span class="ph base"></span>Base <span class="ph build"></span>Build <span class="ph peak"></span>Peak <span class="ph taper"></span>Taper</p>
    </section>
    ${S.plan.weeks.map((wk) => {
      const s = weekStats(wk, S.logs, S.extras);
      const open = wk === wkNow || (!wkNow && wk.n === 1);
      return `<details class="week" ${open ? 'open' : ''} id="week-${wk.n}">
        <summary><span><b>Week ${wk.n}</b> <span class="muted">· ${fmtShort(wk.start)} · ${phaseName(wk)}</span></span><span class="muted">${wk.start <= t ? `${s.done}/` : ''}${wk.km} km</span></summary>
        ${DAY.map((d, i) => {
          const date = addDays(wk.start, i);
          const w = wk.workouts.find((x) => x.date === date);
          const gym = sessionsOn(T(), date);
          const extra = S.extras.filter((x) => x.date === date).map((x) => `${x.walk ? 'Walk' : 'Extra run'} ${x.km} km &#10003;`);
          const gymText = gym.length || extra.length ? `<span class="gymline">${[...gym.map(esc), ...extra].join(' · ')}</span>` : '';
          if (!w) return `<button class="day ${gymText ? '' : 'rest'}" data-day="${date}"><span class="d">${d}</span>
            <span class="grow">${gymText || '<span class="muted">Rest</span>'}</span></button>`;
          return `<button class="day" data-open="${w.id}" style="--type: var(--c-${TYPES[w.type].color})"><span class="d">${d}</span><span class="pill"></span>
            <span class="grow">${esc(TYPES[w.type].name)}${gymText}</span><span class="muted">${w.km} km</span>${statusIcon(w)}</button>`;
        }).join('')}
      </details>`;
    }).join('')}`;
  if (wkNow && scrollToWeek) setTimeout(() => $(`#week-${wkNow.n}`)?.scrollIntoView({ block: 'start' }), 0);
  scrollToWeek = false;
}

// ---------- workout sheet ----------
function openWorkout(id) {
  const w = findWorkout(id);
  if (!w) return;
  const t = TYPES[w.type];
  const log = S.logs[w.id];
  const wk = weekOf(S.plan, w.date);
  const moveDays = DAY.map((d, i) => ({ d, date: addDays(wk.start, i) })).filter((x) => x.date !== w.date && (x.date <= S.profile.raceDate || w.type === 'race'));
  const done = log?.status === 'done';
  openSheet(`
    <div class="sheet-head" style="--type: var(--c-${t.color})"><span class="type-bar"></span>
      <div><p class="eyebrow">${fmtDate(w.date)} · Week ${wk.n}</p><h2>${esc(t.name)}</h2>
      <p class="muted">${w.km} km · about ${duration(estimate(w))}${w.adjusted ? ' · adjusted' : ''}</p></div></div>
    <ol class="steps">${w.steps.map(stepHtml).join('')}</ol>
    ${done ? `<div class="card done-box"><b>Done</b>${runStats({ ...log, date: w.date })}</div>` : ''}
    ${log?.status === 'skipped' ? `<div class="card done-box"><b>Skipped</b>${log.note ? ` · ${esc(log.note)}` : ''}</div>` : ''}
    <div class="actions">
      ${done ? `<button class="btn" data-act="log" data-id="${w.id}">Edit</button>
           <button class="btn ghost" data-act="tread" data-src="plan" data-id="${w.id}">Count as ${log.treadmill ? 'outdoor' : 'treadmill'} run</button>
           <button class="btn ghost" data-act="unlog" data-id="${w.id}">Undo (remove this run)</button>`
        : log?.status === 'skipped' ? `<button class="btn ghost" data-act="unlog" data-id="${w.id}">Undo skip</button>`
        : `<button class="btn primary" data-act="log" data-id="${w.id}">Log this run</button>
           ${w.type !== 'race' ? `<button class="btn" data-act="feel" data-id="${w.id}">Not feeling 100%</button>` : ''}
           <button class="btn ghost" data-act="skip" data-id="${w.id}">Skip</button>`}
      ${w.adjusted ? `<button class="btn ghost" data-act="restore" data-id="${w.id}">Restore original</button>` : ''}
    </div>
    ${!done && w.type !== 'race' ? `<label class="field">Move to<select data-act="move" data-id="${w.id}"><option value="">Pick a day this week</option>${moveDays.map((x) =>
      `<option value="${x.date}">${x.d} ${fmtShort(x.date)}${wk.workouts.some((o) => o.date === x.date) ? ' (swap)' : ''}</option>`).join('')}</select></label>` : ''}
    ${HARD.has(w.type) && w.type !== 'race' ? `<p class="muted small">Hit the paces on the reps, not the whole run. Log how hard it felt so the app can tune your paces.</p>` : ''}
    ${clashNote(w)}
    ${dayTraining(w.date)}
  `);
}

// ---------- gym and other training ----------
const T = () => ensureTraining(S);
const doneKey = (date, name) => `${date}|${name}`;

function gymCard(date, name) {
  const done = T().done[doneKey(date, name)];
  return `<button class="card workout gym" data-day="${date}" style="--type: var(--c-gym)"><span class="type-bar"></span>
    <span class="grow"><span class="eyebrow">${fmtDate(date)} · ${isHard(T(), name) ? 'Hard on legs' : 'Gym'}</span><span class="title">${esc(name)}</span></span>
    ${done ? '<span class="status done" aria-label="Done">&#10003;</span>' : ''}</button>`;
}

function clashNote(w) {
  const c = clashFor(T(), w, HARD);
  if (!c || S.logs[w.id]) return '';
  const wk = weekOf(S.plan, w.date);
  const swap = swapOption(T(), w, wk, HARD, today());
  const when = c.when === 'same' ? `the same day as ${esc(c.name)}` : `the day after ${esc(c.name)}`;
  return `<div class="banner small"><p><b>${esc(TYPES[w.type].name)}</b> on ${fmtDate(w.date)} is ${when}.</p>
    ${swap ? `<div class="row"><button class="btn primary" data-act="swap" data-id="${w.id}" data-with="${swap.id}">Swap with ${DAY[weekday(swap.date)]} easy run</button></div>`
      : '<p class="muted">No easy run this week to swap with. Run it first, or move it with Move to.</p>'}</div>`;
}

// Next upcoming clash in the coming week, for the Today screen.
function nextClash() {
  const t = today(), end = addDays(t, 7);
  return allWorkouts().filter((w) => w.date >= t && w.date <= end && !S.logs[w.id]).sort((a, b) => a.date.localeCompare(b.date))
    .find((w) => clashFor(T(), w, HARD));
}

function dayTraining(date) {
  const wk = weekOf(S.plan, date);
  const days = wk ? DAY.map((d, i) => ({ d, date: addDays(wk.start, i) })).filter((x) => x.date !== date) : [];
  const list = sessionsOn(T(), date);
  return `<section class="training"><h3>Gym and training</h3>
    ${list.map((n) => {
      const done = T().done[doneKey(date, n)];
      return `<div class="gymrow">
        <button class="tick ${done ? 'on' : ''}" data-act="gym-done" data-date="${date}" data-name="${esc(n)}" aria-label="${done ? 'Mark not done' : 'Mark done'}">&#10003;</button>
        <span class="grow">${esc(n)}${isHard(T(), n) ? ' <span class="muted small">hard on legs</span>' : ''}</span>
        <select data-act="gym-move" data-date="${date}" data-name="${esc(n)}" aria-label="Move ${esc(n)}"><option value="">Move</option>${days.map((x) => `<option value="${x.date}">${x.d} ${fmtShort(x.date)}</option>`).join('')}</select>
        <button class="link" data-act="gym-remove" data-date="${date}" data-name="${esc(n)}">Remove</button></div>`;
    }).join('') || '<p class="muted small">Nothing planned.</p>'}
    <select class="add-session" data-act="gym-add" data-date="${date}" aria-label="Add a session"><option value="">+ Add a session to this day</option>${T().library.map((x) => `<option value="${esc(x.name)}">${esc(x.name)}</option>`).join('')}</select>
    <p class="muted small">Changes here are for this date only. Set your usual week in Settings.</p></section>
    ${(() => { const nx = allWorkouts().find((x) => x.date === addDays(date, 1)); return nx && clashFor(T(), nx, HARD)?.when === 'after' ? clashNote(nx) : ''; })()}`;
}

function openDay(date) {
  const w = allWorkouts().find((x) => x.date === date);
  if (w) return openWorkout(w.id);
  openSheet(`<div class="sheet-head"><div><p class="eyebrow">${fmtDate(date)}</p><h2>No run</h2></div></div>${dayTraining(date)}`);
}

// Changing which days are hard on the legs rebuilds the coming weeks around them.
function afterTemplateChange() {
  const hd = hardDays(T());
  if (hd.join() !== [...S.profile.otherDays].sort().join()) {
    const prev = copy(S.profile);
    S.profile.otherDays = hd;
    return doRebuild('Runs from next Monday rebuilt around your hard days', prev, 'monday');
  }
  persist(); render();
}

function trainingSettings() {
  const t = T();
  return `<section class="card"><h2>Weekly gym and training</h2>
    <p class="muted small">Your usual week. Sessions marked hard on legs keep hard runs off that day and the day after.</p>
    ${DAY.map((d, i) => `<div class="wkrow"><span class="d">${d}</span><span class="grow chipwrap">
      ${t.week[i].map((n) => `<button class="tchip ${isHard(t, n) ? 'hard' : ''}" data-act="tpl-remove" data-day="${i}" data-name="${esc(n)}" aria-label="Remove ${esc(n)} from ${d}">${esc(n)} &times;</button>`).join('')}</span>
      <select data-act="tpl-add" data-day="${i}" aria-label="Add to ${d}"><option value="">+</option>${t.library.map((x) => `<option value="${esc(x.name)}">${esc(x.name)}</option>`).join('')}</select></div>`).join('')}
    <h3>Session list</h3>
    ${t.library.map((x) => `<div class="row-between lib"><span>${esc(x.name)}</span>
      <label class="toggle small"><input type="checkbox" data-act="lib-hard" data-name="${esc(x.name)}" ${x.hard ? 'checked' : ''}> Hard on legs</label>
      <button class="link" data-act="lib-del" data-name="${esc(x.name)}">Delete</button></div>`).join('')}
    <form id="lib-add" class="row" novalidate>
      <input name="name" placeholder="New session, e.g. Mobility" aria-label="New session name" maxlength="40">
      <button class="btn" type="submit">Add</button>
    </form></section>`;
}

function openLog(id, extra = false) {
  const w = id ? findWorkout(id) : null;
  const log = (id && S.logs[id]) || {};
  const result = w && (w.type === 'trial' || w.type === 'race');
  const resultKm = w?.type === 'trial' ? 5 : w?.type === 'race' ? DIST[S.profile.goal] / 1000 : null;
  openSheet(`
    <h2>${extra ? 'Log a run' : `Log: ${esc(TYPES[w.type].name)}`}</h2>
    <form id="logform" novalidate>
      ${extra ? `<label class="field">Date<input type="date" name="date" value="${today()}" max="${today()}"></label>` : ''}
      <div class="row">
        <label class="field">Distance (km)<input type="number" step="0.01" min="0" name="km" inputmode="decimal" value="${log.km ?? w?.km ?? ''}"></label>
        <label class="field">Time<input name="time" placeholder="mm:ss or h:mm:ss" value="${log.sec ? fmtTime(log.sec) : ''}"></label>
      </div>
      ${result ? `<label class="field">${w.type === 'trial' ? '5K time' : 'Race time'} (updates your paces)<input name="result" placeholder="${w.type === 'trial' ? 'e.g. 22:30' : 'e.g. 1:45:00'}" value="${log.resultSec ? fmtTime(log.resultSec) : ''}"></label>` : ''}
      <div class="row">
        <label class="field">Avg heart rate (optional)<input type="number" name="hr" min="60" max="230" inputmode="numeric" value="${log.hr ? Math.round(log.hr) : ''}" placeholder="bpm"></label>
        <label class="field">Avg cadence (optional)<input type="number" name="cad" min="60" max="240" inputmode="numeric" value="${log.cad ? Math.round(log.cad) : ''}" placeholder="spm"></label>
      </div>
      <label class="toggle"><input type="checkbox" name="treadmill" ${log.treadmill ? 'checked' : ''}> Treadmill</label>
      ${extra ? '<label class="toggle"><input type="checkbox" name="walk"> This was a walk (kept out of running stats)</label>' : ''}
      <label class="field">How hard did it feel? <output id="rpe-out">${log.rpe ?? 5}</output>/10
        <input type="range" min="1" max="10" name="rpe" value="${log.rpe ?? 5}"></label>
      <p class="hint">1 to 3 easy chat · 5 to 6 comfortably hard · 8 to 9 very hard · 10 all out</p>
      <label class="field">Notes<textarea name="note" rows="2">${esc(log.note || '')}</textarea></label>
      <p class="error" id="log-error" role="alert"></p>
      <button class="btn primary wide" type="submit">Save</button>
    </form>`, (root) => {
    const f = $('#logform', root);
    f.rpe.addEventListener('input', () => { $('#rpe-out', root).textContent = f.rpe.value; });
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const km = Number(f.km.value);
      const sec = f.time.value.trim() ? parseTime(f.time.value) : null;
      if (!km || km <= 0 || km > 100) return ($('#log-error', root).textContent = 'Add the distance in km.');
      if (f.time.value.trim() && !sec) return ($('#log-error', root).textContent = 'Time should look like 32:10 or 1:05:00.');
      const hr = f.hr.value ? Number(f.hr.value) : null;
      if (hr && (hr < 60 || hr > 230)) return ($('#log-error', root).textContent = 'Heart rate should be between 60 and 230.');
      const cad = f.cad.value ? Number(f.cad.value) : null;
      if (cad && (cad < 60 || cad > 240)) return ($('#log-error', root).textContent = 'Cadence should be between 60 and 240 steps a minute.');
      const entry = { km, sec, rpe: Number(f.rpe.value), note: f.note.value.trim(), hr, cad, treadmill: f.treadmill.checked, treadmillSet: true };
      if (extra) {
        S.extras.push({ id: 'm' + Date.now(), date: f.date.value || today(), source: 'manual', ...entry, walk: f.walk.checked || undefined });
      } else {
        const rs = result && f.result.value.trim() ? parseTime(f.result.value) : null;
        if (result && f.result.value.trim() && !rs) return ($('#log-error', root).textContent = 'Result time should look like 22:30.');
        S.logs[id] = { ...S.logs[id], status: 'done', source: S.logs[id]?.source || 'manual', ...entry, resultSec: rs };
        if (rs) {
          const v = vdotFromResult(resultKm, rs);
          if (v) setBase(v, w.type === 'trial' ? '5K time trial' : 'Race');
        }
      }
      persist();
      closeSheet();
      render();
      toast('Run saved');
    });
  });
}

function recalcWeek(w) {
  const wk = weekOf(S.plan, w.date);
  wk.km = Math.round(wk.workouts.reduce((s, x) => s + x.km, 0) * 2) / 2;
}


// Keep a copy of the plan before anything replaces it, so it can be restored. Last 5 kept.
const copy = (x) => JSON.parse(JSON.stringify(x));
function snapshot(reason, profile = S.profile, archived = []) {
  if (!S.plan) return;
  S.planHistory = [{ id: 'p' + Date.now(), savedAt: today(), reason, profile: copy(profile), plan: copy(S.plan), logs: copy(S.logs), archived },
    ...(S.planHistory || [])].slice(0, 5);
}

function restorePlan(id) {
  const snap = (S.planHistory || []).find((x) => x.id === id);
  if (!snap) return;
  const rest = S.planHistory.filter((x) => x.id !== id);
  snapshot('Before restoring an older plan');
  S.planHistory = [S.planHistory[0], ...rest].slice(0, 5);
  S.extras = S.extras.filter((e) => !snap.archived.includes(e.id)); // its runs come back as plan runs, not extras
  S.profile = snap.profile; S.plan = snap.plan; S.logs = snap.logs;
  persist(); render(); toast('Older plan restored');
}

let rebuildFrom = 'today'; // Settings choice: 'today' or 'monday'

function doRebuild(msg, prevProfile = S.profile, from = rebuildFrom) {
  try {
    snapshot('Before rebuild', prevProfile);
    const fromToday = from === 'today';
    msg = msg || (fromToday ? 'Plan rebuilt from today' : 'Plan rebuilt from next Monday');
    const next = addDays(mondayOf(today()), 7);
    for (const w of S.plan.weeks) if (w.start >= next) for (const x of w.workouts) delete S.logs[x.id];
    S.plan = rebuild(S.profile, S.plan, S.logs, S.extras, today(), fromToday);
    persist();
    render();
    toast(msg);
  } catch (ex) { toast(ex.message); }
}

// ---------- progress ----------
let pf = { where: 'all', kind: 'all' }; // Progress filters

function renderProgress() {
  const t = today();
  const weeks = S.plan.weeks.filter((w) => w.start <= t);
  const rows = weeks.map((w) => ({ label: String(w.n), planned: w.km, done: weekStats(w, S.logs, S.extras).done, current: w === weekOf(S.plan, t) }));
  const all = runList(S.plan, S.logs, S.extras);
  const totalKm = Math.round(all.reduce((sum, r) => sum + (r.km || 0), 0) * 10) / 10;
  const rec = records(all);
  const runs = filterRuns(all, pf);
  const timed = runs.filter((r) => r.sec && r.km >= 0.5);
  const cls = (r) => (HARD.has(r.type) ? 'hard' : '');
  const pacePts = timed.map((r) => ({ label: fmtShort(r.date), y: r.sec / r.km, cls: cls(r) }));
  const hrPts = timed.filter((r) => r.hr).map((r) => ({ label: fmtShort(r.date), y: r.hr, cls: cls(r) }));
  const cadPts = timed.filter((r) => r.cad).map((r) => ({ label: fmtShort(r.date), y: r.cad, cls: cls(r) }));
  const beatPts = timed.filter((r) => r.hr).map((r) => ({ label: fmtShort(r.date), y: (r.hr * r.sec) / 60 / r.km, cls: cls(r) }));
  const avg = averages(runs);
  const cmp = compare(runs, t);
  const seg = (key, opts) => `<div class="seg mini">${opts.map(([v, label]) =>
    `<button class="${pf[key] === v ? 'on' : ''}" data-act="pf" data-key="${key}" data-val="${v}" aria-pressed="${pf[key] === v}">${label}</button>`).join('')}</div>`;
  // goodWhen: 'lower' (pace, beats per km) or null when neither direction is simply better (heart rate, cadence)
  const change = (a, b, fmt, unit, goodWhen = 'lower') => {
    if (a == null || b == null) return a == null ? '-' : `${fmt(a)}${unit}`;
    const word = Math.abs(a - b) < 0.5 ? 'same' : a < b ? 'lower' : 'higher';
    const good = goodWhen === 'lower' && word === 'lower';
    return `${fmt(b)} &rarr; <b>${fmt(a)}</b>${unit} <span class="${good ? 'good' : 'muted'}">${good ? 'better' : word}</span>`;
  };
  const prRow = (name, r) => `<tr><td>${name}</td><td>${r ? fmtTime(r.sec) : '-'}</td><td class="muted small">${r ? `${fmtShort(r.date)}${r.est ? ' · from a longer run' : ''}` : ''}</td></tr>`;
  const walks = S.extras.filter((e) => e.walk).map((e) => ({ type: 'extra', ...e }));
  const recent = [...all, ...walks].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12);

  $('#view').innerHTML = `
    <section><h1>Progress</h1>
      <div class="tiles">
        <div class="tile"><span class="big">${totalKm}</span><span class="muted small">km logged</span></div>
        <div class="tile"><span class="big">${all.length}</span><span class="muted small">runs</span></div>
        <div class="tile"><span class="big">${S.profile.vdot}</span><span class="muted small">fitness (VDOT)</span></div>
      </div>
    </section>

    <section><h2>Personal records</h2>
      <table class="table">
        ${prRow('5K', rec.fiveK)}${prRow('10K', rec.tenK)}${prRow('Half marathon', rec.half)}${prRow('Marathon', rec.marathon)}
        <tr><td>Longest run</td><td>${rec.longest ? `${rec.longest.km} km` : '-'}</td><td class="muted small">${rec.longest ? fmtShort(rec.longest.date) : ''}</td></tr>
        <tr><td>Fastest avg pace (3 km+)</td><td>${rec.fastest ? `${fmtPace(rec.fastest.pace)} /km` : '-'}</td><td class="muted small">${rec.fastest ? `${fmtShort(rec.fastest.date)} · ${rec.fastest.km} km` : ''}</td></tr>
      </table>
    </section>

    <section><h2>Predicted race times</h2>
      <table class="table">
        ${[['5K', 5000], ['10K', 10000], ['Half marathon', 21097.5], ['Marathon', 42195]].map(([n, m]) =>
          `<tr><td>${n}</td><td>${fmtTime(predict(S.profile.vdot, m))}</td><td class="muted small">${fmtPace(predict(S.profile.vdot, m) / (m / 1000))} /km</td></tr>`).join('')}
      </table>
      <p class="muted small">From your fitness score (VDOT ${S.profile.vdot}). ${S.profile.autoFitness ? 'Updates automatically from your runs, and resets with each time trial or race.' : 'Updates after each time trial or race.'}</p>
      ${line(S.vdotHistory.map((h) => ({ label: fmtShort(h.date), y: h.vdot })), { label: 'VDOT over time' })}
    </section>

    ${(() => {
      const w = (S.sync.wellness || []).filter((d) => d.date >= addDays(t, -90));
      const rhr = w.filter((d) => d.rhr), vo2 = w.filter((d) => d.vo2);
      if (!rhr.length && !vo2.length) return '';
      const hr = HR();
      return `<section><h2>From Garmin</h2>
        <div class="tiles">
          <div class="tile"><span class="big">${S.sync.restHr ?? '-'}</span><span class="muted small">resting HR, 14-day avg</span></div>
          <div class="tile"><span class="big">${vo2.at(-1)?.vo2 ?? '-'}</span><span class="muted small">Garmin VO2 max</span></div>
          <div class="tile"><span class="big">${hr.max ?? '-'}</span><span class="muted small">max HR used</span></div>
        </div>
        <h3>Resting heart rate</h3>
        ${line(rhr.map((d) => ({ label: fmtShort(d.date), y: d.rhr })), { fmt: (v) => String(Math.round(v)), lowerIsBetter: true, label: 'Resting heart rate' }) || '<p class="muted small">Needs 2 days of data.</p>'}
        <p class="muted small">Lower is fitter and better recovered (higher on the chart). A jump of 5+ bpm can mean tiredness or illness coming: take an easy day.</p>
        ${vo2.length >= 2 ? `<h3>Garmin VO2 max</h3>${line(vo2.map((d) => ({ label: fmtShort(d.date), y: d.vo2 })), { label: 'Garmin VO2 max' })}` : ''}
      </section>`;
    })()}

    <section><h2>Run analysis</h2>
      ${seg('where', [['all', 'All'], ['outdoor', 'Outdoor'], ['treadmill', 'Treadmill']])}
      ${seg('kind', [['all', 'All runs'], ['easy', 'Easy and long only']])}
      <p class="muted small">${runs.length} run${runs.length === 1 ? '' : 's'}. Easy and long only is the fairest comparison, since hard sessions skew pace and heart rate.</p>
      <div class="tiles">
        <div class="tile"><span class="big">${avg.pace ? fmtPace(avg.pace) : '-'}</span><span class="muted small">avg pace /km</span></div>
        <div class="tile"><span class="big">${avg.hr ? Math.round(avg.hr) : '-'}</span><span class="muted small">avg run heart rate</span></div>
        <div class="tile"><span class="big">${avg.cad ? Math.round(avg.cad) : '-'}</span><span class="muted small">avg cadence (spm)</span></div>
      </div>
      <h3>Average pace per run</h3>
      ${dots(pacePts, { fmt: fmtPace, lowerIsBetter: true, label: 'Average pace per run' }) || '<p class="muted small">Needs 2 runs with a time.</p>'}
      <h3>Average heart rate per run</h3>
      ${dots(hrPts, { fmt: (v) => String(Math.round(v)), label: 'Average heart rate per run' }) || '<p class="muted small">Needs 2 runs with heart rate. Synced Garmin runs include it, or add it when you log.</p>'}
      <h3>Heartbeats per km per run</h3>
      ${dots(beatPts, { fmt: (v) => String(Math.round(v)), lowerIsBetter: true, label: 'Heartbeats per km per run' }) || '<p class="muted small">Needs 2 runs with heart rate.</p>'}
      <p class="muted small">Your clearest fitness signal: fewer beats per km is higher on this chart. Pace and heart rate alone move with effort; this joins them.</p>
      <h3>Average cadence per run</h3>
      ${dots(cadPts, { fmt: (v) => String(Math.round(v)), label: 'Average cadence per run' }) || '<p class="muted small">Needs 2 runs with cadence. Garmin runs include it.</p>'}
      <p class="legend small"><span class="key done"></span>Easy, long and extra <span class="key hard"></span>Hard sessions · dashed line shows the trend. Faster is higher on the pace chart.</p>
      <h3>Last 4 weeks vs the 4 before</h3>
      <table class="table">
        <tr><td>Avg pace</td><td>${change(cmp.recent.pace, cmp.before.pace, fmtPace, ' /km')}</td></tr>
        <tr><td>Avg heart rate</td><td>${change(cmp.recent.hr, cmp.before.hr, (v) => Math.round(v), ' bpm', null)}</td></tr>
        <tr><td>Heartbeats per km</td><td>${change(cmp.recent.beats, cmp.before.beats, (v) => Math.round(v), '')}</td></tr>
        <tr><td>Avg cadence</td><td>${change(cmp.recent.cad, cmp.before.cad, (v) => Math.round(v), ' spm', null)}</td></tr>
      </table>
      <p class="muted small">Heartbeats per km joins pace and heart rate: fewer beats to cover a km means you're getting fitter.</p>
    </section>

    <section><h2>Weekly km</h2>
      ${rows.length ? weeklyBars(rows) + '<p class="legend small"><span class="key planned"></span>Planned <span class="key done"></span>Done</p>' : '<p class="muted">Shows once your plan starts.</p>'}
    </section>

    ${recent.length ? `<section><h2>Recent runs</h2>${recent.map((r) => {
      const isExtra = r.type === 'extra';
      return `<button class="card runrow" data-act="run" data-src="${isExtra ? 'extra' : 'plan'}" data-id="${r.id}">
        <span class="row-between"><span><b>${fmtDate(r.date)}</b> · ${esc(isExtra ? (r.name || (r.walk ? 'Walk' : 'Extra run')) : TYPES[r.type]?.name || r.type)}</span>
        <span class="muted small">${r.walk ? 'Walk' : r.treadmill ? 'Treadmill' : 'Outdoor'} &rsaquo;</span></span>
        <span class="muted small">${r.km} km${r.sec ? ` · ${fmtTime(r.sec)} · ${paceOf(r.sec, r.km)}` : ''}${r.hr ? ` · ${Math.round(r.hr)} bpm` : ''}${r.maxHr ? ` (max ${Math.round(r.maxHr)})` : ''}${r.cad ? ` · ${Math.round(r.cad)} spm` : ''}</span></button>`;
    }).join('')}<p class="muted small">Tap a run for all its numbers, to switch treadmill or outdoor, or to delete it.</p></section>` : ''}`;
}

// ---------- settings ----------
function renderSettings() {
  const p = S.profile;
  const pz = zp();
  const fit = fitnessNow();
  const hr = HR();
  const fitPace = predict(p.vdot, DIST[p.goal]) / (DIST[p.goal] / 1000);
  const goalPace = p.goalTime ? p.goalTime / (DIST[p.goal] / 1000) : null;
  $('#view').innerHTML = `
    <h1>Settings</h1>
    <section class="card"><h2>Paces</h2>
      <table class="table">
        <tr><th>Per km</th><th>Pace</th><th>Treadmill</th></tr>
        <tr><td>Easy and long runs</td><td>${fmtPace(pz.easyFast)} to ${fmtPace(pz.easySlow)}</td><td>${kmh(pz.easySlow)} to ${kmh(pz.easyFast)} km/h</td></tr>
        <tr><td>${GOAL_NAME[p.goal]} pace from your fitness${usesGoal() ? '' : ' <span class="muted small">(used in sessions)</span>'}</td><td>${fmtPace(fitPace)}</td><td>${kmh(fitPace)} km/h</td></tr>
        ${p.goalTime ? `<tr><td>${GOAL_NAME[p.goal]} goal pace${usesGoal() ? ' <span class="muted small">(used in sessions)</span>' : ''}</td><td>${fmtPace(goalPace)}</td><td>${kmh(goalPace)} km/h</td></tr>` : ''}
        <tr><td>Threshold (tempo)</td><td>${fmtPace(pz.threshold)}</td><td>${kmh(pz.threshold)} km/h</td></tr>
        <tr><td>10K pace</td><td>${fmtPace(pz.tenK)}</td><td>${kmh(pz.tenK)} km/h</td></tr>
        <tr><td>5K pace</td><td>${fmtPace(pz.fiveK)}</td><td>${kmh(pz.fiveK)} km/h</td></tr>
        <tr><td>Intervals</td><td>${fmtPace(pz.interval)}</td><td>${kmh(pz.interval)} km/h</td></tr>
      </table>
      <p class="muted small">Treadmill: set the incline to 1%, which matches running outside.</p>

      <h3>Fitness score: ${p.vdot}</h3>
      <label class="toggle"><input type="checkbox" data-act="auto-fit" ${p.autoFitness ? 'checked' : ''}> Adjust automatically from my runs</label>
      <table class="table stats">
        <tr><td>Last race, time trial or setup</td><td>${fit.base} <span class="muted small">${esc(p.base.source)}, ${fmtShort(p.base.date)}</span></td></tr>
        ${p.autoFitness ? `<tr><td>From your recent runs</td><td>${fit.runVdot ?? '-'} <span class="muted small">${fit.runs} run${fit.runs === 1 ? '' : 's'}, counts ${Math.round(fit.trust * 100)}%</span></td></tr>
        <tr><td>From Garmin VO2 max trend</td><td>${fit.garmin ? `${fit.garmin.vdot} <span class="muted small">VO2 max ${fit.garmin.then} &rarr; ${fit.garmin.now}, counts 20%</span>` : `- <span class="muted small">${latestVo2() ? `VO2 max ${latestVo2().vo2}, needs a change to use` : 'not received yet'}</span>`}</td></tr>` : ''}
        <tr><td>Your adjustment</td><td>${p.offset > 0 ? '+' : ''}${p.offset}</td></tr>
        <tr><td><b>Used for paces</b></td><td><b>${p.vdot}</b></td></tr>
      </table>
      <p class="muted small">${p.autoFitness ? `Garmin's VO2 max reads higher than race-based fitness (it can't see how efficiently you run), so only its rises and falls are used. Each steady run (easy, long, tempo, race pace, 15 min+) compares your pace with how hard it was: heart rate first, effort score if there's no heart rate. Recent runs count more, odd ones are ignored, treadmill runs count a bit less (indoor heat raises heart rate). A time trial or race resets the base.${hr.max ? '' : ' <b>Add your age or max heart rate below so heart rate can be used.</b>'}` : 'Paces only change with a time trial, race, entered result, or the buttons below.'}</p>
      <div class="row"><button class="btn" data-act="vdot" data-change="-1">Slower</button><button class="btn" data-act="vdot" data-change="1">Faster</button></div>
      <p class="muted small">Each tap moves every pace about 3 seconds per km. A new time trial or race clears your adjustment.</p>
      <form id="result-form" class="row" novalidate>
        <select name="dist" aria-label="Race distance">${Object.entries(GOAL_NAME).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        <input name="time" placeholder="New result" aria-label="Result time">
        <button class="btn" type="submit">Set</button>
      </form>

      <h3>Heart rate</h3>
      <form id="hr-form" novalidate>
        <div class="row">
          <label class="field">Age<input type="number" name="age" min="10" max="90" inputmode="numeric" value="${p.age ?? ''}"></label>
          <label class="field">Max HR<input type="number" name="maxHr" min="120" max="230" inputmode="numeric" value="${p.maxHr ?? ''}" placeholder="${hr.max ?? 'bpm'}"></label>
          <label class="field">Resting HR<input type="number" name="restHr" min="30" max="100" inputmode="numeric" value="${p.restHr ?? ''}" placeholder="${hr.rest}"></label>
        </div>
        <p class="hint">Using max ${hr.max ?? 'unknown'} (${{ set: 'you set it', recorded: 'highest recorded', age: 'estimated from age' }[hr.maxSource] || 'add your age'}) and resting ${hr.rest} (${{ set: 'you set it', garmin: 'from Garmin', default: 'a typical value' }[hr.restSource]}). Leave max blank unless you've seen a higher one in an all-out effort.</p>
        <button class="btn wide" type="submit">Save heart rate</button>
      </form>
    </section>

    <section class="card"><h2>Goal and schedule</h2>
      <form id="sched" novalidate>
        <label class="field">Race date<input type="date" name="raceDate" value="${p.raceDate}"></label>
        <label class="field">Goal time (optional)<input name="goalTime" value="${p.goalTime ? fmtTime(p.goalTime) : ''}" placeholder="e.g. 1:45:00"></label>
        <p class="hint">Predicted from your fitness: ${fmtTime(predict(p.vdot, DIST[p.goal]))}.</p>
        ${p.goalTime ? `<fieldset><legend>Race pace sessions use</legend><div class="seg">
          <label><input type="radio" name="paceFrom" value="goal" ${usesGoal() ? 'checked' : ''}><span>My goal time</span></label>
          <label><input type="radio" name="paceFrom" value="fitness" ${usesGoal() ? '' : 'checked'}><span>My fitness</span></label></div>
          <p class="hint">Goal: a fixed target. Fitness: moves faster or slower as your fitness score changes.</p></fieldset>` : ''}
        ${(() => {
          const target = p.peakLong || DEFAULT_PEAK_LONG[p.goal];
          const planned = Math.max(0, ...S.plan.weeks.flatMap((w) => w.workouts).filter((w) => w.type === 'long').map((w) => w.km));
          return `<label class="field">Longest run before race day (km)<input type="number" name="peakLong" min="5" max="40" step="0.5" inputmode="decimal" value="${target}"></label>
          <p class="hint ${planned < target ? 'error' : ''}">Your plan's longest run is ${planned} km${planned < target ? `, short of ${target} km. The weekly build is capped to stay safe; once you're running more each week, tap Rebuild from my recent running and it can go further.` : '.'}</p>`;
        })()}
        <fieldset><legend>Run days</legend>${dayChips('runDays', p.runDays)}</fieldset>
        <label class="field">Long run day<select name="longRunDay">${DAY.map((d, i) => `<option value="${i}" ${p.longRunDay === i ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
        <p class="hint">Hard training days come from your weekly gym and training below.</p>
        <label class="toggle"><input type="checkbox" name="timeTrials" ${p.timeTrials ? 'checked' : ''}> 5K time trials in recovery weeks</label>
        <p class="error" id="sched-error" role="alert"></p>
        <div class="row">
          <label class="field">Km per week now<input type="number" name="weeklyKm" min="0" max="200" inputmode="decimal" value="${p.weeklyKm}"></label>
          <label class="field">Longest recent run (km)<input type="number" name="longestKm" min="0" max="50" inputmode="decimal" value="${p.longestKm}"></label>
        </div>
        <p class="hint">Used until you've logged two full weeks; after that the plan builds from what you actually ran.</p>
        <fieldset><legend>Rebuild from</legend><div class="seg">
          <label><input type="radio" name="rebuildFrom" value="today" ${rebuildFrom === 'today' ? 'checked' : ''}><span>Today</span></label>
          <label><input type="radio" name="rebuildFrom" value="monday" ${rebuildFrom === 'monday' ? 'checked' : ''}><span>Next Monday</span></label></div>
          <p class="hint">Today keeps days already gone and runs you've logged, and replans the rest of this week.</p></fieldset>
        <button class="btn primary wide" type="submit">Save and rebuild</button>
      </form>
      <button class="btn wide" data-act="rebuild">Rebuild from my recent running</button>
      <button class="btn ghost wide" data-act="new-plan">Start a new plan</button>
    </section>

    ${trainingSettings()}

    <section class="card"><h2>Previous plans</h2>
      <p class="muted small">A copy is saved automatically whenever a plan is rebuilt or replaced (last 5).</p>
      ${(S.planHistory || []).map((h) => `<div class="row-between lib"><span>${GOAL_NAME[h.profile.goal]} · race ${fmtShort(h.profile.raceDate)}<br>
        <span class="muted small">Saved ${fmtShort(h.savedAt)} · ${esc(h.reason.toLowerCase())} · ${Object.values(h.logs).filter((l) => l.status === 'done').length} runs logged</span></span>
        <button class="btn" data-act="restore-plan" data-id="${h.id}">Restore</button></div>`).join('') || '<p class="muted small">None yet.</p>'}
    </section>

    <section class="card"><h2>Auto sync (free)</h2>
      <p class="muted small">Garmin watch &rarr; Garmin Connect &rarr; intervals.icu (free) &rarr; this app. Strava isn't used: its API now needs a paid subscription.</p>
      <ol class="small muted">
        <li>Sign up free at intervals.icu and connect <b>Garmin</b> there (not Strava: Strava runs can't be passed on).</li>
        <li>On intervals.icu open Settings, scroll to Developer Settings, create an API key.</li>
        <li>Paste it below. Athlete ID can stay 0.</li>
      </ol>
      <form id="sync-form" novalidate>
        <div class="row">
          <label class="field">Athlete ID<input name="athleteId" value="${esc(S.sync.athleteId || '0')}"></label>
          <label class="field">API key<input name="apiKey" type="password" autocomplete="off" value="${esc(S.sync.apiKey)}"></label>
        </div>
        <button class="btn primary wide" type="submit">Save and sync</button>
      </form>
      <p class="small ${S.sync.lastError ? 'error' : 'muted'}" id="sync-status">${esc(S.sync.lastError || S.sync.lastResult || (S.sync.apiKey ? 'Not synced yet' : 'Not connected'))}</p>
      ${S.sync.apiKey ? '<button class="btn ghost wide" data-act="disconnect">Disconnect</button>' : ''}
    </section>

    <section class="card"><h2>Backup</h2>
      <p class="muted small">Everything lives on this phone. A backup file lets you restore it on another phone or after clearing your browser.</p>
      <div class="row"><button class="btn" data-act="backup">Save backup</button>
        <label class="btn">Restore<input type="file" accept="application/json,.json" id="restore" hidden></label></div>
      <button class="btn danger wide" data-act="reset">Delete everything</button>
    </section>
    <p class="muted small center">Runplan · free and private · v1</p>`;

  $('#hr-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const val = (x, lo, hi) => { const n = Number(x.value); return x.value && n >= lo && n <= hi ? n : null; };
    S.profile.age = val(f.age, 10, 90);
    S.profile.maxHr = val(f.maxHr, 120, 230);
    S.profile.restHr = val(f.restHr, 30, 100);
    refreshFitness();
    persist(); render(); toast('Heart rate saved');
  });
  $('#result-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const sec = parseTime(f.time.value);
    if (!sec) return toast('Time should look like 22:30');
    setBase(vdotFromRace(DIST[f.dist.value], sec), 'Entered result');
    persist(); render();
  });
  $('#sched').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const err = (m) => { $('#sched-error').textContent = m; };
    const runDays = checked(f, 'runDays');
    const longRunDay = Number(f.longRunDay.value);
    const goalTime = f.goalTime.value.trim() ? parseTime(f.goalTime.value) : null;
    const peakLong = Number(f.peakLong.value);
    if (!peakLong || peakLong < 5 || peakLong > 40) return err('Longest run should be between 5 and 40 km.');
    if (runDays.length < 2) return err('Pick at least 2 run days.');
    if (!runDays.includes(longRunDay)) return err('Long run day must be a run day.');
    if (f.goalTime.value.trim() && !goalTime) return err('Goal time should look like 1:45:00.');
    if (daysBetween(today(), f.raceDate.value) < 21) return err('Race date must be at least 3 weeks away.');
    const prev = copy(S.profile);
    S.profile = { ...S.profile, raceDate: f.raceDate.value, goalTime, runDays, longRunDay, otherDays: hardDays(T()), timeTrials: f.timeTrials.checked,
      peakLong, paceFrom: f.paceFrom ? f.paceFrom.value : S.profile.paceFrom,
      weeklyKm: Number(f.weeklyKm.value) || 0, longestKm: Number(f.longestKm.value) || 0 };
    doRebuild(null, prev);
  });
  $('#lib-add').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    if (!name) return;
    if (T().library.some((x) => x.name.toLowerCase() === name.toLowerCase())) return toast('That session already exists');
    T().library.push({ name, hard: false });
    persist(); render(); toast(`${name} added`);
  });
  $('#sync-form').addEventListener('submit', (e) => {
    e.preventDefault();
    S.sync.athleteId = e.target.athleteId.value.trim() || '0';
    S.sync.apiKey = e.target.apiKey.value.trim();
    persist();
    runSync(true);
  });
  $('#restore').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      S = await importFile(file, S);
      persist(); render(); toast('Backup restored');
    } catch (ex) { toast(ex.message); }
  });
}

// ---------- sync ----------
let syncing = false;
async function runSync(loud) {
  if (!S.sync.apiKey || !S.plan || syncing) return;
  syncing = true;
  const status = $('#sync-status');
  if (status) status.textContent = 'Syncing...';
  try {
    const [from, to] = syncWindow(today(), S.sync.lastSync);
    const runs = await fetchRuns(S.sync, from, to);
    const r = applyRuns(S, runs);
    // Max cadence and run/walk time need each run's second-by-second data: fetched once per run.
    const needStreams = [...Object.values(S.logs), ...S.extras].filter((x) => x.extId && !x.streamsDone && (x.streamTries || 0) < 2).slice(0, 8);
    for (const rec of needStreams) {
      try {
        const st = runWalk(await fetchStreams(S.sync, rec.extId), rec.walk);
        if (st) Object.assign(rec, st);
        rec.streamsDone = true;
      } catch { rec.streamTries = (rec.streamTries || 0) + 1; }
    }
    try {
      // Garmin daily wellness via intervals.icu: resting heart rate and VO2 max, last 120 days.
      const res = await fetch(`https://intervals.icu/api/v1/athlete/${encodeURIComponent(S.sync.athleteId || '0')}/wellness?oldest=${addDays(today(), -120)}&newest=${today()}`,
        { headers: { Authorization: 'Basic ' + btoa('API_KEY:' + S.sync.apiKey) } });
      if (res.ok) {
        const ok = (x, lo, hi) => (Number.isFinite(x) && x > lo && x < hi ? x : null);
        S.sync.wellness = (await res.json())
          .map((d) => ({ date: String(d.id || d.date || '').slice(0, 10), rhr: ok(d.restingHR, 25, 110), vo2: ok(d.vo2max ?? d.vo2Max ?? d.VO2max, 20, 95) }))
          .filter((d) => d.date && (d.rhr || d.vo2))
          .sort((a, b) => a.date.localeCompare(b.date));
        const rhr = S.sync.wellness.filter((d) => d.rhr && d.date >= addDays(today(), -14)).map((d) => d.rhr);
        if (rhr.length) S.sync.restHr = Math.round(rhr.reduce((a, b) => a + b, 0) / rhr.length);
      }
    } catch { /* resting heart rate is a nice-to-have */ }
    S.sync.lastSync = today();
    S.sync.lastError = '';
    S.sync.lastResult = `Last sync ${fmtDate(today())}: found ${runs.length} run${runs.length === 1 ? '' : 's'} from ${fmtShort(from)}, ${r.matched} ticked off the plan, ${r.extra} added as extra runs, ${r.updated} updated.`;
    persist();
    render();
    if (loud || r.matched || r.extra) toast(`Synced: ${r.matched} planned run${r.matched === 1 ? '' : 's'}, ${r.extra} extra`);
  } catch (ex) {
    S.sync.lastError = `Sync failed ${fmtDate(today())}: ${ex.message === 'Failed to fetch' || ex.message === 'Load failed' ? 'could not reach intervals.icu (no connection, or the browser blocked the request).' : ex.message}`;
    persist();
    if (status) { status.textContent = S.sync.lastError; status.className = 'small error'; }
    if (loud) toast('Sync failed');
  } finally { syncing = false; }
}

// ---------- events ----------
document.addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]');
  if (open && !open.disabled) return openWorkout(open.dataset.open);
  const dayBtn = e.target.closest('[data-day]:not([data-act])');
  if (dayBtn) return openDay(dayBtn.dataset.day);
  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) { tab = tabBtn.dataset.tab; scrollToWeek = true; window.scrollTo(0, 0); render(); return; }
  if (e.target.closest('[data-close]')) return closeSheet();
  const a = e.target.closest('[data-act]');
  if (!a || a.tagName === 'SELECT') return;
  const id = a.dataset.id;
  const w = id && findWorkout(id);
  switch (a.dataset.act) {
    case 'log': return openLog(id);
    case 'log-extra': return openLog(null, true);
    case 'unlog': delete S.logs[id]; break;
    case 'skip': S.logs[id] = { status: 'skipped' }; break;
    case 'feel':
      return openSheet(`<h2>Not feeling 100%?</h2><p class="muted">Pick what fits. Your plan stays the same otherwise.</p>
        <div class="actions"><button class="btn primary" data-act="shorten" data-id="${id}">Make it a short easy run</button>
        <button class="btn" data-act="skip-feel" data-id="${id}">Rest instead</button><button class="btn ghost" data-close>Cancel</button></div>
        <p class="muted small">Pain that changes how you run, or feeling unwell below the neck: rest, and see a professional if it lasts.</p>`);
    case 'shorten':
      if (!w.original) w.original = { type: w.type, steps: w.steps, km: w.km };
      w.type = 'easy';
      w.km = Math.max(3, Math.round(w.original.km * 0.6 * 2) / 2);
      w.steps = [{ kind: 'run', km: w.km, zone: 'easy', label: 'Gentle. Stop early if it feels wrong.' }];
      w.adjusted = true;
      recalcWeek(w);
      break;
    case 'skip-feel': S.logs[id] = { status: 'skipped', note: 'Not feeling 100%' }; break;
    case 'restore': Object.assign(w, w.original); delete w.original; delete w.adjusted; recalcWeek(w); break;
    case 'rebuild': return doRebuild();
    case 'dismiss-volume': S.seen.volume = Number(a.dataset.week); break;
    case 'pace': S.seen.pace = a.dataset.last; nudge(Number(a.dataset.change), 'Pace check'); break;
    case 'dismiss-pace': S.seen.pace = a.dataset.last; break;
    case 'vdot': nudge(Number(a.dataset.change) * 0.5, 'Manual'); break;
    case 'auto-fit': S.profile.autoFitness = !S.profile.autoFitness; refreshFitness(S.profile.autoFitness ? 'Auto' : 'Manual'); break;
    case 'backup': exportFile(S); S.lastBackup = today(); break;
    case 'sync': return runSync(true);
    case 'disconnect': S.sync.apiKey = ''; break;
    case 'gym-done': {
      const k = doneKey(a.dataset.date, a.dataset.name);
      if (T().done[k]) delete T().done[k]; else T().done[k] = true;
      persist(); render(); return openDay(a.dataset.date);
    }
    case 'gym-remove': removeSession(T(), a.dataset.date, a.dataset.name); persist(); render(); return openDay(a.dataset.date);
    case 'tpl-remove': {
      const list = T().week[Number(a.dataset.day)];
      list.splice(list.indexOf(a.dataset.name), 1);
      return afterTemplateChange();
    }
    case 'lib-del': {
      const n = a.dataset.name;
      if (!confirm(`Delete ${n} from your usual week and session list?`)) return;
      T().library = T().library.filter((x) => x.name !== n);
      T().week = T().week.map((d) => d.filter((x) => x !== n));
      return afterTemplateChange();
    }
    case 'swap': {
      const other = findWorkout(a.dataset.with);
      [w.date, other.date] = [other.date, w.date];
      weekOf(S.plan, w.date).workouts.sort((x, y) => x.date.localeCompare(y.date));
      persist(); closeSheet(); render(); return toast('Runs swapped');
    }
    case 'pf': pf[a.dataset.key] = a.dataset.val; return render();
    case 'run': return openRun(a.dataset.src, id);
    case 'walk': { const r = S.extras.find((x) => x.id === id); r.walk = !r.walk; persist(); render(); return openRun('extra', id); }
    case 'restore-plan':
      if (!confirm('Restore this plan? Your current plan is saved under Previous plans first, so you can switch back.')) return;
      return restorePlan(id);
    case 'tread': {
      const r = a.dataset.src === 'extra' ? S.extras.find((x) => x.id === id) : S.logs[id];
      r.treadmill = !r.treadmill;
      r.treadmillSet = true; // your choice wins over what the sync detects
      break;
    }
    case 'del-extra':
      if (!confirm('Delete this run from Runplan?')) return;
      S.extras = S.extras.filter((x) => x.id !== id); break;
    case 'new-plan': closeSheet(); return renderSetup({ ...S.profile, goalTime: S.profile.goalTime ? fmtTime(S.profile.goalTime) : '', raceTime: S.profile.raceTime || '' });
    case 'reset':
      if (!confirm('Delete your plan and every logged run on this phone? This cannot be undone.')) return;
      reset(); S = load(); closeSheet(); return render();
    default: return;
  }
  persist();
  closeSheet();
  render();
});

document.addEventListener('change', (e) => {
  if (e.target.name === 'rebuildFrom') { rebuildFrom = e.target.value; return; }
  // Race pace source applies straight away, no rebuild needed (paces are worked out when shown).
  if (e.target.name === 'paceFrom' && S.profile) {
    S.profile.paceFrom = e.target.value;
    persist(); render();
    return toast(e.target.value === 'fitness' ? 'Race pace now follows your fitness' : 'Race pace now uses your goal time');
  }
  const g = e.target.closest('[data-act^="gym-"], [data-act^="tpl-"], [data-act="lib-hard"]');
  if (g && g.tagName === 'SELECT' && !g.value) return;
  if (g) {
    const act = g.dataset.act;
    if (act === 'gym-add') { addSession(T(), g.dataset.date, g.value); persist(); render(); return openDay(g.dataset.date); }
    if (act === 'gym-move') { moveSession(T(), g.dataset.date, g.value, g.dataset.name); persist(); render(); toast(`${g.dataset.name} moved`); return openDay(g.value); }
    if (act === 'tpl-add') { T().week[Number(g.dataset.day)].push(g.value); return afterTemplateChange(); }
    if (act === 'lib-hard') { T().library.find((x) => x.name === g.dataset.name).hard = g.checked; return afterTemplateChange(); }
  }
  const sel = e.target.closest('select[data-act="move"]');
  if (!sel || !sel.value) return;
  const w = findWorkout(sel.dataset.id);
  const wk = weekOf(S.plan, w.date);
  const other = wk.workouts.find((x) => x.date === sel.value);
  if (other) other.date = w.date;
  w.date = sel.value;
  wk.workouts.sort((a, b) => a.date.localeCompare(b.date));
  persist();
  closeSheet();
  render();
  toast(other ? 'Runs swapped' : 'Run moved');
});

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

function render() {
  if (!S.profile || !S.plan) return renderSetup();
  refreshFitness();
  $('#tabs').hidden = false;
  $$('[data-tab]').forEach((b) => b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false'));
  ({ today: renderToday, plan: renderPlan, progress: renderProgress, settings: renderSettings })[tab]();
}

if (S.profile) ensureTraining(S);
render();
if (S.sync.apiKey && S.sync.lastSync !== today()) runSync(false);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { render(); if (S.sync.apiKey) runSync(false); } });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
