/** Throwaway probe: hands-off villages, wells and mills. npx tsx tools/probe-wells.ts seed years */
import { DAYS_PER_YEAR, STEPS_PER_DAY } from '../src/sim/constants';
import { Simulation } from '../src/sim/sim';
import { SOIL_PROPS } from '../src/sim/world';
import { generateWorld } from '../src/sim/worldgen/index';
import { WELL } from '../src/sim/people/wells';
if (process.env.GARDEN) WELL.garden = Number(process.env.GARDEN);
if (process.env.NOWELL) WELL.minPeople = 1e9;

const seed = Number(process.argv[2] ?? 3);
const years = Number(process.argv[3] ?? 3);
const gen = generateWorld({ seed, size: 128 });
const sim = new Simulation(gen.world, seed, { people: { startX: gen.startX, startY: gen.startY }, rain: gen.rain });
sim.run(600);
sim.step = 0;
const w = sim.world;
const p = sim.people!;
function tableDepth(i: number): number {
  const n = Math.max(0.02, SOIL_PROPS[w.soilType[i]!]!.porosity);
  return w.soil[i]! - w.ground[i]! / n;
}
const line: string[] = [];
for (let d = 1; d <= years * DAYS_PER_YEAR; d++) {
  sim.run(STEPS_PER_DAY);
  if (d % (DAYS_PER_YEAR / 2) === 0) {
    const vs = p.settlements.map((s) => {
      const st = s.state;
      const c = w.idx(Math.round(st.x), Math.round(st.y));
      const wd = (p as any).waterDist[c] as number;
      let best = 99;
      for (let y = st.y - 6; y <= st.y + 6; y++) for (let x = st.x - 6; x <= st.x + 6; x++) {
        const i = w.idx(Math.round(x), Math.round(y));
        const n = Math.max(0.02, SOIL_PROPS[w.soilType[i]!]!.porosity);
        if (w.ground[i]! / n < 0.5) continue;
        best = Math.min(best, tableDepth(i));
      }
      const wells = p.buildings.filter((b) => b.settlement === st.id && (b.kind as string) === 'well').length;
      const mills = p.buildings.filter((b) => b.settlement === st.id && (b.kind as string) === 'mill').length;
      const wg = (p as any).wellGarden as Int32Array;
      let gf = 0;
      let nf = 0;
      for (let i = 0; i < w.size; i++) if (w.landuse[i] === 1) { nf++; if (wg[i]! >= 0) gf++; }
      const mill = p.millOf(st.id);
      return `${st.population}p f${nf}/${gf} food${st.food.toFixed(0)}${mill ? ` mill${mill.progress.toFixed(1)} sp${mill.spin}` : ''} w${st.wellbeing.toFixed(2)} wd${wd.toFixed(0)} tbl${best.toFixed(1)} wa${st.waterAccess.toFixed(2)} W${wells}M${mills}`;
    });
    line.push(`d${d}: ${p.population} [${vs.join(' | ')}]`);
  }
}
console.log(`seed ${seed}\n  ${line.join('\n  ')}`);
