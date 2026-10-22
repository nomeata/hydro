/**
 * Where a sluice gate can go (docs/DESIGN.md §4): only into a bank the
 * player raised (heaped earth) or a weir, where it parts water (a pond, a
 * canal) from lower ground. Pure, so the sim's placeGate, the tool's ghost
 * and its site marks (ui/tools.ts) agree.
 */
import type { Pt } from '../../shared/protocol';

/** How far across the gate line the site looks, and the passage may cut through a dike (cells). */
export const PASSAGE_REACH = 6;
/** Minimum head a gate must hold (m). */
export const MIN_GATE_HEAD = 0.3;

/** What the gate's site rule needs to see of the world (the sim's World, or the UI's mirror). */
export interface GateGrid {
  readonly width: number;
  readonly height: number;
  /** Ground height (m). */
  terrain(i: number): number;
  /** Water depth (m). */
  depth(i: number): number;
  /** Whether cell i is the body of a raised bank (heaped earth, CellFlag.Fill) or a weir, free of other structures and of plans. */
  wall(i: number): boolean;
  /** Whether cell i is a dug canal (it counts as the water side even when dry). */
  canal?(i: number): boolean;
  /** Known land (fog of war); absent: everywhere. */
  allowed?(i: number): boolean;
}

/** Where a gate tapped at `p` would go (Structures.placeGate's rule; also the tool's ghost and site marks). */
export interface GateSite {
  /** Whether a gate fits: in a bank or weir, water (or a canal) on one side, lower ground on the other. */
  ok: boolean;
  /** Centre cell, unit step along the wall, crest and sill (m). */
  cx: number;
  cy: number;
  dx: number;
  dy: number;
  top: number;
  sill: number;
  /** As StructureInfo: the leaf's centre, direction and width (cells). */
  x: number;
  y: number;
  rot: number;
  width: number;
}

/** Water this deep marks the water side (m). */
const SITE_WET = 0.05;
/** The other side must lie this much below the water (m). */
const SITE_DROP = 0.2;

/** One side of the wall at a site: its lowest ground, and its water level (−∞: dry). */
function gateSide(g: GateGrid, cx: number, cy: number, px: number, py: number): { low: number; level: number } {
  const W = g.width;
  let low = Infinity;
  let level = -Infinity;
  for (let k = 1; k <= PASSAGE_REACH; k++) {
    const x = cx + px * k;
    const y = cy + py * k;
    if (x < 0 || y < 0 || x >= W || y >= g.height) break;
    const i = y * W + x;
    const t = g.terrain(i);
    low = Math.min(low, t);
    const d = g.depth(i);
    if (d > SITE_WET || g.canal?.(i)) level = Math.max(level, t + Math.max(0, d));
  }
  return { low, level };
}

/**
 * The gate site at cell `p` (docs/DESIGN.md §4): the cell must be part of a
 * raised bank or a weir (`wall`); along it runs the gate line (the way the
 * ridge runs), and across it the wall must part water (or a canal) on one
 * side from lower ground (or lower water) on the other. The sill is the
 * higher of the two sides' lowest ground near the gate: the water side's
 * bed, so the gate can let the pond down to it, unless the ground below
 * stands higher. One cell wide. Null off the map.
 */
export function gateSite(g: GateGrid, p: Pt): GateSite | null {
  const W = g.width;
  const H = g.height;
  const cx = Math.round(p[0]);
  const cy = Math.round(p[1]);
  if (cx < 0 || cy < 0 || cx >= W || cy >= H) return null;
  const ci = cy * W + cx;
  const at = (x: number, y: number): number => g.terrain(Math.max(0, Math.min(H - 1, y)) * W + Math.max(0, Math.min(W - 1, x)));
  const ridge = (ux: number, uy: number): number => {
    let s = 0;
    for (const k of [-2, -1, 1, 2]) s += at(cx + ux * k, cy + uy * k);
    return s;
  };
  const top = g.terrain(ci);
  const fits = g.wall(ci) && (!g.allowed || g.allowed(ci));
  const judge = (dx: number, dy: number): GateSite => {
    const a = gateSide(g, cx, cy, -dy, dx);
    const b = gateSide(g, cx, cy, dy, -dx);
    const [up, down] = a.level >= b.level ? [a, b] : [b, a];
    const sill = Number.isFinite(a.low) && Number.isFinite(b.low) ? Math.max(a.low, b.low) : top;
    const below = Math.max(down.low, down.level);
    const ok = fits && Number.isFinite(up.level) && below <= up.level - SITE_DROP && top - sill >= MIN_GATE_HEAD;
    return { ok, cx, cy, dx, dy, top, sill, x: cx, y: cy, rot: dx === 1 ? 0 : Math.PI / 2, width: 1 };
  };
  const along = ridge(1, 0) >= ridge(0, 1);
  const first = along ? judge(1, 0) : judge(0, 1);
  if (first.ok) return first;
  const other = along ? judge(0, 1) : judge(1, 0);
  return other.ok ? other : first;
}

/** All cells where a tapped gate would fit (the tool's marks), at most `max` of them. */
export function gateSites(g: GateGrid, max = 400): GateSite[] {
  const out: GateSite[] = [];
  const W = g.width;
  for (let i = 0; i < W * g.height && out.length < max; i++) {
    if (!g.wall(i)) continue;
    const s = gateSite(g, [i % W, (i / W) | 0]);
    if (s?.ok) out.push(s);
  }
  return out;
}
