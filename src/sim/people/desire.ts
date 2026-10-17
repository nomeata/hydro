/**
 * Desire paths (docs/PEOPLE.md §3.3, M3-δ): every walker entering a cell
 * adds to its `traffic` (agents.ts `walk`); once a day traffic decays a
 * little. Where people (and herds) walk every day, the count climbs above
 * `on` and the grass gives way to a trodden earth path (LandUse.Path:
 * quicker to walk, a little less infiltration, drawn by the terrain
 * shader). A path nobody uses fades back to meadow once its traffic falls
 * below `off` (a month or two of game time).
 */
import { CellFlag, LandUse, type World } from '../world';

export const DESIRE = {
  /** Daily decay: traffic loses 1/2^decayShift of itself (at least 1). */
  decayShift: 4,
  /** Traffic at which open land becomes a path, and below which a path fades. */
  on: 180,
  off: 24,
};

/**
 * Daily: decay the traffic and turn well-trodden open land into paths
 * (and unused paths back). Returns whether any land use changed.
 */
export function updateDesirePaths(w: World): boolean {
  const { traffic, landuse, water, flags } = w;
  const shift = DESIRE.decayShift;
  let changed = false;
  for (let i = 0; i < w.size; i++) {
    let t = traffic[i]!;
    const lu = landuse[i]!;
    if (t === 0 && lu !== LandUse.Path) continue;
    if (t > 0) {
      t -= Math.max(1, t >> shift);
      traffic[i] = t;
    }
    if (lu === LandUse.None) {
      if (t >= DESIRE.on && water[i]! < 0.05 && (flags[i]! & CellFlag.Lined) === 0) {
        landuse[i] = LandUse.Path;
        changed = true;
      }
    } else if (lu === LandUse.Path && t < DESIRE.off) {
      landuse[i] = LandUse.None;
      changed = true;
    }
  }
  return changed;
}

/** Size of the largest 8-connected group of path cells. */
export function longestPath(w: World): number {
  const { width: W, height: H, landuse } = w;
  const seen = new Uint8Array(w.size);
  const stack: number[] = [];
  let best = 0;
  for (let s = 0; s < w.size; s++) {
    if (seen[s] || landuse[s] !== LandUse.Path) continue;
    let n = 0;
    seen[s] = 1;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      n++;
      const x = i % W;
      const y = (i / W) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (!seen[j] && landuse[j] === LandUse.Path) {
            seen[j] = 1;
            stack.push(j);
          }
        }
    }
    if (n > best) best = n;
  }
  return best;
}
