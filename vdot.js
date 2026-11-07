// Jack Daniels' VDOT formulas. Distances in metres, times in seconds, paces in seconds per km.

const vo2At = (mPerMin) => -4.6 + 0.182258 * mPerMin + 0.000104 * mPerMin * mPerMin;
const pctMax = (min) => 0.8 + 0.1894393 * Math.exp(-0.012778 * min) + 0.2989558 * Math.exp(-0.1932605 * min);
const speedAt = (vo2) => (-0.182258 + Math.sqrt(0.182258 ** 2 + 4 * 0.000104 * (vo2 + 4.6))) / (2 * 0.000104);

export function vdotFromRace(metres, seconds) {
  const min = seconds / 60;
  return vo2At(metres / min) / pctMax(min);
}

// Predicted race time for a distance, by bisection.
export function predict(vdot, metres) {
  let lo = metres / 500 * 60, hi = metres / 50 * 60; // 500 m/min to 50 m/min
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (vdotFromRace(metres, mid) > vdot) lo = mid; else hi = mid;
  }
  return Math.round((lo + hi) / 2);
}

const paceAtPct = (vdot, pct) => 60000 / speedAt(vdot * pct); // sec per km

// Training paces in sec/km. Easy is a range (slow, fast).
export function paces(vdot) {
  return {
    easySlow: paceAtPct(vdot, 0.62),
    easyFast: paceAtPct(vdot, 0.70),
    marathon: predict(vdot, 42195) / 42.195,
    half: predict(vdot, 21097.5) / 21.0975,
    threshold: paceAtPct(vdot, 0.88),
    tenK: predict(vdot, 10000) / 10,
    interval: paceAtPct(vdot, 0.975),
    fiveK: predict(vdot, 5000) / 5,
    rep: paceAtPct(vdot, 0.975) - 15, // Daniels: R is about 6 s per 400 m faster than I
  };
}

export const DIST = { '5k': 5000, '10k': 10000, half: 21097.5, marathon: 42195 };

export function fmtPace(secPerKm) {
  const s = Math.round(secPerKm);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtTime(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

// "25:30", "1:45:00", "1:45" (h:mm only if > 2 parts not given? no: 2 parts = m:ss)
export function parseTime(str) {
  const parts = String(str).trim().split(':').map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}
