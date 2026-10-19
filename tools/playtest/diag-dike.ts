// Scratch (round 5): the dike bot's look at a village every few days after a forced early flood.
import { CLIMATE } from '../../src/sim/climate/climate';
import { STEPS_PER_DAY } from '../../src/sim/constants';
import { newGame } from '../../src/sim/newgame';
import { dikeWhy, makeBot } from './bots';

const seed = Number(process.argv[2] ?? 4);
const until = Number(process.argv[3] ?? 80);
CLIMATE.bigFrom = 1;
(CLIMATE as { bigChanceRange: readonly number[] }).bigChanceRange = [1, 1];
CLIMATE.bigSpread = 0;
CLIMATE.bigFactor = Number(process.argv[4] ?? 4.5);
const { sim } = newGame(seed, 128);
const bot = makeBot('dike');
for (let d = 0; d < until; d++) {
  sim.run(STEPS_PER_DAY);
  if (d >= 46 && d % 2 === 0) {
    for (const k of Object.keys(dikeWhy)) delete dikeWhy[k];
    const acts = bot.check(sim, d);
    console.log(`d${d}`, JSON.stringify(dikeWhy), acts.map((a) => a.note).join('; '));
    for (const a of acts) for (const c of a.commands) sim.command(c);
  }
}
