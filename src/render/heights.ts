/**
 * CPU copy of the terrain heightfield (and current water depth), used for
 * picking, camera height following and by animation layers.
 *
 * Fractional cell coordinates: cell index i has its centre at coordinate i
 * (so `Math.round(c)` is the cell index) and at three.js x = c + 0.5.
 */
import type { HeightSampler } from './coords';

export class HeightField implements HeightSampler {
  readonly width: number;
  readonly height: number;
  /** Terrain height (m) per cell, row-major. Updated in place by the renderer. */
  readonly terrain: Float32Array;
  /** Water depth (m) per cell of the latest snapshot. */
  readonly depth: Float32Array;
  minTerrain = 0;
  maxTerrain = 0;

  constructor(width: number, height: number, terrain?: Float32Array) {
    this.width = width;
    this.height = height;
    this.terrain = new Float32Array(width * height);
    this.depth = new Float32Array(width * height);
    if (terrain) this.terrain.set(terrain.subarray(0, width * height));
    this.recomputeRange();
  }

  recomputeRange(): void {
    let lo = Infinity;
    let hi = -Infinity;
    const t = this.terrain;
    for (let i = 0; i < t.length; i++) {
      const v = t[i]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    this.minTerrain = Number.isFinite(lo) ? lo : 0;
    this.maxTerrain = Number.isFinite(hi) ? hi : 0;
  }

  /** Copy terrain rows [y0, y1) from `data` (which holds exactly those rows). */
  setRows(y0: number, y1: number, data: Float32Array): void {
    const w = this.width;
    this.terrain.set(data.subarray(0, (y1 - y0) * w), y0 * w);
    for (let i = 0; i < data.length && i < (y1 - y0) * w; i++) {
      const v = data[i]!;
      if (v < this.minTerrain) this.minTerrain = v;
      if (v > this.maxTerrain) this.maxTerrain = v;
    }
  }

  terrainAt(cx: number, cy: number): number {
    const w = this.width;
    const h = this.height;
    const x = Math.min(Math.max(cx, 0), w - 1);
    const y = Math.min(Math.max(cy, 0), h - 1);
    const x0 = Math.min(Math.floor(x), w - 2 < 0 ? 0 : w - 2);
    const y0 = Math.min(Math.floor(y), h - 2 < 0 ? 0 : h - 2);
    const x1 = Math.min(x0 + 1, w - 1);
    const y1 = Math.min(y0 + 1, h - 1);
    const fx = x - x0;
    const fy = y - y0;
    const t = this.terrain;
    const a = t[y0 * w + x0]!;
    const b = t[y0 * w + x1]!;
    const c = t[y1 * w + x0]!;
    const d = t[y1 * w + x1]!;
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }

  depthAt(cx: number, cy: number): number {
    const x = Math.min(Math.max(Math.round(cx), 0), this.width - 1);
    const y = Math.min(Math.max(Math.round(cy), 0), this.height - 1);
    return this.depth[y * this.width + x]!;
  }

  /** Terrain + water surface height (m): bilinear terrain, nearest depth. */
  surfaceAt(cx: number, cy: number): number {
    return this.terrainAt(cx, cy) + this.depthAt(cx, cy);
  }
}
