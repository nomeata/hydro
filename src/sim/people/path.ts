/**
 * Grid pathfinding for people: A* over cells with 8-neighbour moves, costs
 * from slope and wading depth, restricted to a window to bound the work.
 * Deterministic: ties are broken by insertion order.
 */
import { LandUse, type World } from '../world';

/** Deepest water people will wade through (m). */
export const MAX_WADE = 0.4;
/** Steepest slope (rise over run, both in metres) people will walk. */
export const MAX_SLOPE = 0.9;
/** Cost factor for stepping onto a trodden path (they are quicker, and people like them). */
export const PATH_COST = 0.8;

export interface PathOptions {
  /** Search window half-size in cells around the midpoint of start/goal. */
  window?: number;
  /** Maximum expanded nodes before giving up. */
  maxExpand?: number;
  /** Extra passability (e.g. bridges): returns true if cell i is walkable regardless of water. */
  bridge?: (i: number) => boolean;
}

/** Cost of entering cell j from cell i (distance dist in cells), or Infinity. */
export function stepCost(world: World, i: number, j: number, dist: number, bridge?: (i: number) => boolean): number {
  const dj = world.water[j]!;
  const onBridge = bridge?.(j) ?? false;
  if (dj > MAX_WADE && !onBridge) return Infinity;
  const rise = Math.abs(world.terrain(j) - world.terrain(i)) / (5 * dist);
  // Stepping on or off a bridge (or jetty) ignores the ground beneath it.
  if (rise > MAX_SLOPE && !onBridge && !(bridge?.(i) ?? false)) return Infinity;
  let c = dist * (1 + 3 * rise * rise);
  if (!onBridge && dj > 0.05) c *= 1 + 6 * dj; // wading is slow
  else if (world.landuse[j] === LandUse.Path) c *= PATH_COST; // people keep to the trodden paths
  return c;
}

export class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  private seq: number[] = [];
  private n = 0;
  private counter = 0;

  get size(): number {
    return this.n;
  }

  push(key: number, val: number): void {
    let i = this.n++;
    const s = this.counter++;
    this.keys[i] = key;
    this.vals[i] = val;
    this.seq[i] = s;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.less(p, i)) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): number {
    const top = this.vals[0]!;
    this.n--;
    if (this.n > 0) {
      this.keys[0] = this.keys[this.n]!;
      this.vals[0] = this.vals[this.n]!;
      this.seq[0] = this.seq[this.n]!;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.n && this.less(l, m)) m = l;
        if (r < this.n && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private less(a: number, b: number): boolean {
    const ka = this.keys[a]!;
    const kb = this.keys[b]!;
    return ka < kb || (ka === kb && this.seq[a]! < this.seq[b]!);
  }

  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b]!, this.keys[a]!];
    [this.vals[a], this.vals[b]] = [this.vals[b]!, this.vals[a]!];
    [this.seq[a], this.seq[b]] = [this.seq[b]!, this.seq[a]!];
  }
}

const DIRS: readonly [number, number, number][] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

/** Reusable scratch for path searches over one world size. */
export class PathFinder {
  private readonly g: Float32Array;
  private readonly from: Int32Array;
  private readonly stamp: Uint32Array;
  private gen = 1;
  /** Nodes expanded by the last search (for budgeting). */
  lastExpanded = 0;

  constructor(private readonly world: World) {
    this.g = new Float32Array(world.size);
    this.from = new Int32Array(world.size);
    this.stamp = new Uint32Array(world.size);
  }

  /**
   * Cell indices from start to goal (inclusive), or null when unreachable
   * within the window/budget.
   */
  find(start: number, goal: number, opts: PathOptions = {}): number[] | null {
    const w = this.world;
    const W = w.width;
    const H = w.height;
    const win = opts.window ?? 48;
    const maxExpand = opts.maxExpand ?? 6000;
    const sx = start % W;
    const sy = (start / W) | 0;
    const gx = goal % W;
    const gy = (goal / W) | 0;
    const cx = (sx + gx) >> 1;
    const cy = (sy + gy) >> 1;
    const half = Math.max(win, (Math.max(Math.abs(sx - gx), Math.abs(sy - gy)) >> 1) + 8);
    const x0 = Math.max(0, cx - half);
    const x1 = Math.min(W - 1, cx + half);
    const y0 = Math.max(0, cy - half);
    const y1 = Math.min(H - 1, cy + half);

    const gen = ++this.gen;
    const { g, from, stamp } = this;
    const h = (x: number, y: number) => {
      const dx = Math.abs(x - gx);
      const dy = Math.abs(y - gy);
      return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
    };
    const open = new MinHeap();
    stamp[start] = gen;
    g[start] = 0;
    from[start] = -1;
    open.push(h(sx, sy), start);
    let expanded = 0;
    const closed = new Set<number>();
    while (open.size > 0) {
      const cur = open.pop();
      if (closed.has(cur)) continue;
      closed.add(cur);
      if (cur === goal) {
        this.lastExpanded = expanded;
        const path: number[] = [];
        for (let c = cur; c !== -1; c = from[c]!) path.push(c);
        return path.reverse();
      }
      if (++expanded > maxExpand) break;
      const x = cur % W;
      const y = (cur / W) | 0;
      for (const [dx, dy, dist] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
        const n = ny * W + nx;
        if (closed.has(n)) continue;
        const c = stepCost(w, cur, n, dist, opts.bridge);
        if (!Number.isFinite(c)) continue;
        const ng = g[cur]! + c;
        if (stamp[n] === gen && g[n]! <= ng) continue;
        stamp[n] = gen;
        g[n] = ng;
        from[n] = cur;
        open.push(ng + h(nx, ny), n);
      }
    }
    this.lastExpanded = expanded;
    return null;
  }
}
