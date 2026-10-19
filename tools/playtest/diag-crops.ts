// Scratch: crop stages of a village's fields some days after a bot's works (seed, bot, act after N days from the d16 cache, then run M days).
import { readFileSync } from 'node:fs';
import { STEPS_PER_DAY } from '../../src/sim/constants';
import { loadGame } from '../../src/sim/persist';
import { CellFlag, LandUse } from '../../src/sim/world';
import { makeBot } from './bots';
import { villages } from './geo';
import { CAPILLARY } from '../../src/sim/people/village';
if (process.env.REACH) CAPILLARY.canalReach = Number(process.env.REACH);
const seed = Number(process.argv[2] ?? 3);
const name = process.argv[3] ?? 'weircanal';
const pre = Number(process.argv[4] ?? 24);
const after = Number(process.argv[5] ?? 30);
const { sim } = await loadGame(new Uint8Array(readFileSync(`out/playtest-cache/s${seed}-128-d16.bin`)).buffer);
sim.run(STEPS_PER_DAY * pre);
if (name !== 'baseline') {
  const acts = makeBot(name, { ignoreUnlocks: true }).check(sim, 16 + pre);
  for (const a of acts) for (const c of a.commands) sim.command(c);
  console.log(acts.map((a) => a.note).join('; '));
}
const w = sim.world;
const PP = sim.people as any; const of = PP.flee.bind(PP); let fled = 0; const fleeAt: Record<string, number> = {}; PP.flee = (a: any, t: any) => { fled++; const c = PP.cellOf(a); const k = `${c % sim.world.width},${(c / sim.world.width) | 0} d${sim.world.water[c].toFixed(1)} c${sim.world.flags[c] & 0} sk${a.siteKind}`; fleeAt[k] = (fleeAt[k] ?? 0) + 1; of(a, t); };
for (let d = 0; d < after; d++) {
  sim.run(STEPS_PER_DAY);
  if (d % 4 !== 3) continue;
  const s = villages(sim)[0]!;
  let n = 0, sown = 0, ripe = 0, wet = 0, sum = 0;
  for (let i = 0; i < w.size; i++) {
    if (w.landuse[i] !== LandUse.Field) continue;
    n++;
    const c = w.crop[i]!;
    if (c > 0) { sown++; sum += c; }
    if (c >= 230) ripe++;
    if (w.water[i]! > 0.05) wet++;
  }
  let canalWet = 0;
  for (let i = 0; i < w.size; i++) if (w.flags[i]! & CellFlag.Canal && w.water[i]! > 0.4) canalWet++;
  const t = sim.time;
  const tally: Record<string, number> = {};
  for (const a of (sim.people as any).agents) { const k = `${a.job}:${a.task}:${a.siteKind}${a.flee ? "F" : ""}`; tally[k] = (tally[k] ?? 0) + 1; }
  const P = sim.people as any;
  const fs0 = P.fieldsOf(s);
  let zero = 0, wetf = 0, res = 0, blk = 0;
  for (const i of fs0) { if (w.crop[i] === 0) zero++; if (w.water[i] > 0.15) wetf++; if (P.reserved.has(i)) res++; if (P.blocked.has(i)) blk++; }
  const ft = P.agents.filter((a: any) => a.job === 2).slice(0, 3).map((a: any) => JSON.stringify(P.fieldTask(a, s, sim.time)));
  for (const a of P.agents.filter((a: any) => a.job === 2 && a.task === 3).slice(0, 4)) {
    const t = P.fieldTask(a, s, sim.time);
    const path = t ? P.pf.find(P.cellOf(a), t[0], { window: 48, maxExpand: 4000, bridge: P.onBridge }) : null;
    console.log('resting farmer at', Math.round(a.x), Math.round(a.y), 'water', w.water[P.cellOf(a)].toFixed(2), 'task', t && [t[0] % w.width, (t[0] / w.width) | 0, t[1]], 'path', path ? path.length : null, 'timer', a.timer, 'carry', a.carry, a.load);
  }
  if (process.env.CELL) { const [cx, cy] = process.env.CELL.split(',').map(Number); const rows: string[] = []; for (let y = cy! - 3; y <= cy! + 3; y++) { const r: string[] = []; for (let x = cx! - 4; x <= cx! + 4; x++) { const i = w.idx(x, y); r.push(`${w.water[i]!.toFixed(1)}/${w.landuse[i]}${w.flags[i]! & 8 ? 'C' : ''}`); } rows.push(r.join(' ')); } console.log(rows.join('\n')); }
  console.log('fieldsOf', fs0.length, 'zero', zero, 'wet', wetf, 'reserved', res, 'blocked', blk, 'task', ft.join(' '));
  console.log(JSON.stringify(tally), 'fled', fled, JSON.stringify(Object.entries(fleeAt).sort((p, q) => q[1] - p[1]).slice(0, 6)), 'ditches', JSON.stringify((s.state.ditches ?? []).map((d: any) => `${d.dug}/${d.cells.length}`)));
  console.log(`day ${t.day} s${t.season}.${t.dayOfSeason} pop ${s.state.population} food ${s.state.food.toFixed(0)} fields ${n} sown ${sown} ripe ${ripe} mean stage ${(sum / Math.max(1, sown)).toFixed(0)} wet ${wet} canal>0.4m ${canalWet} blocked ${(sim.people as any).blocked.size}`);
}
