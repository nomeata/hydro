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
import { World, CellFlag, SOIL_PROPS } from '../world';
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
  /**
   * The generation climate's rain factor per cell (wetness, orography, rain
   * shadow; ~1 nominal): soils were made with it, the live weather follows it.
   */
  rain: Float32Array;
  /** How the start was chosen (terrace or meadow fallback). */
  start: StartInfo;
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
    result: { world, startX: start.x, startY: start.y, riverScale: macro.riverScale, rain, start },
    debug: { gen, macro, base, carve, soils, inflowCells, timings },
  };
}

/**
 * Terrace start (docs/GAMEPLAY.md §4.3 P2): flat, dry land 2–6 m above the
 * nearest river and 8–20 cells from it, with a fertile, flood-prone
 * floodplain between it and the water. The family settles with dry feet,
 * farms the floodplain and the bank, and the player's first canal or dike
 * has an obvious point. Falls back to the river meadow (`meadowStart`)
 * when no terrace qualifies.
 */
export const TERRACE = {
  minDist: 8,
  maxDist: 20,
  /** Height above the nearest water surface: allowed, and preferred (m). */
  minHeight: 1.5,
  maxHeight: 8,
  goodHeight: [2, 6] as readonly number[],
  /** Floodplain cells: at most this high above the water, at least this fertile, within this radius. */
  plainHeight: 0.9,
  plainFertility: 0.6,
  plainRadius: 16,
  /** Floodplain cells needed, and for a full score. */
  plainMin: 60,
  plainFull: 120,
  /**
   * Land within the first village's field radius (docs/PLAYTEST.md round 4):
   * a dry terrace has some land crops grow on now (`good`, preferred between
   * the two bounds: enough for 15–30 people) and much fertile land that is
   * too dry but lies low enough for the player's water (`dry`, at most
   * `dryHeight` m above the water; a full score from `dryFull` cells).
   */
  fieldRadius: 18,
  good: [170, 230] as readonly number[],
  dryFull: 200,
  dryHeight: 6,
};

export interface StartInfo {
  x: number;
  y: number;
  terrace: boolean;
  /** Height above the nearest water (m), distance to it (cells), floodplain cells. */
  height: number;
  dist: number;
  plain: number;
  /** Good and dry fertile land within the field radius, as worldgen judges it (TERRACE). */
  good?: number;
  dry?: number;
  /** The terrace pass's score (internal). */
  score?: number;
}

/** Distance (cells) to the nearest water and that water's surface height, per cell. */
function nearestWater(world: World, z: Float32Array): { dist: Float32Array; surf: Float32Array } {
  const W = world.width;
  const H = world.height;
  const n = W * H;
  const d = new Float32Array(n);
  const near = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const wet = world.water[i]! > 0.05;
    d[i] = wet ? 0 : 1e9;
    near[i] = wet ? i : -1;
  }
  const relax = (i: number, j: number, c: number): void => {
    if (d[j]! + c < d[i]!) {
      d[i] = d[j]! + c;
      near[i] = near[j]!;
    }
  };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (x > 0) relax(i, i - 1, 1);
      if (y > 0) {
        relax(i, i - W, 1);
        if (x > 0) relax(i, i - W - 1, 1.414);
        if (x < W - 1) relax(i, i - W + 1, 1.414);
      }
    }
  for (let y = H - 1; y >= 0; y--)
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (x < W - 1) relax(i, i + 1, 1);
      if (y < H - 1) {
        relax(i, i + W, 1);
        if (x < W - 1) relax(i, i + W + 1, 1.414);
        if (x > 0) relax(i, i + W - 1, 1.414);
      }
    }
  const surf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = near[i]!;
    surf[i] = j >= 0 ? z[j]! + world.water[j]! : -Infinity;
  }
  return { dist: d, surf };
}

export function chooseStart(world: World, slope: Float32Array, carve: CarveResult): StartInfo {
  const W = world.width;
  const H = world.height;
  const n = W * H;
  const z = new Float32Array(n);
  for (let i = 0; i < n; i++) z[i] = world.terrain(i);
  const { dist, surf } = nearestWater(world, z);
  const moist = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cap = world.soil[i]! * SOIL_PROPS[world.soilType[i]!]!.porosity;
    moist[i] = cap > 0 ? world.ground[i]! / cap : 0;
  }
  const strict = terracePass(world, slope, carve, z, dist, surf, moist, TERRACE);
  // A dry terrace may also be a lower or farther bench (the relaxed pass), if that is drier.
  const relaxed = !strict || !fertileStart(world.seed) ? terracePass(world, slope, carve, z, dist, surf, moist, TERRACE_RELAXED) : null;
  const pick = strict && (!relaxed || strict.score! >= relaxed.score!) ? strict : relaxed;
  if (pick) return pick;
  const m = meadowStart(world, slope, carve, moist, z, dist, surf);
  const i = m.y * W + m.x;
  return { ...m, terrace: false, height: z[i]! - surf[i]!, dist: dist[i]!, plain: 0 };
}

/** A second try when no terrace qualifies: a lower or higher bench, a smaller floodplain. */
export const TERRACE_RELAXED: typeof TERRACE = {
  ...TERRACE,
  minDist: 6,
  maxDist: 26,
  minHeight: 1.5,
  maxHeight: 12,
  plainHeight: 1.2,
  plainMin: 30,
};

/**
 * Field moisture as the villagers judge it (people/village.ts: own saturation
 * × 0.6, or capillary water 0.8·e^(−d/2.5)); crops grow at least half as well
 * (`FARMING.minGrowth`) from 0.34.
 */
const GOOD_MOISTURE = 0.34;

/** Good and dry fertile land within the field radius of (x, y) (see TERRACE). */
function fieldLand(
  world: World,
  slope: Float32Array,
  z: Float32Array,
  dist: Float32Array,
  surf: Float32Array,
  moist: Float32Array,
  x: number,
  y: number,
  T: typeof TERRACE,
): { good: number; dry: number } {
  const W = world.width;
  const H = world.height;
  const R = T.fieldRadius;
  let good = 0;
  let dry = 0;
  for (let yy = Math.max(0, y - R); yy <= Math.min(H - 1, y + R); yy++)
    for (let xx = Math.max(0, x - R); xx <= Math.min(W - 1, x + R); xx++) {
      const r2 = (xx - x) ** 2 + (yy - y) ** 2;
      if (r2 > R * R || r2 < 9) continue;
      const j = yy * W + xx;
      if (world.water[j]! > 0.05 || world.fertility[j]! < 0.5 || slope[j]! > 0.25) continue;
      // On this side of the water (farmers walk; the far bank needs a bridge).
      if (acrossWater(world, x, y, xx, yy)) continue;
      const m = Math.max(0.6 * moist[j]!, 0.8 * Math.exp(-dist[j]! / 2.5));
      if (m >= GOOD_MOISTURE) good++;
      else if (z[j]! - surf[j]! <= T.dryHeight) dry++;
    }
  return { good, dry };
}

/** Whether the straight line from (x0, y0) to (x1, y1) crosses open water. */
function acrossWater(world: World, x0: number, y0: number, x1: number, y1: number): boolean {
  const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)));
  for (let k = 1; k < n; k++) {
    const xx = Math.round(x0 + ((x1 - x0) * k) / n);
    const yy = Math.round(y0 + ((y1 - y0) * k) / n);
    if (world.water[yy * world.width + xx]! > 0.3) return true;
  }
  return false;
}

/**
 * Whether this world keeps the old fertile floodplain start (about one in
 * four): most starts are dry terraces where the player's water matters from
 * the first year (docs/PLAYTEST.md round 4).
 */
export function fertileStart(seed: number): boolean {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) % 4 === 0;
}

function terracePass(
  world: World,
  slope: Float32Array,
  carve: CarveResult,
  z: Float32Array,
  dist: Float32Array,
  surf: Float32Array,
  moist: Float32Array,
  T: typeof TERRACE,
): StartInfo | null {
  const fertile = fertileStart(world.seed);
  const W = world.width;
  const H = world.height;
  const margin = Math.max(16, Math.floor(W / 8));
  const cx = W / 2;
  const cy = H / 2;
  let best = -Infinity;
  let pick: StartInfo | null = null;
  const R = T.plainRadius;
  for (let y = margin; y < H - margin; y += 2)
    for (let x = margin; x < W - margin; x += 2) {
      const i = y * W + x;
      if (world.water[i]! > 0.01) continue;
      const d = dist[i]!;
      if (d < T.minDist || d > T.maxDist) continue;
      // The nearest water is the river (not a pond or a bog).
      if (carve.riverDist[i]! > d + 6) continue;
      const h = z[i]! - surf[i]!;
      if (h < T.minHeight || h > T.maxHeight) continue;
      let s = 0;
      let m = 0;
      let k = 0;
      let wet = 0;
      for (let dy = -4; dy <= 4; dy += 2)
        for (let dx = -4; dx <= 4; dx += 2) {
          const j = (y + dy) * W + x + dx;
          s += slope[j]!;
          m += moist[j]!;
          if (world.water[j]! > 0.01) wet++;
          k++;
        }
      s /= k;
      m /= k;
      if (wet > 0 || s > 0.12) continue;
      // The floodplain between the terrace and the water.
      let plain = 0;
      let fert = 0;
      for (let yy = Math.max(0, y - R); yy <= Math.min(H - 1, y + R); yy++)
        for (let xx = Math.max(0, x - R); xx <= Math.min(W - 1, x + R); xx++) {
          if ((xx - x) ** 2 + (yy - y) ** 2 > R * R) continue;
          const j = yy * W + xx;
          if (world.water[j]! > 0.01 || dist[j]! >= d || z[j]! - surf[j]! > T.plainHeight) continue;
          const f = world.fertility[j]!;
          if (f < T.plainFertility) continue;
          plain++;
          fert += f;
        }
      if (plain < T.plainMin) continue;
      const flat = Math.max(0, 1 - s / 0.12);
      const plainScore = Math.min(1, plain / T.plainFull) * Math.min(1, fert / plain);
      const good = h >= T.goodHeight[0]! && h <= T.goodHeight[1]! ? 1 : 0;
      const centre = Math.hypot(x - cx, y - cy) / (0.5 * W);
      let score = 1.0 * flat - 1.5 * m + 0.5 * good - 0.5 * centre * centre;
      const land = fieldLand(world, slope, z, dist, surf, moist, x, y, T);
      if (fertile) score += 0.8 * plainScore;
      else {
        // A dry terrace: some farmland now, much more once the player brings water.
        const [lo, hi] = T.good as [number, number];
        const under = Math.max(0, (lo - land.good) / lo);
        const over = Math.max(0, (land.good - hi) / hi);
        score += 0.4 * plainScore + 1.2 * Math.min(1, land.dry / T.dryFull) - 3 * under - 2 * over;
      }
      if (score > best) {
        best = score;
        pick = { x, y, terrace: true, height: h, dist: d, plain, good: land.good, dry: land.dry, score };
      }
    }
  return pick;
}

/**
 * Meadow start weights: slope penalty, the extra penalty on slopes above
 * 0.05, and penalties for water farther than `near` cells or more than
 * `height` m below (or above) the site.
 */
export const MEADOW = { slope: 6, steep: 20, near: 14, farPerCell: 0.06, height: 5, highPerMetre: 0.08, riverQ: 0.5 };

/** The old start: the best fertile meadow near the biggest river. */
function meadowStart(
  world: World,
  slope: Float32Array,
  carve: CarveResult,
  moist: Float32Array,
  z: Float32Array,
  wdist: Float32Array,
  surf: Float32Array,
): { x: number; y: number } {
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
      let bog = 0;
      for (let dy = -4; dy <= 4; dy += 2)
        for (let dx = -4; dx <= 4; dx += 2) {
          const j = (y + dy) * W + x + dx;
          s += slope[j]!;
          f += world.fertility[j]!;
          bog += Math.max(0, moist[j]! - 0.6);
          if (world.water[j]! > 0.01) wet++;
          k++;
        }
      s /= k;
      f /= k;
      const d = carve.riverDist[i]!;
      const nearRiver = d < 255 ? Math.max(0, 1 - Math.abs(d - 12) / 18) : 0;
      const big = Math.min(1, carve.chanQ[i]! / 20);
      const centre = Math.hypot(x - cx, y - cy) / (0.5 * W);
      // Steep land far from a real river makes a village that never grows (docs/PLAYTEST.md):
      // flatness and a river with some water in it count for more than fertility.
      const steep = Math.max(0, s - 0.05);
      // ...and so does open water within reach, not far below (or above) the village.
      // (a river with some water in it, not a pond or a closed lake that a big freshet fills)
      const river = carve.chanQ[i]! >= MEADOW.riverQ ? carve.riverDist[i]! : 255;
      const far = Math.max(0, Math.max(wdist[i]!, river) - MEADOW.near) * MEADOW.farPerCell;
      const high = Math.max(0, Math.abs(z[i]! - surf[i]!) - MEADOW.height) * MEADOW.highPerMetre;
      // Not in a bog: the houses want dry feet.
      const score =
        1.2 * f + 1.4 * nearRiver * (0.4 + 0.6 * big) - MEADOW.slope * s - MEADOW.steep * steep - far - high - 0.15 * wet - 0.5 * centre * centre - (3 * bog) / k;
      if (score > best) {
        best = score;
        bx = x;
        by = y;
      }
    }
  return { x: bx, y: by };
}
