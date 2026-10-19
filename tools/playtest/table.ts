/**
 * Compact round tables from playtest results (docs/PLAYTEST.md round 3):
 * population at the end of each year, prosperity over the last year, the
 * days to the weir and gate milestones, and each bot against the hands-off
 * run of the same seed.
 *
 *   npx tsx tools/playtest/table.ts out/playtest [bots,...]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DAYS_PER_YEAR } from '../../src/sim/constants';
import type { JobResult } from './run';

const dir = process.argv[2] ?? 'out/playtest';
const only = process.argv[3]?.split(',');
const rs: JobResult[] = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as JobResult)
  .filter((r) => !only || only.includes(r.spec.bot) || r.spec.bot === 'baseline');
const bots = [...new Set(rs.map((r) => r.spec.bot))].sort((a, b) => (a === 'baseline' ? -1 : b === 'baseline' ? 1 : a.localeCompare(b)));
const seeds = [...new Set(rs.map((r) => r.spec.seed))].sort((a, b) => a - b);
const get = (bot: string, seed: number) => rs.find((r) => r.spec.bot === bot && r.spec.seed === seed);
const popAt = (r: JobResult, y: number) => r.daily.population[Math.min(r.daily.population.length, y * DAYS_PER_YEAR) - 1] ?? 0;
const prospYear = (r: JobResult, y: number) => {
  const xs = r.daily.prosperity.slice((y - 1) * DAYS_PER_YEAR, y * DAYS_PER_YEAR);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
};
const years = Math.max(...rs.map((r) => Math.round(r.spec.days / DAYS_PER_YEAR)));

console.log(`| bot | ${seeds.map((s) => `s${s}`).join(' | ')} | mean Δ% |`);
console.log(`|---|${seeds.map(() => '---').join('|')}|---|`);
for (const bot of bots) {
  const cells: string[] = [];
  const deltas: number[] = [];
  for (const s of seeds) {
    const r = get(bot, s);
    if (!r) {
      cells.push('–');
      continue;
    }
    const ys = Array.from({ length: Math.round(r.spec.days / DAYS_PER_YEAR) }, (_, k) => popAt(r, k + 1));
    const b = get('baseline', s);
    const yN = ys.length;
    const pr = prospYear(r, yN);
    cells.push(`${ys.join('/')} (${pr.toFixed(0)}%)`);
    if (b && bot !== 'baseline') {
      const bp = popAt(b, yN);
      deltas.push(bp ? (100 * (ys[yN - 1]! - bp)) / bp : 0);
    }
  }
  const md = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : NaN;
  console.log(`| ${bot} | ${cells.join(' | ')} | ${Number.isNaN(md) ? '' : (md > 0 ? '+' : '') + md.toFixed(0)} |`);
}
console.log('');
console.log(`Population at the end of years 1–${years} (prosperity, mean over the last year). Days to 15 / 30 (real minutes at 1× = day/2):`);
for (const bot of bots) {
  const row = seeds.map((s) => {
    const r = get(bot, s);
    if (!r) return '–';
    const m = r.outcome.milestones as Record<string, number>;
    return `${m[15] ?? '–'}/${m[30] ?? '–'}`;
  });
  console.log(`| ${bot} | ${row.join(' | ')} |`);
}
console.log('');
console.log('Earth moved (m³) and actions:');
for (const bot of bots.filter((b) => b !== 'baseline')) {
  const row = seeds.map((s) => {
    const r = get(bot, s);
    if (!r) return '–';
    const e = r.actions.reduce((n, a) => n + ((a as { earthMoved?: number }).earthMoved ?? 0), 0);
    return `${Math.round(e)} (${r.actions.length})`;
  });
  console.log(`| ${bot} | ${row.join(' | ')} |`);
}
console.log('');
console.log('Response: days from the first works to the first day the bot run has more houses + camps than the hands-off run (– never), and to +2 houses:');
for (const bot of bots.filter((b) => b !== 'baseline')) {
  const row = seeds.map((s) => {
    const r = get(bot, s);
    const b = get('baseline', s);
    if (!r || !b || !r.actions.length) return '–';
    const a0 = r.actions[0]!;
    const from = a0.day;
    const more = (k: number, d: number) => (r.daily.houses[d] ?? 0) + (k ? 0 : r.daily.camps?.[d] ?? 0) - ((b.daily.houses[d] ?? 0) + (k ? 0 : b.daily.camps?.[d] ?? 0));
    let first = -1;
    let two = -1;
    for (let d = from; d < r.daily.houses.length; d++) {
      if (first < 0 && more(0, d) > 0) first = d - from;
      if (two < 0 && more(1, d) >= 2) two = d - from;
    }
    return `${first < 0 ? '–' : first}/${two < 0 ? '–' : two}`;
  });
  console.log(`| ${bot} | ${row.join(' | ')} |`);
}
