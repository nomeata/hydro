/**
 * Walkable decks over the water (footbridges and jetties): their shape along
 * the line from one end to the other, in metres. Shared by the structures
 * layer (planks, rails) and the crowd (people walk on the deck, not wade
 * under it). Pure functions, no three.js.
 */
import type { StructureInfo } from '../../shared/protocol';

export interface Deck {
  /** Start cell (cell coordinates) and unit direction along the deck. */
  x: number;
  y: number;
  c: number;
  s: number;
  /** Length from start to the far end cell (cells), and where the planks begin and end along it. */
  len: number;
  u0: number;
  u1: number;
  /** Deck height (m) at either end and at its middle (a footbridge arches a little). */
  eA: number;
  eB: number;
  peak: number;
  /** Half-width across (cells). */
  half: number;
}

/** A footbridge rises this much (m) per cell of length in the middle, over its deck height. */
export const ARCH_PER_CELL = 0.07;

/** The deck of a finished (or partly planked) footbridge or jetty, or null for other structures. */
export function deckOf(st: StructureInfo, terrainAt: (x: number, y: number) => number): Deck | null {
  if (st.x2 === undefined || st.y2 === undefined) return null;
  const len = Math.hypot(st.x2 - st.x, st.y2 - st.y);
  if (len <= 0) return null;
  const c = (st.x2 - st.x) / len;
  const s = (st.y2 - st.y) / len;
  if (st.kind === 'jetty') return { x: st.x, y: st.y, c, s, len, u0: 0.15, u1: len + 0.45, eA: st.top, eB: st.top, peak: st.top, half: 0.42 };
  if (st.kind !== 'bridge') return null;
  const eA = terrainAt(st.x, st.y) + 0.06;
  const eB = terrainAt(st.x2, st.y2) + 0.06;
  const peak = Math.max(st.top, (eA + eB) / 2) + ARCH_PER_CELL * len;
  return { x: st.x, y: st.y, c, s, len, u0: 0.25, u1: len - 0.25, eA, eB, peak, half: 0.4 };
}

/** Deck height (m) at distance u (cells) along it. */
export function deckHeight(d: Deck, u: number): number {
  const t = Math.min(1, Math.max(0, (u - d.u0) / Math.max(1e-6, d.u1 - d.u0)));
  const lin = d.eA + (d.eB - d.eA) * t;
  const mid = (d.eA + d.eB) / 2;
  return lin + (d.peak - mid) * Math.sin(Math.PI * t);
}

/** Deck height (m) under the point (x, y) in cell coordinates, or NaN when not on the deck. */
export function deckAt(d: Deck, x: number, y: number): number {
  const dx = x - d.x;
  const dy = y - d.y;
  const u = dx * d.c + dy * d.s;
  const v = -dx * d.s + dy * d.c;
  if (u < d.u0 - 0.2 || u > d.u1 + 0.2 || Math.abs(v) > d.half + 0.15) return NaN;
  return deckHeight(d, u);
}
