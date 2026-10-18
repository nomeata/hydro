/**
 * Main-thread copy of the slowly changing world data (terrain, plans, look),
 * kept current from snapshots. Implements PlanGrid so tools can preview plans
 * with exactly the same rasterisation as the simulation.
 */
import { FIELD_BYTES, type Snapshot } from '../shared/protocol';
import { keepsPlan } from '../sim/plans/plans';
import type { PlanGrid } from '../sim/plans/plans';
import type { ReadyData } from './simClient';

export class WorldMirror implements PlanGrid {
  readonly width: number;
  readonly height: number;
  readonly terrainH: Float32Array;
  plan: Float32Array;
  look: Uint8Array;
  /** Fog of war (null: everything known). */
  revealed: Uint8Array | null;
  /** Land use per cell (from the fields snapshots; plans go round houses). */
  readonly landuse: Uint8Array;
  /** Cells the brushes leave alone (Snapshot.fixed; 1 = fixed). */
  fixed: Uint8Array;

  constructor(data: ReadyData) {
    this.width = data.info.width;
    this.height = data.info.height;
    this.terrainH = data.terrain.slice();
    this.plan = data.plan.slice();
    this.look = data.look.slice();
    this.revealed = data.revealed ? data.revealed.slice() : null;
    this.landuse = new Uint8Array(this.width * this.height);
    this.fixed = data.fixed ? data.fixed.slice() : new Uint8Array(this.width * this.height);
  }

  /** Whether the brushes leave cell i alone (as the sim decides: Simulation.isFixed). */
  isFixed(i: number): boolean {
    return this.fixed[i] === 1 || (this.revealed !== null && this.revealed[i]! < 128);
  }

  /** Whether cell (x, y) is known land (revealed ≥ 128). */
  isRevealed(x: number, y: number): boolean {
    const r = this.revealed;
    if (!r) return true;
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
    return r[y * this.width + x]! >= 128;
  }

  /**
   * Undo preview plan cells on unrevealed land and under houses and
   * footbridges (restores the current plan there), as the sim does.
   * Returns whether a house or footbridge was left out.
   */
  maskUnrevealed(plan: Float32Array): boolean {
    const r = this.revealed;
    if (r) for (let i = 0; i < r.length; i++) if (r[i]! < 128) plan[i] = this.plan[i]!;
    let houses = false;
    const lu = this.landuse;
    for (let i = 0; i < lu.length; i++) {
      if (lu[i] === 0 || keepsPlan(lu[i]!)) continue;
      if (plan[i] !== this.plan[i] && !(Number.isNaN(plan[i]!) && Number.isNaN(this.plan[i]!))) {
        plan[i] = this.plan[i]!;
        houses = true;
      }
    }
    return houses;
  }

  /** Whether the plan tools may plan cell i (not a house or footbridge). */
  plannable(i: number): boolean {
    return keepsPlan(this.landuse[i]!);
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
    if (s.revealed) this.revealed = s.revealed.slice();
    if (s.fixed) this.fixed = s.fixed.slice();
    if (s.fields) {
      const lu = this.landuse;
      for (let i = 0; i < lu.length; i++) lu[i] = s.fields[i * FIELD_BYTES]!;
    }
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
