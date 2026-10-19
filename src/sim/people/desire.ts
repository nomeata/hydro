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
 *   water) and lone specks fade sooner (`stub`), any path below `off`;
 * - no duplicates: a way never grows alongside another one a cell or two
 *   away that it does not join nearby (a parallel track), and of two such
 *   tracks the less trodden one gives way, cell by cell; a short loop (a
 *   ring of path, yards and houses of at most `loop` cells, such as a rung
 *   between two ways or a lane round a cluster of yards) loses its least
 *   trodden cell. Walkers then keep to the one way that is left.
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
  /** Loops of at most this many cells (path, yards, houses) are broken. */
  loop: 14,
  /** Two ways closer than 3 cells count as one only if joined within this many cells of path. */
  near: 8,
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
  // Which pieces of path (with the yards and bridges they lead to) are already
  // joined: a gap is closed only between different pieces, not into a loop.
  const parent = pieces(w);
  const find = (a: number): number => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]!]!;
    return a;
  };
  // Cell c (just made path, parent[c] = c) joins the pieces beside it.
  const join = (c: number) => {
    const cx = c % W;
    const cy = (c / W) | 0;
    for (let k = 0; k < 8; k++) {
      const nx = cx + RX[k]!;
      const ny = cy + RY[k]!;
      if (nx < 0 || ny < 0 || nx >= W || ny >= w.height) continue;
      const j = ny * W + nx;
      if (parent[j]! >= 0 && find(j) !== c) parent[find(j)] = c;
    }
  };
  for (let i = 0; i < w.size; i++) {
    const t = traffic[i]!;
    const lu = landuse[i]!;
    if (lu === LandUse.None) {
      if (t < DESIRE.link || water[i]! >= 0.05 || (flags[i]! & CellFlag.Lined) !== 0) continue;
      const x = i % W;
      const y = (i / W) | 0;
      const r = ring(w, x, y);
      const near = r.path | r.ends;
      let groups = 0;
      if (RING_GROUPS[near]! >= 2) {
        let first = -1;
        for (let k = 0; k < 8 && groups < 2; k++)
          if (near & (1 << k) && parent[(y + RY[k]!) * W + x + RX[k]!]! >= 0) {
            const root = find((y + RY[k]!) * W + x + RX[k]!);
            if (first < 0) {
              first = root;
              groups = 1;
            } else if (root !== first) groups = 2;
          }
      }
      const pathGroups = RING_GROUPS[r.path]!;
      // A high-traffic cell starts a path; a fairly trodden one continues a path
      // end (one piece of path beside it, in line); any trodden one closes a gap.
      // (Growing a path end never closes a loop with a yard beside it, and a new
      // track never starts beside an old one.)
      const ok =
        groups >= 2 ||
        (t >= DESIRE.grow && pathGroups === 1 && RING_GROUPS[near] === 1 && popcount(r.path) <= 2 && !isCorner(r.path)) ||
        (t >= DESIRE.on && (r.path | r.ends) === 0 && !pathWithin(w, x, y, 2));
      if (ok && !wouldThicken(w, x, y) && (r.path === 0 || parallelStrength(w, i) < 0)) {
        landuse[i] = LandUse.Path;
        changed = true;
        parent[i] = i;
        join(i);
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
      // Straighten: a corner of a staircase is cut (its neighbours stay joined
      // corner to corner), and a tooth of a zigzag moves into the line.
      if ((n === 2 || n === 3) && r.ends === 0) {
        const moved = straighten(w, x, y, r.path);
        if (moved !== -1) {
          changed = true;
          // A tooth moved into the line: the new cell joins its neighbours' piece.
          if (moved >= 0) {
            parent[moved] = moved;
            join(moved);
          }
          continue;
        }
      }
      // Thin a thick spot: drop the least trodden cell of a 2×2 block when its
      // neighbours stay connected without it.
      if (n >= 3 && RING_GROUPS[r.path | r.ends] === 1 && thickWeakest(w, x, y)) {
        landuse[i] = LandUse.None;
        changed = true;
        continue;
      }
      // A rung of a ladder or a lane on a short loop: the least trodden cell goes.
      if (RING_GROUPS[r.path | r.ends]! >= 2 && onShortLoop(w, x, y, r.path | r.ends)) {
        landuse[i] = LandUse.None;
        changed = true;
        continue;
      }
      // The weaker of two parallel tracks gives way.
      if (n >= 1 && parallelStrength(w, i) > meanTraffic(w, ballCells, ballN)) {
        landuse[i] = LandUse.None;
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Whether a ring mask is a corner of a way: two orthogonal neighbours a
 * quarter turn apart, no other orthogonal one, and any diagonal ones
 * touching them. The corner cell is not needed: its neighbours stay joined
 * corner to corner without it.
 */
function isCorner(m: number): boolean {
  const orth = m & 0x55;
  for (let k = 0; k < 8; k += 2) if (orth === ((1 << k) | (1 << ((k + 2) & 7)))) return RING_GROUPS[m] === 1;
  return false;
}

/**
 * Straighten path cell (x, y) with exactly the two path neighbours in ring
 * mask m (and no yard, house or bridge beside it): an L corner is dropped;
 * a tooth (two diagonal neighbours on the same side) moves into the line
 * between them. Returns −1 if nothing changed, −2 for a dropped corner,
 * else the cell the tooth moved to.
 */
function straighten(w: World, x: number, y: number, m: number): number {
  const { width: W, landuse, traffic, water, flags } = w;
  const i = y * W + x;
  if (isCorner(m)) {
    landuse[i] = LandUse.None;
    return -2;
  }
  for (let k = 1; k < 8; k += 2) {
    // Diagonals k and k + 2 share the orthogonal neighbour k + 1 (same side).
    if (m !== ((1 << k) | (1 << ((k + 2) & 7)))) continue;
    const o = (k + 1) & 7;
    const j = (y + RY[o]!) * W + x + RX[o]!;
    if (landuse[j] !== LandUse.None || water[j]! >= 0.05 || (flags[j]! & CellFlag.Lined) !== 0) return -1;
    landuse[i] = LandUse.None;
    if (wouldThicken(w, x + RX[o]!, y + RY[o]!)) {
      landuse[i] = LandUse.Path;
      return -1;
    }
    landuse[j] = LandUse.Path;
    traffic[j] = Math.max(traffic[j]!, traffic[i]!);
    return j;
  }
  return -1;
}

/** Whether any path cell lies within Chebyshev distance r of (x, y) (other than itself). */
function pathWithin(w: World, x: number, y: number, r: number): boolean {
  const { width: W, height: H, landuse } = w;
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if ((dx || dy) && nx >= 0 && ny >= 0 && nx < W && ny < H && landuse[ny * W + nx] === LandUse.Path) return true;
    }
  return false;
}

// Breadth-first searches over path cells (8-connected), depth-limited. Two
// independent scratch sets: the cell under test, and a neighbour's line.
let netStamp: Uint32Array | null = null;
let netDist: Uint8Array | null = null;
let netGen = 0;
let ballStamp: Uint32Array | null = null;
let ballGen = 0;
let netCells: Int32Array = new Int32Array(0);
let netN = 0;
let ballCells: Int32Array = new Int32Array(0);
let ballN = 0;

function ensureScratch(w: World): void {
  if (!netStamp || netStamp.length !== w.size) {
    netStamp = new Uint32Array(w.size);
    netDist = new Uint8Array(w.size);
    ballStamp = new Uint32Array(w.size);
    netGen = ballGen = 0;
  }
}

/**
 * Path cells within `depth` steps of cell s along the path (s counts as path).
 * Into netCells/netN (with netDist, marked in netStamp) or ballCells/ballN.
 */
function bfs(w: World, s: number, depth: number, net: boolean): void {
  const { width: W, height: H, landuse } = w;
  const stamp = net ? netStamp! : ballStamp!;
  const gen = net ? ++netGen : ++ballGen;
  let cells = net ? netCells : ballCells;
  if (cells.length < 256) cells = new Int32Array(256);
  let n = 0;
  let head = 0;
  stamp[s] = gen;
  cells[n++] = s;
  const dist = netDist!;
  // Depth per entry (only kept in netDist for the net search; local otherwise).
  const dep: number[] = [0];
  while (head < n) {
    const i = cells[head]!;
    const d = dep[head++]!;
    if (net) dist[i] = d;
    if (d >= depth) continue;
    const x = i % W;
    const y = (i / W) | 0;
    for (let k = 0; k < 8; k++) {
      const nx = x + RX[k]!;
      const ny = y + RY[k]!;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (stamp[j] === gen || landuse[j] !== LandUse.Path) continue;
      stamp[j] = gen;
      if (n >= cells.length) {
        const c2 = new Int32Array(cells.length * 2);
        c2.set(cells);
        cells = c2;
      }
      cells[n++] = j;
      dep.push(d + 1);
    }
  }
  if (net) {
    netCells = cells;
    netN = n;
  } else {
    ballCells = cells;
    ballN = n;
  }
}

/** Mean traffic of the first n cells of a list. */
function meanTraffic(w: World, cells: Int32Array, n: number): number {
  let s = 0;
  for (let k = 0; k < n; k++) s += w.traffic[cells[k]!]!;
  return n ? s / n : 0;
}

/** Principal direction (unit) of a set of cells, or null when they do not form a line. */
function lineDir(w: World, cells: Int32Array, n: number): [number, number] | null {
  if (n < 3) return null;
  const W = w.width;
  let mx = 0;
  let my = 0;
  for (let k = 0; k < n; k++) {
    mx += cells[k]! % W;
    my += (cells[k]! / W) | 0;
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let k = 0; k < n; k++) {
    const dx = (cells[k]! % W) - mx;
    const dy = ((cells[k]! / W) | 0) - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const tr = sxx + syy;
  const disc = Math.sqrt(((sxx - syy) * (sxx - syy)) / 4 + sxy * sxy);
  const l1 = tr / 2 + disc;
  const l2 = tr / 2 - disc;
  if (l1 <= 0 || l2 > 0.3 * l1) return null;
  const a = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return [Math.cos(a), Math.sin(a)];
}

/**
 * Whether cell i runs alongside another track: a path cell a cell or two
 * away, not joined to i within DESIRE.near cells of path, whose line runs
 * the same way and lies beside (not ahead of) i. Returns the strongest such
 * track's mean traffic, or −1. For a candidate (open land), i counts as path.
 * Leaves i's own line (within 3 cells) in ballCells/ballN for the caller.
 */
function parallelStrength(w: World, i: number): number {
  ensureScratch(w);
  const { width: W, height: H, landuse } = w;
  bfs(w, i, DESIRE.near, true);
  // i's own line: the cells of its net search within 3 steps.
  let own = new Int32Array(64);
  let on = 0;
  for (let k = 0; k < netN && on < 64; k++) if (netDist![netCells[k]!]! <= 3) own[on++] = netCells[k]!;
  const dirI = lineDir(w, own, on);
  let best = -1;
  if (dirI) {
    const x = i % W;
    const y = (i / W) | 0;
    const gen = netGen;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (landuse[j] !== LandUse.Path || netStamp![j] === gen) continue;
        // Beside, not ahead: the offset runs across i's line.
        const len = Math.hypot(dx, dy);
        if (Math.abs((dx * dirI[0] + dy * dirI[1]) / len) > 0.75) continue;
        bfs(w, j, 3, false);
        const dirJ = lineDir(w, ballCells, ballN);
        if (!dirJ || Math.abs(dirI[0] * dirJ[0] + dirI[1] * dirJ[1]) < 0.8) continue;
        best = Math.max(best, meanTraffic(w, ballCells, ballN));
      }
  }
  // For the caller: i's own line in ballCells.
  if (ballCells.length < on) ballCells = new Int32Array(Math.max(256, on));
  ballCells.set(own.subarray(0, on));
  ballN = on;
  return best;
}

let loopStamp: Uint32Array | null = null;
let loopFrom: Int32Array | null = null;
let loopGen = 0;

/**
 * Whether path cell (x, y) lies on a loop of at most DESIRE.loop cells
 * through path, yard, building and bridge cells, and is its least trodden
 * path cell (ties: the later index goes). `mask`: ring mask of its path and
 * end neighbours (in two or more groups).
 */
function onShortLoop(w: World, x: number, y: number, mask: number, any = false): boolean {
  const { width: W, height: H, landuse, traffic } = w;
  if (!loopStamp || loopStamp.length !== w.size) {
    loopStamp = new Uint32Array(w.size);
    loopFrom = new Int32Array(w.size);
    loopGen = 0;
  }
  const i = y * W + x;
  const node = (lu: number) => lu === LandUse.Path || lu === LandUse.Yard || lu === LandUse.Building || lu === LandUse.Bridge;
  // One start per ring group: label the groups by walking the ring.
  const group = new Int8Array(8).fill(-1);
  let ng = 0;
  for (let k = 0; k < 8; k++) {
    if (!(mask & (1 << k)) || group[k]! >= 0) continue;
    const st = [k];
    group[k] = ng;
    while (st.length) {
      const a = st.pop()!;
      const nb = [(a + 1) & 7, (a + 7) & 7];
      if ((a & 1) === 0) nb.push((a + 2) & 7, (a + 6) & 7);
      for (const b of nb)
        if (mask & (1 << b) && group[b]! < 0) {
          group[b] = ng;
          st.push(b);
        }
    }
    ng++;
  }
  if (ng < 2) return false;
  // Breadth-first from group 0's cells (not through i) until another group's cell.
  const stamp = loopStamp;
  const from = loopFrom!;
  const gen = ++loopGen;
  stamp[i] = gen;
  const q: number[] = [];
  const dep: number[] = [];
  const target = new Set<number>();
  for (let k = 0; k < 8; k++) {
    if (group[k]! < 0) continue;
    const j = (y + RY[k]!) * W + x + RX[k]!;
    if (group[k] === 0) {
      stamp[j] = gen;
      from[j] = -1;
      q.push(j);
      dep.push(1);
    } else target.add(j);
  }
  const limit = DESIRE.loop - 1;
  for (let h = 0; h < q.length; h++) {
    const c = q[h]!;
    if (target.has(c)) {
      // Found a loop: is i its least trodden path cell?
      if (any) return true;
      const t = traffic[i]!;
      for (let p = c; p !== -1; p = from[p]!) {
        if (landuse[p] !== LandUse.Path) continue;
        const tp = traffic[p]!;
        if (tp < t || (tp === t && p > i)) return false;
      }
      return true;
    }
    if (dep[h]! >= limit) continue;
    const cx = c % W;
    const cy = (c / W) | 0;
    for (let k = 0; k < 8; k++) {
      const nx = cx + RX[k]!;
      const ny = cy + RY[k]!;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (stamp[j] === gen || !node(landuse[j]!)) continue;
      stamp[j] = gen;
      from[j] = c;
      q.push(j);
      dep.push(dep[h]! + 1);
    }
  }
  return false;
}

let scratch: Int32Array | null = null;

/** Union-find forest over path, yard, building and bridge cells (8-connected); -1 elsewhere. */
function pieces(w: World): Int32Array {
  if (!scratch || scratch.length !== w.size) scratch = new Int32Array(w.size);
  const parent = scratch;
  const { width: W, landuse } = w;
  const joined = (lu: number) => lu === LandUse.Path || lu === LandUse.Building || lu === LandUse.Yard || lu === LandUse.Bridge;
  const find = (a: number): number => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]!]!;
    return a;
  };
  for (let i = 0; i < w.size; i++) {
    if (!joined(landuse[i]!)) {
      parent[i] = -1;
      continue;
    }
    parent[i] = i;
    const x = i % W;
    // Earlier neighbours: W, SW, S, SE (in index order, y − 1 is "S").
    const prev = [x > 0 ? i - 1 : -1, x > 0 ? i - W - 1 : -1, i - W, x + 1 < W ? i - W + 1 : -1];
    for (const j of prev) if (j >= 0 && parent[j]! >= 0) parent[find(j)] = find(i);
  }
  return parent;
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

/**
 * Duplicates in the path network: path cells running alongside another
 * track they do not join nearby (`parallel`), and path cells on a loop of
 * at most DESIRE.loop cells through path, yards and houses (`loop`).
 */
export function pathDuplicates(w: World): { parallel: number; loop: number } {
  const { width: W, landuse } = w;
  let parallel = 0;
  let loop = 0;
  for (let i = 0; i < w.size; i++) {
    if (landuse[i] !== LandUse.Path) continue;
    const x = i % W;
    const y = (i / W) | 0;
    if (parallelStrength(w, i) >= 0) parallel++;
    const r = ring(w, x, y);
    if (RING_GROUPS[r.path | r.ends]! >= 2 && onShortLoop(w, x, y, r.path | r.ends, true)) loop++;
  }
  return { parallel, loop };
}
