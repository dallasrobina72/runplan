// Gym and other training: a weekly template of session names, plus one-off changes for single dates.
import { weekday, addDays, daysBetween } from './dates.js';

// "hard" = hard on the legs. Hard runs are kept off these days and the day after.
export const DEFAULT_LIBRARY = [
  { name: 'Chest & Biceps', hard: false },
  { name: 'Back & Triceps', hard: false },
  { name: 'Leg day', hard: true },
  { name: 'Shoulders & Abs', hard: false },
  { name: 'Plyometrics', hard: true },
  { name: 'Football', hard: true },
  { name: 'Padel', hard: true },
];

export function ensureTraining(S) {
  if (S.training) return S.training;
  const library = DEFAULT_LIBRARY.map((x) => ({ ...x }));
  const week = [[], [], [], [], [], [], []];
  for (const d of S.profile?.otherDays || []) {
    if (!library.some((x) => x.name === 'Other hard training')) library.push({ name: 'Other hard training', hard: true });
    week[d].push('Other hard training');
  }
  S.training = { library, week, overrides: {}, done: {} };
  return S.training;
}

export const sessionsOn = (T, date) => T.overrides[date] ?? T.week[weekday(date)];
export const isHard = (T, name) => !!T.library.find((x) => x.name === name)?.hard;
export const hardDays = (T) => [0, 1, 2, 3, 4, 5, 6].filter((d) => T.week[d].some((n) => isHard(T, n)));

export function addSession(T, date, name) {
  T.overrides[date] = [...sessionsOn(T, date), name];
}

export function removeSession(T, date, name) {
  const list = [...sessionsOn(T, date)];
  const i = list.indexOf(name);
  if (i >= 0) list.splice(i, 1);
  T.overrides[date] = list;
}

export function moveSession(T, from, to, name) {
  if (from === to) return;
  removeSession(T, from, name);
  addSession(T, to, name);
}

// Ticked "other hard training days" from the setup screen, applied to the weekly template.
export function applyHardDays(T, ticked) {
  for (let d = 0; d < 7; d++) {
    const has = T.week[d].some((n) => isHard(T, n));
    if (ticked.includes(d) && !has) {
      if (!T.library.some((x) => x.name === 'Other hard training')) T.library.push({ name: 'Other hard training', hard: true });
      T.week[d].push('Other hard training');
    }
    if (!ticked.includes(d) && has) T.week[d] = T.week[d].filter((n) => !isHard(T, n));
  }
}

// A hard run on a hard-on-legs day or the day after one (long run: same day only).
export function clashFor(T, w, HARD) {
  if (w.type === 'race') return null;
  const same = sessionsOn(T, w.date).find((n) => isHard(T, n));
  if (same && (HARD.has(w.type) || w.type === 'long')) return { name: same, when: 'same' };
  const before = sessionsOn(T, addDays(w.date, -1)).find((n) => isHard(T, n));
  if (before && HARD.has(w.type)) return { name: before, when: 'after' };
  return null;
}

// An easy run this week to swap with, so the hard run lands somewhere safe.
export function swapOption(T, w, week, HARD, today) {
  const hardDates = week.workouts.filter((x) => x !== w && HARD.has(x.type)).map((x) => x.date);
  return week.workouts.find((x) => {
    if (!['easy', 'strides'].includes(x.type) || x.date < today) return false;
    if (clashFor(T, { ...w, date: x.date }, HARD)) return false;
    return hardDates.every((d) => Math.abs(daysBetween(d, x.date)) > 1);
  }) || null;
}
