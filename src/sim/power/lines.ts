/**
 * The villagers' power lines (docs/GAMEPLAY.md §1.5): where a line of
 * poles runs and where each pole stands. Pure functions over the world;
 * PowerGrid (grid.ts) decides which lines to build, the village builders
 * put the poles up (people/village.ts).
 *
 * - **Route**: A* over the cells between two ends, cheapest along trodden
 *   paths and beside them, then along field edges; fields, houses, slopes
 *   and water cost more; water farther than `halfSpan` from dry land (a
 *   river too wide for one span) and unknown land are closed.
 * - **Poles**: evenly along the route (`spacing`, spans at most LINK_SPAN),
 *   each on the best dry cell near its place (beside a path, at a field's
 *   edge, never in a house, a field, on a bridge, a structure, a plan or a
 *   steep slope), with a penalty for turning; then a couple of passes pull
 *   each pole towards the line between its neighbours (straight runs,
 *   gentle turns).
 *
 * Deterministic (no RNG): ties go to the lower cell index / earlier path cell.
 */
import { CellFlag, LandUse, type World } from '../world';
import { MinHeap } from '../people/path';
import { LINK_SPAN, POLE_SPACING } from './power';

export const LINES = {
  /** Poles stand this far apart (cells) along a line, and no closer than `minGap` to another pole. */
  spacing: POLE_SPACING,
  span: LINK_SPAN,
  minGap: 2.5,
  /** Shortest span (cells). */
  minSpan: 3,
  /** A wire crosses water no farther than this from dry land (cells): a stream of about twice this. */
  halfSpan: 3.5,
  /** Water this deep (m) or more is no place for a pole. */
  dry: 0.05,
  /** Steepest step to a neighbour (m) for a pole. */
  maxRise: 1.5,
  /** Margin (cells) of a route's search window around its ends, and the largest window. */
  margin: 20,
  maxCells: 260 * 260,
  /** The last pole of a line to a house, the store or a pump stands within this many cells of it. */
  endNear: 2.3,
  /** Lines planned per day at most, and no new ones while this many poles wait to be built. */
  routesPerDay: 2,
  maxPending: 14,
  /** Longest line (straight, cells) the villagers take on. */
  maxLine: 160,
  /** Days before a line that could not be routed is tried again. */
  retryDays: 20,
  /** A village builds the poles within this distance (cells) of its centre; beyond, the spirit crew does. */
  reach: 56,
  /** Days a pole may wait for its village's builders before the spirit crew puts it up. */
  crewAfter: 12,
  /** Progress per builder visit (two visits a pole). */
  perVisit: 0.5,
  /** A flood knocks a pole down: water this deep (m), or `wade` deep and flowing faster than `speed` (m/s). */
  floodDeep: 1.0,
  floodWade: 0.5,
  floodSpeed: 0.6,
  /** Ground moved under a standing pole by more than this (m) knocks it down. */
  ground: 0.3,
  /** What is left of a knocked-down pole (progress): the stump. */
  stump: 0.25,
  /** A knocked-down pole in water this many days is moved to dry ground nearby. */
  wetDays: 4,
  /** How far (cells) a pole may move out of the way of a house, a field or the water. */
  moveReach: 3,
};

export type Allow = ((i: number) => boolean) | null;

const N8: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
];

/**
 * How well a pole stands at cell i (lower is better, > 0), or Infinity
 * where none may stand. `fields`: a field may take one (at a high cost),
 * for lines that find no way round.
 */
export function poleCost(w: World, i: number, allow: Allow, fields = false): number {
  const W = w.width;
  const x = i % W;
  const y = (i / W) | 0;
  if (x < 1 || y < 1 || x >= W - 1 || y >= w.height - 1) return Infinity;
  if (allow && !allow(i)) return Infinity;
  if (w.water[i]! >= LINES.dry) return Infinity;
  const lu = w.landuse[i]!;
  if (lu === LandUse.Building || lu === LandUse.Bridge) return Infinity;
  if ((w.flags[i]! & CellFlag.Structure) !== 0 || !Number.isNaN(w.plan[i]!)) return Infinity;
  let c = 1;
  if (lu === LandUse.Field || lu === LandUse.Garden) {
    if (!fields) return Infinity;
    c += 4;
  }
  const h = w.terrain(i);
  const rise = Math.max(Math.abs(w.terrain(i - 1) - h), Math.abs(w.terrain(i + 1) - h), Math.abs(w.terrain(i - W) - h), Math.abs(w.terrain(i + W) - h));
  if (rise > LINES.maxRise) return Infinity;
  c += rise * 0.8;
  let path = false;
  let field = false;
  let wet = false;
  for (const [dx, dy] of N8) {
    const j = i + dy * W + dx;
    const u = w.landuse[j]!;
    if (u === LandUse.Path) path = true;
    else if (u === LandUse.Field || u === LandUse.Garden) field = true;
    if (w.water[j]! >= LINES.dry) wet = true;
  }
  // Beside a path best (on it is fine), along a field's edge, in a yard by the house.
  if (lu === LandUse.Path) c -= 0.2;
  else if (path) c -= 0.5;
  if (field && lu !== LandUse.Field && lu !== LandUse.Garden) c -= 0.3;
  if (lu === LandUse.Yard) c -= 0.1;
  // Not right at the water's edge, nor where floods come.
  if (wet) c += 0.4;
  c += (1.5 * w.floodMemory[i]!) / 255;
  return Math.max(0.1, c);
}

/**
 * The cells a line from `from` to `to` (cell indices) follows, both
 * included, or null when there is no way (or the window would be too big).
 */
export function routeLine(w: World, from: number, to: number, allow: Allow): number[] | null {
  const W = w.width;
  const fx = from % W;
  const fy = (from / W) | 0;
  const tx = to % W;
  const ty = (to / W) | 0;
  const M = LINES.margin;
  const x0 = Math.max(1, Math.min(fx, tx) - M);
  const x1 = Math.min(W - 2, Math.max(fx, tx) + M);
  const y0 = Math.max(1, Math.min(fy, ty) - M);
  const y1 = Math.min(w.height - 2, Math.max(fy, ty) + M);
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  if (bw <= 0 || bh <= 0 || bw * bh > LINES.maxCells) return null;
  const n = bw * bh;
  const loc = (i: number) => i % W >= x0 && i % W <= x1 && ((i / W) | 0) >= y0 && ((i / W) | 0) <= y1;
  if (!loc(from) || !loc(to)) return null;
  // Distance (cells) from each wet cell to dry land: wires span narrow water only.
  const wd = new Float32Array(n);
  for (let ly = 0; ly < bh; ly++)
    for (let lx = 0; lx < bw; lx++) wd[ly * bw + lx] = w.water[(y0 + ly) * W + x0 + lx]! >= LINES.dry ? 1e6 : 0;
  const D = Math.SQRT2;
  for (let ly = 0; ly < bh; ly++)
    for (let lx = 0; lx < bw; lx++) {
      const k = ly * bw + lx;
      let v = wd[k]!;
      if (v === 0) continue;
      if (lx > 0) v = Math.min(v, wd[k - 1]! + 1);
      if (ly > 0) {
        v = Math.min(v, wd[k - bw]! + 1);
        if (lx > 0) v = Math.min(v, wd[k - bw - 1]! + D);
        if (lx < bw - 1) v = Math.min(v, wd[k - bw + 1]! + D);
      }
      wd[k] = v;
    }
  for (let ly = bh - 1; ly >= 0; ly--)
    for (let lx = bw - 1; lx >= 0; lx--) {
      const k = ly * bw + lx;
      let v = wd[k]!;
      if (v === 0) continue;
      if (lx < bw - 1) v = Math.min(v, wd[k + 1]! + 1);
      if (ly < bh - 1) {
        v = Math.min(v, wd[k + bw]! + 1);
        if (lx < bw - 1) v = Math.min(v, wd[k + bw + 1]! + D);
        if (lx > 0) v = Math.min(v, wd[k + bw - 1]! + D);
      }
      wd[k] = v;
    }
  // What it costs to run the line over each cell.
  const cost = new Float32Array(n);
  for (let ly = 0; ly < bh; ly++)
    for (let lx = 0; lx < bw; lx++) {
      const k = ly * bw + lx;
      const i = (y0 + ly) * W + x0 + lx;
      let c: number;
      if (i !== from && i !== to && allow && !allow(i)) c = Infinity;
      else if (w.water[i]! >= LINES.dry) c = wd[k]! > LINES.halfSpan ? Infinity : 2.5;
      else {
        const lu = w.landuse[i]!;
        if (lu === LandUse.Building) c = 6;
        else if (lu === LandUse.Field || lu === LandUse.Garden) c = 2.5;
        else if ((w.flags[i]! & CellFlag.Structure) !== 0) c = 3;
        else {
          const p = poleCost(w, i, null);
          c = Number.isFinite(p) ? 0.45 + 0.5 * p : 2.5;
        }
      }
      cost[k] = c;
    }
  const lf = (fy - y0) * bw + (fx - x0);
  const lt = (ty - y0) * bw + (tx - x0);
  cost[lf] = Math.min(cost[lf]!, 1);
  cost[lt] = Math.min(cost[lt]!, 1);
  const g = new Float32Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new MinHeap();
  const h = (k: number) => {
    const dx = Math.abs((k % bw) - (tx - x0));
    const dy = Math.abs(((k / bw) | 0) - (ty - y0));
    return 0.5 * (Math.max(dx, dy) + (D - 1) * Math.min(dx, dy));
  };
  g[lf] = 0;
  heap.push(h(lf), lf);
  while (heap.size) {
    const k = heap.pop();
    if (closed[k]) continue;
    closed[k] = 1;
    if (k === lt) break;
    const lx = k % bw;
    const ly = (k / bw) | 0;
    for (const [dx, dy] of N8) {
      const nx = lx + dx;
      const ny = ly + dy;
      if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
      const m = ny * bw + nx;
      if (closed[m] || !Number.isFinite(cost[m]!)) continue;
      const step = (dx && dy ? D : 1) * 0.5 * (cost[k]! + cost[m]!);
      const ng = g[k]! + step;
      if (ng < g[m]!) {
        g[m] = ng;
        prev[m] = k;
        heap.push(ng + h(m), m);
      }
    }
  }
  if (!closed[lt]) return null;
  const out: number[] = [];
  for (let k = lt; k >= 0; k = prev[k]!) {
    out.push((y0 + ((k / bw) | 0)) * W + x0 + (k % bw));
    if (k === lf) break;
  }
  return out.reverse();
}

export interface PlaceOptions {
  allow: Allow;
  /** Poles may stand in fields (a line that finds no way round). */
  fields?: boolean;
  /** Whether the route ends at a node (a pole or turbine: wire to it) or at a spot (a house, the store, a pump: a pole beside it). */
  toNode: boolean;
  /** Other poles and turbines (x, y): new poles keep `minGap` from them (the ends' nodes excepted). */
  others: readonly (readonly [number, number])[];
  /** Extra cost of an end spot (x, y), e.g. less for one that reaches more houses. */
  endScore?: (x: number, y: number) => number;
}

/**
 * The new poles of a line along `path` (cells from its start node to its
 * end), in order from the start: evenly spaced, each on a good cell near
 * its place, smoothed into straight runs. With `toNode` false the last one
 * is the end pole beside the end cell. Null if they cannot stand with
 * every span at most LINK_SPAN.
 */
export function placeAlong(w: World, path: readonly number[], o: PlaceOptions): [number, number][] | null {
  if (path.length < 1) return null;
  const W = w.width;
  const px = path.map((i) => i % W);
  const py = path.map((i) => (i / W) | 0);
  const s: number[] = [0];
  for (let k = 1; k < path.length; k++) s.push(s[k - 1]! + Math.hypot(px[k]! - px[k - 1]!, py[k]! - py[k - 1]!));
  const A: [number, number] = [px[0]!, py[0]!];
  const last = path.length - 1;
  const dist = (a: readonly [number, number], b: readonly [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const cost = (x: number, y: number) => poleCost(w, y * W + x, o.allow, o.fields);
  const crowded = (x: number, y: number, chosen: readonly [number, number][]) => {
    for (const q of o.others) if (Math.hypot(q[0] - x, q[1] - y) < LINES.minGap) return true;
    for (const q of chosen) if (Math.hypot(q[0] - x, q[1] - y) < LINES.minGap) return true;
    return false;
  };
  // The end: the node itself, or the best spot beside the end cell.
  let E: [number, number];
  if (o.toNode) E = [px[last]!, py[last]!];
  else {
    const ex = px[last]!;
    const ey = py[last]!;
    let best: [number, number] | null = null;
    let bc = Infinity;
    const r = Math.ceil(LINES.endNear);
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const d = Math.hypot(dx, dy);
        if (d > LINES.endNear) continue;
        const x = ex + dx;
        const y = ey + dy;
        if (!w.inBounds(x, y) || crowded(x, y, [])) continue;
        const c = cost(x, y);
        if (!Number.isFinite(c)) continue;
        const v = c + 0.3 * d + (o.endScore?.(x, y) ?? 0);
        if (v < bc) {
          bc = v;
          best = [x, y];
        }
      }
    if (!best) return null;
    E = best;
  }
  const L = s[last]!;
  const chosen: [number, number][] = [];
  // How many spans: about `spacing` each.
  let spans = Math.max(1, Math.round(L / LINES.spacing));
  if (dist(A, E) <= LINES.span && L <= LINES.spacing * 1.35) spans = 1;
  // Where each pole came from along the path (for smoothing).
  let prev: [number, number] = A;
  let before: [number, number] | null = null;
  for (let k = 1; k < spans; k++) {
    const t = (k * L) / spans;
    if (dist(prev, E) <= LINES.spacing * 1.3 && dist(prev, E) <= LINES.span) break;
    const pick = (lo: number, hi: number): [number, number] | null => {
      let best: [number, number] | null = null;
      let bc = Infinity;
      const seen = new Set<number>();
      for (let q = 0; q <= last; q++) {
        if (s[q]! < lo || s[q]! > hi) continue;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const x = px[q]! + dx;
            const y = py[q]! + dy;
            const i = y * W + x;
            if (seen.has(i) || !w.inBounds(x, y)) continue;
            seen.add(i);
            const dp = Math.hypot(x - prev[0], y - prev[1]);
            if (dp < LINES.minSpan || dp > LINES.span || Math.hypot(x - E[0], y - E[1]) < LINES.minSpan) continue;
            if (crowded(x, y, chosen)) continue;
            const c = cost(x, y);
            if (!Number.isFinite(c)) continue;
            let v = c + 0.5 * Math.abs(s[q]! - t) + (dx || dy ? 0.4 : 0) + 0.25 * Math.abs(dp - LINES.spacing);
            if (before) {
              const ax = prev[0] - before[0];
              const ay = prev[1] - before[1];
              const bx = x - prev[0];
              const by = y - prev[1];
              const cos = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1);
              v += 2 * (1 - cos);
            }
            if (v < bc) {
              bc = v;
              best = [x, y];
            }
          }
      }
      return best;
    };
    // Near its place first; over water, anywhere a span reaches.
    const sp = s[path.findIndex((_, q) => px[q] === prev[0] && py[q] === prev[1])] ?? t - L / spans;
    const c = pick(t - 2, t + 2) ?? pick(Math.max(0, sp + 1), sp + LINES.span + 1);
    if (!c) return null;
    chosen.push(c);
    before = prev;
    prev = c;
  }
  // The last span (water near the end may need one more pole).
  for (let extra = 0; extra < 4 && dist(prev, E) > LINES.span; extra++) {
    let best: [number, number] | null = null;
    let bc = Infinity;
    for (let q = 0; q <= last; q++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = px[q]! + dx;
          const y = py[q]! + dy;
          if (!w.inBounds(x, y)) continue;
          const dp = Math.hypot(x - prev[0], y - prev[1]);
          const de = Math.hypot(x - E[0], y - E[1]);
          if (dp < LINES.minSpan || dp > LINES.span || de < LINES.minSpan || de >= dist(prev, E) || crowded(x, y, chosen)) continue;
          const c = cost(x, y);
          if (!Number.isFinite(c)) continue;
          const v = c + 0.3 * de;
          if (v < bc) {
            bc = v;
            best = [x, y];
          }
        }
    if (!best) return null;
    chosen.push(best);
    prev = best;
  }
  if (dist(prev, E) > LINES.span) return null;
  // Straighten: each pole towards the line between its neighbours, staying on good ground.
  const all: [number, number][] = [A, ...chosen, E];
  for (let pass = 0; pass < 3; pass++)
    for (let k = 1; k < all.length - 1; k++) {
      const q = all[k - 1]!;
      const r = all[k + 1]!;
      const mx = (q[0] + r[0]) / 2;
      const my = (q[1] + r[1]) / 2;
      const cur = all[k]!;
      const others = all.filter((_, j) => j !== k && j !== 0 && j !== all.length - 1);
      let best = cur;
      let bc = cost(cur[0], cur[1]) + 0.9 * Math.hypot(cur[0] - mx, cur[1] - my);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const x = cur[0] + dx;
          const y = cur[1] + dy;
          if (!w.inBounds(x, y)) continue;
          const dq = Math.hypot(x - q[0], y - q[1]);
          const dr = Math.hypot(x - r[0], y - r[1]);
          if (dq < LINES.minSpan || dr < LINES.minSpan || dq > LINES.span || dr > LINES.span || crowded(x, y, others)) continue;
          const c = cost(x, y);
          if (!Number.isFinite(c)) continue;
          const v = c + 0.9 * Math.hypot(x - mx, y - my);
          if (v < bc - 1e-9) {
            bc = v;
            best = [x, y];
          }
        }
      all[k] = best;
    }
  const out = all.slice(1, all.length - 1);
  if (!o.toNode) out.push(E);
  return out;
}
