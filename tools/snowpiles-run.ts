/**
 * Snow piles beside the fields (village.ts SNOW_CLEARING): how deep they get
 * and how long they last.
 *   npx tsx tools/snowpiles-run.ts [--seed 1] [--size 256] [--from 140] [--to 165]
 *     [--save out/piles --save-days 145,151]   (writes out/piles-<day>.hydro)
 *     [--load game.hydro] [--snow-mult 10]     (resume a save, its snow scaled: a snowier winter)
 * Prints the banks four times a game day from day `from`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { STEPS_PER_DAY } from '../src/sim/constants';
import { newGame } from '../src/sim/newgame';
import { loadGame, saveGame } from '../src/sim/persist';
import { snowPiles } from '../src/sim/people/village';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1]! : d;
};
const seed = Number(opt('seed', '1'));
const size = Number(opt('size', '256'));
const from = Number(opt('from', '140'));
const to = Number(opt('to', '165'));
const save = opt('save', '');
const saveDays = opt('save-days', '').split(',').filter(Boolean).map(Number);

const load = opt('load', '');
const sim = load ? (await loadGame(readFileSync(load).buffer as ArrayBuffer)).sim : newGame(seed, size).sim;
const w = sim.world;
const mult = Number(opt('snow-mult', '1'));
for (let i = 0; i < w.size; i++) w.snow[i]! *= mult;
/** The snow banks beside the fields (village.ts snowPiles): count, deepest, total (m water above the snow around). */
function piles(): { n: number; max: number; sum: number } {
  const p = sim.people ? snowPiles(w, sim.people.snowBanks) : [];
  let max = 0;
  let sum = 0;
  for (let k = 2; k < p.length; k += 3) {
    max = Math.max(max, p[k]!);
    sum += p[k]!;
  }
  return { n: p.length / 3, max, sum };
}
let day = 0;
while (sim.step / STEPS_PER_DAY < to) {
  sim.run(STEPS_PER_DAY / 4);
  const d = Math.floor((sim.step / STEPS_PER_DAY) * 4) / 4;
  if (d >= from && d !== day) {
    day = d;
    const p = piles();
    const t = sim.weather.climateState(sim.time).temperature;
    console.log(`day ${d.toFixed(2)} y${sim.time.year} s${sim.time.season} d${sim.time.dayOfSeason} T=${t.toFixed(1)} piles n=${p.n} max=${p.max.toFixed(3)} sum=${p.sum.toFixed(2)}`);
  }
  const sd = saveDays.find((d) => Math.abs(sim.step / STEPS_PER_DAY - d) < 0.13);
  if (save && sd !== undefined) {
    saveDays.splice(saveDays.indexOf(sd), 1);
    mkdirSync('out', { recursive: true });
    writeFileSync(`${save}-${sd}.hydro`, Buffer.from(await saveGame(sim, {})));
    console.log('saved', `${save}-${sd}.hydro`);
  }
}
