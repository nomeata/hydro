// Scratch: run a bot on its schedule from the d16 cache and print why the first village does (not) grow.
import { readFileSync } from 'node:fs';
import { DAYS_PER_SEASON, STEPS_PER_DAY } from '../../src/sim/constants';
import { loadGame } from '../../src/sim/persist';
import { ECONOMY } from '../../src/sim/people/settlement';
import { makeBot } from './bots';
import { villages } from './geo';
const seed = Number(process.argv[2] ?? 5);
const name = process.argv[3] ?? 'good';
const until = Number(process.argv[4] ?? 100);
const { sim } = await loadGame(new Uint8Array(readFileSync(`out/playtest-cache/s${seed}-128-d16.bin`)).buffer);
const bot = name === 'baseline' ? null : makeBot(name);
for (let d = 16; d < until; d++) {
  if (bot && (d - 16) % 12 === 0) for (const a of bot.check(sim, d)) { console.log(`day ${d}: ${a.note}`); for (const c of a.commands) sim.command(c); }
  sim.run(STEPS_PER_DAY);
  if (d % 4 === 0) {
    const s = villages(sim)[0]!;
    const st = s.state;
    const t = sim.time;
    const doy = t.season * DAYS_PER_SEASON + t.dayOfSeason;
    const P = sim.people as any;
    const bs = P.buildings.filter((b: any) => b.settlement === st.id);
    const unfinished = bs.filter((b: any) => b.progress < 1).map((b: any) => `${b.kind}${b.progress.toFixed(2)}`);
    const jobs: Record<number, number> = {};
    for (const a of P.agents) if (a.settlement === st.id) jobs[a.job] = (jobs[a.job] ?? 0) + 1;
    console.log(`d${d} pop ${st.population} houses ${st.houses} free ${s.freeHouses} w ${st.wellbeing.toFixed(2)} fs ${s.foodSecurity(doy).toFixed(2)} fedH ${s.foodSecurity(doy, ECONOMY.growHorizon).toFixed(2)} wants ${s.wantsHouse()} building ${unfinished.join(',')} jobs ${JSON.stringify(jobs)} villages ${villages(sim).length}`);
  }
}
