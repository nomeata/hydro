/**
 * Desire-path review (docs/PEOPLE.md §3.3): grows a new game headless for a
 * number of days and reports how connected the paths are, with an ASCII map
 * of the start village; optionally saves the game for tools/shot-paths.ts.
 *
 *   npx tsx tools/paths-run.ts [--seed 1] [--size 128] [--days 96] [--save out/paths.bin] [--map]
 */
import { writeFileSync } from 'node:fs';
import { STEPS_PER_DAY } from '../src/sim/constants';
import { newGame } from '../src/sim/newgame';
import { saveGame } from '../src/sim/persist';
import { pathStats } from '../src/sim/people/desire';
import { LandUse } from '../src/sim/world';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};
const seed = Number(arg('seed', '1'));
const size = Number(arg('size', '128'));
const days = Number(arg('days', '96'));
const save = arg('save', '');
const t0 = Date.now();
const { sim } = newGame(seed, size);
const w = sim.world;
const st = sim.people!.settlements[0]!.state;
const every = Math.max(1, Math.round(days / 8));
for (let d = 0; d < days; d += every) {
  sim.run(STEPS_PER_DAY * Math.min(every, days - d));
  const s = pathStats(w);
  console.log(
    `day ${Math.min(days, d + every)}: ${s.cells} path cells in ${s.groups} groups, largest ${s.largest}, ` +
      `isolated ${s.small} (groups ≤ 3 cells), ${s.thick} thick (2×2 blocks); pop ${st.population} (${((Date.now() - t0) / 1000).toFixed(0)} s)`,
  );
}
if (process.argv.includes('--map')) {
  const R = 30;
  const ch: Record<number, string> = { [LandUse.Path]: '#', [LandUse.Field]: ',', [LandUse.Building]: 'H', [LandUse.Yard]: 'y', [LandUse.Garden]: 'g', [LandUse.Bridge]: '=', [LandUse.Pasture]: '"' };
  for (let y = Math.max(0, Math.round(st.y) - R); y < Math.min(w.height, Math.round(st.y) + R); y++) {
    let line = '';
    for (let x = Math.max(0, Math.round(st.x) - R * 2); x < Math.min(w.width, Math.round(st.x) + R * 2); x++) {
      const i = w.idx(x, y);
      const c = ch[w.landuse[i]!];
      line += c ?? (w.water[i]! > 0.3 ? '~' : w.landuse[i]! ? 'o' : '.');
    }
    console.log(line);
  }
}
if (save) {
  writeFileSync(save, new Uint8Array(await saveGame(sim, {})));
  writeFileSync(save.replace(/\.bin$/, '.json'), JSON.stringify({ seed, x: st.x, y: st.y, day: sim.step / STEPS_PER_DAY }));
}
