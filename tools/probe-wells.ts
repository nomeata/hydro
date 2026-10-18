/** Throwaway probe: hands-off villages, wells and mills. npx tsx tools/probe-wells.ts seed years */
import { DAYS_PER_YEAR, STEPS_PER_DAY } from '../src/sim/constants';
import { Simulation } from '../src/sim/sim';
import { SOIL_PROPS } from '../src/sim/world';
import { generateWorld } from '../src/sim/worldgen/index';
import { WELL } from '../src/sim/people/wells';
import { MILL, headAt } from '../src/sim/people/mills';
if (process.env.GARDEN) WELL.garden = Number(process.env.GARDEN);
if (process.env.NOWELL) WELL.minPeople = 1e9;
if (process.env.REACH) MILL.reach = Number(process.env.REACH);
if (process.env.DROP) MILL.minDrop = Number(process.env.DROP);

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
function placeWeir(): void {
  const st = p.settlements[0]!.state;
  // The fastest river cell within 20 of the centre; a wall across its flow.
  let best = -1;
  let bv = 0;
  for (let y = st.y - 20; y <= st.y + 20; y++) for (let x = st.x - 20; x <= st.x + 20; x++) {
    if (!w.inBounds(x, y) || Math.hypot(x - st.x, y - st.y) > 20) continue;
    const i = w.idx(x, y);
    const v = Math.hypot(w.velX[i]!, w.velY[i]!) * Math.min(1, w.water[i]!);
    if (w.water[i]! > 0.3 && v > bv) { bv = v; best = i; }
  }
  if (best < 0) return;
  const bx = best % w.width, by = (best / w.width) | 0;
  const vx = w.velX[best]!, vy = w.velY[best]!, n = Math.hypot(vx, vy);
  const px = -vy / n, py = vx / n;
  const end = (sgn: number) => { let k = 1; while (k < 14) { const x = Math.round(bx + px * k * sgn), y = Math.round(by + py * k * sgn); if (!w.inBounds(x, y) || w.water[w.idx(x, y)]! < 0.02) break; k++; } return { x: bx + px * (k + 5) * sgn, y: by + py * (k + 5) * sgn }; };
  const a = end(1), b = end(-1);
  sim.command({ type: 'planWeir', points: [[a.x, a.y], [b.x, b.y]], width: 1, height: Number(process.env.WEIR) });
  (globalThis as any).weirAt = [bx, by, vx / n, vy / n];
  console.log(`weir at ${bx},${by} from ${a.x.toFixed(0)},${a.y.toFixed(0)} to ${b.x.toFixed(0)},${b.y.toFixed(0)}`);
}
for (let d = 1; d <= years * DAYS_PER_YEAR; d++) {
  if (process.env.WEIR && d === 30) placeWeir();
  if (process.env.WEIR && d > 30 && d % 4 === 0) {
    let best = { drop: 0, speed: 0, flow: 0, power: 0 };
    let lined = 0;
    for (const wr of sim.structures.weirs) for (const c of wr.cells) {
      if (w.flags[c]! & 1) lined++;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const hd = headAt(w, c + dy * w.width + dx); if (hd.power > best.power) best = hd; }
    }
    if (process.env.PROFILE) {
      const [bx, by, ux, uy] = (globalThis as any).weirAt;
      const row: string[] = [];
      for (let k = -6; k <= 6; k++) { const i = w.idx(Math.round(bx + ux * k), Math.round(by + uy * k)); row.push(`${k}:${w.terrain(i).toFixed(1)}+${w.water[i]!.toFixed(2)}=${w.surface(i).toFixed(2)}@${Math.hypot(w.velX[i]!, w.velY[i]!).toFixed(1)}`); }
      console.log(row.join(' '));
    }
    console.log(`d${d} weir lined ${lined} best drop ${best.drop.toFixed(2)} v ${best.speed.toFixed(2)} Q ${best.flow.toFixed(2)} P ${(best.power / 1000).toFixed(1)} kW`);
  }
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
      return `${st.population}p f${nf}/${gf} food${st.food.toFixed(0)}${mill ? ` mill${mill.progress.toFixed(1)}@${mill.x},${mill.y} sp${mill.spin}` : ''} w${st.wellbeing.toFixed(2)} wd${wd.toFixed(0)} tbl${best.toFixed(1)} wa${st.waterAccess.toFixed(2)} W${wells}M${mills}`;
    });
    line.push(`d${d}: ${p.population} [${vs.join(' | ')}]`);
  }
}
console.log(`seed ${seed}\n  ${line.join('\n  ')}`);
