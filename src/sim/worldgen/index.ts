/**
 * World generator (M1a). Pipeline:
 *  1. base terrain: pure function of (seed, global cell) — terrain.ts
 *  2. macro river network on a coarse grid over a larger domain — macro.ts
 *  3. carve rivers (channel, banks, floodplain, valley walls) — carve.ts
 *  4. boundary inflows/outlets, drainage guarantee, depressions, initial
 *     surface water — hydrology.ts
 *  5. soils, groundwater, fertility, vegetation — soils.ts
 *  6. a starting focus point near a river on flat fertile land
 */
import { World, CellFlag } from '../world';
import { TerrainGen } from './terrain';
import { buildMacro, sampleMacro, type MacroResult } from './macro';
import { carveRivers, type CarveResult } from './carve';
import { d8Accumulate, depressions, findCrossings, flood, initialWater, perimeter, placeBoundary, settleBasins, slopeField } from './hydrology';
import { computeSoils, type SoilOutputs } from './soils';
import { MinHeap } from './util';

export interface GenOptions {
  seed: number;
  size: number;
  originX?: number;
  originY?: number;
  /**
   * Discharge multiplier for the macro rivers. Leave unset for a new world
   * (it is chosen so the map has a real main river); pass the returned value
   * when regenerating/extending the same world.
   */
  riverScale?: number;
}

export interface GenResult {
  world: World;
  startX: number;
  startY: number;
  /** The discharge multiplier used (see GenOptions.riverScale). */
  riverScale: number;
}

/** Intermediate products, exposed for previews and tests. */
export interface GenDebug {
  gen: TerrainGen;
  macro: MacroResult;
  base: Float32Array;
  carve: CarveResult;
  soils: SoilOutputs;
  inflowCells: number[];
  timings: Record<string, number>;
}

export function generateWorld(opts: GenOptions): GenResult {
  return generateWorldDebug(opts).result;
}

export function generateWorldDebug(opts: GenOptions): { result: GenResult; debug: GenDebug } {
  const now = (): number => (typeof performance !== 'undefined' ? performance.now() : 0);
  const timings: Record<string, number> = {};
  let t0 = now();
  const lap = (name: string): void => {
    const t = now();
    timings[name] = t - t0;
    t0 = t;
  };

  const W = opts.size;
  const H = opts.size;
  const ox = opts.originX ?? 0;
  const oy = opts.originY ?? 0;
  const n = W * H;
  const world = new World(W, H, opts.seed);
  world.originX = ox;
  world.originY = oy;

  const gen = new TerrainGen(opts.seed);
  const base = new Float32Array(n);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) base[y * W + x] = gen.height(ox + x, oy + y, true);
  lap('base');

  const macro = buildMacro(gen, ox, oy, W, H, opts.riverScale);
  lap('macro');

  const carve = carveRivers(base, W, H, ox, oy, macro.paths);
  const z = carve.terrain;
  lap('carve');

  const heap = new MinHeap(4 * W);
  const { crossings, springs } = findCrossings(macro.paths, ox, oy, W, H);
  const outlet = new Uint8Array(n);
  const inflowCells = placeBoundary(z, W, H, crossings, springs, carve.chanU, world.inflow, outlet, heap);
  for (let i = 0; i < n; i++) if (outlet[i]) world.flags[i] = world.flags[i]! | CellFlag.Outlet;
  settleBasins(z, W, H, outlet, carve.chanU, heap);
  const dep = depressions(z, W, H, outlet, heap);
  initialWater(z, W, H, dep, carve.chanU, carve.chanLevel, carve.chanBed, world.water);
  lap('hydrology');

  const slope = slopeField(z, W, H);
  const open = flood(z, W, H, perimeter(W, H), 1e-4, heap);
  const acc = d8Accumulate(open.filled, W, H, open.order, open.count);
  const rain = new Float32Array(n);
  let rsum = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const r = sampleMacro(macro.grid, macro.grid.rain, ox + x, oy + y);
      rain[y * W + x] = r;
      rsum += r;
    }
  const rmean = rsum / n;
  // Relative to a nominal climate of 1, softened towards the map mean.
  for (let i = 0; i < n; i++) rain[i] = 0.5 * (rain[i]! / rmean) + 0.5 * rain[i]!;
  const soils = computeSoils({
    W,
    H,
    originX: ox,
    originY: oy,
    seed: opts.seed,
    z,
    slope,
    water: world.water,
    chanU: carve.chanU,
    chanQ: carve.chanQ,
    riverDist: carve.riverDist,
    plain: carve.plain,
    depDepth: dep.depth,
    acc,
    rain,
  });
  world.soilType.set(soils.soilType);
  world.soil.set(soils.soil);
  for (let i = 0; i < n; i++) world.bedrock[i] = z[i]! - soils.soil[i]!;
  world.ground.set(soils.ground);
  world.fertility.set(soils.fertility);
  world.vegetation.set(soils.vegetation);
  lap('soils');

  const start = chooseStart(world, slope, carve);
  lap('start');

  return {
    result: { world, startX: start.x, startY: start.y, riverScale: macro.riverScale },
    debug: { gen, macro, base, carve, soils, inflowCells, timings },
  };
}

function chooseStart(world: World, slope: Float32Array, carve: CarveResult): { x: number; y: number } {
  const W = world.width;
  const H = world.height;
  const margin = Math.max(16, Math.floor(W / 8));
  const cx = W / 2;
  const cy = H / 2;
  let best = -Infinity;
  let bx = Math.floor(cx);
  let by = Math.floor(cy);
  for (let y = margin; y < H - margin; y += 2)
    for (let x = margin; x < W - margin; x += 2) {
      const i = y * W + x;
      if (world.water[i]! > 0.01) continue;
      // Averages over a small neighbourhood: flat, dry, fertile land.
      let s = 0;
      let f = 0;
      let wet = 0;
      let k = 0;
      for (let dy = -4; dy <= 4; dy += 2)
        for (let dx = -4; dx <= 4; dx += 2) {
          const j = (y + dy) * W + x + dx;
          s += slope[j]!;
          f += world.fertility[j]!;
          if (world.water[j]! > 0.01) wet++;
          k++;
        }
      s /= k;
      f /= k;
      const d = carve.riverDist[i]!;
      const nearRiver = d < 255 ? Math.max(0, 1 - Math.abs(d - 14) / 22) : 0;
      const big = Math.min(1, carve.chanQ[i]! / 20);
      const centre = Math.hypot(x - cx, y - cy) / (0.5 * W);
      const score = 1.2 * f + 1.0 * nearRiver * (0.6 + 0.4 * big) - 6 * s - 0.15 * wet - 0.5 * centre * centre;
      if (score > best) {
        best = score;
        bx = x;
        by = y;
      }
    }
  return { x: bx, y: by };
}
