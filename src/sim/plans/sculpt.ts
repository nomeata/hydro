/**
 * Sculpting brushes (DESIGN.md §4): Raise, Dig and Even.
 *
 * Raise and Dig are a *stamp*: a flattened sphere (the cap of an ellipsoid,
 * as wide as the brush, `capHeight` deep) pressed into the ground (Dig) or
 * pushed up from below it (Raise). It first sits where its inner part
 * (under the pointer) would touch the ground as it was before the stroke,
 * and while held it moves on at a
 * steady rate (`BRUSH.rate`): the ground becomes min(ground, stamp's lower
 * surface) for Dig, max(ground, upper surface) for Raise, evaluated with
 * the exact ellipsoid at every cell centre, so the result is a round bowl
 * (or dome) whatever the ground was like. How far it is pressed is rate ×
 * the time the stroke has spent around the spot (each earlier sample
 * counting less the farther it was, nothing beyond a radius: `pressTime`),
 * so a channel's depth goes with the time spent on it, not the stroke's
 * length, and scrubbing back and forth digs deeper. After
 * every step the slopes around the stamp relax to the angle of repose of
 * loose earth (dry, or wet under water), conserving the earth: a deeper
 * dig becomes a widening funnel and a growing mound a sand pile, never a
 * cliff. Slopes that were already steeper before the stroke (a natural
 * bank) keep their steepness; only what the stroke steepened relaxes.
 * Even pulls the ground towards the brush's weighted mean height, so
 * repeated strokes level.
 *
 * The kernel (`brushSample`) is pure and works on a `SculptGrid`, so the
 * sim (on the World) and the client (on its mirror, for instant feedback)
 * compute exactly the same change. The sim applies it in brushwork.ts
 * (soil, loose earth, flags).
 *
 * Cells the brush must leave alone (houses, mills, wells, stores, ruins,
 * jetties, structures and their works in progress) are `fixed`; the stamp's
 * reach fades out over two cells around them, so it never cuts a cliff at
 * a house's wall. Water depth is never touched: raising ground under water
 * lifts the water with it (it then runs off), digging lowers it (water
 * flows in), so the water volume is conserved exactly.
 */
import type { BrushTool, Pt } from '../../shared/protocol';
import { CELL } from '../constants';
import { PARAMS } from '../params';
import { SOIL_PROPS, SoilType } from '../world';

export type { BrushTool };

/** Brush (stamp) radii (cells) of the palette's sizes, small to large: about 20, 30 and 45 m across. */
export const BRUSH_SIZES: readonly number[] = [2, 3, 4.5];
/** Index of the default size. */
export const BRUSH_DEFAULT_SIZE = 1;

/** Loose loam's angle of repose (rise per run), as the sim's talus sees it (hydro/talus.ts). */
const LOOSE = SOIL_PROPS[SoilType.Loam]!.repose * (1 - PARAMS.looseRepose);

export const BRUSH = {
  /** Raise and Dig: how fast the stamp moves on while held (m/s, real time). */
  rate: 1.2,
  /**
   * The stamp's cap height over its radius, in metres per metre. 0.2 looks
   * like a sphere flattened to 0.4 with the map's 2× vertical exaggeration
   * (render/coords.ts VERTICAL_EXAGGERATION).
   */
  flatten: 0.2,
  /** The ground follows the stamp at most this many times its rate (no pop where its flank cuts in at once). */
  follow: 1,
  /** Repose slope (rise per run) the earth around the stamp relaxes to: loose loam, dry... */
  repose: LOOSE,
  /** ...and wet (under water). */
  reposeWet: LOOSE * PARAMS.reposeWet[SoilType.Loam]!,
  /** How far beyond the stamp the slopes may relax in one step (cells). */
  reach: 8,
  /** Relaxation sweeps per step at most, and the excess slope (m) left. */
  passes: 120,
  tolerance: 0.004,
  /** Even: fraction of the way to the mean per second held at the centre is 1 − e^(−evenRate·t). */
  evenRate: 3,
  /** Longest hold one sample may stand for (s): a stalled frame does not dig a pit. */
  maxDt: 0.25,
  /** Fixed cells fade the brush out within this distance (cells). */
  maskReach: 2,
};

/** The stamp's cap height (m) for a brush of radius r cells. */
export function capHeight(r: number): number {
  return r * CELL * BRUSH.flatten;
}

/**
 * How far the stamp's surface stands off its lowest (Dig) or highest
 * (Raise) point at distance d (cells) from the centre: the ellipsoid
 * c·(1 − √(1 − (d/r)²)); c at and beyond the rim.
 */
export function stampOffset(d: number, r: number, c = capHeight(r)): number {
  const u = d / r;
  return u >= 1 ? c : c * (1 - Math.sqrt(1 - u * u));
}

/** What the brush kernel needs to know about the land. */
export interface SculptGrid {
  readonly width: number;
  readonly height: number;
  terrain(i: number): number;
  /** Whether the brush must leave cell i alone. */
  fixed(i: number): boolean;
  /** The ground of cell i before the current stroke (default: as it is). */
  orig?(i: number): number;
  /** Whether cell i is under water (its earth stands at the wet angle of repose); hosts keep the answer for the whole stroke. */
  wet?(i: number): boolean;
}

/** A stroke's stamp: where it was held and how long (flat [x, y, dt, …]). */
export interface Stamp {
  held: number[];
}

export function newStamp(): Stamp {
  return { held: [] };
}

/**
 * The time (s) the stroke has pressed at (x, y): its samples' hold times,
 * each weighted 1 − d/r by its distance d from here (a pass at speed v
 * adds r / v; a held spot adds all of it).
 */
export function pressTime(stamp: Stamp, x: number, y: number, r: number): number {
  const h = stamp.held;
  let t = 0;
  for (let k = 0; k < h.length; k += 3) {
    const d = Math.hypot(h[k]! - x, h[k + 1]! - y);
    if (d < r) t += h[k + 2]! * (1 - d / r);
  }
  return t;
}

/** Even's weight at distance d from the centre of a brush of radius r: a soft dome. */
export function brushWeight(d: number, r: number): number {
  if (d >= r) return 0;
  const u = d / r;
  const v = 1 - u * u;
  return v * v;
}

/** How much the brush may change cell (x, y): 0 on fixed cells, rising to 1 two cells away. */
function maskFactor(g: SculptGrid, x: number, y: number): number {
  const W = g.width;
  if (g.fixed(y * W + x)) return 0;
  const R = BRUSH.maskReach;
  let f = 1;
  for (let dy = -R; dy <= R; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= g.height) continue;
    for (let dx = -R; dx <= R; dx++) {
      const xx = x + dx;
      if ((dx === 0 && dy === 0) || xx < 0 || xx >= W) continue;
      if (!g.fixed(yy * W + xx)) continue;
      const d = Math.hypot(dx, dy);
      if (d > R) continue;
      f = Math.min(f, (d - 0.5) / (R - 0.5));
    }
  }
  return Math.max(0, f);
}

/**
 * One brush sample: the brush of radius `r` (cells) held at (x, y) for `dt`
 * seconds; `stamp` is the stroke's stamp (Raise, Dig), carried from sample
 * to sample. Calls `out(i, dz)` once for every cell it changes (dz in
 * metres, negative = lower). Does not change the grid.
 */
export function brushSample(
  g: SculptGrid,
  tool: BrushTool,
  x: number,
  y: number,
  r: number,
  dt: number,
  stamp: Stamp,
  out: (i: number, dz: number) => void,
): void {
  const t = Math.max(0, Math.min(BRUSH.maxDt, dt));
  if (!(t > 0) || !(r > 0)) return;
  if (tool === 'even') return evenSample(g, x, y, r, t, out);
  const W = g.width;
  const H = g.height;
  const M = BRUSH.reach;
  // The stamp's box (every cell whose square it may overlap), and the region its slopes may relax in.
  const sx0 = Math.max(0, Math.ceil(x - r - 0.5));
  const sx1 = Math.min(W - 1, Math.floor(x + r + 0.5));
  const sy0 = Math.max(0, Math.ceil(y - r - 0.5));
  const sy1 = Math.min(H - 1, Math.floor(y + r + 0.5));
  if (sx1 < sx0 || sy1 < sy0) return;
  const rx0 = Math.max(0, sx0 - M);
  const rx1 = Math.min(W - 1, sx1 + M);
  const ry0 = Math.max(0, sy0 - M);
  const ry1 = Math.min(H - 1, sy1 + M);
  const bw = rx1 - rx0 + 1;
  const bh = ry1 - ry0 + 1;
  const n = bw * bh;
  const z = new Float64Array(n);
  const z0 = new Float64Array(n);
  const fix = new Uint8Array(n);
  const wet = new Uint8Array(n);
  for (let yy = ry0; yy <= ry1; yy++)
    for (let xx = rx0; xx <= rx1; xx++) {
      const i = yy * W + xx;
      const k = (yy - ry0) * bw + (xx - rx0);
      z[k] = g.terrain(i);
      z0[k] = g.orig ? g.orig(i) : z[k]!;
      fix[k] = g.fixed(i) ? 1 : 0;
      wet[k] = g.wet?.(i) ? 1 : 0;
    }
  const start = Float64Array.from(z);

  // Press on: rate × the time held around here.
  const h = stamp.held;
  const last = h.length - 3;
  // (Held still: one sample stands for the time, so a long press stays cheap.)
  if (last >= 0 && h[last] === x && h[last + 1] === y) h[last + 2]! += t;
  else h.push(x, y, t);
  const depth = BRUSH.rate * pressTime(stamp, x, y, r);

  // The stamp: where it first touches the ground as it was before the stroke, pressed on by `depth`.
  // Each cell sees the stamp averaged over its square (SUB × SUB points), so
  // even a shallow press of the small brush is a rounded dimple over several
  // cells rather than one cell sunk.
  const dig = tool === 'dig';
  const c = capHeight(r);
  const cells: number[] = [];
  /** Per cell, the stamp's offsets at its sub-points (SUB² each). */
  const offs: number[] = [];
  const masks: number[] = [];
  // Where it first touches: within the inner part (CONTACT × r) of the
  // stamp, under the pointer, so on a slope it bites where it is held (the
  // outer part may cut into the hillside at once); anywhere, if that is all
  // fixed.
  const eIn = stampOffset(CONTACT * r, r, c);
  let contact = dig ? -Infinity : Infinity;
  let anywhere = contact;
  for (let yy = sy0; yy <= sy1; yy++)
    for (let xx = sx0; xx <= sx1; xx++) {
      const k = (yy - ry0) * bw + (xx - rx0);
      if (fix[k]) continue;
      let inside = false;
      const o = offs.length;
      for (let a = 0; a < SUB; a++)
        for (let b = 0; b < SUB; b++) {
          const d = Math.hypot(xx + (b + 0.5) / SUB - 0.5 - x, yy + (a + 0.5) / SUB - 0.5 - y);
          const e = stampOffset(d, r, c);
          if (d < r) inside = true;
          offs.push(e);
        }
      const m = inside ? maskFactor(g, xx, yy) : 0;
      if (m <= 0) {
        offs.length = o;
        continue;
      }
      for (let q = o; q < o + SUB * SUB; q++) {
        const e = offs[q]!;
        if (e >= c) continue;
        const touch = dig ? z0[k]! - e : z0[k]! + e;
        if (e <= eIn) contact = dig ? Math.max(contact, touch) : Math.min(contact, touch);
        anywhere = dig ? Math.max(anywhere, touch) : Math.min(anywhere, touch);
      }
      cells.push(k);
      masks.push(m);
    }
  if (!Number.isFinite(contact)) contact = anywhere;
  if (!cells.length || !Number.isFinite(contact)) return;
  const level = dig ? contact - depth : contact + depth;
  // Box of the cells changed so far (region coordinates).
  let bx0 = bw;
  let bx1 = -1;
  let by0 = bh;
  let by1 = -1;
  const inv = 1 / (SUB * SUB);
  const step = BRUSH.follow * BRUSH.rate * t;
  for (let q = 0; q < cells.length; q++) {
    const k = cells[q]!;
    const g0 = z0[k]!;
    // The cell's ground before the stroke, less (plus) the stamp's mean bite into its square.
    let bite = 0;
    for (let p = q * SUB * SUB; p < (q + 1) * SUB * SUB; p++) {
      const e = offs[p]!;
      bite += dig ? Math.max(0, g0 - (level + e)) : Math.max(0, level - e - g0);
    }
    // Near fixed cells the stamp bites less deep.
    bite *= inv * masks[q]!;
    // The ground follows the stamp at most `follow` × rate, so where its flank
    // meets ground well above (below) it, nothing pops.
    const target = dig ? Math.max(g0 - bite, z[k]! - step) : Math.min(g0 + bite, z[k]! + step);
    if (dig ? target < z[k]! : target > z[k]!) {
      z[k] = target;
      const kx = k % bw;
      const ky = (k / bw) | 0;
      if (kx < bx0) bx0 = kx;
      if (kx > bx1) bx1 = kx;
      if (ky < by0) by0 = ky;
      if (ky > by1) by1 = ky;
    }
  }
  if (bx1 < 0) return;
  relax(z, z0, fix, wet, bw, bh, bx0, bx1, by0, by1);
  for (let ky = 0; ky < bh; ky++)
    for (let kx = 0; kx < bw; kx++) {
      const k = ky * bw + kx;
      const dz = z[k]! - start[k]!;
      if (Math.abs(dz) > 1e-6) out((ry0 + ky) * W + rx0 + kx, dz);
    }
}

const DIAG = Math.SQRT2;
/** The stamp first touches the ground within this fraction of its radius. */
const CONTACT = 0.3;
/** Sub-points per cell side at which the stamp is sampled. */
const SUB = 4;
const NB_X = [-1, 0, 1, -1, 1, -1, 0, 1];
const NB_Y = [-1, -1, -1, 0, 0, 1, 1, 1];

/**
 * Let the slopes in the region relax to the angle of repose (a pair of
 * neighbours may differ by the repose slope × distance, or by as much as
 * they did before the stroke), starting from the changed box. Jacobi
 * sweeps as in hydro/talus.ts (deltas first, then applied), so the result
 * does not depend on the scan order and the earth is conserved; fixed
 * cells neither give nor receive.
 */
function relax(
  z: Float64Array,
  z0: Float64Array,
  fix: Uint8Array,
  wet: Uint8Array,
  bw: number,
  bh: number,
  bx0: number,
  bx1: number,
  by0: number,
  by1: number,
): void {
  const delta = new Float64Array(z.length);
  const dry = BRUSH.repose * CELL;
  const wetR = BRUSH.reposeWet * CELL;
  const tol = BRUSH.tolerance;
  const ex = new Float64Array(8);
  const nb = new Int32Array(8);
  for (let pass = 0; pass < BRUSH.passes; pass++) {
    // Cells next to the changed box may now be out of repose too.
    const x0 = Math.max(0, bx0 - 1);
    const x1 = Math.min(bw - 1, bx1 + 1);
    const y0 = Math.max(0, by0 - 1);
    const y1 = Math.min(bh - 1, by1 + 1);
    let moved = false;
    for (let ky = y0; ky <= y1; ky++)
      for (let kx = x0; kx <= x1; kx++) {
        const k = ky * bw + kx;
        if (fix[k]) continue;
        const zk = z[k]!;
        let cnt = 0;
        let total = 0;
        let maxEx = 0;
        for (let q = 0; q < 8; q++) {
          const jx = kx + NB_X[q]!;
          const jy = ky + NB_Y[q]!;
          if (jx < 0 || jy < 0 || jx >= bw || jy >= bh) continue;
          const j = jy * bw + jx;
          if (fix[j]) continue;
          const drop = zk - z[j]!;
          if (drop <= tol) continue;
          const dist = q === 0 || q === 2 || q === 5 || q === 7 ? DIAG : 1;
          const allowed = Math.max((wet[k] || wet[j] ? wetR : dry) * dist, z0[k]! - z0[j]!);
          const e = drop - allowed;
          if (e <= tol) continue;
          ex[cnt] = e;
          nb[cnt] = j;
          cnt++;
          total += e;
          if (e > maxEx) maxEx = e;
        }
        if (!cnt) continue;
        // Move part of the largest excess, shared by excess.
        const m = 0.25 * maxEx;
        delta[k]! -= m;
        const inv = m / total;
        for (let q = 0; q < cnt; q++) delta[nb[q]!]! += ex[q]! * inv;
        moved = true;
      }
    if (!moved) break;
    bx0 = bw;
    bx1 = -1;
    by0 = bh;
    by1 = -1;
    for (let ky = Math.max(0, y0 - 1); ky <= Math.min(bh - 1, y1 + 1); ky++)
      for (let kx = Math.max(0, x0 - 1); kx <= Math.min(bw - 1, x1 + 1); kx++) {
        const k = ky * bw + kx;
        const d = delta[k]!;
        if (d === 0) continue;
        delta[k] = 0;
        z[k]! += d;
        if (kx < bx0) bx0 = kx;
        if (kx > bx1) bx1 = kx;
        if (ky < by0) by0 = ky;
        if (ky > by1) by1 = ky;
      }
  }
}

/** Even: pull the ground under the brush towards its weighted mean. */
function evenSample(g: SculptGrid, x: number, y: number, r: number, t: number, out: (i: number, dz: number) => void): void {
  const W = g.width;
  const x0 = Math.max(0, Math.floor(x - r));
  const x1 = Math.min(W - 1, Math.ceil(x + r));
  const y0 = Math.max(0, Math.floor(y - r));
  const y1 = Math.min(g.height - 1, Math.ceil(y + r));
  const cells: number[] = [];
  const weights: number[] = [];
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      // Cell centres are at integer cell coordinates (see render/coords.ts).
      const w = brushWeight(Math.hypot(cx - x, cy - y), r);
      if (w <= 0) continue;
      const m = w * maskFactor(g, cx, cy);
      if (m <= 1e-4) continue;
      cells.push(cy * W + cx);
      weights.push(m);
    }
  }
  if (!cells.length) return;
  let sw = 0;
  let sh = 0;
  for (let k = 0; k < cells.length; k++) {
    sw += weights[k]!;
    sh += weights[k]! * g.terrain(cells[k]!);
  }
  const mean = sh / sw;
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k]!;
    const dz = (mean - g.terrain(i)) * (1 - Math.exp(-BRUSH.evenRate * t * weights[k]!));
    if (Math.abs(dz) > 1e-5) out(i, dz);
  }
}

/**
 * Samples of a stroke along a polyline, as a player would brush it: the
 * brush moves at `speed` cells per second, one sample every `step` seconds
 * (scripted strokes: bots, scenes, tests). Returns flat [x, y, dt, …].
 */
export function strokeSamples(points: readonly Pt[], speed: number, step = 1 / 30): number[] {
  const out: number[] = [];
  if (!points.length) return out;
  if (points.length === 1) {
    out.push(points[0]![0], points[0]![1], step);
    return out;
  }
  const ds = speed * step;
  for (let k = 0; k + 1 < points.length; k++) {
    const a = points[k]!;
    const b = points[k + 1]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(len / ds));
    for (let j = k === 0 ? 0 : 1; j <= n; j++) {
      const u = j / n;
      out.push(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, (len / n / speed) || step);
    }
  }
  return out;
}

/**
 * How far the stamp is pressed in (m) on a steady pass at `speed` cells/s
 * with a brush of radius r: rate × the press time behind the brush as it
 * passes, r / (2 speed) (a quick swipe digs a shallow groove, a slow pass a
 * full round channel; going back over it adds r / speed more).
 */
export function passDepth(r: number, speed: number): number {
  return (BRUSH.rate * r) / (2 * speed);
}
