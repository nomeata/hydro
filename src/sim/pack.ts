/**
 * Snapshot packing shared by the worker (sim/worker.ts) and the profiler
 * (tools/perfgame.ts): depth and velocity (RG8 signed) into pooled buffers.
 */
import { VEL_SCALE } from '../shared/protocol';
import type { Simulation } from './sim';

export interface WaterBuffers {
  id: number;
  depth: Float32Array;
  vel: Int8Array;
}

/**
 * Remembers what each pooled buffer set holds outside the active land: the
 * frozen cells' depth and velocity as of (sim, active set version). Frozen
 * cells never change (docs/ENDLESS.md §12), so while both are unchanged only
 * the active rows are packed again. (The main thread only reads the
 * buffers before returning them.)
 */
export class WaterPacker {
  private readonly synced: ({ sim: Simulation; version: number } | null)[] = [];

  /** Forget what the buffers hold (something changed frozen cells): pack everything next time. */
  reset(): void {
    this.synced.length = 0;
  }

  pack(sim: Simulation, set: WaterBuffers): void {
    const w = sim.world;
    const act = sim.active;
    const was = this.synced[set.id];
    if (!act.all && was && was.sim === sim && was.version === act.version) {
      const rows = act.rows;
      const W = w.width;
      for (let r = 0; r < rows.length; r += 3) packCells(sim, set, rows[r]! * W + rows[r + 1]!, rows[r]! * W + rows[r + 2]!);
    } else {
      packCells(sim, set, 0, w.size);
      this.synced[set.id] = { sim, version: act.version };
    }
  }
}

/** Pack depth and velocity of the cells [a, b). */
function packCells(sim: Simulation, set: WaterBuffers, a: number, b: number): void {
  const { water, velX, velY } = sim.world;
  set.depth.set(water.subarray(a, b), a);
  const vel = set.vel;
  const k = 127 / VEL_SCALE;
  for (let i = a; i < b; i++) {
    const vx = Math.round(velX[i]! * k);
    const vy = Math.round(velY[i]! * k);
    vel[2 * i] = vx > 127 ? 127 : vx < -127 ? -127 : vx;
    vel[2 * i + 1] = vy > 127 ? 127 : vy < -127 ? -127 : vy;
  }
}
