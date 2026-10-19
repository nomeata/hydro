// Scratch: ASCII map around the first village after a bot's works (seed, bot, days after).
import { readFileSync } from 'node:fs';
import { STEPS_PER_DAY } from '../../src/sim/constants';
import { loadGame } from '../../src/sim/persist';
import { cropGrowth } from '../../src/sim/people/village';
import { CellFlag, LandUse } from '../../src/sim/world';
import { makeBot } from './bots';
import { villages } from './geo';
const seed = Number(process.argv[2] ?? 2);
const name = process.argv[3] ?? 'weircanal';
const after = Number(process.argv[4] ?? 20);
const pre = Number(process.argv[5] ?? 0);
const { sim } = await loadGame(new Uint8Array(readFileSync(`out/playtest-cache/s${seed}-128-d16.bin`)).buffer);
sim.run(STEPS_PER_DAY * pre);
if (name !== 'baseline') {
  const bot = makeBot(name, { ignoreUnlocks: true });
  const acts = bot.check(sim, 16 + pre);
  for (const a of acts) {
    console.log(a.note);
    for (const c of a.commands) sim.command(c);
  }
}
sim.run(STEPS_PER_DAY * after);
const w = sim.world;
const s = villages(sim)[0]!;
const m = sim.people!.fieldMoisture;
const R = 24;
let counts: Record<string, number> = {};
const rows: string[] = [];
for (let y = Math.round(s.state.y) - R; y <= Math.round(s.state.y) + R; y++) {
  let row = '';
  for (let x = Math.round(s.state.x) - R; x <= Math.round(s.state.x) + R; x++) {
    if (!w.inBounds(x, y)) { row += ' '; continue; }
    const i = w.idx(x, y);
    const lu = w.landuse[i];
    let c = '.';
    if (w.flags[i]! & CellFlag.Structure) c = 'W';
    else if (lu === LandUse.Building) c = 'H';
    else if (w.water[i]! > 0.05) c = w.flags[i]! & CellFlag.Canal ? 'C' : w.water[i]! > 0.3 ? '~' : '-';
    else if (lu === LandUse.Field) c = cropGrowth(m[i]!) >= 0.99 ? 'F' : 'f';
    else if (lu === LandUse.Yard) c = 'y';
    else if (w.flags[i]! & CellFlag.Canal) c = 'c';
    else if (lu === LandUse.None && cropGrowth(m[i]!) >= 0.5 && w.vegetation[i]! < 0.6) c = 'g';
    else if (w.vegetation[i]! >= 0.6) c = 't';
    counts[c] = (counts[c] ?? 0) + 1;
    row += c;
  }
  rows.push(row);
}
console.log(rows.join('\n'));
console.log(`day ${sim.time.day} pop ${s.state.population}`, JSON.stringify(counts));
