/**
 * Tuning experiments: playtest jobs in this process with tunables overridden
 * (the exported parameter objects are mutable), population per season.
 *
 *   npx tsx tools/playtest/exp.ts --seeds 7,8 --days 96 --bot baseline --set FARMING.yield=12,ECONOMY.stayers=6
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { DAYS_PER_YEAR } from '../../src/sim/constants';
import { PARAMS } from '../../src/sim/params';
import { ECONOMY } from '../../src/sim/people/settlement';
import { CAPILLARY, CROP_MOISTURE, FARMING, FOUNDING, HARDY } from '../../src/sim/people/village';
import { DITCH } from '../../src/sim/people/ditches';
import { runJob } from './run';
import { makeBot } from './bots';
import { makeBot as makeOld } from './oldbots';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1]! : d;
};
const tables: Record<string, Record<string, unknown>> = { PARAMS, ECONOMY, CAPILLARY, CROP_MOISTURE, FARMING, FOUNDING, HARDY, DITCH };
for (const kv of opt('set', '').split(',').filter(Boolean)) {
  const [k, v] = kv.split('=') as [string, string];
  const [t, f] = k.split('.') as [string, string];
  if (!tables[t] || !(f in tables[t]!)) throw new Error(`unknown ${k}`);
  tables[t]![f] = Number(v);
}
const seeds = opt('seeds', '1').split(',').map(Number);
const days = Number(opt('days', '96'));
for (const bot of opt('bot', 'baseline').split(',')) {
  for (const seed of seeds) {
    const r = await runJob({ seed, size: Number(opt('size', '128')), days, bot: bot, actDay: 16, checkEvery: 12, window: 2, ...(args.includes('--ignore-unlocks') ? { ignoreUnlocks: true } : {}) }, () => {}, ((name: string, o: object) => (name.startsWith('old-') ? makeOld(name.slice(4), o) : makeBot(name, o))) as typeof makeBot);
    mkdirSync('out/exp', { recursive: true });
    writeFileSync(`out/exp/${opt('tag', 'x')}-${bot}-s${seed}.json`, JSON.stringify(r));
    const pops = r.seasons.map((s) => s.population);
    const years = Array.from({ length: Math.round(days / DAYS_PER_YEAR) }, (_, y) => r.daily.population[(y + 1) * DAYS_PER_YEAR - 1]);
    const m = r.outcome.milestones as Record<string, number>;
    console.log(
      `seed ${seed} ${bot}: years ${years.join('/')} | seasons ${pops.join(' ')} | prosp ${r.outcome.prosperity.toFixed(0)}% fs ${r.outcome.foodSecurity.toFixed(2)} | 15@${m[15] ?? '-'} 30@${m[30] ?? '-'} | fields ${r.outcome.fields} | ${r.actions.map((a) => a.note.slice(0, 60)).join('; ')}`,
    );
  }
}
