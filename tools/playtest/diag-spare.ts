/**
 * Scratch (round 5): a game hands-off or with a bot, printing every few days
 * what year-round growth judges by: last year's food against need
 * (`produced`), what the fields promise (`promised`), the spare good land's
 * promise, the store, the growth limit and camps.
 *
 *   npx tsx tools/playtest/diag-spare.ts <seed> [bot] [days] [every] [size]
 */
import { DAYS_PER_SEASON, DAYS_PER_YEAR, STEPS_PER_DAY } from '../../src/sim/constants';
import { CLIMATE } from '../../src/sim/climate/climate';
import { newGame } from '../../src/sim/newgame';
import { makeBot } from './bots';
import { villages } from './geo';

const seed = Number(process.argv[2] ?? 3);
const name = process.argv[3] ?? 'baseline';
const until = Number(process.argv[4] ?? 192);
const every = Number(process.argv[5] ?? 4);
const size = Number(process.argv[6] ?? 128);
// SET="bigFrom=1,bigChanceRange=1:1,bigFactor=4.5": climate overrides.
for (const kv of (process.env.SET ?? '').split(',').filter(Boolean)) {
  const [k, v] = kv.split('=') as [string, string];
  (CLIMATE as Record<string, unknown>)[k] = v.includes(':') ? v.split(':').map(Number) : Number(v);
}
const { sim } = newGame(seed, size);
const bot = name === 'baseline' ? null : makeBot(name);
for (let d = 0; d < until; d++) {
  if (bot && d >= 16 && (d - 16) % 12 === 0)
    for (const a of bot.check(sim, d)) {
      console.log(`day ${d}: ${a.note}`);
      for (const c of a.commands) sim.command(c);
    }
  sim.run(STEPS_PER_DAY);
  if (d % every === every - 1) {
    const t = sim.time;
    const doy = t.season * DAYS_PER_SEASON + t.dayOfSeason;
    const row = villages(sim).map((s) => {
      const st = s.state;
      const need = st.population * DAYS_PER_YEAR;
      return `#${st.id} p${st.population} h${st.houses} w${st.wellbeing.toFixed(2)} ahead ${s.ahead(doy).toFixed(2)} g ${s.growth(doy).toFixed(2)} spare ${((st.spareLand ?? 0) / Math.max(1, need)).toFixed(2)} fs ${s.foodSecurity(doy).toFixed(2)} gs ${s.growSecurity(doy).toFixed(2)} ${st.limit}${st.camp ? ' camp' : ''}`;
    });
    console.log(`d${d + 1} y${Math.floor((d + 1) / DAYS_PER_YEAR) + 1}s${t.season} ${row.join(' | ')}`);
  }
}
