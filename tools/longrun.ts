/**
 * Long-horizon geomorphology run: is the landscape stationary?
 *
 *   npx tsx tools/longrun.ts [--seed 1] [--size 128] [--years 10] [--out out/longrun]
 *                            [--scale 2] [--set key=value ...] [--snap-every N] [--crop x,y,n]
 *
 * Runs the full simulation (rain, rivers, erosion, talus, weathering) and
 * prints yearly statistics. Writes <tag>-before.png and <tag>-after.png
 * (hillshaded relief with water), <tag>-diff.png (red = raised, blue =
 * lowered, full colour at ±2 m), <tag>-rivers.png (water before only = cyan,
 * after only = orange, both = blue), <tag>-strip.png (all four side by side),
 * with --snap-every N snapshots every N years <tag>-yN.png, and with
 * --crop x,y,n a magnified n×n crop of the four images, <tag>-crop.png.
 * `--set morfac=200` overrides a geomorphology parameter (see GeoParams).
 * `--valley` runs a synthetic sinuous sand valley instead of a generated world.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { CELL, CELL_AREA, DAYS_PER_YEAR, STEPS_PER_DAY } from '../src/sim/constants';
import { Simulation } from '../src/sim/sim';
import { CellFlag, SoilType, World } from '../src/sim/world';
import { generateWorld } from '../src/sim/worldgen/index';

type RGB = [number, number, number];
interface Img {
  w: number;
  h: number;
  data: Uint8Array;
}

function img(w: number, h: number): Img {
  return { w, h, data: new Uint8Array(w * h * 3) };
}

function put(im: Img, x: number, y: number, c: RGB): void {
  const o = (y * im.w + x) * 3;
  im.data[o] = Math.max(0, Math.min(255, c[0]));
  im.data[o + 1] = Math.max(0, Math.min(255, c[1]));
  im.data[o + 2] = Math.max(0, Math.min(255, c[2]));
}

function writePng(path: string, im: Img, scale = 1): void {
  const png = new PNG({ width: im.w * scale, height: im.h * scale });
  for (let y = 0; y < im.h * scale; y++)
    for (let x = 0; x < im.w * scale; x++) {
      const s = (Math.floor(y / scale) * im.w + Math.floor(x / scale)) * 3;
      const o = (y * im.w * scale + x) * 4;
      png.data[o] = im.data[s]!;
      png.data[o + 1] = im.data[s + 1]!;
      png.data[o + 2] = im.data[s + 2]!;
      png.data[o + 3] = 255;
    }
  writeFileSync(path, PNG.sync.write(png));
}

function tile(images: Img[], gap = 4): Img {
  const w = images[0]!.w;
  const h = images[0]!.h;
  const out = img(images.length * w + (images.length - 1) * gap, h);
  out.data.fill(255);
  images.forEach((im, k) => {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const s = (y * w + x) * 3;
        put(out, k * (w + gap) + x, y, [im.data[s]!, im.data[s + 1]!, im.data[s + 2]!]);
      }
  });
  return out;
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function ramp(stops: [number, RGB][], v: number): RGB {
  if (v <= stops[0]![0]) return stops[0]![1];
  for (let k = 1; k < stops.length; k++)
    if (v <= stops[k]![0]) {
      const [a, ca] = stops[k - 1]!;
      const [b, cb] = stops[k]!;
      return mix(ca, cb, (v - a) / (b - a));
    }
  return stops[stops.length - 1]![1];
}

const HYPSO: [number, RGB][] = [
  [0, [92, 140, 70]],
  [0.15, [130, 165, 85]],
  [0.35, [190, 185, 115]],
  [0.55, [170, 135, 90]],
  [0.75, [140, 120, 105]],
  [0.92, [200, 195, 190]],
  [1, [250, 250, 250]],
];

function heights(w: World): Float32Array {
  const z = new Float32Array(w.size);
  for (let i = 0; i < w.size; i++) z[i] = w.bedrock[i]! + w.soil[i]!;
  return z;
}

function shade(z: Float32Array, W: number, H: number, x: number, y: number, exag = 2): number {
  const at = (xx: number, yy: number): number => z[Math.min(H - 1, Math.max(0, yy)) * W + Math.min(W - 1, Math.max(0, xx))]!;
  const dzdx = ((at(x + 1, y) - at(x - 1, y)) / (2 * CELL)) * exag;
  const dzdy = ((at(x, y + 1) - at(x, y - 1)) / (2 * CELL)) * exag;
  const l = Math.hypot(dzdx, dzdy, 1);
  return Math.max(0, (0.5 * dzdx + 0.5 * dzdy + 0.707) / l);
}

/** Hillshaded relief with water; zmin/zmax fixed so before/after compare. */
function relief(w: World, zmin: number, zmax: number): Img {
  const W = w.width;
  const H = w.height;
  const z = heights(w);
  const im = img(W, H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const hs = shade(z, W, H, x, y);
      let c = ramp(HYPSO, (z[i]! - zmin) / Math.max(1, zmax - zmin));
      if (w.soilType[i] === 5) c = mix(c, [120, 160, 110], 0.35); // silt tint
      c = c.map((v) => v * (0.35 + 0.85 * hs)) as RGB;
      const d = w.water[i]!;
      if (d > 0.01) c = mix(c, mix([110, 170, 220], [25, 60, 150], Math.min(1, d / 3)), Math.min(1, 0.55 + d));
      if (w.flags[i]! & CellFlag.Outlet) c = [255, 0, 255];
      if (w.inflow[i]! > 0) c = [255, 30, 30];
      put(im, x, y, c);
    }
  return im;
}

/** Terrain change: red raised, blue lowered, saturating at ±range m, over a faint hillshade. */
/** Channel change: water (> 0.2 m) before only = cyan, after only = orange, both = blue. */
function riversImg(w: World, wet0: Uint8Array): Img {
  const W = w.width;
  const H = w.height;
  const z = heights(w);
  const im = img(W, H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const hs = shade(z, W, H, x, y);
      const a = wet0[i] === 1;
      const b = w.water[i]! > 0.2;
      let c: RGB = [190 + 50 * hs, 190 + 50 * hs, 190 + 50 * hs];
      if (a && b) c = [40, 80, 190];
      else if (a) c = [90, 220, 230];
      else if (b) c = [240, 140, 30];
      put(im, x, y, c);
    }
  return im;
}

function crop(im: Img, x0: number, y0: number, n: number): Img {
  const out = img(n, n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const s = ((y0 + y) * im.w + x0 + x) * 3;
      put(out, x, y, [im.data[s]!, im.data[s + 1]!, im.data[s + 2]!]);
    }
  return out;
}

function diffImg(w: World, z0: Float32Array, range = 2): Img {
  const W = w.width;
  const H = w.height;
  const z = heights(w);
  const im = img(W, H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const hs = shade(z, W, H, x, y);
      const base: RGB = [200 + 40 * hs, 200 + 40 * hs, 200 + 40 * hs];
      const d = z[i]! - z0[i]!;
      const t = Math.min(1, Math.sqrt(Math.abs(d) / range));
      const c = mix(base, d > 0 ? [200, 30, 20] : [20, 60, 210], Math.abs(d) < 0.005 ? 0 : t);
      put(im, x, y, c);
    }
  return im;
}

interface Stats {
  meanZ: number;
  relief: number;
  river: number;
  wet: number;
  meanAbsDz: number;
  maxAbsDz: number;
  spikes: number;
  maxBump: number;
  sediment: number;
}

function stats(w: World, z0: Float32Array, spikeT: number): Stats {
  const W = w.width;
  const H = w.height;
  let sz = 0;
  let zmin = Infinity;
  let zmax = -Infinity;
  let river = 0;
  let wet = 0;
  let sad = 0;
  let mad = 0;
  let sed = 0;
  for (let i = 0; i < w.size; i++) {
    const z = w.bedrock[i]! + w.soil[i]!;
    sz += z;
    zmin = Math.min(zmin, z);
    zmax = Math.max(zmax, z);
    if (w.water[i]! > 0.3) river++;
    if (w.water[i]! > 0.05) wet++;
    const d = Math.abs(z - z0[i]!);
    sad += d;
    mad = Math.max(mad, d);
    sed += w.sediment[i]!;
  }
  // Single-cell spikes/pits: deviation from the mean of the 4 neighbours,
  // compared with the same measure at the start.
  let spikes = 0;
  let maxBump = 0;
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const zt = (j: number): number => w.bedrock[j]! + w.soil[j]!;
      const b = zt(i) - 0.25 * (zt(i - 1) + zt(i + 1) + zt(i - W) + zt(i + W));
      const b0 = z0[i]! - 0.25 * (z0[i - 1]! + z0[i + 1]! + z0[i - W]! + z0[i + W]!);
      const db = Math.abs(b - b0);
      if (db > spikeT) spikes++;
      maxBump = Math.max(maxBump, db);
    }
  return { meanZ: sz / w.size, relief: zmax - zmin, river, wet, meanAbsDz: sad / w.size, maxAbsDz: mad, spikes, maxBump, sediment: sed };
}

/**
 * A synthetic test valley: a gently sloping sandy/loamy floodplain with a
 * sinuous channel, a river entering on the left and leaving on the right.
 */
function valleyWorld(n: number, seed: number): World {
  const w = new World(n, n, seed);
  const centre = (x: number): number => n / 2 + (n / 8) * Math.sin((x * 2 * Math.PI) / (n / 2));
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = w.idx(x, y);
      const d = Math.abs(y - centre(x));
      const floor = 50 + (n - x) * 0.02 + 0.02 * d;
      const z = floor + (d < 3 ? -2.2 * (1 - (d / 3) ** 2) : 0) + Math.max(0, Math.abs(y - n / 2) - n / 4) * 0.4;
      w.soil[i] = 3;
      w.soilType[i] = SoilType.Sand;
      w.bedrock[i] = z - 3;
      w.ground[i] = 0.6;
      if (d < 3) w.water[i] = 1.2;
    }
  for (let y = 0; y < n; y++) {
    if (Math.abs(y - centre(0)) <= 2) w.inflow[w.idx(0, y)] = 1.5;
    if (Math.abs(y - centre(n - 1)) <= 3) w.flags[w.idx(n - 1, y)] |= CellFlag.Outlet;
  }
  return w;
}

function main(): void {
  const args = process.argv.slice(2);
  let seed = 1;
  let size = 128;
  let years = 10;
  let out = 'out/longrun';
  let scale = 2;
  let snapEvery = 0;
  let valley = false;
  let cropAt: number[] | null = null;
  const sets: [string, number][] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (a === '--seed') seed = Number(args[++k]);
    else if (a === '--size') size = Number(args[++k]);
    else if (a === '--years') years = Number(args[++k]);
    else if (a === '--out') out = args[++k]!;
    else if (a === '--scale') scale = Number(args[++k]);
    else if (a === '--snap-every') snapEvery = Number(args[++k]);
    else if (a === '--crop') cropAt = args[++k]!.split(',').map(Number);
    else if (a === '--valley') valley = true;
    else if (a === '--set') {
      const [key, v] = args[++k]!.split('=');
      sets.push([key!, Number(v)]);
    } else throw new Error(`unknown argument ${a}`);
  }
  mkdirSync(out, { recursive: true });
  const tag = valley ? `valley-${size}` : `s${seed}-${size}`;
  const world = valley ? valleyWorld(size, seed) : generateWorld({ seed, size }).world;
  const sim = new Simulation(world, seed);
  for (const [key, v] of sets) (sim.geo as unknown as Record<string, number>)[key] = v;
  const z0 = heights(world);
  let zmin = Infinity;
  let zmax = -Infinity;
  for (const z of z0) {
    zmin = Math.min(zmin, z);
    zmax = Math.max(zmax, z);
  }
  // Spin up the hydrology for a few days so "before" shows flowing rivers.
  sim.run(STEPS_PER_DAY * 3);
  const before = relief(world, zmin, zmax);
  const wet0 = Uint8Array.from(world.water, (h) => (h > 0.2 ? 1 : 0));
  writePng(join(out, `${tag}-before.png`), before, scale);

  const L = sim.sedLedger;
  const prev = { ...L };
  const fmt = (v: number, d = 0): string => v.toFixed(d).padStart(8);
  console.log(`seed ${seed} size ${size} years ${years} ${sets.map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(
    'year     meanZ   relief  river    wet  mean|dz|  max|dz| spikes  maxBump  sedIn/yr sedOut/yr  eroded  deposit    bank   talus   suspended  outflow/d   s',
  );
  const t0 = performance.now();
  const s0 = stats(world, z0, 0.5);
  console.log(
    `${fmt(0)}${fmt(s0.meanZ, 2)}${fmt(s0.relief, 1)}${fmt(s0.river)}${fmt(s0.wet)}${fmt(s0.meanAbsDz, 4)}${fmt(s0.maxAbsDz, 2)}${fmt(s0.spikes)}${fmt(s0.maxBump, 2)}`,
  );
  for (let y = 1; y <= years; y++) {
    sim.run(STEPS_PER_DAY * DAYS_PER_YEAR);
    const s = stats(world, z0, 0.5);
    const d = (k: keyof typeof L): number => L[k] - prev[k];
    console.log(
      `${fmt(y)}${fmt(s.meanZ, 2)}${fmt(s.relief, 1)}${fmt(s.river)}${fmt(s.wet)}${fmt(s.meanAbsDz, 4)}${fmt(s.maxAbsDz, 2)}${fmt(s.spikes)}${fmt(s.maxBump, 2)}` +
        `${fmt(d('inflow'))}  ${fmt(d('outflow'))}${fmt(d('eroded'))}${fmt(d('deposited'))}${fmt(d('bank'))}${fmt(d('talus'))}${fmt(s.sediment, 1)}   ${fmt(sim.outflowLastDay)}${fmt((performance.now() - t0) / 1000)}`,
    );
    Object.assign(prev, L);
    if (snapEvery > 0 && y % snapEvery === 0) writePng(join(out, `${tag}-y${y}.png`), relief(world, zmin, zmax), scale);
  }
  const after = relief(world, zmin, zmax);
  const diff = diffImg(world, z0);
  writePng(join(out, `${tag}-after.png`), after, scale);
  writePng(join(out, `${tag}-diff.png`), diff, scale);
  console.log(`net terrain change ${(sumDz(world, z0) * CELL_AREA).toFixed(0)} m³; ledger`, JSON.stringify(roundAll(L)));
  const rivers = riversImg(world, wet0);
  writePng(join(out, `${tag}-rivers.png`), rivers, scale);
  writePng(join(out, `${tag}-strip.png`), tile([before, after, diff, rivers]), scale);
  if (cropAt) {
    const [cx, cy, cn] = cropAt as [number, number, number];
    const parts = [before, after, diff, rivers].map((im) => crop(im, cx, cy, cn));
    writePng(join(out, `${tag}-crop.png`), tile(parts), Math.max(1, Math.round((3 * 128) / cn)));
  }
}

function sumDz(w: World, z0: Float32Array): number {
  let s = 0;
  for (let i = 0; i < w.size; i++) s += w.bedrock[i]! + w.soil[i]! - z0[i]!;
  return s;
}

function roundAll(o: object): Record<string, number> {
  const r: Record<string, number> = {};
  for (const [k, v] of Object.entries(o)) r[k] = Math.round(v as number);
  return r;
}

main();
