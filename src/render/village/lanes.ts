/**
 * Village lanes: the ways between the houses, drawn on the yards (the
 * trampled ground around each building) like the desire paths outside.
 * Render-side only: each cluster of yards gets a small tree of lanes
 * through its yard cells (Prim's algorithm over shortest routes), from the
 * store outwards, linking every house door, the store, the well and the
 * mill, and the spots where paths from outside reach the yards. The lanes'
 * links go into the fields texture like a path cell's (B: ring mask; A:
 * the ends among them, here the buildings), the footfall byte G sets their
 * width: narrow lanes, a little wider by the store (a small square).
 */
import type { BuildingInfo } from '../../shared/protocol';
import { FIELD_BYTES } from '../../shared/protocol';
import { MinHeap } from '../../sim/people/path';
import { RING_X, RING_Y } from './fields';

const LU_PATH = 4;
const LU_YARD = 6;
const LU_BUILDING = 5;

/** Footfall byte (width) of lanes, and of lanes beside the store. */
export const LANE_WEAR = 110;
export const SQUARE_WEAR = 210;

function rotate(x: number, z: number, rot: number): [number, number] {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return [x * c + z * s, -x * s + z * c];
}

/**
 * Write the lanes into the RGBA texels `dst` (fields as from fieldsToRgba,
 * path links already set) for a grid of n cells, `width` wide.
 */
export function villageLanes(src: Uint8Array, dst: Uint8Array, n: number, width: number, buildings: readonly BuildingInfo[]): void {
  const height = Math.floor(n / width);
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : src[FIELD_BYTES * (y * width + x)]!);
  for (let i = 0; i < n; i++) if (src[FIELD_BYTES * i] === LU_YARD) dst[4 * i + 2] = dst[4 * i + 3] = 0;
  // Terminals: yard cells the lanes must reach, with links towards their building or path.
  const links = new Map<number, number>();
  const ends = new Map<number, number>();
  const terms: number[] = [];
  const square = new Set<number>();
  const addTerm = (i: number, k: number) => {
    links.set(i, (links.get(i) ?? 0) | (1 << k));
    ends.set(i, (ends.get(i) ?? 0) | (1 << k));
    if (!terms.includes(i)) terms.push(i);
  };
  // The store first: the trees grow from it.
  const order = [...buildings].sort((a, b) => (a.kind === 'store' ? 0 : 1) - (b.kind === 'store' ? 0 : 1) || a.id - b.id);
  for (const b of order) {
    if (b.kind === 'ruin' || b.kind === 'camp' || b.progress < 1) continue;
    if (at(b.x, b.y) !== LU_BUILDING) continue;
    let k = -1;
    if (b.kind === 'house') {
      // The door: on the house's local +x side (render/village/houses.ts).
      const [dx, dz] = rotate(1, 0, b.rot);
      const rx = Math.round(dx);
      const ry = Math.round(dz);
      for (let r = 0; r < 8; r += 2) if (RING_X[r] === rx && RING_Y[r] === ry) k = r;
      if (k >= 0 && at(b.x + rx, b.y + ry) !== LU_YARD) k = -1;
    }
    if (k < 0) {
      // Else the yard side facing most of the other buildings.
      let best = -Infinity;
      for (let r = 0; r < 8; r += 2) {
        if (at(b.x + RING_X[r]!, b.y + RING_Y[r]!) !== LU_YARD) continue;
        let s = 0;
        for (const o of buildings) {
          const d = Math.hypot(o.x - b.x, o.y - b.y);
          if (o !== b && d < 8) s += ((o.x - b.x) * RING_X[r]! + (o.y - b.y) * RING_Y[r]!) / (d + 1);
        }
        if (s > best) {
          best = s;
          k = r;
        }
      }
    }
    if (k < 0) continue;
    const t = (b.y + RING_Y[k]!) * width + b.x + RING_X[k]!;
    addTerm(t, (k + 4) & 7);
    if (b.kind === 'store') for (let r = 0; r < 8; r++) square.add((b.y + RING_Y[r]!) * width + b.x + RING_X[r]!);
  }
  // Where paths reach the yards (their links into a yard).
  for (let i = 0; i < n; i++) {
    if (src[FIELD_BYTES * i] !== LU_PATH) continue;
    const e = dst[4 * i + 3]!;
    if (!e) continue;
    const x = i % width;
    const y = (i / width) | 0;
    for (let k = 0; k < 8; k++)
      if (e & (1 << k) && at(x + RING_X[k]!, y + RING_Y[k]!) === LU_YARD) {
        const j = (y + RING_Y[k]!) * width + x + RING_X[k]!;
        // A plain link back to the path (the path cell draws the way into the yard).
        links.set(j, (links.get(j) ?? 0) | (1 << ((k + 4) & 7)));
        if (!terms.includes(j)) terms.push(j);
      }
  }
  if (terms.length === 0) {
    commit();
    return;
  }
  // Prim: grow a tree from the first unconnected terminal along shortest routes over yard cells.
  const inTree = new Set<number>();
  const done = new Set<number>();
  const dist = new Map<number, number>();
  const from = new Map<number, number>();
  const link = (a: number, b: number) => {
    const ax = a % width;
    const ay = (a / width) | 0;
    const dx = (b % width) - ax;
    const dy = ((b / width) | 0) - ay;
    for (let k = 0; k < 8; k++)
      if (RING_X[k] === dx && RING_Y[k] === dy) {
        links.set(a, (links.get(a) ?? 0) | (1 << k));
        links.set(b, (links.get(b) ?? 0) | (1 << ((k + 4) & 7)));
      }
  };
  for (const root of terms) {
    if (done.has(root)) continue;
    inTree.clear();
    inTree.add(root);
    done.add(root);
    for (;;) {
      // Shortest routes from the tree; the first unconnected terminal reached joins it.
      dist.clear();
      from.clear();
      const heap = new MinHeap();
      for (const c of inTree) {
        dist.set(c, 0);
        heap.push(0, c);
      }
      let hit = -1;
      while (heap.size > 0) {
        const c = heap.pop();
        const dc = dist.get(c)!;
        if (!inTree.has(c) && terms.includes(c) && !done.has(c)) {
          hit = c;
          break;
        }
        const x = c % width;
        const y = (c / width) | 0;
        for (let k = 0; k < 8; k++) {
          const nx = x + RING_X[k]!;
          const ny = y + RING_Y[k]!;
          if (at(nx, ny) !== LU_YARD) continue;
          // No cutting a corner of a house.
          if (k & 1 && (at(nx, y) !== LU_YARD || at(x, ny) !== LU_YARD)) continue;
          const j = ny * width + nx;
          const nd = dc + (k & 1 ? 1.45 : 1);
          if (nd < (dist.get(j) ?? Infinity)) {
            dist.set(j, nd);
            from.set(j, c);
            heap.push(nd, j);
          }
        }
      }
      if (hit < 0) break;
      done.add(hit);
      for (let c = hit; !inTree.has(c); ) {
        inTree.add(c);
        const p = from.get(c)!;
        link(c, p);
        c = p;
      }
    }
  }
  commit();

  function commit(): void {
    for (const [i, m] of links) {
      dst[4 * i + 2] = m;
      dst[4 * i + 3] = ends.get(i) ?? 0;
      dst[4 * i + 1] = square.has(i) ? SQUARE_WEAR : LANE_WEAR;
    }
  }
}
