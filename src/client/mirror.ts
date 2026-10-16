/**
 * Main-thread copy of the slowly changing world data (terrain, plans, look),
 * kept current from snapshots. Implements PlanGrid so tools can preview plans
 * with exactly the same rasterisation as the simulation.
 */
import type { Snapshot } from '../shared/protocol';
import type { PlanGrid } from '../sim/plans/plans';
import type { ReadyData } from './simClient';

export class WorldMirror implements PlanGrid {
  readonly width: number;
  readonly height: number;
  readonly terrainH: Float32Array;
  plan: Float32Array;
  look: Uint8Array;

  constructor(data: ReadyData) {
    this.width = data.info.width;
    this.height = data.info.height;
    this.terrainH = data.terrain.slice();
    this.plan = data.plan.slice();
    this.look = data.look.slice();
  }

  idx(x: number, y: number): number {
    return y * this.width + x;
  }

  terrain(i: number): number {
    return this.terrainH[i]!;
  }

  apply(s: Snapshot): void {
    if (s.terrain) this.terrainH.set(s.terrain.data, s.terrain.y0 * this.width);
    if (s.plan) this.plan = s.plan.slice();
    if (s.look) this.look = s.look.slice();
  }

  /** A grid whose plan array is a scratch copy, for previews. */
  previewGrid(): PlanGrid {
    return {
      width: this.width,
      height: this.height,
      plan: this.plan.slice(),
      idx: (x, y) => y * this.width + x,
      terrain: (i) => this.terrainH[i]!,
    };
  }
}
