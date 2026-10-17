/**
 * The villagers' own works (docs/PEOPLE.md §5.4): stone lining of the banks
 * by their homes and of the player's canals near the village, quays where
 * lined banks by the houses face open water, and one wooden jetty per
 * fishing village. Pure functions over the world; the agents in village.ts
 * carry the stones and do the work.
 */
import { CellFlag, LandUse, type World } from '../world';

export const WORKS = {
  /** Banks within this many cells of buildings, yards, fields and paths are lined. */
  near: 3,
  /** Player canals within this distance of the village centre are lined. */
  canalRadius: 22,
  /** Cells lined per day at full wellbeing (a fifth of it when poor). */
  ratePerDay: 1.5,
  /** Unused lining budget is capped (cells). */
  maxBudget: 4,
  /** Candidate sites kept per village (best first). */
  maxSites: 24,
  /** Quays: lined banks this close to a house, facing water this deep. */
  quayNear: 4,
  quayDepth: 0.5,
  /** Jetty: shore within this distance of the centre; deck over water this deep. */
  jettyRadius: 18,
  jettyDepth: 0.5,
  jettyMaxLen: 3,
};

/** A villagers' jetty: from the shore cell out over the water. */
export interface Jetty {
  shore: number;
  /** Deck cells over the water, from the shore outwards (the last is the fishing end). */
  cells: number[];
  dx: number;
  dy: number;
  progress: number;
  /** Deck height (m), set when finished. */
  top: number;
}

/** Land uses that make a cell part of "home": banks near them are worth lining. */
function isHome(lu: number): boolean {
  return lu === LandUse.Building || lu === LandUse.Yard || lu === LandUse.Field || lu === LandUse.Garden || lu === LandUse.Path || lu === LandUse.Bridge;
}

function speed(w: World, i: number): number {
  return Math.hypot(w.velX[i]!, w.velY[i]!);
}

/**
 * Cells a village would like to line, best first: banks (dry or shallow
 * cells next to water) within WORKS.near of its homes and fields, and the
 * beds and banks of player canals near the village. Faster water, flood
 * memory and canals rank higher, and so do banks right by a house (they
 * become quays); nearer ranks higher.
 * `mine(x, y)` says whether the village owns the land at a cell.
 */
export function surveyLining(
  w: World,
  cx: number,
  cy: number,
  mine: (x: number, y: number) => boolean,
  houses: readonly { x: number; y: number }[] = [],
): number[] {
  const W = w.width;
  const H = w.height;
  const R = WORKS.canalRadius + WORKS.near;
  const x0 = Math.max(1, Math.round(cx - R));
  const x1 = Math.min(W - 2, Math.round(cx + R));
  const y0 = Math.max(1, Math.round(cy - R));
  const y1 = Math.min(H - 2, Math.round(cy + R));
  if (x1 < x0 || y1 < y0) return [];
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  // Home mask, dilated by `near` (Chebyshev, separable).
  const home = new Uint8Array(bw * bh);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) if (isHome(w.landuse[y * W + x]!) && mine(x, y)) home[(y - y0) * bw + (x - x0)] = 1;
  const n = WORKS.near;
  const tmp = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++)
    for (let x = 0; x < bw; x++) {
      let v = 0;
      for (let k = Math.max(0, x - n); k <= Math.min(bw - 1, x + n) && !v; k++) v = home[y * bw + k]!;
      tmp[y * bw + x] = v;
    }
  for (let y = 0; y < bh; y++)
    for (let x = 0; x < bw; x++) {
      let v = 0;
      for (let k = Math.max(0, y - n); k <= Math.min(bh - 1, y + n) && !v; k++) v = tmp[k * bw + x]!;
      home[y * bw + x] = v;
    }

  const { water, flags, landuse, floodMemory } = w;
  const cands: [number, number][] = [];
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const i = y * W + x;
      if ((flags[i]! & CellFlag.Lined) !== 0 || landuse[i] === LandUse.Building || landuse[i] === LandUse.Bridge) continue;
      const d = Math.hypot(x - cx, y - cy);
      if (d > R) continue;
      const h = water[i]!;
      let v = 0;
      let wetNb = false;
      let canalNb = false;
      for (const j of [i - 1, i + 1, i - W, i + W]) {
        if (water[j]! > 0.1) {
          wetNb = true;
          v = Math.max(v, speed(w, j));
          if ((flags[j]! & CellFlag.Canal) !== 0) canalNb = true;
        }
      }
      const bank = h < 0.3 && wetNb;
      const canal = d <= WORKS.canalRadius && (((flags[i]! & CellFlag.Canal) !== 0 && h > 0.05) || (bank && canalNb)) && mine(x, y);
      const nearHome = bank && home[(y - y0) * bw + (x - x0)] === 1;
      if (!canal && !nearHome) continue;
      if (canal) v = Math.max(v, speed(w, i));
      let byHouse = 0;
      if (nearHome) for (const b of houses) if (Math.abs(b.x - x) <= WORKS.quayNear && Math.abs(b.y - y) <= WORKS.quayNear) byHouse = 2;
      const score = (nearHome ? 1 : 0) + byHouse + (canal ? 1.2 : 0) + Math.min(1.5, v * 2) + floodMemory[i]! / 255 - d / 40;
      cands.push([score, i]);
    }
  cands.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  return cands.slice(0, WORKS.maxSites).map((c) => c[1]);
}

/**
 * Where to stand to lay stones on cell i: the cell itself if shallow,
 * else the dry neighbour nearest to (ax, ay); -1 if none.
 */
export function standCell(w: World, i: number, ax: number, ay: number): number {
  if (w.water[i]! < 0.3) return i;
  const W = w.width;
  let best = -1;
  let bestD = Infinity;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const x = (i % W) + dx;
      const y = ((i / W) | 0) + dy;
      if (!w.inBounds(x, y)) continue;
      const j = w.idx(x, y);
      if (w.water[j]! >= 0.3 || w.landuse[j] === LandUse.Building) continue;
      const d = Math.hypot(x - ax, y - ay);
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
  return best;
}

/**
 * The best shore for a jetty near (cx, cy): a dry cell from which at least
 * two cells of calm water at least WORKS.jettyDepth deep lead straight out.
 * `fishScore(j)` rates the water at the jetty end (0..1).
 */
export function chooseJetty(w: World, cx: number, cy: number, fishScore: (j: number) => number): Jetty | null {
  const W = w.width;
  const R = WORKS.jettyRadius;
  let best: Jetty | null = null;
  let bestScore = -Infinity;
  for (let y = Math.max(1, Math.round(cy - R)); y <= Math.min(w.height - 2, Math.round(cy + R)); y++)
    for (let x = Math.max(1, Math.round(cx - R)); x <= Math.min(W - 2, Math.round(cx + R)); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > R || d < 3) continue;
      const i = y * W + x;
      if (w.water[i]! > 0.05) continue;
      const lu = w.landuse[i]!;
      if (lu !== LandUse.None && lu !== LandUse.Yard && lu !== LandUse.Path && lu !== LandUse.Pasture) continue;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const cells: number[] = [];
        for (let k = 1; k <= WORKS.jettyMaxLen; k++) {
          const px = x + dx * k;
          const py = y + dy * k;
          if (!w.inBounds(px, py)) break;
          const j = w.idx(px, py);
          if (w.water[j]! < WORKS.jettyDepth || speed(w, j) > 0.4 || w.landuse[j] !== LandUse.None) break;
          if ((w.flags[j]! & CellFlag.Canal) !== 0) break; // not across the player's canal
          cells.push(j);
        }
        if (cells.length < 2) continue;
        const end = cells[cells.length - 1]!;
        // Open water beyond the end is better (room to cast).
        const bx = x + dx * (cells.length + 1);
        const by = y + dy * (cells.length + 1);
        const beyond = w.inBounds(bx, by) ? Math.min(1.5, w.water[w.idx(bx, by)]!) : 0;
        const score = Math.min(2, w.water[end]!) + beyond + 2 * fishScore(end) + cells.length * 0.2 - d / 12;
        if (score > bestScore) {
          bestScore = score;
          best = { shore: i, cells, dx, dy, progress: 0, top: 0 };
        }
      }
    }
  return best;
}

/**
 * Quay cells: lined, dry-ish cells next to water deeper than
 * WORKS.quayDepth, within WORKS.quayNear of a house or store. Writes 1
 * into `out` for them (0 elsewhere); returns whether anything changed.
 */
export function markQuays(w: World, houses: readonly { x: number; y: number; r?: number }[], out: Uint8Array): boolean {
  const W = w.width;
  const next = new Uint8Array(out.length);
  for (const b of houses) {
    const R = b.r ?? WORKS.quayNear;
    for (let y = Math.max(1, b.y - R); y <= Math.min(w.height - 2, b.y + R); y++)
      for (let x = Math.max(1, b.x - R); x <= Math.min(W - 2, b.x + R); x++) {
        if (Math.hypot(x - b.x, y - b.y) > R + 0.5) continue;
        const i = y * W + x;
        if ((w.flags[i]! & CellFlag.Lined) === 0 || w.water[i]! > 0.3) continue;
        const dq = WORKS.quayDepth;
        if (w.water[i - 1]! > dq || w.water[i + 1]! > dq || w.water[i - W]! > dq || w.water[i + W]! > dq) next[i] = 1;
      }
  }
  let changed = false;
  for (let i = 0; i < out.length; i++)
    if (out[i] !== next[i]) {
      changed = true;
      break;
    }
  if (changed) out.set(next);
  return changed;
}
