/**
 * Desire-path review (docs/PEOPLE.md §3.3): grows a new game headless for a
 * number of days and reports how connected the paths are, with an ASCII map
 * of the start village; optionally saves the game for tools/shot-paths.ts.
 *
 *   npx tsx tools/paths-run.ts [--seed 1] [--size 128] [--days 96] [--map]
 *     [--save out/paths --save-at 114,140]   (out/paths-d114.bin + .json, … for tools/shot-paths.ts)
 */
import { writeFileSync } from 'node:fs';
import { STEPS_PER_DAY } from '../src/sim/constants';
import { newGame } from '../src/sim/newgame';
import { saveGame } from '../src/sim/persist';
import { pathDuplicates, pathStats } from '../src/sim/people/desire';
import { LandUse } from '../src/sim/world';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};
const seed = Number(arg('seed', '1'));
const size = Number(arg('size', '128'));
const days = Number(arg('days', '96'));
const save = arg('save', '');
const saveAt = arg('save-at', String(days)).split(',').map(Number);
const t0 = Date.now();
const { sim } = newGame(seed, size);
const w = sim.world;
const st = sim.people!.settlements[0]!.state;
const every = Math.max(1, Math.round(days / 8));
const marks = [...new Set([...saveAt.filter((d) => d > 0 && d <= days), days])].sort((a, b) => a - b);
let day = 0;
const report = () => {
  const s = pathStats(w);
  const d = pathDuplicates(w);
  console.log(
    `day ${day}: ${s.cells} path cells in ${s.groups} groups, largest ${s.largest}, ` +
      `isolated ${s.small} (groups ≤ 3 cells), ${s.thick} thick (2×2 blocks), ${d.parallel} parallel, ${d.loop} on short loops; pop ${st.population} (${((Date.now() - t0) / 1000).toFixed(0)} s)`,
  );
};
for (const m of marks) {
  while (day < m) {
    const n = Math.min(every - (day % every), m - day);
    sim.run(STEPS_PER_DAY * n);
    day += n;
    if (day % every === 0 || day === m) report();
  }
  if (save && saveAt.includes(m)) {
    writeFileSync(`${save}-d${m}.bin`, new Uint8Array(await saveGame(sim, {})));
    writeFileSync(`${save}-d${m}.json`, JSON.stringify({ seed, x: st.x, y: st.y, day: m, season: sim.time.season }));
  }
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
