// Route screens: the route section on each run, the route planner (loop, start to end, draw),
// your hill, and your saved routes. The map is Leaflet (free) with OpenStreetMap tiles.
// It only loads when a map is shown, so the rest of the app stays quick.
import { makeLoop, makeAtoB, makeHillRoute, measureHill, fetchPath, trackFromStreams, closestRoutes, toGpx, routeKm, climbOf } from './routes.js';
import { fetchTrack } from './sync.js';
import { TYPES, HARD } from './plan.js';
import { fmtShort } from './dates.js';

let C; // what the app gives us: state, saving, sheets, messages
export const initRoutes = (ctx) => { C = ctx; };

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const S = () => C.state();
const R = () => S().routing;
const saved = () => (S().savedRoutes ||= []);
const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
const pt = (p) => ({ lat: Math.round(p.lat * 1e5) / 1e5, lon: Math.round(p.lon * 1e5) / 1e5 });
const netMsg = (ex) => (ex.message === 'Failed to fetch' || ex.message === 'Load failed' ? 'Could not connect. Check your signal and try again.' : ex.message);

// ---------- map and location ----------
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  return loadLeaflet.p ||= new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = 'leaflet.css';
    document.head.append(link);
    const js = document.createElement('script');
    js.src = 'leaflet.js';
    js.onload = () => resolve(window.L);
    js.onerror = () => { loadLeaflet.p = null; reject(new Error('Map could not load')); };
    document.head.append(js);
  });
}

function newMap(L, el) {
  const map = L.map(el, { zoomControl: true });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
  setTimeout(() => map.invalidateSize(), 300); // after the sheet has slid open
  return map;
}

const dot = (L, p, fill, label) => L.circleMarker([p.lat, p.lon], { radius: 8, color: '#fff', weight: 2, fillColor: fill, fillOpacity: 1 }).bindTooltip(label);

// Draws a route; hill routes are drawn part by part (warm-up, hill, cool-down) in their own colours.
function drawLine(L, map, route) {
  const layers = [];
  if (route.parts?.length) {
    let i = 0;
    for (const p of route.parts) {
      const seg = route.coords.slice(i, i + p.n);
      i += p.n;
      layers.push(L.polyline(seg.map((c) => [c[0], c[1]]), { color: css(p.kind === 'hills' ? '--c-hills' : '--c-easy', '#4fd1a5'), weight: p.kind === 'hills' ? 7 : 5 }).bindTooltip(p.label));
    }
  } else {
    layers.push(L.polyline(route.coords.map((c) => [c[0], c[1]]), { color: css('--accent', '#c8f560'), weight: 5 }));
  }
  const first = route.coords[0], last = route.coords.at(-1);
  layers.push(dot(L, { lat: first[0], lon: first[1] }, '#111', route.kind === 'ab' ? 'Start' : 'Start and finish'));
  if (route.kind === 'ab') layers.push(dot(L, { lat: last[0], lon: last[1] }, '#d12e55', 'Finish'));
  const group = L.featureGroup(layers).addTo(map);
  map.fitBounds(group.getBounds(), { padding: [18, 18] });
  setTimeout(() => { map.invalidateSize(); map.fitBounds(group.getBounds(), { padding: [18, 18] }); }, 320);
  return group;
}

export function here() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This phone does not share its location with the app.'));
    navigator.geolocation.getCurrentPosition((p) => resolve(pt({ lat: p.coords.latitude, lon: p.coords.longitude })),
      (e) => reject(new Error(e.code === 1 ? 'Location is off for Runplan. Allow it in iPhone Settings → Privacy & Security → Location Services.' : 'Could not find your location. Try again in a moment.')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  });
}

// ---------- the route section on a run ----------
const stepKm = (w, kind, def) => w.steps.find((s) => s.kind === kind)?.km ?? def;

function hillReps(w) {
  const r = w.steps.find((s) => s.kind === 'reps');
  if (!r) return '';
  const m = Math.round((r.work.min * 60 * 1000) / C.hillPace());
  const h = R().hill;
  return `${r.n} reps of ${r.work.min === 1 ? '60 s' : `${r.work.min * 60} s`}: about ${m} m each at hill effort.${h ? ` Your hill is ${h.m} m at ${h.gradient}%${h.m < m ? `, so turn at the top or carry on over it` : `, so stop where the time runs out and jog back down`}.` : ''}`;
}

export function routeSection(w) {
  if (w.type === 'race') return '';
  const r = S().routes?.[w.date];
  const key = R().key;
  const list = closestRoutes(saved(), w.km).slice(0, 3);
  const savedHtml = list.length ? `<p class="small"><b>Your routes</b> (closest to ${w.km} km first)</p>
    <ul class="route-list">${list.map((x) => `<li><span>${esc(x.name)} <span class="muted">${x.km} km</span></span>
      <button class="btn small" data-act="rt-use-saved" data-rid="${x.id}" data-id="${w.id}">Use</button></li>`).join('')}</ul>` : '';
  if (r) {
    const off = r.target && Math.abs(r.target - w.km) / w.km > 0.1;
    const info = r.kind === 'hill'
      ? `Warm-up ${r.warmKm} km · hill ${r.hill.repM} m at ${r.hill.gradient}% · cool-down ${r.coolKm} km${r.coolShort >= 0.3 ? ` (the plan says ${stepKm(w, 'cool', 1.5)} km, so add ${r.coolShort} km)` : ''}`
      : `<b>${r.km} km</b>${r.kind === 'ab' ? ' start to finish' : r.kind === 'saved' ? '' : ' loop'} · ${r.climb} m climb${r.name ? ` · ${esc(r.name)}` : ''}${r.target && Math.abs(r.km - r.target) / r.target > 0.1 ? ` · closest found to ${r.target} km` : ''}`;
    return `<section class="route" data-route-date="${w.date}"><h3>Route</h3>
      <div class="route-map" id="route-map" role="img" aria-label="Map of the route"></div>
      <p class="small">${info}</p>
      ${w.type === 'hills' ? `<p class="muted small">${hillReps(w)}</p>` : ''}
      ${off ? `<p class="small error">This route was made for ${r.target} km, but the run is now ${w.km} km.</p>` : ''}
      <div class="actions">
        <button class="btn primary" data-act="rt-gpx" data-id="${w.id}">Save GPX for Garmin</button>
        ${key ? `<button class="btn" data-act="rt-plan" data-id="${w.id}">Plan a different route</button>` : ''}
        ${r.kind !== 'saved' ? `<button class="btn" data-act="rt-save-current" data-id="${w.id}">Save to my routes</button>` : ''}
        <button class="btn ghost" data-act="rt-remove" data-id="${w.id}">Remove route</button>
      </div>
      ${savedHtml ? `<p class="muted small">Or swap to one of your routes:</p>${savedHtml.replace(/^<p class="small">.*?<\/p>/, '')}` : ''}
      <p class="muted small">On your watch: on a computer go to connect.garmin.com &rarr; Training &amp; Planning &rarr; Courses &rarr; Import, pick the GPX file, then Send to Device.</p>
    </section>`;
  }
  return `<section class="route"><h3>Route</h3>
    ${key ? `<p class="muted small">Starts from where you are. Make a ${w.km} km loop, pick a start and finish, or draw your own.${w.type === 'hills' ? '' : HARD.has(w.type) ? ' Loops pick the flattest of 3.' : ''}</p>
      <div class="actions">
        ${w.type === 'hills' && R().hill ? `<button class="btn primary" data-act="rt-hill-go" data-id="${w.id}">Route to my hill</button>` : ''}
        <button class="btn${w.type === 'hills' && R().hill ? '' : ' primary'}" data-act="rt-quick-loop" data-id="${w.id}">Quick ${w.km} km loop from here</button>
        <button class="btn" data-act="rt-plan" data-id="${w.id}">Plan on the map</button>
      </div>
      ${w.type === 'hills' && !R().hill ? '<p class="muted small">Mark your hill in Settings &rarr; Routes and hill sessions will route you there.</p>' : ''}
      ${w.type === 'hills' ? `<p class="muted small">${hillReps(w)}</p>` : ''}`
    : '<p class="muted small">Add a free OpenRouteService key in Settings &rarr; Routes to make routes. Routes you save from past runs still work without it.</p>'}
    ${savedHtml}
  </section>`;
}

// Draws the small map on a run, if it has a route.
export async function mountRouteSection(root) {
  const el = $('#route-map', root);
  const date = el?.closest('[data-route-date]')?.dataset.routeDate;
  const route = date && S().routes?.[date];
  if (!route?.coords?.length) return;
  try {
    const L = await loadLeaflet();
    if (!el.isConnected) return;
    drawLine(L, newMap(L, el), route);
  } catch {
    el.innerHTML = '<p class="muted small">The map could not load (no signal?). The route is still saved and the GPX file still works.</p>';
  }
}

// ---------- the planner ----------
let P = null; // planner state while it's open

function plannerControls() {
  const m = P.mode;
  const res = P.result;
  const seg = `<div class="seg mini" role="group" aria-label="Kind of route">${[['loop', 'Loop'], ['ab', 'Start to finish'], ['draw', 'Draw']].map(([v, l]) =>
    `<button type="button" class="${m === v ? 'on' : ''}" data-act="rt-mode" data-mode="${v}" aria-pressed="${m === v}">${l}</button>`).join('')}</div>`;
  const help = {
    loop: 'A loop that starts and finishes at the black dot (you). Tap the map to start somewhere else.',
    ab: P.end ? `Tap to add a point to pass through (${P.via.length} so far). If you add none and it's short, a detour is added to make up ${P.km} km.` : 'Tap where you want to finish.',
    draw: P.draw.length ? `Tap the next point. It follows paths between taps. ${P.drawKm.toFixed(2)} of ${P.km} km so far.` : 'Tap where you want to go first. It follows paths from the black dot (you).',
  }[m];
  const go = {
    loop: `<button class="btn primary" data-act="rt-go">${res ? 'Another loop' : `Make a ${P.km} km loop`}</button>`,
    ab: `<button class="btn primary" data-act="rt-go"${P.end ? '' : ' disabled'}>Make route</button><button class="btn ghost" data-act="rt-clear">Clear points</button>`,
    draw: `<div class="row"><button class="btn" data-act="rt-undo"${P.draw.length ? '' : ' disabled'}>Undo</button><button class="btn" data-act="rt-close"${P.draw.length ? '' : ' disabled'}>Back to start</button></div><button class="btn ghost" data-act="rt-clear">Clear</button>`,
  }[m];
  const result = res ? `<div class="card route-result"><p><b>${res.km} km</b> · ${res.climb} m climb${Math.abs(res.km - P.km) / P.km > 0.1 ? ` <span class="muted">(run is ${P.km} km)</span>` : ''}</p>
      <div class="actions"><button class="btn primary" data-act="rt-use">Use for this run</button>
      <button class="btn" data-act="rt-save-result">Save to my routes</button></div></div>` : '';
  return `${seg}<p class="muted small" aria-live="polite">${help}</p>${result}<div class="actions">${go}
    <button class="btn ghost" data-act="rt-locate">Start from where I am</button></div>`;
}

const refresh = () => { const c = $('#rt-controls'); if (c) c.innerHTML = plannerControls(); };

function redraw() {
  const { L, map } = P;
  P.layer?.remove();
  const layers = [];
  if (P.start) layers.push(dot(L, P.start, '#111', 'Start'));
  if (P.mode === 'ab') {
    P.via.forEach((v, i) => layers.push(dot(L, v, '#9aa3ad', `Via ${i + 1}`)));
    if (P.end) layers.push(dot(L, P.end, '#d12e55', 'Finish'));
  }
  if (P.mode === 'draw' && P.drawCoords.length) layers.push(L.polyline(P.drawCoords.map((c) => [c[0], c[1]]), { color: css('--accent', '#c8f560'), weight: 5 }));
  if (P.result && P.mode !== 'draw') layers.push(L.polyline(P.result.coords.map((c) => [c[0], c[1]]), { color: css('--accent', '#c8f560'), weight: 5 }));
  P.layer = L.featureGroup(layers).addTo(map);
}

export async function openPlanner(w) {
  P = { w, date: w.date, km: w.km, type: w.type, mode: 'loop', start: null, end: null, via: [], draw: [], segs: [], drawCoords: [], drawKm: 0, result: null, busy: false };
  C.openSheet(`<div class="sheet-head"><div><p class="eyebrow">${C.fmtDate(w.date)}</p><h2>Plan a route</h2>
      <p class="muted">${esc(TYPES[w.type].name)} · ${w.km} km</p></div></div>
    <div id="rt-map" class="route-map big" role="application" aria-label="Map. Tap to place points."></div>
    <div id="rt-controls">${plannerControls()}</div>
    <button class="btn ghost wide" data-act="rt-back" data-id="${w.id}">Back to the run</button>`, async (root) => {
    try {
      const L = await loadLeaflet();
      const el = $('#rt-map', root);
      const map = newMap(L, el);
      P.L = L; P.map = map;
      const last = S().routes?.[w.date]?.start || R().last;
      map.setView(last ? [last.lat, last.lon] : [51.4545, -2.5879], last ? 15 : 12);
      map.on('click', (e) => onTap(pt({ lat: e.latlng.lat, lon: e.latlng.lng })));
      locate(true);
    } catch { $('#rt-map', root).innerHTML = '<p class="muted small">The map could not load (no signal?).</p>'; }
  });
}

async function locate(quiet) {
  try {
    const p = await here();
    if (!P) return;
    P.start = p; R().last = p; C.persist();
    P.map.setView([p.lat, p.lon], 15);
    resetResult(); redraw(); refresh();
  } catch (ex) { if (!quiet || !P?.start) C.toast(ex.message); }
}

function resetResult() { P.result = null; if (P.mode === 'draw') { P.draw = []; P.segs = []; setDraw(); } }

// The drawn route so far: the path pieces between taps joined up.
function setDraw() {
  P.drawCoords = P.segs.reduce((all, seg) => (all.length ? all.concat(seg.slice(1)) : seg.slice()), []);
  P.drawKm = P.drawCoords.length ? routeKm(P.drawCoords) : 0;
  P.result = P.drawCoords.length ? { coords: P.drawCoords, km: Math.round(P.drawKm * 100) / 100, climb: climbOf(P.drawCoords), kind: P.draw.at(-1) === P.start ? 'loop' : 'ab', start: P.start } : null;
}

async function onTap(p) {
  if (!P || P.busy) return;
  if (P.mode === 'loop') { P.start = p; P.result = null; }
  else if (P.mode === 'ab') { if (!P.start) P.start = p; else if (!P.end) P.end = p; else P.via.push(p); P.result = null; }
  else if (P.mode === 'draw') {
    if (!P.start) { P.start = p; redraw(); refresh(); return; }
    const from = P.draw.at(-1) || P.start;
    await busy(async () => {
      const seg = await fetchPath(R().key, [from, p], C.fetch);
      P.draw.push(p);
      P.segs.push(seg.coords);
      setDraw();
    });
  }
  redraw(); refresh();
}

async function busy(fn) {
  P.busy = true;
  document.querySelectorAll('#rt-controls button').forEach((b) => { b.disabled = true; });
  try { await fn(); } catch (ex) { C.toast(netMsg(ex)); } finally { if (P) { P.busy = false; refresh(); } }
}

async function go() {
  if (!P.start) return C.toast('Waiting for your location. Or tap the map to set a start.');
  await busy(async () => {
    C.toast('Finding a route…');
    P.result = P.mode === 'loop' ? await makeLoop(R().key, P.start, P.km, P.type, C.fetch) : await makeAtoB(R().key, P.start, P.end, P.via, P.km, P.type, C.fetch);
    redraw();
    P.map.fitBounds(P.layer.getBounds(), { padding: [18, 18] });
  });
}

// ---------- saving and using routes ----------
function useRoute(date, route) {
  S().routes[date] = route;
  C.persist();
}

function askName(defaultName, onSave, back) {
  C.openSheet(`<div class="sheet-head"><div><h2>Save to my routes</h2></div></div>
    <form id="rt-name" novalidate><label class="field">Name<input name="name" maxlength="60" value="${esc(defaultName)}" required></label>
    <button class="btn primary wide" type="submit">Save</button></form>
    <button class="btn ghost wide" data-act="rt-cancel-name">Cancel</button>`, (root) => {
    const input = $('input', root);
    input.focus(); input.select();
    $('#rt-name', root).addEventListener('submit', (e) => { e.preventDefault(); const n = input.value.trim(); if (!n) return; onSave(n); back(); });
  });
  askName.back = back;
}

function addSaved(name, route, from) {
  saved().push({ id: 'r' + Date.now().toString(36), name, coords: route.coords, km: route.km, climb: route.climb, from, made: new Date().toISOString().slice(0, 10) });
  C.persist();
  C.toast(`${name} saved to your routes`);
}

async function saveGpx(w) {
  const r = S().routes?.[w.date];
  if (!r) return;
  const name = `Runplan ${fmtShort(w.date)} ${TYPES[w.type].name} ${r.km} km`;
  const file = new File([toGpx(r, r.name || name)], `${name.replace(/[^\w .]+/g, '').replace(/ +/g, '-')}.gpx`, { type: 'application/gpx+xml' });
  // iPhone: the share sheet (Save to Files, AirDrop to your laptop, email...). Elsewhere: a normal download.
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); } catch { /* closed the share sheet */ }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// "Save this route" on a run that came from Garmin with GPS.
export const canSaveTrack = (r) => r && r.extId && !r.treadmill && !r.walk && S().sync.apiKey;
export const saveTrackButton = (src, id) => `<button class="btn" data-act="rt-save-run" data-src="${src}" data-id="${id}">Save this route</button>`;

// ---------- your hill ----------
let H = null;

function hillControls() {
  const res = H.result;
  return `<p class="muted small" aria-live="polite">${!H.bottom ? 'Tap the bottom of the hill.' : !H.top ? 'Now tap the top.' : res ? '' : 'Measuring…'}</p>
    ${res ? `<div class="card route-result"><p><b>${res.m} m</b> long · rises ${res.rise} m · <b>${res.gradient}%</b> average</p>
      <div class="actions"><button class="btn primary" data-act="rt-hill-save">Save as my hill</button></div></div>` : ''}
    <div class="actions"><button class="btn ghost" data-act="rt-hill-reset">Start again</button></div>`;
}

function openHill() {
  H = { bottom: null, top: null, result: null };
  C.openSheet(`<div class="sheet-head"><div><h2>Mark your hill</h2><p class="muted">Tap the bottom, then the top. Hill sessions will route you there.</p></div></div>
    <div id="rt-map" class="route-map big" role="application" aria-label="Map. Tap the bottom and top of your hill."></div>
    <div id="rt-hill">${hillControls()}</div>`, async (root) => {
    try {
      const L = await loadLeaflet();
      const map = newMap(L, $('#rt-map', root));
      H.L = L; H.map = map;
      const h = R().hill, last = h?.bottom || R().last;
      map.setView(last ? [last.lat, last.lon] : [51.4545, -2.5879], last ? 16 : 12);
      if (h) drawHill(h);
      map.on('click', async (e) => {
        if (H.top) return;
        const p = pt({ lat: e.latlng.lat, lon: e.latlng.lng });
        if (!H.bottom) H.bottom = p; else H.top = p;
        drawHill(H);
        $('#rt-hill').innerHTML = hillControls();
        if (H.top) {
          try { H.result = await measureHill(R().key, H.bottom, H.top, C.fetch); drawHill(H.result); } catch (ex) { C.toast(netMsg(ex)); H.top = null; }
          $('#rt-hill').innerHTML = hillControls();
        }
      });
      if (!h) here().then((p) => { if (!H.bottom) map.setView([p.lat, p.lon], 16); }).catch(() => {});
    } catch { $('#rt-map', root).innerHTML = '<p class="muted small">The map could not load (no signal?).</p>'; }
  });
}

function drawHill(h) {
  const { L, map } = H;
  H.layer?.remove();
  const layers = [];
  if (h.coords) layers.push(L.polyline(h.coords.map((c) => [c[0], c[1]]), { color: css('--c-hills', '#ff8f5a'), weight: 7 }));
  if (h.bottom) layers.push(dot(L, h.bottom, '#111', 'Bottom'));
  if (h.top) layers.push(dot(L, h.top, css('--c-hills', '#ff8f5a'), 'Top'));
  H.layer = L.featureGroup(layers).addTo(map);
  if (h.coords) map.fitBounds(H.layer.getBounds(), { padding: [30, 30], maxZoom: 17 });
}

// ---------- Settings card ----------
export function routeSettings() {
  const h = R().hill;
  return `<section class="card"><h2>Routes (free)</h2>
    <p class="muted small">Routes start from where you are and follow OpenStreetMap paths. Making them needs a free OpenRouteService key (2,000 routes a day).</p>
    <ol class="small muted">
      <li>Sign up free at openrouteservice.org, then open the Dashboard.</li>
      <li>Under API Keys, create a free Standard key and copy it.</li>
      <li>Paste it below.</li>
    </ol>
    <form id="route-form" novalidate>
      <label class="field">OpenRouteService key<input name="key" type="password" autocomplete="off" value="${esc(R().key)}"></label>
      <button class="btn primary wide" type="submit">Save key</button>
    </form>
    <h3>My hill</h3>
    <p class="small ${h ? '' : 'muted'}">${h ? `${h.m} m long, rises ${h.rise} m, ${h.gradient}% average` : 'Not set. Mark it and hill sessions will route you there.'}</p>
    <div class="row"><button class="btn" data-act="rt-hill-edit"${R().key ? '' : ' disabled'}>${h ? 'Move my hill' : 'Mark my hill'}</button>
      ${h ? '<button class="btn ghost" data-act="rt-hill-clear">Remove</button>' : ''}</div>
    <h3>My routes</h3>
    ${saved().length ? `<ul class="route-list">${[...saved()].sort((a, b) => a.km - b.km).map((x) => `<li><span>${esc(x.name)} <span class="muted">${x.km} km · ${x.climb} m climb</span></span>
      <button class="btn small ghost" data-act="rt-del-saved" data-rid="${x.id}" aria-label="Delete ${esc(x.name)}">Delete</button></li>`).join('')}</ul>`
      : '<p class="muted small">None yet. Open a run from Garmin and tap "Save this route", or plan one on the map and save it.</p>'}
  </section>`;
}

export function mountRouteSettings(root) {
  $('#route-form', root)?.addEventListener('submit', (e) => {
    e.preventDefault();
    R().key = e.target.key.value.trim();
    C.persist(); C.render(); C.toast(R().key ? 'Route key saved' : 'Route key removed');
  });
}

// ---------- buttons ----------
// Returns true if it handled the button.
export function routeAction(a) {
  const act = a.dataset.act;
  if (!act.startsWith('rt-')) return false;
  const w = a.dataset.id && C.findWorkout(a.dataset.id);
  const reopen = () => w && C.openWorkout(w.id);
  switch (act) {
    case 'rt-plan': openPlanner(w); break;
    case 'rt-back': P = null; reopen(); break;
    case 'rt-mode': P.mode = a.dataset.mode; resetResult(); P.end = null; P.via = []; redraw(); refresh(); break;
    case 'rt-locate': locate(false); break;
    case 'rt-go': go(); break;
    case 'rt-clear': P.end = null; P.via = []; resetResult(); redraw(); refresh(); break;
    case 'rt-undo': P.draw.pop(); P.segs.pop(); setDraw(); redraw(); refresh(); break;
    case 'rt-close': onTap(P.start); break;
    case 'rt-use': {
      const pw = P.w;
      useRoute(P.date, { ...P.result, kind: P.result.kind || P.mode, target: P.km, type: P.type, start: P.start, made: new Date().toISOString().slice(0, 10) });
      P = null; C.toast('Route added to this run'); C.openWorkout(pw.id);
      break;
    }
    case 'rt-save-result': {
      const res = P.result, pw = P.w;
      askName(`${res.km} km ${res.kind === 'ab' || P.mode === 'ab' ? 'route' : 'loop'}`, (n) => addSaved(n, res, 'planned'), () => { P = null; C.openWorkout(pw.id); });
      break;
    }
    case 'rt-quick-loop': quick(w); break;
    case 'rt-hill-go': hillGo(w); break;
    case 'rt-use-saved': {
      const x = saved().find((s) => s.id === a.dataset.rid);
      if (x) { useRoute(w.date, { ...x, kind: 'saved', savedId: x.id, target: w.km, type: w.type, start: { lat: x.coords[0][0], lon: x.coords[0][1] } }); reopen(); }
      break;
    }
    case 'rt-save-current': {
      const r = S().routes[w.date];
      askName(r.kind === 'hill' ? 'Hill session' : `${r.km} km ${r.kind === 'ab' ? 'route' : 'loop'}`, (n) => addSaved(n, r, 'planned'), reopen);
      break;
    }
    case 'rt-cancel-name': askName.back?.(); break;
    case 'rt-remove': delete S().routes[w.date]; C.persist(); reopen(); break;
    case 'rt-gpx': saveGpx(w); break;
    case 'rt-save-run': saveRun(a.dataset.src, a.dataset.id); break;
    case 'rt-hill-edit': openHill(); break;
    case 'rt-hill-reset': H.bottom = H.top = H.result = null; drawHill({}); $('#rt-hill').innerHTML = hillControls(); break;
    case 'rt-hill-save': {
      const { bottom, top, m, rise, gradient, coords } = H.result;
      R().hill = { bottom, top, m, rise, gradient, coords };
      H = null; C.persist(); C.closeSheet(); C.render(); C.toast('Hill saved');
      break;
    }
    case 'rt-hill-clear': R().hill = null; C.persist(); C.render(); break;
    case 'rt-del-saved': {
      const i = saved().findIndex((s) => s.id === a.dataset.rid);
      if (i >= 0 && confirm(`Delete ${saved()[i].name}?`)) { saved().splice(i, 1); C.persist(); C.render(); }
      break;
    }
    default: return false;
  }
  return true;
}

async function quick(w) {
  C.toast('Finding your location…');
  try {
    const start = await here();
    R().last = start;
    C.toast('Finding a route…');
    useRoute(w.date, await makeLoop(R().key, start, w.km, w.type, C.fetch));
    C.toast('Route ready');
    C.openWorkout(w.id);
  } catch (ex) { C.toast(netMsg(ex)); }
}

async function hillGo(w) {
  C.toast('Finding your location…');
  try {
    const start = await here();
    R().last = start;
    C.toast('Finding the way to your hill…');
    useRoute(w.date, { ...(await makeHillRoute(R().key, start, R().hill, stepKm(w, 'warm', 2), stepKm(w, 'cool', 1.5), C.fetch)), target: null });
    C.toast('Route ready');
    C.openWorkout(w.id);
  } catch (ex) { C.toast(netMsg(ex)); }
}

async function saveRun(src, id) {
  const r = src === 'extra' ? S().extras.find((x) => x.id === id) : S().logs[id];
  if (!r?.extId) return;
  const back = () => (src === 'extra' ? C.openRun('extra', id) : C.openWorkout(id));
  C.toast('Getting the GPS track from intervals.icu…');
  try {
    const { latlng, altitude } = await fetchTrack(S().sync, r.extId);
    const track = trackFromStreams(latlng, altitude);
    if (!track) return C.toast('This run has no GPS track (treadmill, or GPS was off).');
    askName(r.name || `${track.km} km route`, (n) => addSaved(n, track, 'run'), back);
  } catch (ex) { C.toast(netMsg(ex)); }
}
