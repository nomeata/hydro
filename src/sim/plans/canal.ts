/**
 * Canal planning (moved here from the playtest bots so the sim's ideas can
 * use it, sim/ideas.ts "help"; tools/playtest/bots.ts): a graded canal from a
 * water level (a weir's pool, a wheel's head, the river) onto dry land,
 * routed like a player would lay it out: along the slope (a contour canal),
 * its water surface falling gently and never above the ground beside it
 * (so it does not spill), cut no deeper than needed, clear of houses, and
 * through as much dry land as it can water. One `shapeLine` dig with
 * absolute floor heights shapes it; `earthOf` gives the earth it moves.
 */
import type { Command, Pt } from '../../shared/protocol';
import { CELL_AREA } from '../constants';
import { isRevealed } from '../fog';
import { CAPILLARY, CROP_MOISTURE } from '../people/village';
import { planDike, planLevel, planTrench, type PlanGrid } from './plans';
import { LandUse, type World } from '../world';

/** What the planner looks at (the Simulation). */
export interface CanalHost {
  readonly world: World;
  readonly fog: boolean;
  isFixed(i: number): boolean;
}

/** Water depth in the canal at its intake (m): the floor lies this far below the source's level. */
export const CANAL_DEPTH = 0.4;
/** Fall of the canal's water surface per cell of length (m). */
export const CANAL_SLOPE = 0.006;
/** The ground beside the canal stands at least this far above its water (m). */
const FREEBOARD = 0.08;
/** Cells within this distance of the canal's water get full crop growth (CROP_MOISTURE.moist at canalReach). */
export const wetReach = (): number => CAPILLARY.canalReach * Math.log(CAPILLARY.max / CROP_MOISTURE.moist);

export interface CanalStart {
  /** Land cell where the canal begins (next to the water, or the wheel's head). */
  cell: number;
  /** Water level the canal starts from (m). */
  level: number;
}

export interface CanalPlan {
  /** Polyline (cell coordinates), and its floor heights at the start and end. */
  points: Pt[];
  floor: [number, number];
  /** Cells along the path. */
  path: number[];
  /** Target cells the canal waters (within wetReach() of its water). */
  covered: number[];
  /** Earth it moves (m³). */
  earth: number;
  /** Route cost (length weighted by cut). */
  cost: number;
  level: number;
}

export interface CanalOptions {
  maxLen?: number;
  maxCut?: number;
  slope?: number;
  /** Cells the canal may not enter (besides water, fixed cells and the houses' margin). */
  blocked?: (i: number) => boolean;
  /** Earth the canal may move at most (m³). */
  maxEarth?: number;
  width?: number;
  /** The village centre: the canal keeps out of the ring its houses grow into (forbidden within `r`/2, dearer within `r`). */
  village?: { x: number; y: number; r: number };
  /** Ends to weigh at most (each costs a coverage count; default 400). */
  ends?: number;
  /** Only look within this box of cells (inclusive; default the whole map): quicker on a big map. */
  box?: Box;
}

/** A box of cells, inclusive. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Each cell of `box` (clipped to the map; the whole map without one). */
function eachIn(w: World, box: Box | undefined, f: (i: number, x: number, y: number) => void): void {
  const x0 = Math.max(0, box?.x0 ?? 0);
  const y0 = Math.max(0, box?.y0 ?? 0);
  const x1 = Math.min(w.width - 1, box?.x1 ?? w.width);
  const y1 = Math.min(w.height - 1, box?.y1 ?? w.height);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) f(y * w.width + x, x, y);
}

/** Cells within `r` of any building or fixed cell (the canal keeps clear of the houses). */
export function houseMargin(sim: CanalHost, r = 2.5, box?: Box): Uint8Array {
  const w = sim.world;
  const out = new Uint8Array(w.size);
  const R = Math.ceil(r);
  eachIn(w, box && grow(box, R), (i, x, y) => {
    const lu = w.landuse[i];
    if (lu !== LandUse.Building && !sim.isFixed(i)) return;
    if (sim.fog && !isRevealed(w, i)) return; // unrevealed land is fixed, but needs no margin
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dy * dy > r * r || !w.inBounds(x + dx, y + dy)) continue;
        out[w.idx(x + dx, y + dy)] = 1;
      }
  });
  return out;
}

const grow = (b: Box, d: number): Box => ({ x0: b.x0 - d, y0: b.y0 - d, x1: b.x1 + d, y1: b.y1 + d });

/**
 * The best canal from `starts` onto `targets` (dry land cells): Dijkstra over
 * the land by route cost, then the end that waters most target cells for
 * its cost. Null if no route waters at least `minCovered` cells.
 */
export function planCanal(sim: CanalHost, starts: CanalStart[], targets: Set<number>, opts: CanalOptions = {}, minCovered = 12): CanalPlan | null {
  const w = sim.world;
  const W = w.width;
  const maxLen = opts.maxLen ?? 90;
  const maxCut = opts.maxCut ?? 2;
  const slope = opts.slope ?? CANAL_SLOPE;
  const box = opts.box;
  const margin = houseMargin(sim, 2.5, box);
  const cost = new Float64Array(w.size).fill(Infinity);
  const len = new Float64Array(w.size);
  const lvl = new Float64Array(w.size);
  const prev = new Int32Array(w.size).fill(-1);
  // A binary heap of [cost, cell].
  const heap: [number, number][] = [];
  const push = (c: number, i: number) => {
    heap.push([c, i]);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heap[p]![0] <= heap[k]![0]) break;
      [heap[p], heap[k]] = [heap[k]!, heap[p]!];
      k = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l;
        if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k]!, heap[m]!];
        k = m;
      }
    }
    return top;
  };
  const inBox = (i: number): boolean => {
    if (!box) return true;
    const x = i % W;
    const y = (i / W) | 0;
    return x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;
  };
  const ok = (i: number): boolean =>
    inBox(i) &&
    !margin[i] && w.water[i]! < 0.05 && !(opts.blocked?.(i) ?? false) && (!sim.fog || isRevealed(w, i));
  // Lowest water surface within 2 cells of each cell: past its first cells the canal keeps
  // away from water lower than its own (it would spill into it, or become the river's bypass).
  const lowWater = new Float32Array(w.size).fill(Infinity);
  eachIn(w, box && grow(box, 2), (i, x, y) => {
    if (w.water[i]! < 0.05) return;
    const sf = w.surface(i);
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        if (!w.inBounds(x + dx, y + dy)) continue;
        const j = w.idx(x + dx, y + dy);
        if (sf < lowWater[j]!) lowWater[j] = sf;
      }
  });
  for (const s of starts) {
    if (!ok(s.cell)) continue;
    const g = w.terrain(s.cell);
    if (g < s.level + FREEBOARD - 0.3) continue;
    const c = 1 + Math.max(0, g - (s.level - CANAL_DEPTH));
    if (c < cost[s.cell]!) {
      cost[s.cell] = c;
      len[s.cell] = 0;
      lvl[s.cell] = s.level;
      prev[s.cell] = -1;
      push(c, s.cell);
    }
  }
  const D8 = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [-1, -1, Math.SQRT2],
  ] as const;
  const reached: number[] = [];
  while (heap.length) {
    const [c, i] = pop();
    if (c > cost[i]!) continue;
    if (targets.has(i)) reached.push(i);
    const x = i % W;
    const y = (i / W) | 0;
    for (const [dx, dy, l] of D8) {
      const nx = x + dx;
      const ny = y + dy;
      if (!w.inBounds(nx, ny)) continue;
      const j = w.idx(nx, ny);
      if (!ok(j)) continue;
      const s = len[i]! + l;
      if (s > maxLen) continue;
      const surface = lvl[i]! - slope * s;
      const g = w.terrain(j);
      if (g < surface + FREEBOARD) continue; // the water would spill here
      if (s > 3 && lowWater[j]! < surface - 0.05) continue; // ...or run off into lower water
      const cut = g - (surface - CANAL_DEPTH);
      if (cut > maxCut) continue;
      // Digging through fields costs the land; a cut costs earth.
      const field = w.landuse[j] === LandUse.Field ? 1.5 : 0;
      let home = 0;
      if (opts.village) {
        const dv = Math.hypot(nx - opts.village.x, ny - opts.village.y);
        if (dv < opts.village.r / 2) continue;
        if (dv < opts.village.r) home = 2;
      }
      const nc = c + l * (1 + cut * 1.2 + field + home);
      if (nc < cost[j]!) {
        cost[j] = nc;
        len[j] = s;
        lvl[j] = lvl[i]!;
        prev[j] = i;
        push(nc, j);
      }
    }
  }
  if (!reached.length) return null;
  // The end that waters most target cells for its cost.
  let best: { end: number; covered: number[]; score: number } | null = null;
  const step = Math.max(1, Math.floor(reached.length / (opts.ends ?? 400)));
  for (let k = 0; k < reached.length; k += step) {
    const end = reached[k]!;
    const path: number[] = [];
    for (let i = end; i >= 0; i = prev[i]!) path.push(i);
    const { covered: cov, lost } = coverage(w, path, targets);
    // The village's own dry fields count most: its farmers work them now (new land waits for hands).
    let worth = 0;
    for (const j of cov) worth += w.landuse[j] === LandUse.Field ? 1 : OPEN_LAND;
    const score = worth - lost - 0.35 * cost[end]!;
    if (cov.size >= minCovered && (!best || score > best.score)) best = { end, covered: [...cov], score };
  }
  if (!best) return null;
  const path: number[] = [];
  for (let i = best.end; i >= 0; i = prev[i]!) path.push(i);
  path.reverse();
  const level = lvl[best.end]!;
  const pts = simplify(path.map((i): Pt => [i % W, (i / W) | 0]), 0.7);
  let L = 0;
  for (let k = 0; k + 1 < pts.length; k++) L += Math.hypot(pts[k + 1]![0] - pts[k]![0], pts[k + 1]![1] - pts[k]![1]);
  const floor: [number, number] = [level - CANAL_DEPTH, level - CANAL_DEPTH - slope * L];
  const plan: CanalPlan = { points: pts, floor, path, covered: best.covered, earth: 0, cost: cost[best.end]!, level };
  plan.earth = earthOf(sim, [canalCommand(plan, opts.width ?? 2)]);
  if (opts.maxEarth !== undefined && plan.earth > opts.maxEarth) {
    // Shorten it until it fits.
    for (let n = path.length - 4; n >= 6; n -= 4) {
      const sub = path.slice(0, n);
      const p2 = simplify(sub.map((i): Pt => [i % W, (i / W) | 0]), 0.7);
      let L2 = 0;
      for (let k = 0; k + 1 < p2.length; k++) L2 += Math.hypot(p2[k + 1]![0] - p2[k]![0], p2[k + 1]![1] - p2[k]![1]);
      const cand: CanalPlan = { ...plan, points: p2, path: sub, floor: [level - CANAL_DEPTH, level - CANAL_DEPTH - slope * L2] };
      cand.earth = earthOf(sim, [canalCommand(cand, opts.width ?? 2)]);
      if (cand.earth <= opts.maxEarth) {
        cand.covered = [...coverage(w, sub, targets).covered];
        return cand.covered.length >= minCovered ? cand : null;
      }
    }
    return null;
  }
  return plan;
}

/**
 * Target cells a canal along `path` waters (within wetReach() of its water,
 * which spreads a cell either side of the path), outside its footprint (the
 * floor and banks it clears, FOOTPRINT cells either side), and the fields
 * that footprint takes.
 */
export function coverage(w: World, path: readonly number[], targets: Set<number>): { covered: Set<number>; lost: number } {
  const W = w.width;
  const reach = wetReach() + 1;
  const R = Math.ceil(reach);
  const near = new Map<number, number>();
  for (const i of path) {
    const x = i % W;
    const y = (i / W) | 0;
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        if (!w.inBounds(x + dx, y + dy)) continue;
        const j = w.idx(x + dx, y + dy);
        const d = Math.hypot(dx, dy);
        if (d < (near.get(j) ?? Infinity)) near.set(j, d);
      }
  }
  const covered = new Set<number>();
  let lost = 0;
  for (const [j, d] of near) {
    if (d <= FOOTPRINT) {
      if (w.landuse[j] === LandUse.Field) lost++;
    } else if (d <= reach && targets.has(j)) covered.add(j);
  }
  return { covered, lost };
}

/** Worth of the cells a canal waters (dry fields 1, open land OPEN_LAND). */
export function worthOf(w: World, cells: Iterable<number>): number {
  let n = 0;
  for (const j of cells) n += w.landuse[j] === LandUse.Field ? 1 : OPEN_LAND;
  return n;
}

/** Worth of watering open land, against a dry field the farmers already work. */
const OPEN_LAND = 0.35;

/** Cells either side of a canal's path that its floor and banks clear (width 2: 1 + bank 1.5). */
const FOOTPRINT = 2;

export function canalCommand(plan: CanalPlan, width = 2): Command {
  return { type: 'shapeLine', tool: 'dig', points: plan.points, width, floor: plan.floor };
}

/** Douglas–Peucker simplification of a cell path (tolerance in cells). */
export function simplify(ps: Pt[], tol: number): Pt[] {
  if (ps.length <= 2) return ps;
  const [a, b] = [ps[0]!, ps[ps.length - 1]!];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  let far = -1;
  let fd = -1;
  for (let k = 1; k < ps.length - 1; k++) {
    const p = ps[k]!;
    const d = Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / l;
    if (d > fd) {
      fd = d;
      far = k;
    }
  }
  if (fd <= tol) return [a, b];
  return [...simplify(ps.slice(0, far + 1), tol).slice(0, -1), ...simplify(ps.slice(far), tol)];
}

/**
 * Earth (m³) a list of shapeLine commands would move, applied in order
 * (the sim's own profiles; fixed cells are left alone, as the sim does).
 */
export function earthOf(sim: CanalHost, cmds: readonly Command[]): number {
  return shapeOf(sim, cmds).moved;
}

/** Cells a list of shapeLine commands would move by more than `min` m (their footprint). */
export function footprintOf(sim: CanalHost, cmds: readonly Command[], min = 0.1): number[] {
  const { z } = shapeOf(sim, cmds);
  const w = sim.world;
  return [...z.keys()].filter((i) => Math.abs(z.get(i)! - w.terrain(i)) > min);
}

/** The terrain a list of shapeLine commands would leave (changed cells only). */
export function shapeAfter(sim: CanalHost, cmds: readonly Command[]): Map<number, number> {
  return shapeOf(sim, cmds).z;
}

function shapeOf(sim: CanalHost, cmds: readonly Command[]): { moved: number; z: Map<number, number> } {
  const w = sim.world;
  const z = new Map<number, number>();
  const terrain = (i: number) => z.get(i) ?? w.terrain(i);
  let moved = 0;
  for (const c of cmds) {
    if (c.type !== 'shapeLine') continue;
    const grid: PlanGrid = { width: w.width, height: w.height, plan: new Float32Array(w.size).fill(NaN), idx: (x, y) => w.idx(x, y), terrain };
    const cells =
      c.tool === 'dig'
        ? planTrench(grid, c.points, c.width, c.amount ?? 1, c.floor)
        : c.tool === 'raise'
          ? planDike(grid, c.points, c.width, c.amount ?? 1)
          : planLevel(grid, c.points, c.width);
    for (const i of cells) {
      if (sim.isFixed(i)) continue;
      const dz = grid.plan[i]! - terrain(i);
      moved += Math.abs(dz) * CELL_AREA;
      z.set(i, grid.plan[i]!);
    }
  }
  return { moved, z };
}
