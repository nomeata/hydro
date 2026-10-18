/**
 * Sculpting brushes (DESIGN.md §4): Raise, Dig and Even. While the pointer
 * is held, the ground under the brush changes continuously and at once:
 * by a rate × hold time, with a soft round falloff. Even pulls the ground
 * towards the brush's weighted mean height, so repeated strokes level.
 *
 * The kernel (`brushSample`) is pure and works on a `SculptGrid`, so the
 * sim (on the World) and the client (on its mirror, for instant feedback)
 * compute exactly the same change. The sim applies it with `applySculpt`
 * (soil, loose earth, flags) and keeps the last strokes for undo.
 *
 * Cells the brush must leave alone (houses, mills, wells, stores, ruins,
 * footbridges, structures and their works in progress) are `fixed`; the
 * brush fades out over two cells around them, so it never cuts a cliff at
 * a house's wall. Water depth is never touched: raising ground under water
 * lifts the water with it (it then runs off), digging lowers it (water
 * flows in), so the water volume is conserved exactly.
 */
import type { BrushTool, Pt } from '../../shared/protocol';

export type { BrushTool };

/** Brush radii (cells) of the palette's sizes, small to large. */
export const BRUSH_SIZES: readonly number[] = [1.5, 2.5, 4];
/** Index of the default size. */
export const BRUSH_DEFAULT_SIZE = 1;

export const BRUSH = {
  /** Raise and Dig: change at the brush centre per second held (m/s, real time). */
  rate: 1.2,
  /** Even: fraction of the way to the mean per second held at the centre is 1 − e^(−evenRate·t). */
  evenRate: 3,
  /** Longest hold one sample may stand for (s): a stalled frame does not dig a pit. */
  maxDt: 0.25,
  /** Fixed cells fade the brush out within this distance (cells). */
  maskReach: 2,
};

/** What the brush kernel needs to know about the land. */
export interface SculptGrid {
  readonly width: number;
  readonly height: number;
  terrain(i: number): number;
  /** Whether the brush must leave cell i alone. */
  fixed(i: number): boolean;
}

/** Brush weight at distance d from the centre of a brush of radius r: a soft dome. */
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
 * seconds. Calls `out(i, dz)` for every cell it changes (dz in metres,
 * negative = lower). Pure: does not change the grid.
 */
export function brushSample(g: SculptGrid, tool: BrushTool, x: number, y: number, r: number, dt: number, out: (i: number, dz: number) => void): void {
  const t = Math.max(0, Math.min(BRUSH.maxDt, dt));
  if (!(t > 0) || !(r > 0)) return;
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
  if (tool === 'even') {
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
    return;
  }
  const s = (tool === 'raise' ? 1 : -1) * BRUSH.rate * t;
  for (let k = 0; k < cells.length; k++) out(cells[k]!, s * weights[k]!);
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
 * How far one pass of a brush of radius r at `speed` cells/s moves the
 * ground on its centre line (m), for Raise and Dig: rate × ∫ weight dt.
 */
export function passDepth(r: number, speed: number): number {
  return (BRUSH.rate * r * 16) / 15 / speed;
}
