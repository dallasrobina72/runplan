// Route logic (no screens here, so it can be tested in Node). Paths come from OpenRouteService
// (free key, 2,000 routes a day, 40 a minute), which follows OpenStreetMap footpaths and roads.
// Coordinates are [lat, lon, height in m] throughout; OpenRouteService itself wants [lon, lat].
import { HARD } from './plan.js';

const BASE = 'https://api.openrouteservice.org/v2/directions/foot-walking/geojson';
const r5 = (v) => Math.round(v * 1e5) / 1e5;
const r2 = (v) => Math.round(v * 100) / 100;

// Distance between two [lat, lon] points in km.
export function haversine(a, b) {
  const rad = Math.PI / 180, R = 6371;
  const dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const routeKm = (coords) => coords.slice(1).reduce((s, p, i) => s + haversine(coords[i], p), 0);

// Total climb in metres, ignoring wobbles under 2 m.
export function climbOf(coords) {
  let up = 0, base = coords[0]?.[2];
  for (const p of coords) {
    if (p[2] == null || base == null) continue;
    if (p[2] > base + 2) { up += p[2] - base; base = p[2]; } else if (p[2] < base) base = p[2];
  }
  return Math.round(up);
}

// Drops points that sit on a straight line (within tolM metres), so a saved route takes little space.
export function simplify(coords, tolM = 4) {
  if (coords.length < 3) return coords;
  const lat0 = coords[0][0] * Math.PI / 180;
  const xy = coords.map((p) => [p[1] * 111320 * Math.cos(lat0), p[0] * 110540]);
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = xy[a], [bx, by] = xy[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    let far = -1, dist = tolM;
    for (let i = a + 1; i < b; i++) {
      // Distance from the line a-b (or from point a when a and b are the same place, as on a loop).
      const d = len ? Math.abs(dy * xy[i][0] - dx * xy[i][1] + bx * ay - by * ax) / len : Math.hypot(xy[i][0] - ax, xy[i][1] - ay);
      if (d > dist) { dist = d; far = i; }
    }
    if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return coords.filter((_, i) => keep[i]);
}

async function call(key, body, fetchFn) {
  const res = await fetchFn(BASE, {
    method: 'POST',
    headers: { Authorization: key, 'Content-Type': 'application/json', Accept: 'application/geo+json, application/json' },
    body: JSON.stringify({ elevation: true, instructions: false, ...body }),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    const code = json?.error?.code;
    if (res.status === 401 || res.status === 403) throw new Error('OpenRouteService refused the request. Check the key in Settings (or the free limit of 2,000 routes a day is used up).');
    if (res.status === 429) throw new Error('Too many routes in a minute. Wait a minute and try again.');
    if (code === 2010) throw new Error('A point is not near a path or road. Tap closer to one.');
    throw new Error(json?.error?.message || `OpenRouteService error ${res.status}`);
  }
  const f = json?.features?.[0];
  if (!f?.geometry?.coordinates?.length) throw new Error('No route came back. Try again.');
  const coords = f.geometry.coordinates.map(([lon, lat, ele]) => [r5(lat), r5(lon), ele == null ? null : Math.round(ele * 10) / 10]);
  const dist = f.properties?.summary?.distance;
  return { coords, km: r2(dist != null ? dist / 1000 : routeKm(coords)), climb: f.properties?.ascent != null ? Math.round(f.properties.ascent) : climbOf(coords) };
}

const lonLat = (p) => [p.lon, p.lat];

// One loop from start. start: { lat, lon }.
export async function fetchLoop(key, start, km, seed, fetchFn = fetch) {
  const r = await call(key, { coordinates: [lonLat(start)], options: { round_trip: { length: Math.round(km * 1000), points: 4, seed } } }, fetchFn);
  return { ...r, seed };
}

// The path through points in order (start, any via points, end). At most 50 points.
export function fetchPath(key, points, fetchFn = fetch) {
  return call(key, { coordinates: points.map(lonLat) }, fetchFn);
}

// Which loop to keep. type: the session type (hills, tempo, easy...).
export function pickBest(loops, targetKm, type) {
  const err = (l) => Math.abs(l.km - targetKm) / targetKm;
  const close = loops.filter((l) => err(l) <= 0.1);
  if (!close.length) return [...loops].sort((a, b) => err(a) - err(b))[0];
  if (type === 'hills') return [...close].sort((a, b) => b.climb - a.climb)[0];
  if (HARD.has(type)) return [...close].sort((a, b) => a.climb - b.climb)[0];
  return [...close].sort((a, b) => err(a) - err(b))[0];
}

const stamp = (r, start, targetKm, type, kind) => ({ ...r, kind, start: { lat: r5(start.lat), lon: r5(start.lon) }, target: targetKm, type, made: new Date().toISOString().slice(0, 10) });

// A loop of about targetKm. Asks for 3 (different random directions); if none is within 10%,
// asks for 2 more with the length corrected. At most 5 requests.
export async function makeLoop(key, start, targetKm, type, fetchFn = fetch, rand = Math.random) {
  const seeds = [0, 1, 2].map(() => Math.floor(rand() * 10000));
  const first = await Promise.allSettled(seeds.map((s) => fetchLoop(key, start, targetKm, s, fetchFn)));
  let loops = first.filter((x) => x.status === 'fulfilled').map((x) => x.value);
  if (!loops.length) throw first[0].reason;
  let best = pickBest(loops, targetKm, type);
  if (Math.abs(best.km - targetKm) / targetKm > 0.1) {
    const ask = Math.max(1, targetKm * (targetKm / best.km)); // came back long or short: ask for less or more
    const again = await Promise.allSettled([best.seed, seeds.find((s) => s !== best.seed)].map((s) => fetchLoop(key, start, ask, s, fetchFn)));
    loops = loops.concat(again.filter((x) => x.status === 'fulfilled').map((x) => x.value));
    best = pickBest(loops, targetKm, type);
  }
  return stamp(best, start, targetKm, type, 'loop');
}

// A point off to the side of the line from a to b, so a route through it is longer.
// h: how far to the side in km. side: 1 or -1.
export function detourPoint(a, b, h, side = 1) {
  const mid = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
  const kx = 111.32 * Math.cos(mid.lat * Math.PI / 180), ky = 110.54; // km per degree
  let dx = (b.lon - a.lon) * kx, dy = (b.lat - a.lat) * ky;
  const len = Math.hypot(dx, dy);
  if (len < 0.05) { dx = 1; dy = 0; } else { dx /= len; dy /= len; } // same place: go off to the north or south
  return { lat: mid.lat + (side * dx * h) / ky, lon: mid.lon - (side * dy * h) / kx };
}

// Start to end (through any via points you tapped). If you tapped no via points and the direct path is
// more than 10% short of the run, a detour point is added off to one side and moved until the
// distance fits (at most 4 more requests).
export async function makeAtoB(key, start, end, via, targetKm, type, fetchFn = fetch) {
  const direct = await fetchPath(key, [start, ...via, end], fetchFn);
  let best = { ...direct, via };
  if (!via.length && direct.km < targetKm * 0.9) {
    const straight = haversine([start.lat, start.lon], [end.lat, end.lon]);
    // Paths run about 1.25x the straight line. Solve 2 * sqrt((d/2)^2 + h^2) * 1.25 = target for h.
    let h = Math.sqrt(Math.max(0.01, (targetKm / 2.5) ** 2 - (straight / 2) ** 2));
    for (const side of [1, -1]) {
      for (let tries = 0; tries < 2; tries++) {
        const p = detourPoint(start, end, h, side);
        let r;
        try { r = await fetchPath(key, [start, p, end], fetchFn); } catch { break; } // e.g. the point landed in a river
        if (Math.abs(r.km - targetKm) < Math.abs(best.km - targetKm)) best = { ...r, via: [{ lat: r5(p.lat), lon: r5(p.lon) }] };
        if (Math.abs(r.km - targetKm) / targetKm <= 0.1) break;
        h *= Math.min(2, Math.max(0.5, (targetKm - direct.km) / Math.max(0.1, r.km - direct.km))); // scale the detour
      }
      if (Math.abs(best.km - targetKm) / targetKm <= 0.1) break;
    }
  }
  return { ...stamp(best, start, targetKm, type, 'ab'), end: { lat: r5(end.lat), lon: r5(end.lon) } };
}

// Your hill on its own: length, rise and gradient between the bottom and top you tapped.
export async function measureHill(key, bottom, top, fetchFn = fetch) {
  const r = await fetchPath(key, [bottom, top], fetchFn);
  const rise = r.coords.at(-1)[2] != null && r.coords[0][2] != null ? r.coords.at(-1)[2] - r.coords[0][2] : r.climb;
  const m = Math.round(r.km * 1000);
  return { bottom, top, m, rise: Math.round(rise), gradient: m ? Math.round((1000 * rise) / m) / 10 : 0, coords: r.coords };
}

// Hill session: warm-up from where you are to the bottom of your hill, the hill itself, then back.
// If the way to or from the hill is shorter than the warm-up or cool-down, a small loop from the start makes up the difference.
// hill: { bottom: {lat, lon}, top: {lat, lon} }. Returns the whole route plus its parts, drawn in different colours.
export async function makeHillRoute(key, start, hill, warmKm, coolKm, fetchFn = fetch) {
  const [toHill, rep] = await Promise.all([fetchPath(key, [start, hill.bottom], fetchFn), fetchPath(key, [hill.bottom, hill.top], fetchFn)]);
  const parts = [];
  const extra = warmKm - toHill.km;
  if (extra >= 0.5) {
    const loop = await fetchLoop(key, start, extra, 1, fetchFn).catch(() => null);
    if (loop) parts.push({ label: 'Warm-up loop', kind: 'easy', coords: loop.coords, km: loop.km });
  }
  parts.push({ label: 'Warm-up to the hill', kind: 'easy', coords: toHill.coords, km: toHill.km });
  parts.push({ label: 'Hill reps', kind: 'hills', coords: rep.coords, km: rep.km });
  parts.push({ label: 'Cool-down back', kind: 'easy', coords: [...toHill.coords].reverse(), km: toHill.km });
  if (coolKm - toHill.km >= 0.5) {
    const loop = await fetchLoop(key, start, coolKm - toHill.km, 2, fetchFn).catch(() => null);
    if (loop) parts.push({ label: 'Cool-down loop', kind: 'easy', coords: loop.coords, km: loop.km });
  }
  const repM = Math.round(rep.km * 1000);
  const rise = rep.coords.at(-1)[2] != null && rep.coords[0][2] != null ? rep.coords.at(-1)[2] - rep.coords[0][2] : rep.climb;
  const sum = (word) => parts.filter((p) => p.label.startsWith(word)).reduce((s, p) => s + p.km, 0);
  const warm = sum('Warm'), cool = sum('Cool');
  const coords = parts.flatMap((p) => p.coords);
  return {
    ...stamp({ coords, km: r2(warm + cool), climb: climbOf(coords) }, start, null, 'hills', 'hill'),
    parts: parts.map((p) => ({ label: p.label, kind: p.kind, km: p.km, n: p.coords.length })),
    hill: { repM, rise: Math.round(rise), gradient: repM ? Math.round((1000 * rise) / repM) / 10 : 0 },
    warmKm: r2(warm), coolKm: r2(cool), coolShort: r2(Math.max(0, coolKm - cool)),
  };
}

// A route from a run's GPS track (intervals.icu latlng stream: data = latitudes, data2 = longitudes).
export function trackFromStreams(latlng, altitude = []) {
  const lats = latlng?.data || [], lons = latlng?.data2 || [];
  const pts = [];
  for (let i = 0; i < Math.min(lats.length, lons.length); i++) {
    if (lats[i] == null || lons[i] == null || (lats[i] === 0 && lons[i] === 0)) continue;
    pts.push([r5(lats[i]), r5(lons[i]), altitude[i] == null ? null : Math.round(altitude[i] * 10) / 10]);
  }
  if (pts.length < 10) return null;
  return { coords: simplify(pts), km: r2(routeKm(pts)), climb: climbOf(pts) };
}

// Saved routes, closest to the run's distance first.
export const closestRoutes = (saved, km) => [...saved].sort((a, b) => Math.abs(a.km - km) - Math.abs(b.km - km));

const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

// A GPX file Garmin Connect can import as a course.
export function toGpx(route, name) {
  const pts = route.coords.map(([lat, lon, ele]) => `<trkpt lat="${lat}" lon="${lon}">${ele == null ? '' : `<ele>${ele}</ele>`}</trkpt>`).join('\n      ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Runplan" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${xml(name)}</name></metadata>
  <trk><name>${xml(name)}</name>
    <trkseg>
      ${pts}
    </trkseg>
  </trk>
</gpx>
`;
}
