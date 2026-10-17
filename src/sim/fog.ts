/**
 * Fog of war as progression (docs/PEOPLE.md §6): `world.revealed` (0..255)
 * marks the land the player knows. It starts as a disc around the start
 * point and grows around every settlement with its population; revealed
 * land stays revealed. Plans can only be placed where revealed ≥ REVEALED.
 */
import { perlin } from '../shared/noise';
import type { World } from './world';

/** Cells with revealed at or above this count as known land (plans, objects). */
export const REVEALED = 128;
/** Radius (cells) revealed around the start point of a new game. */
export const START_REVEAL = 40;
/** Width (cells) of the soft edge of a revealed disc. */
export const REVEAL_SOFT = 6;
/** How far (cells) the edge wobbles in and out, so the known land isn't a perfect circle. */
const WOBBLE = 5;

/** Reveal radius of a settlement: R = 40 + 4·√pop. */
export function revealRadius(population: number): number {
  return START_REVEAL + 4 * Math.sqrt(Math.max(0, population));
}

/**
 * Raise `revealed` to a soft disc of radius r around (cx, cy). Values only
 * ever grow. Returns whether any cell changed.
 */
export function revealDisc(world: World, cx: number, cy: number, r: number): boolean {
  const rev = world.revealed;
  const W = world.width;
  const outer = r + REVEAL_SOFT / 2 + WOBBLE;
  const x0 = Math.max(0, Math.floor(cx - outer));
  const x1 = Math.min(W - 1, Math.ceil(cx + outer));
  const y0 = Math.max(0, Math.floor(cy - outer));
  const y1 = Math.min(world.height - 1, Math.ceil(cy + outer));
  const seed = world.seed ^ 0x0f06;
  let changed = false;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * W + x;
      if (rev[i] === 255) continue;
      const d = Math.hypot(x - cx, y - cy) + WOBBLE * perlin(x / 17, y / 17, seed);
      const t = (r + REVEAL_SOFT / 2 - d) / REVEAL_SOFT;
      if (t <= 0) continue;
      const v = t >= 1 ? 255 : Math.round(255 * t * t * (3 - 2 * t));
      if (v > rev[i]!) {
        rev[i] = v;
        changed = true;
      }
    }
  }
  return changed;
}

/** Whether cell i is known land. */
export function isRevealed(world: World, i: number): boolean {
  return world.revealed[i]! >= REVEALED;
}
