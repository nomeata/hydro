/**
 * Walking distance from a village (docs/PEOPLE.md §5.2 "Fields by the way
 * there"): a bounded Dijkstra over the same step costs as the people's A*
 * (path.ts: slope, wading, trodden paths, bridges), from the store, once a
 * day. Villages claim fields that are near *by path*, and give up fields
 * that have become unreasonably far to walk to (a river shifted, a
 * footbridge was swept away) unless a footbridge is on its way.
 * Deterministic: recomputed from the world in the daily pass, never saved.
 */
import type { World } from '../world';
import { MinHeap, stepCost } from './path';

export const REACH_RULES = {
  /** Window half-size (cells) around the village centre. */
  radius: 30,
  /**
   * A cell at straight distance d is near enough to claim as a field if
   * walking there costs at most claimRatio·d + claimSlack, and a field is
   * given up once it costs more than leaveRatio·d + leaveSlack (hysteresis).
   */
  claimRatio: 1.45,
  claimSlack: 6,
  leaveRatio: 1.8,
  leaveSlack: 10,
};

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

/** Walking cost from one cell to every cell of a window around it. */
export class WalkMap {
  readonly x0: number;
  readonly y0: number;
  readonly w: number;
  readonly h: number;
  readonly cost: Float32Array;

  constructor(
    private readonly world: World,
    readonly cx: number,
    readonly cy: number,
    radius = REACH_RULES.radius,
    bridge?: (i: number) => boolean,
  ) {
    const W = world.width;
    this.x0 = Math.max(0, cx - radius);
    this.y0 = Math.max(0, cy - radius);
    const x1 = Math.min(W - 1, cx + radius);
    const y1 = Math.min(world.height - 1, cy + radius);
    this.w = x1 - this.x0 + 1;
    this.h = y1 - this.y0 + 1;
    this.cost = new Float32Array(this.w * this.h).fill(Infinity);
    const start = world.idx(cx, cy);
    const open = new MinHeap();
    this.cost[(cy - this.y0) * this.w + (cx - this.x0)] = 0;
    open.push(0, start);
    const done = new Uint8Array(this.w * this.h);
    while (open.size > 0) {
      const cur = open.pop();
      const x = cur % W;
      const y = (cur / W) | 0;
      const li = (y - this.y0) * this.w + (x - this.x0);
      if (done[li]) continue;
      done[li] = 1;
      const g = this.cost[li]!;
      for (const [dx, dy, dist] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < this.x0 || nx > x1 || ny < this.y0 || ny > y1) continue;
        const lj = (ny - this.y0) * this.w + (nx - this.x0);
        if (done[lj]) continue;
        const n = ny * W + nx;
        const c = stepCost(world, cur, n, dist, bridge);
        if (!Number.isFinite(c)) continue;
        const ng = g + c;
        if (ng < this.cost[lj]!) {
          this.cost[lj] = ng;
          open.push(ng, n);
        }
      }
    }
  }

  /** Walking cost to cell i (Infinity when unreachable or outside the window). */
  at(i: number): number {
    const W = this.world.width;
    const x = (i % W) - this.x0;
    const y = ((i / W) | 0) - this.y0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return Infinity;
    return this.cost[y * this.w + x]!;
  }

  /** Straight (octile) distance from the centre to cell i. */
  straight(i: number): number {
    const W = this.world.width;
    return octile(Math.abs((i % W) - this.cx), Math.abs(((i / W) | 0) - this.cy));
  }

  /** Whether cell i is near enough by path to be claimed as a field. */
  claimable(i: number): boolean {
    return this.at(i) <= REACH_RULES.claimRatio * this.straight(i) + REACH_RULES.claimSlack;
  }

  /** Whether a field at cell i has become too far to walk to. */
  tooFar(i: number): boolean {
    return !(this.at(i) <= REACH_RULES.leaveRatio * this.straight(i) + REACH_RULES.leaveSlack);
  }
}

export function octile(dx: number, dy: number): number {
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
}
