/**
 * Dev loop for the playtest bots: a new game for a seed run to `--day`
 * (cached under out/playtest-cache), then each bot's first look at it, the
 * commands issued, and a few more days run, with how the targets responded.
 *
 *   npx tsx tools/playtest/try-bot.ts --seeds 1..4 --day 16 --bots weircanal,dike --after 12 [--size 128] [--ignore-unlocks]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { STEPS_PER_DAY } from '../../src/sim/constants';
import { newGame } from '../../src/sim/newgame';
import { loadGame, saveGame } from '../../src/sim/persist';
import { CellFlag } from '../../src/sim/world';
import { makeBot, weirWhy } from './bots';
import { villages } from './geo';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1]! : d;
};
const seeds = opt('seeds', '1').split(',').flatMap((p) => {
  const m = /^(\d+)\.\.(\d+)$/.exec(p);
  return m ? Array.from({ length: Number(m[2]) - Number(m[1]) + 1 }, (_, k) => Number(m[1]) + k) : [Number(p)];
});
const size = Number(opt('size', '128'));
const day = Number(opt('day', '16'));
const after = Number(opt('after', '12'));
const bots = opt('bots', 'weircanal').split(',');
const ignoreUnlocks = args.includes('--ignore-unlocks');
const budget = args.includes('--budget') ? Number(opt('budget', '0')) : undefined;

async function at(seed: number): Promise<ArrayBuffer> {
  mkdirSync('out/playtest-cache', { recursive: true });
  const f = `out/playtest-cache/s${seed}-${size}-d${day}.bin`;
  if (existsSync(f)) return new Uint8Array(readFileSync(f)).buffer;
  const { sim } = newGame(seed, size);
  sim.run(STEPS_PER_DAY * day);
  const b = await saveGame(sim);
  writeFileSync(f, new Uint8Array(b));
  return b;
}

for (const seed of seeds) {
  const bytes = await at(seed);
  for (const name of bots) {
    const { sim } = await loadGame(bytes.slice(0));
    const bot = makeBot(name, { ignoreUnlocks, budget });
    const t0 = performance.now();
    const acts = bot.check(sim, day);
    const ms = performance.now() - t0;
    const pop0 = villages(sim).reduce((n, v) => n + v.state.population, 0);
    if (!acts.length) {
      console.log(`seed ${seed} ${name}: nothing (${ms.toFixed(0)} ms)${name === 'weircanal' || name === 'good' ? ' ' + JSON.stringify(weirWhy) : ''}`);
      continue;
    }
    const m0 = sim.brush.moved.script;
    for (const a of acts) for (const c of a.commands) sim.command(c);
    const moved = sim.brush.moved.script - m0;
    const targets = [...new Set(acts.flatMap((a) => a.targets))];
    const w = sim.world;
    const pm = sim.people!.fieldMoisture;
    const mBefore = targets.reduce((n, i) => n + pm[i]!, 0) / Math.max(1, targets.length);
    sim.run(STEPS_PER_DAY * after);
    const mAfter = targets.reduce((n, i) => n + pm[i]!, 0) / Math.max(1, targets.length);
    let canal = 0;
    let wet = 0;
    for (let i = 0; i < w.size; i++)
      if (w.flags[i]! & CellFlag.Canal) {
        canal++;
        if (w.water[i]! > 0.05) wet++;
      }
    const pop1 = villages(sim).reduce((n, v) => n + v.state.population, 0);
    for (const a of acts) console.log(`seed ${seed} ${name}: ${a.note}`);
    console.log(
      `  -> ${moved.toFixed(0)} m³ moved (${ms.toFixed(0)} ms); after ${after} d: target moisture ${mBefore.toFixed(2)} → ${mAfter.toFixed(2)} (${targets.length} cells), canal cells ${canal} wet ${wet}, pop ${pop0} → ${pop1}, weirs ${sim.structures.weirs.length}, wheels ${sim.structures.wheels.map((h) => `${h.progress.toFixed(1)}/${h.lifted.toFixed(0)}m³`).join(',')}`,
    );
  }
}
