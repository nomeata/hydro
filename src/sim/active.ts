/**
 * The active region (docs/ENDLESS.md §2, step 1): the 16² tiles (TILE) that
 * the simulation runs on. With the fog of war it is the revealed land
 * dilated by a margin of MARGIN_TILES tiles; without fog, every tile.
 * Cells outside are frozen: they keep their state and act as a fixed-level
 * boundary (the "halo") for the kernels, with the exchange across the edge
 * booked in the ledgers.
 *
 * The set is derived state: a pure function of `revealed` (as of the last
 * day boundary) and whether the fog is on, so it is not saved.
 *
 * Kernels loop over `spans`: per tile row, runs [tx0, tx1) of consecutive
 * active tiles, flattened as (ty, tx0, tx1) triples. `haloSpans` is the
 * same for the active set dilated by one tile (active + halo tiles).
 */
import { TILE } from './constants';

/** Margin around revealed land, in tiles (32 cells). */
export const MARGIN_TILES = 2;

export class ActiveSet {
  readonly width: number;
  readonly height: number;
  /** Tiles across and down. */
  readonly tw: number;
  readonly th: number;
  /** 1 = active, per tile. */
  readonly tile: Uint8Array;
  /** 1 = active or halo (within one tile of an active tile), per tile. */
  readonly near: Uint8Array;
  /** Flattened (ty, tx0, tx1) runs of active tiles. */
  spans: Int32Array = new Int32Array(0);
  /** The same for active + halo tiles. */
  haloSpans: Int32Array = new Int32Array(0);
  /** Active tiles. */
  count = 0;
  /** Every tile is active. */
  all = false;
  /** Incremented on every change (kernels re-initialise their halo scratch). */
  version = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.tw = Math.ceil(width / TILE);
    this.th = Math.ceil(height / TILE);
    this.tile = new Uint8Array(this.tw * this.th);
    this.near = new Uint8Array(this.tw * this.th);
    this.setAll();
  }

  /** Whether cell (x, y) is active. */
  at(x: number, y: number): boolean {
    return this.tile[((y / TILE) | 0) * this.tw + ((x / TILE) | 0)] === 1;
  }

  /** Whether cell i is active. */
  cell(i: number): boolean {
    const x = i % this.width;
    return this.at(x, (i - x) / this.width);
  }

  /** Make every tile active. */
  setAll(): void {
    if (this.all) return;
    this.tile.fill(1);
    this.commit();
  }

  /** Revealed tiles (any cell with revealed > 0), dilated by `margin` tiles. Tiles never deactivate here. */
  setFromRevealed(revealed: Uint8Array, margin = MARGIN_TILES): void {
    const { tw, th, width: W, height: H } = this;
    const seen = new Uint8Array(tw * th);
    for (let y = 0; y < H; y++) {
      const ty = (y / TILE) | 0;
      const row = y * W;
      for (let tx = 0; tx < tw; tx++) {
        const t = ty * tw + tx;
        if (seen[t]) continue;
        const x1 = Math.min(W, (tx + 1) * TILE);
        for (let x = tx * TILE; x < x1; x++)
          if (revealed[row + x]! > 0) {
            seen[t] = 1;
            break;
          }
      }
    }
    const next = dilate(seen, tw, th, margin);
    let same = !this.all;
    for (let t = 0; t < next.length && same; t++) if (next[t] !== this.tile[t]) same = false;
    if (same) return;
    this.tile.set(next);
    this.commit();
  }

  /** Set an explicit tile mask (tests, tools). */
  setTiles(mask: Uint8Array): void {
    this.tile.set(mask);
    this.commit();
  }

  private commit(): void {
    const { tw, th, tile } = this;
    let n = 0;
    for (let t = 0; t < tile.length; t++) n += tile[t]!;
    this.count = n;
    this.all = n === tile.length;
    this.near.set(dilate(tile, tw, th, 1));
    this.spans = runs(tile, tw, th);
    this.haloSpans = runs(this.near, tw, th);
    this.version++;
  }

  /** Active cells (clipped to the map). */
  cells(): number {
    let n = 0;
    const s = this.spans;
    for (let k = 0; k < s.length; k += 3) {
      const h = Math.min(this.height, (s[k]! + 1) * TILE) - s[k]! * TILE;
      const w = Math.min(this.width, s[k + 2]! * TILE) - s[k + 1]! * TILE;
      n += h * w;
    }
    return n;
  }

  /** A short description (benchmarks). */
  stats(): string {
    return `active ${((100 * this.count) / this.tile.length).toFixed(0)} % of tiles`;
  }
}

function dilate(src: Uint8Array, tw: number, th: number, r: number): Uint8Array {
  if (r <= 0) return src.slice();
  // Separable square dilation.
  const tmp = new Uint8Array(src.length);
  for (let ty = 0; ty < th; ty++)
    for (let tx = 0; tx < tw; tx++) {
      if (!src[ty * tw + tx]) continue;
      for (let x = Math.max(0, tx - r); x <= Math.min(tw - 1, tx + r); x++) tmp[ty * tw + x] = 1;
    }
  const out = new Uint8Array(src.length);
  for (let ty = 0; ty < th; ty++)
    for (let tx = 0; tx < tw; tx++) {
      if (!tmp[ty * tw + tx]) continue;
      for (let y = Math.max(0, ty - r); y <= Math.min(th - 1, ty + r); y++) out[y * tw + tx] = 1;
    }
  return out;
}

function runs(mask: Uint8Array, tw: number, th: number): Int32Array {
  const out: number[] = [];
  for (let ty = 0; ty < th; ty++) {
    let tx = 0;
    while (tx < tw) {
      if (!mask[ty * tw + tx]) {
        tx++;
        continue;
      }
      const a = tx;
      while (tx < tw && mask[ty * tw + tx]) tx++;
      out.push(ty, a, tx);
    }
  }
  return Int32Array.from(out);
}
