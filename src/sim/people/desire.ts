/**
 * Desire paths (docs/PEOPLE.md §3.3, M3-δ): every walker entering a cell
 * adds to its `traffic` (agents.ts `walk`); once a day traffic decays a
 * little. Where people (and herds) walk every day, the count climbs and the
 * grass gives way to a trodden earth path (LandUse.Path: quicker to walk,
 * preferred by A*, a little less infiltration, drawn by the terrain shader
 * as a winding band).
 *
 * The daily update grows paths as lines rather than patches:
 * - a cell becomes path where traffic is high (`on`), where it continues a
 *   path end (`grow`), or where it closes a gap between two pieces of path,
 *   a yard or a bridge (`link`);
 * - never into a 2×2 block (paths stay about one cell wide; existing thick
 *   spots are thinned, keeping the most trodden cells and the connections);
 * - dead ends that lead nowhere (not to a house, field, bridge or the
 *   water) and lone specks fade sooner (`stub`), any path below `off`.
 */
import { CellFlag, LandUse, type World } from '../world';

export const DESIRE = {
  /** Daily decay: traffic loses 1/2^decayShift of itself (at least 1). */
  decayShift: 4,
  /** Traffic at which open land becomes a path, and below which a path fades. */
  on: 150,
  off: 24,
  /** Traffic at which open land next to a path end continues it. */
  grow: 72,
  /** Traffic at which open land joins two separate pieces of path (or a path and a yard or bridge). */
  link: 40,
  /** Dead ends and lone path cells fade below this traffic. */
  stub: 72,
};

// The eight neighbours in ring order (E, NE, N, NW, W, SW, S, SE).
const RX = [1, 1, 0, -1, -1, -1, 0, 1];
const RY = [0, 1, 1, 1, 0, -1, -1, -1];

/**
 * RING_GROUPS[m]: number of 8-connected groups formed by the neighbours set
 * in the ring mask m (bit k = ring neighbour k). Ring neighbours next to each
 * other touch; so do two orthogonal ones a corner apart (E and N).
 */
const RING_GROUPS = (() => {
  const t = new Uint8Array(256);
  for (let m = 0; m < 256; m++) {
    const parent = [0, 1, 2, 3, 4, 5, 6, 7];
    const find = (a: number): number => (parent[a] === a ? a : (parent[a] = find(parent[a]!)));
    const join = (a: number, b: number) => {
      if (m & (1 << a) && m & (1 << b)) parent[find(a)] = find(b);
    };
    for (let k = 0; k < 8; k++) {
      join(k, (k + 1) & 7);
      if ((k & 1) === 0) join(k, (k + 2) & 7);
    }
    let n = 0;
    for (let k = 0; k < 8; k++) if (m & (1 << k) && find(k) === k) n++;
    t[m] = n;
  }
  return t;
})();

/** Ring masks of a cell's neighbours: path cells, and ends a way may lead to (yards, buildings, bridges). */
function ring(w: World, x: number, y: number): { path: number; ends: number; dest: boolean } {
  const { width: W, height: H, landuse, water } = w;
  let path = 0;
  let ends = 0;
  let dest = false;
  for (let k = 0; k < 8; k++) {
    const nx = x + RX[k]!;
    const ny = y + RY[k]!;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const j = ny * W + nx;
    const lu = landuse[j]!;
    if (lu === LandUse.Path) path |= 1 << k;
    else if (lu === LandUse.Building || lu === LandUse.Yard || lu === LandUse.Bridge) {
      ends |= 1 << k;
      dest = true;
    } else if (lu !== LandUse.None || water[j]! > 0.05) dest = true;
  }
  return { path, ends, dest };
}

/** Whether making cell i (at x, y) a path would complete a 2×2 block of path. */
function wouldThicken(w: World, x: number, y: number): boolean {
  const { width: W, height: H, landuse } = w;
  const P = (dx: number, dy: number) => {
    const nx = x + dx;
    const ny = y + dy;
    return nx >= 0 && ny >= 0 && nx < W && ny < H && landuse[ny * W + nx] === LandUse.Path;
  };
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) if (P(sx, 0) && P(0, sy) && P(sx, sy)) return true;
  return false;
}

/**
 * Daily: decay the traffic, turn well-trodden open land into paths (as
 * lines, see above) and unused paths back. Returns whether any land use
 * changed. Deterministic (cells in index order).
 */
export function updateDesirePaths(w: World): boolean {
  const { traffic, landuse, water, flags, width: W } = w;
  const shift = DESIRE.decayShift;
  let changed = false;
  for (let i = 0; i < w.size; i++) {
    const t = traffic[i]!;
    if (t > 0) traffic[i] = t - Math.max(1, t >> shift);
  }
  for (let i = 0; i < w.size; i++) {
    const t = traffic[i]!;
    const lu = landuse[i]!;
    if (lu === LandUse.None) {
      if (t < DESIRE.link || water[i]! >= 0.05 || (flags[i]! & CellFlag.Lined) !== 0) continue;
      const x = i % W;
      const y = (i / W) | 0;
      const r = ring(w, x, y);
      const groups = RING_GROUPS[r.path | r.ends]!;
      const pathGroups = RING_GROUPS[r.path]!;
      // A high-traffic cell starts a path; a fairly trodden one continues a path
      // end (one piece of path beside it, in line); any trodden one closes a gap.
      const ok =
        groups >= 2 ||
        (t >= DESIRE.grow && pathGroups === 1 && popcount(r.path) <= 2) ||
        (t >= DESIRE.on && (r.path | r.ends) === 0);
      if (ok && !wouldThicken(w, x, y)) {
        landuse[i] = LandUse.Path;
        changed = true;
      }
    } else if (lu === LandUse.Path) {
      if (t < DESIRE.off) {
        landuse[i] = LandUse.None;
        changed = true;
        continue;
      }
      const x = i % W;
      const y = (i / W) | 0;
      const r = ring(w, x, y);
      const n = popcount(r.path);
      // Dead ends into open meadow, and lone specks, fade sooner.
      if (t < DESIRE.stub && !r.dest && n <= 1) {
        landuse[i] = LandUse.None;
        changed = true;
        continue;
      }
      // Thin a thick spot: drop the least trodden cell of a 2×2 block when its
      // neighbours stay connected without it.
      if (n >= 3 && RING_GROUPS[r.path | r.ends] === 1 && thickWeakest(w, x, y)) {
        landuse[i] = LandUse.None;
        changed = true;
      }
    }
  }
  return changed;
}

function popcount(m: number): number {
  let n = 0;
  for (; m; m &= m - 1) n++;
  return n;
}

/** Whether cell (x, y) is in a 2×2 block of path in which it is the least trodden (ties: the later index). */
function thickWeakest(w: World, x: number, y: number): boolean {
  const { width: W, height: H, landuse, traffic } = w;
  const i = y * W + x;
  const t = traffic[i]!;
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) {
      const ax = x + sx;
      const ay = y + sy;
      if (ax < 0 || ay < 0 || ax >= W || ay >= H) continue;
      const block = [i + sx, i + sy * W, ay * W + ax];
      if (!block.every((j) => landuse[j] === LandUse.Path)) continue;
      if (block.every((j) => traffic[j]! > t || (traffic[j] === t && j < i))) return true;
    }
  return false;
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

/**
 * Shape of the path network: cells, 8-connected groups, the largest group,
 * cells in small groups (≤ 3 cells: patches rather than ways) and thick
 * spots (path cells at the corner of a full 2×2 block of path).
 */
export function pathStats(w: World): { cells: number; groups: number; largest: number; small: number; thick: number } {
  const { width: W, height: H, landuse } = w;
  const seen = new Uint8Array(w.size);
  const stack: number[] = [];
  let cells = 0;
  let groups = 0;
  let largest = 0;
  let small = 0;
  let thick = 0;
  for (let s = 0; s < w.size; s++) {
    if (landuse[s] !== LandUse.Path) continue;
    const sx = s % W;
    const sy = (s / W) | 0;
    if (sx + 1 < W && sy + 1 < H && landuse[s + 1] === LandUse.Path && landuse[s + W] === LandUse.Path && landuse[s + W + 1] === LandUse.Path) thick++;
    if (seen[s]) continue;
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
    cells += n;
    groups++;
    if (n > largest) largest = n;
    if (n <= 3) small += n;
  }
  return { cells, groups, largest, small, thick };
}
