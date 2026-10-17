/**
 * World queries for the playtest bots and metrics (tools/playtest.ts):
 * read-only helpers over the sim's own state (water, flow, land use,
 * villages), so the bots can find "sensible places" like a player would.
 */
import type { Pt } from '../../src/shared/protocol';
import { isRevealed } from '../../src/sim/fog';
import type { Settlement } from '../../src/sim/people/settlement';
import type { Simulation } from '../../src/sim/sim';
import { saturation } from '../../src/sim/vegetation';
import { LandUse, type World } from '../../src/sim/world';

/** Open water deep enough to count as a river or lake (m). */
export const WATER_DEPTH = 0.3;
/** Flow speed above which open water counts as a river (m/s). */
export const RIVER_SPEED = 0.15;

export const isWater = (w: World, i: number): boolean => w.water[i]! > WATER_DEPTH;
export const speed = (w: World, i: number): number => Math.hypot(w.velX[i]!, w.velY[i]!);
export const isRiver = (w: World, i: number): boolean => isWater(w, i) && speed(w, i) > RIVER_SPEED;

export const cellX = (w: World, i: number): number => i % w.width;
export const cellY = (w: World, i: number): number => (i / w.width) | 0;
export const dist = (w: World, i: number, x: number, y: number): number => Math.hypot(cellX(w, i) - x, cellY(w, i) - y);

/** Living villages (population > 0), oldest first. */
export function villages(sim: Simulation): Settlement[] {
  return sim.people ? sim.people.settlements.filter((s) => s.state.population > 0) : [];
}

/** Cells within radius r of (x, y), revealed only. */
export function cellsAround(sim: Simulation, x: number, y: number, r: number, revealedOnly = true): number[] {
  const w = sim.world;
  const out: number[] = [];
  for (let yy = Math.max(0, Math.floor(y - r)); yy <= Math.min(w.height - 1, Math.ceil(y + r)); yy++)
    for (let xx = Math.max(0, Math.floor(x - r)); xx <= Math.min(w.width - 1, Math.ceil(x + r)); xx++) {
      if ((xx - x) ** 2 + (yy - y) ** 2 > r * r) continue;
      const i = w.idx(xx, yy);
      if (revealedOnly && sim.fog && !isRevealed(w, i)) continue;
      out.push(i);
    }
  return out;
}

/** Field cells belonging to village s (nearest village owns the land). */
export function fieldsOf(sim: Simulation, s: Settlement): number[] {
  const w = sim.world;
  const p = sim.people!;
  return cellsAround(sim, s.state.x, s.state.y, 34, false).filter(
    (i) => w.landuse[i] === LandUse.Field && p.ownerOf(cellX(w, i), cellY(w, i)) === s,
  );
}

/** Building and yard cells of village s. */
export function homesOf(sim: Simulation, s: Settlement): number[] {
  const w = sim.world;
  const p = sim.people!;
  const out: number[] = [];
  for (const b of p.buildings) if (b.settlement === s.state.id && b.kind !== 'ruin') out.push(w.idx(b.x, b.y));
  return out;
}

/** Whether a straight line passes clear of buildings (and, with `yards`, their yards) by `margin` cells. */
export function lineClear(w: World, a: Pt, b: Pt, margin = 1.5, yards = true): boolean {
  const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 2) + 1;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const x = a[0] + (b[0] - a[0]) * t;
    const y = a[1] + (b[1] - a[1]) * t;
    for (let yy = Math.floor(y - margin); yy <= Math.ceil(y + margin); yy++)
      for (let xx = Math.floor(x - margin); xx <= Math.ceil(x + margin); xx++) {
        if (!w.inBounds(xx, yy)) continue;
        const lu = w.landuse[w.idx(xx, yy)];
        if (lu === LandUse.Building || (yards && lu === LandUse.Yard)) return false;
      }
  }
  return true;
}

/** Whether every cell on a straight line is revealed (plans elsewhere are dropped). */
export function lineRevealed(sim: Simulation, a: Pt, b: Pt): boolean {
  if (!sim.fog) return true;
  const w = sim.world;
  const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])) + 1;
  for (let k = 0; k <= n; k++) {
    const x = Math.round(a[0] + ((b[0] - a[0]) * k) / n);
    const y = Math.round(a[1] + ((b[1] - a[1]) * k) / n);
    if (!w.inBounds(x, y) || !isRevealed(w, w.idx(x, y))) return false;
  }
  return true;
}

/** Open-water cells with a dry neighbour (a shore), where a canal can start. */
export function isShore(w: World, i: number): boolean {
  if (!isWater(w, i)) return false;
  const x = cellX(w, i);
  const y = cellY(w, i);
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    if (!w.inBounds(x + dx, y + dy)) continue;
    if (w.water[w.idx(x + dx, y + dy)]! < 0.05) return true;
  }
  return false;
}

/** Mean flow direction (unit vector) of the water around cell i, or null if still. */
export function flowDir(w: World, i: number, r = 2): [number, number] | null {
  let vx = 0;
  let vy = 0;
  const x0 = cellX(w, i);
  const y0 = cellY(w, i);
  for (let y = y0 - r; y <= y0 + r; y++)
    for (let x = x0 - r; x <= x0 + r; x++) {
      if (!w.inBounds(x, y)) continue;
      const j = w.idx(x, y);
      if (!isWater(w, j)) continue;
      vx += w.velX[j]!;
      vy += w.velY[j]!;
    }
  const l = Math.hypot(vx, vy);
  return l > 1e-3 ? [vx / l, vy / l] : null;
}

/**
 * A line across the water at cell i, perpendicular to the flow, reaching
 * out on both sides until the ground stands `above` metres over `level`
 * (so a wall there cannot be bypassed). Null if no such banks within `reach`.
 */
export function crossLine(w: World, i: number, level: number, above: number, reach = 16): [Pt, Pt] | null {
  const d = flowDir(w, i);
  if (!d) return null;
  const nx = -d[1];
  const ny = d[0];
  const x0 = cellX(w, i);
  const y0 = cellY(w, i);
  const ends: Pt[] = [];
  for (const sgn of [1, -1]) {
    let end: Pt | null = null;
    for (let r = 1; r <= reach; r += 0.5) {
      const x = Math.round(x0 + sgn * nx * r);
      const y = Math.round(y0 + sgn * ny * r);
      if (!w.inBounds(x, y)) break;
      const j = w.idx(x, y);
      if (w.water[j]! < 0.05 && w.terrain(j) > level + above) {
        end = [x0 + sgn * nx * (r + 1), y0 + sgn * ny * (r + 1)];
        break;
      }
    }
    if (!end) return null;
    ends.push(end);
  }
  return [ends[0]!, ends[1]!];
}

/** Lowest terrain on the straight line a–b. */
export function lowestOn(w: World, a: Pt, b: Pt): number {
  const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])) + 1;
  let lo = Infinity;
  for (let k = 0; k <= n; k++) {
    const x = Math.round(a[0] + ((b[0] - a[0]) * k) / n);
    const y = Math.round(a[1] + ((b[1] - a[1]) * k) / n);
    if (w.inBounds(x, y)) lo = Math.min(lo, w.terrain(w.idx(x, y)));
  }
  return lo;
}

export { saturation };

/** Point (fractional cell coordinates) of cell i. */
export const pt = (w: World, i: number): Pt => [cellX(w, i), cellY(w, i)];

/**
 * A path from a to b clear of buildings (`margin` cells; yards may be dug): straight if possible,
 * else with one waypoint to the side of the middle (a player's dogleg
 * around the village). Null if none of those is clear and revealed.
 */
export function routeAround(sim: Simulation, a: Pt, b: Pt, margin = 2.5): Pt[] | null {
  const w = sim.world;
  const ok = (p: Pt, q: Pt): boolean => lineClear(w, p, q, margin, false) && lineRevealed(sim, p, q);
  if (ok(a, b)) return [a, b];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  const nx = -dy / l;
  const ny = dx / l;
  for (const off of [6, -6, 10, -10, 14, -14, 18, -18, 24, -24]) {
    for (const t of [0.5, 0.3, 0.7]) {
      const m: Pt = [a[0] + dx * t + nx * off, a[1] + dy * t + ny * off];
      if (!w.inBounds(Math.round(m[0]), Math.round(m[1]))) continue;
      if (ok(a, m) && ok(m, b)) return [a, m, b];
    }
  }
  return null;
}

/** Length of a polyline (cells). */
export function polyLength(ps: readonly Pt[]): number {
  let l = 0;
  for (let k = 0; k + 1 < ps.length; k++) l += Math.hypot(ps[k + 1]![0] - ps[k]![0], ps[k + 1]![1] - ps[k]![1]);
  return l;
}
