/**
 * Start sites (docs/PLAYTEST.md round 4): how each seed's start was chosen
 * (terrace or meadow), and the land within the first village's field
 * radius a few days in: cells that are good for crops now (as the village
 * judges them), fertile land that is too dry (what the player's water
 * would make good), and the village's fields.
 *
 *   npx tsx tools/playtest/diag-start.ts --seeds 1..16 [--size 128] [--day 2]
 */
import { STEPS_PER_DAY } from '../../src/sim/constants';
import { newGame } from '../../src/sim/newgame';
import { fertileStart } from '../../src/sim/worldgen';
import { cropGrowth, FARMING } from '../../src/sim/people/village';
import { LandUse } from '../../src/sim/world';
import { villages } from './geo';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1]! : d;
};
const seeds = opt('seeds', '1..8').split(',').flatMap((p) => {
  const m = /^(\d+)\.\.(\d+)$/.exec(p);
  return m ? Array.from({ length: Number(m[2]) - Number(m[1]) + 1 }, (_, k) => Number(m[1]) + k) : [Number(p)];
});
const size = Number(opt('size', '128'));
const day = Number(opt('day', '2'));
const R = 18;

console.log('| seed | start | h m | d | plain | est. good/dry | good | dry fertile | fields | village good left |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const seed of seeds) {
  const { sim, gen } = newGame(seed, size);
  sim.run(STEPS_PER_DAY * day);
  const w = sim.world;
  const p = sim.people!;
  const v = villages(sim)[0];
  const cx = v ? Math.round(v.state.x) : gen.startX;
  const cy = v ? Math.round(v.state.y) : gen.startY;
  let good = 0;
  let dry = 0;
  let fields = 0;
  for (let y = Math.max(0, cy - R); y <= Math.min(w.height - 1, cy + R); y++)
    for (let x = Math.max(0, cx - R); x <= Math.min(w.width - 1, cx + R); x++) {
      const r = Math.hypot(x - cx, y - cy);
      if (r > R || r < 3) continue;
      const i = w.idx(x, y);
      if (w.landuse[i] === LandUse.Field) fields++;
      if (w.water[i]! > 0.05 || w.fertility[i]! < 0.5 || (w.landuse[i] !== LandUse.None && w.landuse[i] !== LandUse.Field)) continue;
      if (cropGrowth(p.fieldMoisture[i]!) >= FARMING.minGrowth) good++;
      else dry++;
    }
  const s = gen.start;
  console.log(
    `| ${seed} | ${s.terrace ? 'terrace' : 'meadow'}${fertileStart(seed) ? ' (fertile)' : ''} | ${s.height.toFixed(1)} | ${s.dist.toFixed(0)} | ${s.plain} | ${s.good ?? '-'}/${s.dry ?? '-'} | ${good} | ${dry} | ${fields} | ${v ? ((p as unknown as { goodLeft: Map<number, number> }).goodLeft.get(v.state.id) ?? '-') : '-'} |`,
  );
}
