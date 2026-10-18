/**
 * Player plans: target terrain heights per cell (world.plan, NaN = none),
 * rasterised from polyline tools, and the builders that realise them.
 */
import type { Pt } from '../../shared/protocol';
import { CellFlag, LandUse, SOIL_PROPS, SoilType, type World } from '../world';

/**
 * The part of the world that plan rasterisation needs. World satisfies it;
 * the UI implements it on the main thread for instant previews.
 */
export interface PlanGrid {
  readonly width: number;
  readonly height: number;
  readonly plan: Float32Array;
  idx(x: number, y: number): number;
  terrain(i: number): number;
}

/** Width (cells) of the sloped bank on each side of a trench or dike. */
const BANK = 1.5;

interface PathHit {
  /** Distance from the path (cells). */
  dist: number;
  /** Distance along the path from its start (cells). */
  along: number;
}

/** For every cell within `reach` of the polyline, the nearest path point. */
export function rasterisePath(world: PlanGrid, points: readonly Pt[], reach: number): Map<number, PathHit> {
  const hits = new Map<number, PathHit>();
  if (points.length === 0) return hits;
  const pts = points.length === 1 ? [points[0]!, points[0]!] : points;
  let base = 0;
  for (let s = 0; s + 1 < pts.length; s++) {
    const [ax, ay] = pts[s]!;
    const [bx, by] = pts[s + 1]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const len = Math.sqrt(len2);
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - reach));
    const x1 = Math.min(world.width - 1, Math.ceil(Math.max(ax, bx) + reach));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - reach));
    const y1 = Math.min(world.height - 1, Math.ceil(Math.max(ay, by) + reach));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        // Cell centres are at integer cell coordinates (see render/coords.ts).
        const px = x - ax;
        const py = y - ay;
        const t = len2 > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
        const ex = px - t * dx;
        const ey = py - t * dy;
        const dist = Math.sqrt(ex * ex + ey * ey);
        if (dist > reach) continue;
        const i = world.idx(x, y);
        const prev = hits.get(i);
        if (!prev || dist < prev.dist) hits.set(i, { dist, along: base + t * len });
      }
    }
    base += len;
  }
  return hits;
}

function pathLength(points: readonly Pt[]): number {
  let l = 0;
  for (let s = 0; s + 1 < points.length; s++) {
    l += Math.hypot(points[s + 1]![0] - points[s]![0], points[s + 1]![1] - points[s]![1]);
  }
  return l;
}

function terrainAtPoint(world: PlanGrid, p: Pt): number {
  const x = Math.max(0, Math.min(world.width - 1, Math.round(p[0])));
  const y = Math.max(0, Math.min(world.height - 1, Math.round(p[1])));
  return world.terrain(world.idx(x, y));
}

/** Current planned or actual height of a cell. */
function current(world: PlanGrid, i: number): number {
  const p = world.plan[i]!;
  return Number.isNaN(p) ? world.terrain(i) : p;
}

/**
 * Trench: the floor grades linearly from (terrain at start − depth) to
 * (terrain at end − depth); cells only ever get lower. Returns changed cells.
 */
export function planTrench(world: PlanGrid, points: readonly Pt[], width: number, depth: number): number[] {
  if (points.length === 0) return [];
  const half = width / 2;
  const hits = rasterisePath(world, points, half + BANK);
  const L = Math.max(pathLength(points), 1e-6);
  const f0 = terrainAtPoint(world, points[0]!) - depth;
  const f1 = terrainAtPoint(world, points[points.length - 1]!) - depth;
  const changed: number[] = [];
  for (const [i, h] of hits) {
    const floor = f0 + (f1 - f0) * (h.along / L);
    const ground = world.terrain(i);
    let target = floor;
    if (h.dist > half) target = floor + (ground - floor) * ((h.dist - half) / BANK);
    const cur = current(world, i);
    if (target < cur - 0.01) {
      world.plan[i] = target;
      changed.push(i);
    }
  }
  return changed;
}

/**
 * Dike: level crest at `height` above the lowest ground along the path;
 * cells only ever get higher. Returns changed cells.
 */
export function planDike(world: PlanGrid, points: readonly Pt[], width: number, height: number): number[] {
  if (points.length === 0) return [];
  const half = width / 2;
  const core = rasterisePath(world, points, half);
  let lowest = Infinity;
  for (const i of core.keys()) lowest = Math.min(lowest, world.terrain(i));
  if (!Number.isFinite(lowest)) return [];
  const crest = lowest + height;
  const hits = rasterisePath(world, points, half + BANK);
  const changed: number[] = [];
  for (const [i, h] of hits) {
    const ground = world.terrain(i);
    let target = crest;
    if (h.dist > half) target = crest + (ground - crest) * ((h.dist - half) / BANK);
    const cur = current(world, i);
    if (target > cur + 0.01) {
      world.plan[i] = target;
      changed.push(i);
    }
  }
  return changed;
}

/**
 * Level: flatten the area brushed by the path to the ground height at the
 * start of the stroke (raising or lowering). Returns changed cells.
 */
export function planLevel(world: PlanGrid, points: readonly Pt[], width: number): number[] {
  if (points.length === 0) return [];
  const half = width / 2;
  const level = terrainAtPoint(world, points[0]!);
  const hits = rasterisePath(world, points, half + BANK);
  const changed: number[] = [];
  for (const [i, h] of hits) {
    const ground = world.terrain(i);
    let target = level;
    if (h.dist > half) target = level + (ground - level) * ((h.dist - half) / BANK);
    const cur = current(world, i);
    if (Math.abs(target - cur) > 0.01 && Math.abs(target - ground) > 0.01) {
      world.plan[i] = target;
      changed.push(i);
    }
  }
  return changed;
}

/**
 * A weir's cross-section for a crest `height` m above the ground: a level
 * crest WEIR_CREST cells either side of the line, then sloped faces whose
 * run follows from the height (taller weirs have broader feet), then a
 * strip of stone apron (WEIR_APRON). The whole footprint is lined.
 */
export const WEIR_CREST = 1;
export function weirBank(height: number): number {
  return Math.max(1, Math.min(3, 0.6 + 0.4 * height));
}
/** Width (cells) of the stone apron beyond the faces. */
export const WEIR_APRON = 0.6;

/**
 * Weir along the straight line a→b with its crest at `top` (absolute, m):
 * returns cell → target height for every cell of the crest and faces, the
 * crest's lowest ground and the lined cells. `ground(i)` is the ground before
 * the weir (an edited weir passes the ground it was built on).
 */
export function weirShape(
  world: PlanGrid,
  a: Pt,
  b: Pt,
  top: number,
  ground: (i: number) => number = (i) => world.terrain(i),
): { targets: Map<number, number>; lowest: number; lined: number[] } {
  const line: Pt[] = [a, b];
  let lowest = Infinity;
  for (const i of rasterisePath(world, line, WEIR_CREST).keys()) lowest = Math.min(lowest, ground(i));
  const targets = new Map<number, number>();
  if (!Number.isFinite(lowest)) return { targets, lowest, lined: [] };
  const bank = weirBank(top - lowest);
  const reach = WEIR_CREST + bank + WEIR_APRON;
  const lined: number[] = [];
  for (const [i, h] of rasterisePath(world, line, reach)) {
    lined.push(i);
    if (h.dist > WEIR_CREST + bank) continue;
    const g = ground(i);
    let t = top;
    if (h.dist > WEIR_CREST) t = top + (g - top) * ((h.dist - WEIR_CREST) / bank);
    if (t > g + 0.01) targets.set(i, t);
  }
  return { targets, lowest, lined };
}

/** Preview of a new weir (the UI): raise the plan to the weir's shape, as planDike does. Returns the lined cells. */
export function planWeirPreview(world: PlanGrid, a: Pt, b: Pt, top: number): number[] {
  const { targets, lined } = weirShape(world, a, b, top);
  for (const [i, t] of targets) if (t > current(world, i) + 0.01) world.plan[i] = t;
  return lined;
}

/** Lowest ground under a weir's crest along a→b. */
export function weirLowest(world: PlanGrid, a: Pt, b: Pt): number {
  let lowest = Infinity;
  for (const i of rasterisePath(world, [a, b], WEIR_CREST).keys()) lowest = Math.min(lowest, world.terrain(i));
  return lowest;
}

export function cancelPlans(world: PlanGrid, x: number, y: number, radius: number): number[] {
  const changed: number[] = [];
  const r2 = radius * radius;
  for (let cy = Math.max(0, Math.floor(y - radius)); cy <= Math.min(world.height - 1, Math.ceil(y + radius)); cy++) {
    for (let cx = Math.max(0, Math.floor(x - radius)); cx <= Math.min(world.width - 1, Math.ceil(x + radius)); cx++) {
      const dx = cx - x;
      const dy = cy - y;
      if (dx * dx + dy * dy > r2) continue;
      const i = world.idx(cx, cy);
      if (!Number.isNaN(world.plan[i]!)) {
        world.plan[i] = NaN;
        changed.push(i);
      }
    }
  }
  return changed;
}

/**
 * Earthworks take up what stood on the ground: a field, garden, pasture,
 * path or yard there goes back to plain land (the villagers plant again
 * elsewhere, or here once the work is done). Houses never get plans (the
 * plan tools leave them out, see `keepsPlan`). Returns whether it changed.
 */
export function clearGround(world: World, i: number): boolean {
  const lu = world.landuse[i]!;
  if (lu === LandUse.None || lu === LandUse.Building || lu === LandUse.Bridge) return false;
  world.landuse[i] = LandUse.None;
  world.crop[i] = 0;
  return true;
}

/**
 * Ground the villagers must not farm, graze or build on: a structure's
 * footprint (CellFlag.Structure: weirs, gates, wheels, turbines, pumps,
 * poles), stone lining, a pending plan, or the crest and slopes of an
 * earthen bank (fill standing more than RIDGE m above ground within two
 * cells; a levelled terrace's flat inside stays farmable).
 */
export function takenGround(world: World, i: number): boolean {
  if ((world.flags[i]! & (CellFlag.Structure | CellFlag.Lined)) !== 0 || !Number.isNaN(world.plan[i]!)) return true;
  if ((world.flags[i]! & CellFlag.Fill) === 0) return false;
  const W = world.width;
  const x = i % W;
  const y = (i / W) | 0;
  const z = world.terrain(i) - RIDGE;
  // Within two cells of the bank's edge (a dike's crest is a few cells wide).
  for (let k = 1; k <= 2; k++) {
    if (x - k >= 0 && world.terrain(i - k) < z) return true;
    if (x + k < W && world.terrain(i + k) < z) return true;
    if (y - k >= 0 && world.terrain(i - k * W) < z) return true;
    if (y + k < world.height && world.terrain(i + k * W) < z) return true;
  }
  return false;
}
/** Height (m) above a neighbour that makes a fill cell part of a bank's crest or slope. */
const RIDGE = 0.5;

/** Whether the plan tools may plan cell i: not under a house (or a mill, well, store) or a footbridge. */
export function keepsPlan(landuse: number): boolean {
  return landuse !== LandUse.Building && landuse !== LandUse.Bridge;
}

/**
 * Move a cell's terrain by `amount` metres (negative = dig). Digging removes
 * soil, then bedrock; filling adds compacted clay-ish fill (an earthen bank:
 * CellFlag.Fill). Groundwater above the new capacity is squeezed out to the
 * surface. What grew or stood on the ground is cleared (`clearGround`).
 * Returns the actual change.
 */
export function applyEarthwork(world: World, i: number, amount: number): number {
  if (amount === 0) return 0;
  clearGround(world, i);
  if (amount > 0) {
    world.soil[i]! += amount;
    if (world.soilType[i] === SoilType.Rock && world.soil[i]! >= 0.3) world.soilType[i] = SoilType.Clay;
    world.flags[i]! |= CellFlag.Fill;
    return amount;
  }
  let dig = -amount;
  const s = world.soil[i]!;
  const fromSoil = Math.min(s, dig);
  world.soil[i] = s - fromSoil;
  dig -= fromSoil;
  if (dig > 0) world.bedrock[i]! -= dig;
  if (world.soil[i]! < 0.05) {
    world.soilType[i] = SoilType.Rock;
    world.flags[i]! &= ~CellFlag.Fill;
  }
  // Squeeze out groundwater that no longer fits.
  const cap = world.soil[i]! * SOIL_PROPS[world.soilType[i]!]!.porosity;
  if (world.ground[i]! > cap) {
    world.water[i]! += world.ground[i]! - cap;
    world.ground[i] = cap;
  }
  return amount;
}

/**
 * Stand-in builders ("spirit crew") until NPC builders arrive in M3: work on
 * up to `maxCells` plan cells, in the order plans were placed, moving each by
 * at most `rate` metres. Calls `onChange(i)` for every modified cell.
 */
export class SpiritCrew {
  /** Plan cells in placement order (may contain cells whose plan was since cleared). */
  private queue: number[] = [];

  enqueue(cells: readonly number[]): void {
    for (const c of cells) this.queue.push(c);
  }

  getQueue(): number[] {
    return this.queue.slice();
  }

  setQueue(q: readonly number[]): void {
    this.queue = q.slice();
  }

  /** The queued plan cells, in placement order (may include finished ones). */
  get cells(): readonly number[] {
    return this.queue;
  }

  /**
   * Work on up to `maxCells` cells; cells for which `skip` returns true are
   * left to others (e.g. village builders) but stay queued.
   */
  work(
    world: World,
    rate: number,
    maxCells: number,
    onChange: (i: number, planDone: boolean) => void,
    skip?: (i: number) => boolean,
  ): void {
    let worked = 0;
    let write = 0;
    const q = this.queue;
    const seen = new Set<number>();
    for (let r = 0; r < q.length; r++) {
      const i = q[r]!;
      const target = world.plan[i]!;
      if (Number.isNaN(target) || seen.has(i)) continue; // drop finished/cancelled/duplicate cells
      seen.add(i);
      if (worked < maxCells && !skip?.(i)) {
        worked++;
        const diff = target - world.terrain(i);
        const step = Math.max(-rate, Math.min(rate, diff));
        applyEarthwork(world, i, step);
        const done = Math.abs(diff - step) < 0.01;
        if (done) world.plan[i] = NaN;
        onChange(i, done);
        if (done) continue;
      }
      q[write++] = i;
    }
    q.length = write;
  }

  get pending(): number {
    return this.queue.length;
  }
}
