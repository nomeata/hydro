/**
 * Living vegetation over decades: does forest cover stay stationary?
 *
 *   npx tsx tools/vegetation-run.ts [--seed 3] [--size 128] [--years 20] [--fast] [--people]
 *                                   [--out out/vegetation] [--snap-every 5]
 *
 * Prints yearly statistics (forest cover, grass, bare land, mean vegetation)
 * and writes vegetation maps (<tag>-yN.png: water blue, bare tan, grass
 * light green, forest dark green; and a strip of all of them).
 * `--fast` spins the full simulation up for one year and then runs only the
 * daily vegetation step on that frozen hydrology, cycling the seasons
 * (seconds instead of minutes; the stationarity test does the same).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { timeAt, seaLevelTemperature } from '../src/sim/climate/calendar';
import { DAYS_PER_YEAR, STEPS_PER_DAY } from '../src/sim/constants';
import { Simulation } from '../src/sim/sim';
import { VEG, forestCover } from '../src/sim/vegetation';
import type { World } from '../src/sim/world';
import { generateWorld } from '../src/sim/worldgen/index';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1]! : d;
};
const seed = Number(opt('seed', '3'));
const size = Number(opt('size', '128'));
const years = Number(opt('years', '20'));
const fast = args.includes('--fast');
const people = args.includes('--people');
const out = opt('out', 'out/vegetation');
const snapEvery = Number(opt('snap-every', '5'));
const tag = `s${seed}-${size}${fast ? '-fast' : ''}`;
mkdirSync(out, { recursive: true });

function stats(w: World) {
  let land = 0;
  let bare = 0;
  let grass = 0;
  let sum = 0;
  for (let i = 0; i < w.size; i++) {
    if (w.water[i]! > 0.05) continue;
    land++;
    const v = w.vegetation[i]!;
    sum += v;
    if (v < 0.1) bare++;
    else if (v < VEG.forestLevel) grass++;
  }
  return { forest: forestCover(w), grass: grass / land, bare: bare / land, mean: sum / land };
}

function map(w: World): PNG {
  const png = new PNG({ width: w.width, height: w.height });
  for (let i = 0; i < w.size; i++) {
    const v = w.vegetation[i]!;
    let c: [number, number, number];
    if (w.water[i]! > 0.05) c = [70, 130, 200];
    else if (v < 0.1) c = [200, 180, 140];
    else if (v < VEG.forestLevel) c = [Math.round(200 - 200 * v), Math.round(200 - 40 * v), Math.round(110 - 80 * v)];
    else c = [30, Math.round(110 - 50 * (v - 0.6)), 40];
    png.data.set([...c, 255], i * 4);
  }
  return png;
}

const gen = generateWorld({ seed, size });
const sim = new Simulation(gen.world, seed, people ? { people: { startX: gen.startX, startY: gen.startY } } : {});
const w = sim.world;
const snaps: PNG[] = [map(w)];
const fmt = (s: ReturnType<typeof stats>) =>
  `forest ${(100 * s.forest).toFixed(1)}%  grass ${(100 * s.grass).toFixed(1)}%  bare ${(100 * s.bare).toFixed(1)}%  mean ${s.mean.toFixed(3)}`;
console.log(`year 0: ${fmt(stats(w))}`);
const t0 = Date.now();
if (fast) sim.run(DAYS_PER_YEAR * STEPS_PER_DAY);
for (let y = fast ? 1 : 0; y < years; y++) {
  if (fast) {
    for (let d = 0; d < DAYS_PER_YEAR; d++) {
      const day = (y * DAYS_PER_YEAR + d) | 0;
      const t = timeAt(day * STEPS_PER_DAY + STEPS_PER_DAY / 2);
      sim.vegetation.daily(seaLevelTemperature({ ...t, timeOfDay: 0.375 }), day);
    }
  } else sim.run(DAYS_PER_YEAR * STEPS_PER_DAY);
  const s = stats(w);
  console.log(`year ${y + 1}: ${fmt(s)}${people && sim.people ? `  pop ${sim.people.population}` : ''}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  if ((y + 1) % snapEvery === 0) {
    const png = map(w);
    snaps.push(png);
    writeFileSync(join(out, `${tag}-y${y + 1}.png`), PNG.sync.write(png));
  }
}
// Strip of all snapshots side by side.
const gap = 4;
const strip = new PNG({ width: snaps.length * (w.width + gap) - gap, height: w.height });
strip.data.fill(255);
snaps.forEach((p, k) => PNG.bitblt(p, strip, 0, 0, w.width, w.height, k * (w.width + gap), 0));
writeFileSync(join(out, `${tag}-strip.png`), PNG.sync.write(strip));
console.log(`wrote ${join(out, `${tag}-strip.png`)}`);
