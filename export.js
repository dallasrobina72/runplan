// "Share for AI": your runs as one plain-text (Markdown) file that ChatGPT, Claude or any AI chat
// can read. It starts with context (goal, paces, heart rate zones) so the AI knows what "easy" means
// for you, then lists each run with what was planned and what you did. Pure, so it can be tested.
import { fmtDate, addDays, daysBetween } from './dates.js';
import { fmtTime, fmtPace } from './vdot.js';

export const CHOICES = {
  last: { label: 'Last run', file: 'last-run' },
  last5: { label: 'Last 5 runs', file: 'last-5-runs' },
  weeks4: { label: 'Last 4 weeks', file: 'last-4-weeks' },
  all: { label: 'All runs', file: 'all-runs' },
};

// Which runs a choice covers. runs: oldest first.
export function pickRuns(runs, choice, today) {
  const done = runs.filter((r) => r.date <= today && r.km > 0);
  if (choice === 'last') return done.slice(-1);
  if (choice === 'last5') return done.slice(-5);
  if (choice === 'weeks4') return done.filter((r) => r.date > addDays(today, -28));
  if (choice && choice.startsWith('id:')) return done.filter((r) => r.id === choice.slice(3));
  return done;
}

const year = (d) => d.slice(0, 4);
const longDate = (d) => `${fmtDate(d)} ${year(d)}`;
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
const line = (label, parts) => { const v = parts.filter(Boolean).join(' · '); return v ? `- ${label}: ${v}\n` : ''; };

// One run's section.
function runText(r, c) {
  const planned = r.planned;
  const title = r.type === 'extra' ? (r.name || 'Extra run (not in the plan)') : c.typeName(r.type);
  let t = `### ${longDate(r.date)} · ${title}\n`;
  if (planned) t += `- Planned: ${planned.km} km. ${planned.steps.join('; ')}\n`;
  t += line('Done', [`${Math.round(r.km * 100) / 100} km`, r.sec && `time ${fmtTime(r.sec)}`, r.sec && r.km && `pace ${fmtPace(r.sec / r.km)} /km`,
    r.sec && r.km && `${(r.km / (r.sec / 3600)).toFixed(1)} km/h`, r.treadmill ? 'treadmill' : 'outdoor']);
  t += line('Heart rate', [r.hr && `average ${Math.round(r.hr)} bpm`, r.maxHr && `max ${Math.round(r.maxHr)} bpm`,
    r.hr && r.sec && r.km && `${Math.round((r.hr * r.sec) / 60 / r.km)} heartbeats per km`]);
  const z = c.zonesFor(r);
  if (z && z.total) {
    t += `- Time in zones${z.estimated ? ' (estimated from average heart rate)' : ''}: ${z.sec.map((s, i) => `Z${i + 1} ${fmtTime(Math.round(s))} (${pct(s, z.total)}%)`).join(', ')}\n`;
  }
  t += line('Cadence', [r.cad && `average ${Math.round(r.cad)} spm`, r.maxCad && `max ${Math.round(r.maxCad)} spm`]);
  if (r.walkSec >= 30 && r.runSec) t += `- Running ${fmtTime(r.runSec)} (${pct(r.runSec, r.runSec + r.walkSec)}%), walking ${fmtTime(r.walkSec)}\n`;
  t += line('Other', [r.elev && `climb ${Math.round(r.elev)} m`, r.cal && `${Math.round(r.cal)} calories`, r.load && `training load ${Math.round(r.load)}`]);
  if (r.resultSec) t += `- Result: ${fmtTime(r.resultSec)}\n`;
  t += line('How it felt', [r.rpe && `effort ${r.rpe}/10`, r.note && `notes: "${r.note.replace(/\s+/g, ' ').trim()}"`]);
  const gym = c.gymOn(r.date);
  if (gym.length) t += `- Same day: ${gym.join(', ')}\n`;
  return t;
}

// c: everything about you the app already knows (see app.js exportContext()).
export function buildExport(allRuns, choice, today, c) {
  const runs = pickRuns(allRuns, choice, today);
  const label = choice.startsWith('id:') ? 'One run' : CHOICES[choice].label;
  let t = `# My running data (from Runplan)\n\n`;
  t += `Exported ${longDate(today)}. ${label}: ${runs.length} run${runs.length === 1 ? '' : 's'}${runs.length ? `, ${longDate(runs[0].date)} to ${longDate(runs.at(-1).date)}` : ''}.\n`;
  t += `Paces are minutes:seconds per km. Heart rate zones use heart rate reserve (resting to max).\n\n`;

  t += `## About me\n`;
  if (c.goal) t += `- Goal: ${c.goal}\n`;
  t += `- Plan: ${c.planLine}\n`;
  t += `- Fitness score (VDOT): ${c.vdot}. Predicted: ${c.predictions.map((p) => `${p.name} ${p.time}`).join(', ')}\n`;
  t += `- Training paces: ${c.paces.map((p) => `${p.name} ${p.text}`).join('; ')}\n`;
  t += `- Heart rate: max ${c.hr.max ?? 'not set'} (${c.hr.maxSource}), resting ${c.hr.rest} (${c.hr.restSource})${c.vo2 ? `. Garmin VO2 max ${c.vo2}` : ''}\n`;
  if (c.zones) t += `- Zones: ${c.zones.map((z, i) => `Z${i + 1} ${z.name.replace(/^Z\d /, '')} ${z.to ? `${z.from}-${z.to}` : `${z.from}+`}`).join(', ')}\n`;
  if (c.usualWeek) t += `- Usual week of gym and other training: ${c.usualWeek}\n`;
  t += '\n';

  if (runs.length > 1) {
    const km = runs.reduce((s, r) => s + (r.km || 0), 0);
    const timed = runs.filter((r) => r.sec && r.km);
    const sec = timed.reduce((s, r) => s + r.sec, 0), tkm = timed.reduce((s, r) => s + r.km, 0);
    const withHr = runs.filter((r) => r.hr && r.sec);
    const hrAvg = withHr.length ? withHr.reduce((s, r) => s + r.hr * r.sec, 0) / withHr.reduce((s, r) => s + r.sec, 0) : null;
    t += `## Summary\n- ${runs.length} runs, ${Math.round(km * 10) / 10} km${sec ? `, ${fmtTime(sec)} running, average pace ${fmtPace(sec / tkm)} /km` : ''}${hrAvg ? `, average heart rate ${Math.round(hrAvg)} bpm` : ''}\n`;
    const z = c.zonesTotal(runs);
    if (z && z.total) t += `- Time in zones, all these runs: ${z.sec.map((s, i) => `Z${i + 1} ${pct(s, z.total)}%`).join(', ')}\n`;
    if (c.weeks.length) {
      t += `\n| Week | Starts | Planned km | Done km |\n|---|---|---|---|\n`;
      for (const w of c.weeks.filter((w) => w.end >= runs[0].date && w.start <= today)) t += `| ${w.n} | ${fmtDate(w.start)} | ${w.planned} | ${w.done} |\n`;
    }
    t += '\n';
  }

  t += `## Runs (newest first)\n\n`;
  t += runs.length ? [...runs].reverse().map((r) => runText(r, c)).join('\n') : 'No runs yet.\n';
  if (c.next.length) t += `\n## Coming up\n${c.next.map((w) => `- ${longDate(w.date)}: ${c.typeName(w.type)}, ${w.km} km`).join('\n')}\n`;
  if (c.raceDate) t += `\nRace day is ${longDate(c.raceDate)}, ${daysBetween(today, c.raceDate)} days from the export.\n`;
  return { text: t, count: runs.length, file: `Runplan-${choice.startsWith('id:') ? `run-${runs[0]?.date || today}` : `${CHOICES[choice].file}-${today}`}.txt` };
}
