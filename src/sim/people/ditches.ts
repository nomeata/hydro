/**
 * Field ditches (docs/PLAYTEST.md round 2, GAMEPLAY §4): once the player's
 * canal carries water past a village's fields, the farmers dig small
 * ditches off it into the dry land beside it: one cell wide, shallow, their
 * floor a little below the canal's water, so the water runs in and stands
 * there. They are real earthworks (the water sim fills them) and they wet
 * the fields along them like any water does. The player's canal is what
 * makes them possible; the villagers only finish the job.
 */
import { CellFlag, LandUse, type World } from '../world';

export const DITCH = {
  /** Days between two looks for a new ditch per village. */
  everyDays: 2,
  /** Cells per ditch: at most, and at least for it to be worth digging. */
  maxLen: 10,
  minLen: 3,
  /** Ditches per village: 1 + population / perPeople, at most `max`. */
  perPeople: 6,
  max: 12,
  /** The floor lies this far below the canal's water surface (m)... */
  belowSurface: 0.12,
  /** ...and at most this far below the ground (m): ditches are shallow. */
  maxCut: 0.9,
  /** Ground must lie at least this far above the canal's water, or the ditch would spill (m). */
  minAbove: 0.03,
  /** Canal cells this far (cells) from the village centre are considered. */
  reach: 22,
  /** Cells within this distance of the ditch that it should help (dry fields or farmable land), and how many it needs. */
  helps: 2,
  minHelped: 8,
  /** Earth moved per farmer visit (m). */
  perVisit: 0.35,
};

export interface Ditch {
  /** Cells from the canal outwards. */
  cells: number[];
  /** Floor height (m). */
  floor: number;
  /** Cells of `cells` dug to the floor so far (they are dug in order). */
  dug: number;
}

const DIRS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * The best new ditch for a village at (cx, cy), or null. `mine(i)` says
 * whether a cell belongs to the village, `taken(i)` whether it is (or is
 * next to) a ditch already, `moisture` is the field moisture and land
 * below `dryBelow` counts as dry.
 */
export function chooseDitch(
  w: World,
  cx: number,
  cy: number,
  moisture: Float32Array,
  mine: (i: number) => boolean,
  taken: (i: number) => boolean,
  dryBelow: number,
): Ditch | null {
  const W = w.width;
  const R = DITCH.reach;
  let best: Ditch | null = null;
  let bestScore = 0;
  const x0 = Math.max(1, Math.round(cx - R));
  const x1 = Math.min(W - 2, Math.round(cx + R));
  const y0 = Math.max(1, Math.round(cy - R));
  const y1 = Math.min(w.height - 2, Math.round(cy + R));
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const c = y * W + x;
      if ((w.flags[c]! & CellFlag.Canal) === 0 || w.water[c]! <= 0.05) continue;
      if ((x - cx) ** 2 + (y - cy) ** 2 > R * R) continue;
      const surf = w.terrain(c) + w.water[c]!;
      const floor = surf - DITCH.belowSurface;
      for (const [dx, dy] of DIRS) {
        const cells: number[] = [];
        let open = false; // past the canal's banks
        for (let k = 1; k <= DITCH.maxLen + 3; k++) {
          const xx = x + dx * k;
          const yy = y + dy * k;
          if (xx < 1 || yy < 1 || xx >= W - 1 || yy >= w.height - 1) break;
          const j = yy * W + xx;
          const g = w.terrain(j);
          // The canal itself and its banks (the cut through a bank is part of the ditch).
          if ((w.flags[j]! & CellFlag.Canal) !== 0 && !open) {
            if (w.water[j]! > 0.05 || g <= floor) continue;
            if (g - floor > DITCH.maxCut + 1 || (w.flags[j]! & (CellFlag.Structure | CellFlag.Lined)) !== 0) break;
            cells.push(j);
            continue;
          }
          if (w.water[j]! > 0.05 || !ditchable(w, j) || taken(j) || !mine(j)) break;
          if (g < surf + DITCH.minAbove || g - floor > DITCH.maxCut) break;
          open = true;
          cells.push(j);
          if (cells.length >= DITCH.maxLen) break;
        }
        if (cells.length < DITCH.minLen || (w.flags[cells[cells.length - 1]!]! & CellFlag.Canal) !== 0) continue;
        const score = helped(w, cells, moisture, dryBelow);
        if (score < DITCH.minHelped) continue;
        // Prefer ditches that help the most land per cell dug; ties by position (deterministic).
        const s = score / Math.sqrt(cells.length);
        if (s > bestScore) {
          bestScore = s;
          best = { cells, floor, dug: 0 };
        }
      }
    }
  return best;
}

/** Whether a dry cell may become a ditch: open land or a field, nothing built, planned or lined. */
function ditchable(w: World, j: number): boolean {
  const lu = w.landuse[j];
  if (lu !== LandUse.None && lu !== LandUse.Field && lu !== LandUse.Pasture) return false;
  if ((w.flags[j]! & (CellFlag.Structure | CellFlag.Lined | CellFlag.Canal)) !== 0) return false;
  if (!Number.isNaN(w.plan[j]!)) return false;
  // Not right by a house (yards are not ditchable, so this keeps one cell clear).
  const W = w.width;
  for (const k of [j - 1, j + 1, j - W, j + W]) if (w.landuse[k] === LandUse.Building) return false;
  return true;
}

/** Dry fields and dry fertile land within DITCH.helps of the cells. */
function helped(w: World, cells: readonly number[], moisture: Float32Array, dryBelow: number): number {
  const W = w.width;
  const R = DITCH.helps;
  const seen = new Set<number>();
  for (const c of cells) {
    const x = c % W;
    const y = (c / W) | 0;
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= w.height) continue;
        const j = yy * W + xx;
        if (seen.has(j) || cells.includes(j)) continue;
        seen.add(j);
      }
  }
  let n = 0;
  for (const j of seen) {
    if (w.water[j]! > 0.05 || moisture[j]! >= dryBelow) continue;
    const lu = w.landuse[j];
    if (lu === LandUse.Field || (lu === LandUse.None && w.fertility[j]! >= 0.3)) n++;
  }
  return n;
}
