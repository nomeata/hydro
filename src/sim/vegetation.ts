/**
 * Living vegetation (docs/PEOPLE.md §3.2, M3-δ): once a game day, every
 * cell's vegetation biomass (`world.vegetation`, 0..1) moves towards what
 * the land there supports. One number stands for both layers:
 *
 *  - **grass** up to `grassCap` (≈ 0.17–0.44, from soil type and moisture).
 *    Bare ground is colonised quickly in the growing season; drought browns
 *    and thins it, but never quite to bare earth.
 *  - **forest** above it, up to `cap` = grass + forest share, where the soil
 *    is moist, not too steep or waterlogged, and inside the slowly varying
 *    forest patches of the world (the same noise worldgen uses, so forests
 *    keep to their stands). Forest only grows where a forested cell is at
 *    hand (the cell itself or a neighbour), so cleared land is won back
 *    slowly from the edges; drought slowly thins it.
 *
 * Growth pauses in the cold and under snow; standing water drowns plants.
 * Now and then a gust throws a few old trees (a deterministic hash per cell
 * and day), so the woods stay alive rather than frozen.
 *
 * Vegetation feeds back on the water: it raises infiltration
 * (hydro/soilwater.ts) and lowers erosion pickup (hydro/erosion.ts).
 *
 * Deterministic (hashes, no RNG state); everything it needs is in the world,
 * so it saves and loads with the `vegetation` field alone.
 */
import { hash2 } from '../shared/rng';
import { CELL } from './constants';
import { PARAMS } from './params';
import { CellFlag, LandUse, SOIL_PROPS, type World } from './world';
import { forestPatchNoise, forestPatchSeed } from './worldgen/soils';
import { smoothstep } from './worldgen/util';

export const VEG = {
  /** Grass share by soil type (rock, gravel, sand, loam, clay, silt, peat). */
  grassSoil: [0.15, 0.55, 0.4, 1, 1, 1, 1],
  /** Forest share by soil type. */
  forestSoil: [0.3, 0.6, 0.3, 1, 1, 1, 0.45],
  /** Forest share at full suitability inside a patch. */
  forestShare: 0.7,
  /** Fraction of the gap to the grass cap closed per growing day. */
  grassRate: 0.12,
  /** Fraction of the gap to the forest cap closed per growing day (with seed trees at hand). */
  forestRate: 0.025,
  /** A cell (or a neighbour) this green counts as forest: it seeds the cells around. */
  seedLevel: 0.55,
  /** Decline per day of the excess over the cap: grass browns quickly, forest thins slowly. */
  grassDecline: 0.05,
  forestDecline: 0.008,
  /** Standing water deeper than this drowns vegetation, at this fraction per day. */
  drownDepth: 0.1,
  drownRate: 0.06,
  /** Temperatures (°C, daily mean) where growth starts and is full. */
  growMin: 3,
  growFull: 14,
  /** Old trees thrown by wind per year (fraction of forest cells), and what is left. */
  gapsPerYear: 0.004,
  gapLevel: 0.3,
  /** Vegetation caps on used land. */
  pathCap: 0.12,
  yardCap: 0.25,
  buildingCap: 0.1,
  linedCap: 0.05,
  /** Forest above this counts as forest cover (statistics, achievements). */
  forestLevel: 0.6,
};

/** Soil saturation 0..1 of cell i. */
export function saturation(w: World, i: number): number {
  const cap = w.soil[i]! * SOIL_PROPS[w.soilType[i]!]!.porosity;
  return cap > 0 ? Math.min(1, w.ground[i]! / cap) : 0;
}

/** Grass the land supports at cell i (soil type, moisture). */
export function grassCap(soilType: number, moisture: number): number {
  return 0.55 * (0.3 + 0.5 * moisture) * VEG.grassSoil[soilType]!;
}

export class Vegetation {
  /** Forest patch noise per cell (derived from the seed, not saved). */
  readonly patch: Float32Array;
  /** Days processed (for the gap hash). */
  private readonly seed: number;

  constructor(private readonly world: World) {
    const w = world;
    this.seed = forestPatchSeed(w.seed);
    this.patch = new Float32Array(w.size);
    for (let y = 0; y < w.height; y++)
      for (let x = 0; x < w.width; x++) this.patch[y * w.width + x] = forestPatchNoise(this.seed, (w.originX + x) * CELL, (w.originY + y) * CELL);
  }

  /** What the land supports at cell i now (grass + forest), given its moisture. */
  capAt(i: number, m: number, slope: number): number {
    const w = this.world;
    const t = w.soilType[i]!;
    const g = grassCap(t, m);
    // As in worldgen: woods favour gentle slopes over open flats (meadows), not cliffs.
    const suit =
      smoothstep(0.18, 0.45, m) *
      (1 - smoothstep(0.5, 0.9, slope)) *
      (0.6 + 0.4 * smoothstep(0.02, 0.1, slope)) *
      VEG.forestSoil[t]! *
      (m > 0.95 ? 0.6 : 1);
    if (suit <= 0) return g;
    const patch = smoothstep(-0.1, 0.15, this.patch[i]! + 0.3 * (m - 0.4));
    return Math.min(1, g + VEG.forestShare * suit * patch);
  }

  /**
   * One game day. `seaLevelTemp` is the day's mean temperature at sea
   * level (°C); `day` the game day (for the wind-gap hash).
   */
  daily(seaLevelTemp: number, day: number): void {
    const w = this.world;
    const W = w.width;
    const H = w.height;
    const { vegetation: veg, water, snow, landuse, flags, bedrock, soil, soilType } = w;
    const gapP = VEG.gapsPerYear / 48;
    const gapSeed = (this.seed ^ Math.imul(day + 1, 0x2545f491)) | 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const lu = landuse[i]!;
        if (lu === LandUse.Field || lu === LandUse.Garden || lu === LandUse.Bridge) continue;
        let v = veg[i]!;
        const d = water[i]!;
        if (d > VEG.drownDepth) {
          if (v > 0) veg[i] = Math.max(0, v - Math.max(0.01, v * VEG.drownRate));
          continue;
        }
        let limit = 1;
        if (lu === LandUse.Path) limit = VEG.pathCap;
        else if (lu === LandUse.Yard) limit = VEG.yardCap;
        else if (lu === LandUse.Building) limit = VEG.buildingCap;
        if ((flags[i]! & CellFlag.Lined) !== 0) limit = Math.min(limit, VEG.linedCap);

        const z = bedrock[i]! + soil[i]!;
        // Steepest drop to a 4-neighbour (rise over run).
        let dz = 0;
        if (x > 0) dz = Math.max(dz, Math.abs(bedrock[i - 1]! + soil[i - 1]! - z));
        if (x < W - 1) dz = Math.max(dz, Math.abs(bedrock[i + 1]! + soil[i + 1]! - z));
        if (y > 0) dz = Math.max(dz, Math.abs(bedrock[i - W]! + soil[i - W]! - z));
        if (y < H - 1) dz = Math.max(dz, Math.abs(bedrock[i + W]! + soil[i + W]! - z));
        const m = saturation(w, i);
        const g = Math.min(limit, grassCap(soilType[i]!, m));
        const cap = Math.min(limit, this.capAt(i, m, dz / CELL));
        const temp = seaLevelTemp - PARAMS.lapseRate * z;
        const grow = snow[i]! > 0.005 ? 0 : smoothstep(VEG.growMin, VEG.growFull, temp);

        if (v < cap && cap > g && grow > 0) {
          // Forest needs seed trees at hand.
          let seedV = v;
          if (seedV < VEG.seedLevel) {
            if (x > 0) seedV = Math.max(seedV, veg[i - 1]!);
            if (x < W - 1) seedV = Math.max(seedV, veg[i + 1]!);
            if (y > 0) seedV = Math.max(seedV, veg[i - W]!);
            if (y < H - 1) seedV = Math.max(seedV, veg[i + W]!);
          }
          if (seedV >= VEG.seedLevel) v += VEG.forestRate * grow * (cap - v);
        }
        if (v < g) {
          v += VEG.grassRate * grow * (g - v);
        } else if (v > cap) {
          const rate = v > g + 0.1 ? VEG.forestDecline : VEG.grassDecline;
          v -= Math.max(rate * (v - cap), Math.min(0.002, v - cap));
          if (v > limit) v = limit;
        }
        // Wind throws an old tree now and then: a clearing that grows back.
        if (v > 0.75 && hash2(x, y, gapSeed) < gapP) v = VEG.gapLevel;
        veg[i] = v;
      }
    }
  }
}

/** Fraction of dry land cells with forest (v ≥ VEG.forestLevel). */
export function forestCover(w: World): number {
  let land = 0;
  let forest = 0;
  for (let i = 0; i < w.size; i++) {
    if (w.water[i]! > 0.05) continue;
    land++;
    if (w.vegetation[i]! >= VEG.forestLevel) forest++;
  }
  return land ? forest / land : 0;
}
