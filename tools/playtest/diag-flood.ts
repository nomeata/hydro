/**
 * Scratch (round 5): how the floodplain is farmed and what a spring freshet
 * does to it. Runs hands-off (or with a bot) and prints, per spring, the
 * village fields by height above the nearby river, and the most fields
 * standing in water (> drown depth) on any day of the spring.
 *
 *   npx tsx tools/playtest/diag-flood.ts <seed> [days] [bot] [CLIMATE.k=v,...]
 */
import { CROP_MOISTURE } from '../../src/sim/people/village';
import { CLIMATE } from '../../src/sim/climate/climate';
import { DAYS_PER_YEAR, STEPS_PER_DAY } from '../../src/sim/constants';
import { newGame } from '../../src/sim/newgame';
import { LandUse } from '../../src/sim/world';
import { makeBot } from './bots';
import { cellX, cellY, isRiver, villages } from './geo';

const seed = Number(process.argv[2] ?? 2);
const until = Number(process.argv[3] ?? 110);
const name = process.argv[4] ?? 'baseline';
for (const kv of (process.argv[5] ?? '').split(',').filter(Boolean)) {
  const [k, v] = kv.split('=') as [string, string];
  const f = k.replace('CLIMATE.', '');
  if (f === 'bigChanceRange') (CLIMATE as Record<string, unknown>)[f] = v.split(':').map(Number);
  else (CLIMATE as Record<string, unknown>)[f] = Number(v);
}
const { sim } = newGame(seed, 128);
const w = sim.world;
const bot = name === 'baseline' ? null : makeBot(name);
/** Height of each field above the surface of the nearest river cell within 24 cells. */
function heights(): number[] {
  const out: number[] = [];
  const river: number[] = [];
  for (let i = 0; i < w.size; i++) if (isRiver(w, i)) river.push(i);
  for (let i = 0; i < w.size; i++) {
    if (w.landuse[i] !== LandUse.Field) continue;
    let best = Infinity;
    let h = NaN;
    for (const j of river) {
      const d = (cellX(w, i) - cellX(w, j)) ** 2 + (cellY(w, i) - cellY(w, j)) ** 2;
      if (d < best) {
        best = d;
        h = w.terrain(i) - w.surface(j);
      }
    }
    out.push(best <= 24 * 24 ? h : 99);
  }
  return out;
}
let worst = 0;
let worstDay = 0;
let flooded = new Set<number>();
for (let d = 0; d < until; d++) {
  if (bot && d >= 16 && (d - 16) % 12 === 0)
    for (const a of bot.check(sim, d)) {
      console.log(`day ${d}: ${a.note}`);
      for (const c of a.commands) sim.command(c);
    }
  const doy = d % DAYS_PER_YEAR;
  if (doy === 0) {
    const hs = heights();
    const bins = [0.5, 1, 1.5, 2, 3, 99].map((t, k, a) => hs.filter((h) => h < t && h >= (k ? a[k - 1]! : -9)).length);
    const vs = villages(sim);
    console.log(`d${d} y${d / DAYS_PER_YEAR + 1} big ${sim.climate.bigFreshet().toFixed(1)} pop ${vs.map((s) => s.state.population).join('+')} fields ${hs.length} above river <0.5:${bins[0]} <1:${bins[1]} <1.5:${bins[2]} <2:${bins[3]} <3:${bins[4]} more:${bins[5]}`);
    worst = 0;
    flooded = new Set();
  }
  sim.run(STEPS_PER_DAY);
  if (doy < 14) {
    let n = 0;
    for (let i = 0; i < w.size; i++)
      if (w.landuse[i] === LandUse.Field && w.water[i]! > CROP_MOISTURE.drown) {
        n++;
        flooded.add(i);
      }
    if (n > worst) {
      worst = n;
      worstDay = doy;
    }
    if (doy === 13) console.log(`   spring: most fields under water ${worst} (day ${worstDay}), fields wet some day ${flooded.size}, flood cells so far ${sim.people!.floods.cells}, ruined ${sim.people!.floods.ruined}`);
  }
}
