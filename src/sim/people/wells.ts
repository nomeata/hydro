/**
 * Village wells (docs/GAMEPLAY.md §1.1, priority 7): a village far from
 * surface water digs a well where the water table is within reach of a
 * spade. The player's reservoirs and canals raise the table, so a village
 * that could not dig one may suddenly do so: the player's work read back
 * through the villagers. Pure functions over the world; village.ts decides
 * when, the builders dig, and the sim draws the water from `ground`
 * (mass-conserving, booked in the ledger).
 */
import { CellFlag, LandUse, SOIL_PROPS, type World } from '../world';

export const WELL = {
  /** Villages whose centre is at least this far (cells) from surface water want a well. */
  minDist: 8,
  /** Villages smaller than this dig no well. */
  minPeople: 6,
  /** One well per this many people (the first one comes at once), at most `max`. */
  perPeople: 20,
  max: 3,
  /** Deepest water table (m below the ground) villagers can dig to. */
  maxDepth: 4,
  /** Least saturated soil (m of aquifer above bedrock) a new well needs. */
  minAquifer: 0.5,
  /** A well runs dry when the table falls deeper than this, or the aquifer thinner… */
  dryDepth: 6,
  dryAquifer: 0.15,
  /** …and works again once it is back above these. */
  wetDepth: 5.5,
  wetAquifer: 0.3,
  /** Wells are dug within this many cells of the village centre, and this far apart. */
  radius: 7,
  spacing: 6,
  /** Water drawn per person per day (m³), from the cells within `cone` of the well. */
  drawPerPerson: 0.02,
  cone: 2,
  /** Fields within this many cells of a working well are watered from it (a few buckets). */
  garden: 2,
  /** Field moisture they get at least (fully farmable: CROP_MOISTURE.moist). */
  gardenMoisture: 0.42,
  /** Water access: full with a well or this near water, else falling by 1/span per cell to the floor. */
  accessNear: 8,
  accessSpan: 40,
  accessFloor: 0.4,
};

function porosity(w: World, i: number): number {
  return Math.max(0.02, SOIL_PROPS[w.soilType[i]!]!.porosity);
}

/** Saturated thickness of the soil at cell i (m above bedrock). */
export function aquifer(w: World, i: number): number {
  return w.ground[i]! / porosity(w, i);
}

/** Depth of the water table below the ground at cell i (m). */
export function tableDepth(w: World, i: number): number {
  return Math.max(0, w.soil[i]! - aquifer(w, i));
}

/** Whether villagers could dig a new well at cell i (water within reach, and enough of it). */
export function canDig(w: World, i: number): boolean {
  return tableDepth(w, i) <= WELL.maxDepth && aquifer(w, i) >= WELL.minAquifer;
}

/** Whether a well at cell i gives water (with hysteresis: `dry` is its state so far). */
export function wellWorks(w: World, i: number, dry: boolean): boolean {
  const d = tableDepth(w, i);
  const a = aquifer(w, i);
  return dry ? d <= WELL.wetDepth && a >= WELL.wetAquifer : d <= WELL.dryDepth && a >= WELL.dryAquifer;
}

/** Water access of a village (0..1, wellbeing): full with a working well or near water. */
export function waterAccess(dist: number, well: boolean): number {
  if (well || dist < WELL.accessNear) return 1;
  return Math.max(WELL.accessFloor, 1 - (dist - WELL.accessNear) / WELL.accessSpan);
}

/**
 * The best cell for a new well near (cx, cy): dry, flat, open (or yard)
 * ground where the water table is within reach, not too near another well
 * or right against a building; near the centre and with the shallowest
 * table first. `ok(i)` filters cells (ownership). -1 if none.
 */
export function chooseWellSite(
  w: World,
  cx: number,
  cy: number,
  wells: readonly { x: number; y: number }[],
  ok: (i: number) => boolean,
  slope: (i: number) => number,
): number {
  const W = w.width;
  const R = WELL.radius;
  let best = -1;
  let bestScore = -Infinity;
  for (let y = Math.max(2, Math.round(cy - R)); y <= Math.min(w.height - 3, Math.round(cy + R)); y++)
    for (let x = Math.max(2, Math.round(cx - R)); x <= Math.min(W - 3, Math.round(cx + R)); x++) {
      const r = Math.hypot(x - cx, y - cy);
      if (r > R || r < 2) continue;
      const i = y * W + x;
      const lu = w.landuse[i]!;
      if (lu !== LandUse.None && lu !== LandUse.Yard && lu !== LandUse.Path) continue;
      if (w.water[i]! > 0.01 || w.floodMemory[i]! >= 60 || !Number.isNaN(w.plan[i]!) || (w.flags[i]! & CellFlag.Structure) !== 0) continue;
      if (slope(i) >= 0.25 || !canDig(w, i) || !ok(i)) continue;
      if (wells.some((b) => Math.hypot(b.x - x, b.y - y) < WELL.spacing)) continue;
      // Not right against a building (a door, a wall).
      let crowded = false;
      for (let dy = -1; dy <= 1 && !crowded; dy++)
        for (let dx = -1; dx <= 1; dx++) if (w.landuse[i + dy * W + dx] === LandUse.Building) crowded = true;
      if (crowded) continue;
      const score = -r / 2 - tableDepth(w, i) + (lu === LandUse.Yard ? 0.5 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
  return best;
}

/**
 * Draw `m3` of groundwater around a well at cell c (the cells within
 * WELL.cone, each in proportion to what it holds, so the cone deepens
 * gently). Returns the volume actually taken (m³).
 */
export function drawWell(w: World, c: number, m3: number, cellArea: number): number {
  const W = w.width;
  const cx = c % W;
  const cy = (c / W) | 0;
  const R = WELL.cone;
  let total = 0;
  for (let y = Math.max(0, cy - R); y <= Math.min(w.height - 1, cy + R); y++)
    for (let x = Math.max(0, cx - R); x <= Math.min(W - 1, cx + R); x++) total += w.ground[y * W + x]!;
  const want = m3 / cellArea;
  if (total <= 0 || want <= 0) return 0;
  // Never take more than a tenth of what the cone holds in a day.
  const f = Math.min(want, total * 0.1) / total;
  let taken = 0;
  for (let y = Math.max(0, cy - R); y <= Math.min(w.height - 1, cy + R); y++)
    for (let x = Math.max(0, cx - R); x <= Math.min(W - 1, cx + R); x++) {
      const i = y * W + x;
      const t = w.ground[i]! * f;
      w.ground[i]! -= t;
      taken += t;
    }
  return taken * cellArea;
}
