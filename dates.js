// Dates are stored as "YYYY-MM-DD" strings. Maths is done at noon UTC so daylight saving never shifts a day.

const at = (iso) => new Date(iso + 'T12:00:00Z');
const iso = (d) => d.toISOString().slice(0, 10);

export const addDays = (s, n) => { const d = at(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
export const weekday = (s) => (at(s).getUTCDay() + 6) % 7; // Mon 0 ... Sun 6
export const mondayOf = (s) => addDays(s, -weekday(s));
export const daysBetween = (a, b) => Math.round((at(b) - at(a)) / 864e5);

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const fmtDate = (s) => `${DAY[weekday(s)]} ${Number(s.slice(8))} ${MONTH[Number(s.slice(5, 7)) - 1]}`;
export const fmtShort = (s) => `${Number(s.slice(8))} ${MONTH[Number(s.slice(5, 7)) - 1]}`;
