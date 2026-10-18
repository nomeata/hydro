// Scratch: follow a weircanal bot's pool and canal day by day.
import { readFileSync } from 'node:fs';
import { STEPS_PER_DAY } from '../../src/sim/constants';
import { loadGame } from '../../src/sim/persist';
import { makeBot } from './bots';
const seed = Number(process.argv[2] ?? 5);
const days = Number(process.argv[3] ?? 24);
const name = process.argv[4] ?? 'weircanal';
const { sim } = await loadGame(new Uint8Array(readFileSync(`out/playtest-cache/s${seed}-128-d16.bin`)).buffer);
const bot = makeBot(name, { ignoreUnlocks: true });
const acts = bot.check(sim, 16);
for (const a of acts) for (const c of a.commands) sim.command(c);
const w = sim.world;
const cmd = acts[0]!.commands.find((c) => c.type === 'shapeLine') as any;
const p0 = cmd.points[0];
const i0 = w.idx(Math.round(p0[0]), Math.round(p0[1]));
const iEnd = w.idx(Math.round(cmd.points.at(-1)[0]), Math.round(cmd.points.at(-1)[1]));
console.log(acts[0]!.note, 'floor', cmd.floor);
const wr = sim.structures.weirs[0];
const wx = wr ? w.idx(Math.round((wr.x + wr.x2) / 2), Math.round((wr.y + wr.y2) / 2)) : -1;
for (let d = 0; d < days; d++) {
  sim.run(STEPS_PER_DAY);
  let maxS = -Infinity;
  let wetN = 0;
  if (wr) for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) { const j = w.idx(Math.round((wr.x + wr.x2) / 2) + dx, Math.round((wr.y + wr.y2) / 2) + dy); if (w.water[j]! > 0.05) { wetN++; maxS = Math.max(maxS, w.surface(j)); } }
  const planLeft = w.plan.filter((p) => !Number.isNaN(p)).length;
  console.log(`d${d} weir top ${wr?.top.toFixed(2)} wall z ${wx >= 0 ? w.terrain(wx).toFixed(2) : '-'} plans ${planLeft} pool max surf ${maxS.toFixed(2)} wet ${wetN}; intake ground ${w.terrain(i0).toFixed(2)} water ${w.water[i0]!.toFixed(2)} surf ${w.surface(i0).toFixed(2)}; end ground ${w.terrain(iEnd).toFixed(2)} water ${w.water[iEnd]!.toFixed(3)}`);
}
// Profile along the polyline.
const pts = cmd.points as [number, number][];
let s = 0;
const out: string[] = [];
for (let k = 0; k + 1 < pts.length; k++) {
  const [a, b] = [pts[k]!, pts[k + 1]!];
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
  for (let t = 0; t < l; t += 1) {
    const x = Math.round(a[0] + ((b[0] - a[0]) * t) / l);
    const y = Math.round(a[1] + ((b[1] - a[1]) * t) / l);
    const i = w.idx(x, y);
    out.push(`${(s + t).toFixed(0)}:${w.terrain(i).toFixed(2)}/${w.water[i]!.toFixed(2)}${sim.isFixed(i) ? 'F' : ''}`);
  }
  s += l;
}
console.log(out.join(' '));
