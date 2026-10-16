/**
 * Fine-grid hydrology for the generated map: boundary inflows and outlets
 * where macro rivers cross the map edge, extra outlets at low boundary
 * points, a guarantee that every inflow drains to an outlet, closed
 * depressions (lakes/bogs) and flow accumulation for soil moisture.
 */
import { CELL } from '../constants';
import type { RiverPath } from './macro';
import { MinHeap } from './util';

const D4X = [1, 0, -1, 0];
const D4Y = [0, 1, 0, -1];
const D8X = [1, 1, 0, -1, -1, -1, 0, 1];
const D8Y = [0, 1, 1, 1, 0, -1, -1, -1];
const D8L = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2];

export interface Crossing {
  entering: boolean;
  /** Local continuous coordinates of the crossing point. */
  x: number;
  y: number;
  q: number;
  width: number;
}

export interface Spring {
  x: number;
  y: number;
  q: number;
}

function inside(x: number, y: number, W: number, H: number): boolean {
  return x >= -0.5 && y >= -0.5 && x <= W - 0.5 && y <= H - 0.5;
}

/** Distance of a point outside the map rectangle to the rectangle. */
function outsideDist(x: number, y: number, W: number, H: number): number {
  const dx = Math.max(-0.5 - x, 0, x - (W - 0.5));
  const dy = Math.max(-0.5 - y, 0, y - (H - 0.5));
  return Math.hypot(dx, dy);
}

/** Where river centrelines cross the map boundary, and creek heads inside the map. */
export function findCrossings(
  paths: readonly RiverPath[],
  ox: number,
  oy: number,
  W: number,
  H: number,
): { crossings: Crossing[]; springs: Spring[] } {
  const crossings: Crossing[] = [];
  const springs: Spring[] = [];
  for (const p of paths) {
    const m = p.x.length;
    const hx = p.x[0]! - ox;
    const hy = p.y[0]! - oy;
    if (hx > 8 && hy > 8 && hx < W - 9 && hy < H - 9) springs.push({ x: hx, y: hy, q: p.q[0]! });
    const own: (Crossing & { out: number })[] = [];
    let outDepth = 0;
    for (let k = 0; k < m - 1; k++) {
      const ax = p.x[k]! - ox;
      const ay = p.y[k]! - oy;
      const bx = p.x[k + 1]! - ox;
      const by = p.y[k + 1]! - oy;
      const ia = inside(ax, ay, W, H);
      const ib = inside(bx, by, W, H);
      if (ia !== ib) {
        // Bisect for the crossing point.
        let lo = 0;
        let hi = 1;
        for (let it = 0; it < 24; it++) {
          const mid = 0.5 * (lo + hi);
          if (inside(ax + mid * (bx - ax), ay + mid * (by - ay), W, H) === ia) lo = mid;
          else hi = mid;
        }
        const t = 0.5 * (lo + hi);
        own.push({
          entering: !ia,
          x: ax + t * (bx - ax),
          y: ay + t * (by - ay),
          q: p.q[k]! + t * (p.q[k + 1]! - p.q[k]!),
          width: p.width[k]! + t * (p.width[k + 1]! - p.width[k]!),
          out: outDepth,
        });
        outDepth = 0;
      }
      if (!ib) outDepth = Math.max(outDepth, outsideDist(bx, by, W, H));
    }
    // A river grazing the map edge crosses it back and forth. Where it only
    // briefly leaves the map (its channel stays mostly inside), ignore the
    // exit and re-entry so its discharge is not injected twice.
    for (let k = 0; k + 1 < own.length; ) {
      const a = own[k]!;
      const b = own[k + 1]!;
      if (!a.entering && b.entering && b.out < 0.5 * Math.min(a.width, b.width) + 1) own.splice(k, 2);
      else k++;
    }
    for (const c of own) crossings.push({ entering: c.entering, x: c.x, y: c.y, q: c.q, width: c.width });
  }
  return { crossings, springs };
}

/** Boundary cells in perimeter order (clockwise from the top-left corner). */
export function perimeter(W: number, H: number): number[] {
  const out: number[] = [];
  for (let x = 0; x < W; x++) out.push(x);
  for (let y = 1; y < H; y++) out.push(y * W + W - 1);
  for (let x = W - 2; x >= 0; x--) out.push((H - 1) * W + x);
  for (let y = H - 2; y >= 1; y--) out.push(y * W);
  return out;
}

export interface FloodResult {
  filled: Float32Array;
  /** Neighbour towards the seed this cell was reached from (-1 for seeds/unreached). */
  parent: Int32Array;
  /** Cells in pop order. */
  order: Int32Array;
  count: number;
}

/**
 * 4-connected priority flood from the given seed cells. With eps > 0 the
 * filled surface has a tiny gradient towards the seeds.
 */
export function flood(z: Float32Array, W: number, H: number, seeds: ArrayLike<number>, eps: number, heap: MinHeap): FloodResult {
  const n = W * H;
  const filled = new Float32Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const order = new Int32Array(n);
  const done = new Uint8Array(n);
  heap.clear();
  for (let k = 0; k < seeds.length; k++) {
    const c = seeds[k]!;
    if (done[c]) continue;
    done[c] = 1;
    filled[c] = z[c]!;
    heap.push(z[c]!, c);
  }
  let count = 0;
  while (heap.size > 0) {
    const c = heap.pop();
    order[count++] = c;
    const cx = c % W;
    const cy = (c - cx) / W;
    const fc = filled[c]!;
    for (let d = 0; d < 4; d++) {
      const nx = cx + D4X[d]!;
      const ny = cy + D4Y[d]!;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const nb = ny * W + nx;
      if (done[nb]) continue;
      done[nb] = 1;
      parent[nb] = c;
      const f = Math.max(z[nb]!, fc + eps);
      filled[nb] = f;
      heap.push(f, nb);
    }
  }
  return { filled, parent, order, count };
}

export interface BoundaryResult {
  inflowCells: number[];
}

/**
 * Set inflow and outlet cells. Writes flags (via setOutlet) and inflow.
 */
export function placeBoundary(
  z: Float32Array,
  W: number,
  H: number,
  crossings: readonly Crossing[],
  springs: readonly Spring[],
  chanU: Float32Array,
  inflow: Float32Array,
  outlet: Uint8Array,
  heap: MinHeap,
): number[] {
  const n = W * H;
  const per = perimeter(W, H);
  const isInflow = new Uint8Array(n);
  const inflowCells: number[] = [];

  const boundaryNear = (cx: number, cy: number, r: number): number[] => {
    const out: number[] = [];
    for (const c of per) {
      const x = c % W;
      const y = (c - x) / W;
      if (Math.hypot(x - cx, y - cy) <= r) out.push(c);
    }
    return out;
  };

  for (const cr of crossings) {
    if (cr.entering) {
      let cells = boundaryNear(cr.x, cr.y, 0.5 * cr.width + 0.5).filter((c) => chanU[c]! < 1.1);
      if (cells.length === 0) {
        const near = boundaryNear(cr.x, cr.y, cr.width);
        if (near.length === 0) continue;
        near.sort((a, b) => chanU[a]! - chanU[b]! || a - b);
        cells = [near[0]!];
      }
      for (const c of cells) {
        inflow[c] = inflow[c]! + cr.q / cells.length;
        if (!isInflow[c]) {
          isInflow[c] = 1;
          inflowCells.push(c);
        }
      }
    } else {
      for (const c of boundaryNear(cr.x, cr.y, 0.5 * cr.width + 1.5)) outlet[c] = 1;
    }
  }
  // Springs at creek heads inside the map keep small creeks alive.
  for (const s of springs) {
    const c = Math.round(s.y) * W + Math.round(s.x);
    inflow[c] = inflow[c]! + Math.min(1.5 * s.q, 1.2);
    if (!isInflow[c]) {
      isInflow[c] = 1;
      inflowCells.push(c);
    }
  }

  // Exclusion zone around inflow cells on the boundary.
  const noOutlet = new Uint8Array(n);
  for (const c of inflowCells) {
    const x = c % W;
    const y = (c - x) / W;
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -3; dx <= 3; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < W && yy < H) noOutlet[yy * W + xx] = 1;
      }
  }
  for (const c of per) if (noOutlet[c]) outlet[c] = 0;

  // Drainage with an open boundary: boundary cells collecting much flow are outlets.
  const open = flood(z, W, H, per, 1e-4, heap);
  const acc = d8Accumulate(open.filled, W, H, open.order, open.count);
  const OUT_ACC = 150;
  const P = per.length;
  for (let k = 0; k < P; k++) {
    const c = per[k]!;
    if (noOutlet[c]) continue;
    if (acc[c]! >= OUT_ACC) outlet[c] = 1;
    // Local low point along the edge with higher ground inland.
    let low = true;
    for (let d = -2; d <= 2 && low; d++) if (d !== 0 && z[per[(k + d + P) % P]!]! < z[c]!) low = false;
    if (low && inwardHigher(z, W, H, c)) outlet[c] = 1;
  }

  // Remove ponds against the edge: repeatedly open the lowest cell of each
  // run of boundary cells that would be submerged.
  for (let iter = 0; iter < 8; iter++) {
    const seeds: number[] = [];
    for (let c = 0; c < n; c++) if (outlet[c]) seeds.push(c);
    if (seeds.length === 0) {
      let lo = per[0]!;
      for (const c of per) if (!noOutlet[c] && z[c]! < z[lo]!) lo = c;
      outlet[lo] = 1;
      continue;
    }
    const f = flood(z, W, H, seeds, 0, heap);
    let added = 0;
    let runBest = -1;
    const flush = (): void => {
      if (runBest >= 0) {
        outlet[runBest] = 1;
        added++;
      }
      runBest = -1;
    };
    for (let k = 0; k < P; k++) {
      const c = per[k]!;
      if (f.filled[c]! - z[c]! > 0.3 && !noOutlet[c]) {
        if (runBest < 0 || z[c]! < z[runBest]!) runBest = c;
      } else flush();
    }
    flush();
    if (added === 0) break;
  }

  // Every inflow must drain to an outlet without rising above its own bed:
  // lower any obstruction along the flood path.
  const seeds: number[] = [];
  for (let c = 0; c < n; c++) if (outlet[c]) seeds.push(c);
  const f = flood(z, W, H, seeds, 0, heap);
  for (const c of inflowCells) {
    if (f.filled[c]! <= z[c]! + 0.02) continue;
    const lim = z[c]!;
    let p = f.parent[c]!;
    let k = 1;
    while (p >= 0) {
      const cap = lim - 1e-3 * k;
      if (z[p]! > cap) z[p] = cap;
      p = f.parent[p]!;
      k++;
    }
  }
  return inflowCells;
}

function inwardHigher(z: Float32Array, W: number, H: number, c: number): boolean {
  const x = c % W;
  const y = (c - x) / W;
  const ix = x === 0 ? 1 : x === W - 1 ? W - 2 : x;
  const iy = y === 0 ? 1 : y === H - 1 ? H - 2 : y;
  return z[iy * W + ix]! > z[c]!;
}

/** D8 steepest-descent accumulation (cells) on a filled surface, in reverse flood order. */
export function d8Accumulate(filled: Float32Array, W: number, H: number, order: Int32Array, count: number): Float32Array {
  const n = W * H;
  const acc = new Float32Array(n).fill(1);
  const recv = new Int32Array(n).fill(-1);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) continue;
      const c = y * W + x;
      const fc = filled[c]!;
      let best = 0;
      let r = -1;
      for (let d = 0; d < 8; d++) {
        const nb = (y + D8Y[d]!) * W + x + D8X[d]!;
        const s = (fc - filled[nb]!) / D8L[d]!;
        if (s > best) {
          best = s;
          r = nb;
        }
      }
      recv[c] = r;
    }
  for (let k = count - 1; k >= 0; k--) {
    const c = order[k]!;
    const r = recv[c]!;
    if (r >= 0) acc[r] = acc[r]! + acc[c]!;
  }
  return acc;
}

export interface Depressions {
  /** Spill level from outlets minus terrain (m). */
  depth: Float32Array;
  filled: Float32Array;
}

export function depressions(z: Float32Array, W: number, H: number, outlet: Uint8Array, heap: MinHeap): Depressions {
  const seeds: number[] = [];
  for (let c = 0; c < W * H; c++) if (outlet[c]) seeds.push(c);
  const f = flood(z, W, H, seeds, 0, heap);
  const depth = new Float32Array(W * H);
  for (let c = 0; c < W * H; c++) depth[c] = Math.max(0, f.filled[c]! - z[c]!);
  return { depth, filled: f.filled };
}

/**
 * Initial surface water: river channels filled to their water level,
 * depressions on rivers filled to the spill level, and deep closed basins
 * partly filled as lakes.
 */
export function initialWater(
  z: Float32Array,
  W: number,
  H: number,
  dep: Depressions,
  chanU: Float32Array,
  chanLevel: Float32Array,
  chanBed: Float32Array,
  water: Float32Array,
): void {
  const n = W * H;
  const label = new Int32Array(n).fill(-1);
  const stack: number[] = [];
  const comps: { maxDepth: number; channel: boolean; level: number }[] = [];
  for (let s = 0; s < n; s++) {
    if (label[s]! >= 0 || dep.depth[s]! < 0.02) continue;
    const id = comps.length;
    const comp = { maxDepth: 0, channel: false, level: dep.filled[s]! };
    comps.push(comp);
    label[s] = id;
    stack.push(s);
    while (stack.length > 0) {
      const c = stack.pop()!;
      if (dep.depth[c]! > comp.maxDepth) comp.maxDepth = dep.depth[c]!;
      if (chanU[c]! < 1.2) comp.channel = true;
      const cx = c % W;
      const cy = (c - cx) / W;
      for (let d = 0; d < 4; d++) {
        const nx = cx + D4X[d]!;
        const ny = cy + D4Y[d]!;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const nb = ny * W + nx;
        if (label[nb]! >= 0 || dep.depth[nb]! < 0.02) continue;
        label[nb] = id;
        stack.push(nb);
      }
    }
  }
  for (let c = 0; c < n; c++) {
    let w = 0;
    // Channel water up to the river's level, but never deeper than its flow
    // depth (where the river crosses ground below its graded bed, the water
    // follows the ground; closed hollows are filled as lakes below).
    if (chanU[c]! < 1.0) w = Math.min(Math.max(0, chanLevel[c]! - z[c]!), chanLevel[c]! - chanBed[c]!);
    const l = label[c]!;
    if (l >= 0) {
      const comp = comps[l]!;
      let level = -Infinity;
      if (comp.channel) level = comp.level;
      else if (comp.maxDepth > 2) level = comp.level - 0.3 * comp.maxDepth;
      w = Math.max(w, level - z[c]!);
    }
    water[c] = w;
  }
}

/** Slope magnitude (rise/run) by central differences. */
export function slopeField(z: Float32Array, W: number, H: number): Float32Array {
  const s = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const xl = x > 0 ? x - 1 : x;
      const xr = x < W - 1 ? x + 1 : x;
      const yu = y > 0 ? y - 1 : y;
      const yd = y < H - 1 ? y + 1 : y;
      const gx = (z[y * W + xr]! - z[y * W + xl]!) / ((xr - xl) * CELL);
      const gy = (z[yd * W + x]! - z[yu * W + x]!) / ((yd - yu) * CELL);
      s[y * W + x] = Math.hypot(gx, gy);
    }
  return s;
}

/**
 * Closed depressions from noise are far too many and too pitted to look
 * natural. Keep the few largest (by volume) as lakes and give all other
 * depressions away from rivers a flat, sediment-filled floor a little below
 * their spill level (bogs and wet meadows).
 */
export function settleBasins(
  z: Float32Array,
  W: number,
  H: number,
  outlet: Uint8Array,
  chanU: Float32Array,
  heap: MinHeap,
): void {
  const n = W * H;
  const dep = depressions(z, W, H, outlet, heap);
  const label = new Int32Array(n).fill(-1);
  const comps: { cells: number[]; volume: number; maxDepth: number; channel: boolean }[] = [];
  const stack: number[] = [];
  for (let s = 0; s < n; s++) {
    if (label[s]! >= 0 || dep.depth[s]! < 0.01) continue;
    const comp = { cells: [] as number[], volume: 0, maxDepth: 0, channel: false };
    const id = comps.length;
    comps.push(comp);
    label[s] = id;
    stack.push(s);
    while (stack.length > 0) {
      const c = stack.pop()!;
      comp.cells.push(c);
      const d = dep.depth[c]!;
      comp.volume += d;
      if (d > comp.maxDepth) comp.maxDepth = d;
      if (chanU[c]! < 1.5) comp.channel = true;
      const cx = c % W;
      const cy = (c - cx) / W;
      for (let k = 0; k < 4; k++) {
        const nx = cx + D4X[k]!;
        const ny = cy + D4Y[k]!;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const nb = ny * W + nx;
        if (label[nb]! >= 0 || dep.depth[nb]! < 0.01) continue;
        label[nb] = id;
        stack.push(nb);
      }
    }
  }
  const ranked = comps
    .map((c, k) => ({ k, v: c.volume }))
    .filter(({ k }) => !comps[k]!.channel && comps[k]!.maxDepth > 2.5 && comps[k]!.cells.length > 80)
    .sort((a, b) => b.v - a.v || a.k - b.k);
  const maxLakes = Math.max(1, Math.round((3 * n) / 65536));
  const keep = new Set(ranked.slice(0, maxLakes).map((r) => r.k));
  for (let k = 0; k < comps.length; k++) {
    if (keep.has(k)) continue;
    const comp = comps[k]!;
    // River lakes keep a moderate depth; other basins become shallow bogs.
    const keepDepth = comp.channel ? Math.min(comp.maxDepth, 2.5) : Math.min(Math.max(0.2 * comp.maxDepth, 0.15), 0.8);
    for (const c of comp.cells) {
      const floor = dep.filled[c]! - keepDepth;
      if (z[c]! < floor) z[c] = floor;
    }
  }
}
