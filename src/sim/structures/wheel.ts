/**
 * Water wheel / noria (docs/GAMEPLAY.md §1.3): a player tool that lifts
 * river water onto higher ground, driven by the river's own current.
 *
 * Placement is a short stroke from the river onto the bank: the wheel
 * stands in the water cell where the stroke starts, its wooden trough runs
 * along the stroke to the **head cell** (the first dry cell, at most
 * WHEEL_REACH cells away), which may lie up to WHEEL_MAX_LIFT above the
 * river's surface. A tap picks the lowest dry cell next to the water.
 * `wheelSite` is pure, so the tool preview (main thread) and the sim agree.
 *
 * Lift (each step, `wheelLift`): an undershot wheel's power
 * `P = ¼·½ ρ A v³`, A = 5 m × min(depth, 1 m), lifts
 * `Q = gain · P / (ρ g H)` (capped) over the head H; nothing below
 * WHEEL_MIN_SPEED, so a wheel in a pond stands still. The water is moved
 * from the wheel cell to the head cell: mass is conserved, and the ledger
 * books it as `lifted` (an internal transfer).
 */
import { CELL, GRAVITY } from '../constants';
import { PARAMS } from '../params';

/** Highest lift above the river's surface (m). */
export const WHEEL_MAX_LIFT = 5;
/** How far the head cell may be from the wheel (cells, along the stroke). */
export const WHEEL_REACH = 3;
/** Water this deep counts as river for the wheel (m); the head cell must be drier than DRY_HEAD. */
export const WHEEL_MIN_DEPTH = 0.2;
const DRY_HEAD = 0.1;
/** Slowest current that turns a wheel (m/s). */
export const WHEEL_MIN_SPEED = 0.3;
const RHO = 1000;

/** What the site check needs to see of the world (the sim's World or the UI's mirror). */
export interface WheelGrid {
  readonly width: number;
  readonly height: number;
  terrain(i: number): number;
  /** Water depth (m). */
  depth(i: number): number;
  /** Known land (fog of war); absent: everywhere. */
  allowed?(i: number): boolean;
}

export interface WheelSite {
  ok: boolean;
  /** Why not (one friendly line), when !ok. */
  reason?: string;
  /** Wheel and head cells (when found). */
  x: number;
  y: number;
  hx: number;
  hy: number;
  /** Head cell ground above the river's surface (m). */
  lift: number;
}

/** Where a wheel drawn along `points` would stand and lift to (see the module comment). */
export function wheelSite(g: WheelGrid, points: readonly (readonly [number, number])[]): WheelSite | null {
  if (points.length === 0) return null;
  const W = g.width;
  const H = g.height;
  const inb = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H;
  const a = points[0]!;
  const b = points[points.length - 1]!;
  let x = Math.round(a[0]);
  let y = Math.round(a[1]);
  if (!inb(x, y)) return null;
  const fail = (reason: string, hx = x, hy = y, lift = 0): WheelSite => ({ ok: false, reason, x, y, hx, hy, lift });
  // The wheel stands in the water: the start cell, or the deepest water next to it.
  if (g.depth(y * W + x) < WHEEL_MIN_DEPTH) {
    let best = -1;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inb(nx, ny)) continue;
        const d = g.depth(ny * W + nx);
        if (d >= WHEEL_MIN_DEPTH && d > best) {
          best = d;
          x = nx;
          y = ny;
        }
      }
    if (best < 0) return fail('Start in the river: the wheel stands in the water.');
  }
  const wi = y * W + x;
  const surface = g.terrain(wi) + g.depth(wi);
  const dry = (i: number) => g.depth(i) < DRY_HEAD;
  let hx = -1;
  let hy = -1;
  const len = Math.hypot(b[0] - x, b[1] - y);
  if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1.5) {
    // A tap: the lowest dry cell beside the wheel.
    let low = Infinity;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if ((dx === 0 && dy === 0) || !inb(nx, ny)) continue;
        const i = ny * W + nx;
        const t = g.terrain(i);
        if (dry(i) && t >= surface + 0.2 && t < low) {
          low = t;
          hx = nx;
          hy = ny;
        }
      }
  } else {
    // A stroke: the first dry cell along it, at most WHEEL_REACH from the wheel.
    const ux = (b[0] - x) / len;
    const uy = (b[1] - y) / len;
    for (let t = 1; t <= Math.min(len, WHEEL_REACH) + 0.01; t += 0.25) {
      const nx = Math.round(x + ux * t);
      const ny = Math.round(y + uy * t);
      if (!inb(nx, ny) || (nx === x && ny === y)) continue;
      if (Math.max(Math.abs(nx - x), Math.abs(ny - y)) > WHEEL_REACH) break;
      if (dry(ny * W + nx)) {
        hx = nx;
        hy = ny;
        break;
      }
    }
  }
  if (hx < 0) return fail(`Draw from the river onto the bank (at most ${WHEEL_REACH * CELL} m).`);
  const hi = hy * W + hx;
  const lift = g.terrain(hi) - surface;
  if (g.allowed && (!g.allowed(wi) || !g.allowed(hi))) return fail('Only on known land.', hx, hy, lift);
  if (lift > WHEEL_MAX_LIFT) return fail(`Too high: ${lift.toFixed(1)} m above the river (${WHEEL_MAX_LIFT} m at most).`, hx, hy, lift);
  if (lift < 0.2) return fail('That bank is below the river: a trench brings the water by itself.', hx, hy, lift);
  return { ok: true, x, y, hx, hy, lift };
}

/**
 * Water lifted (m³ per hydraulic second) by a wheel in water `depth` deep
 * flowing at `speed`, over a head of `head` metres.
 */
export function wheelLift(speed: number, depth: number, head: number): number {
  if (speed < WHEEL_MIN_SPEED || depth < 0.05) return 0;
  const area = CELL * Math.min(depth, 1);
  const power = 0.25 * 0.5 * RHO * area * speed ** 3;
  return Math.min(PARAMS.wheelMaxFlow, (PARAMS.wheelGain * power) / (RHO * GRAVITY * Math.max(0.5, head)));
}
