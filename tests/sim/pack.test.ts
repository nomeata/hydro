import { describe, expect, it } from 'vitest';
import { STEPS_PER_DAY } from '../../src/sim/constants';
import { thetaForSteps } from '../../src/sim/hydro/inertial';
import { newGame } from '../../src/sim/newgame';
import { WaterPacker, type WaterBuffers } from '../../src/sim/pack';

const buffers = (id: number, size: number): WaterBuffers => ({ id, depth: new Float32Array(size), vel: new Int8Array(size * 2) });

describe('snapshot packing', () => {
  it('packs only the active rows into a pooled buffer, and the result is the whole map', () => {
    const { sim } = newGame(4, 256);
    expect(sim.active.all).toBe(false);
    const packer = new WaterPacker();
    const pool = [0, 1, 2].map((id) => buffers(id, sim.world.size));
    // Over a day boundary (the active set may grow there), snapshots every 20 steps.
    for (let s = 0; s < 1.3 * STEPS_PER_DAY; s += 20) {
      sim.run(20);
      const set = pool[(s / 20) % 3]!;
      packer.pack(sim, set);
      const ref = buffers(9, sim.world.size);
      new WaterPacker().pack(sim, ref);
      expect(Buffer.compare(Buffer.from(set.depth.buffer), Buffer.from(ref.depth.buffer))).toBe(0);
      expect(Buffer.compare(Buffer.from(set.vel.buffer), Buffer.from(ref.vel.buffer))).toBe(0);
    }
  }, 60_000);

  it('surface volume over the active rows matches the whole map', () => {
    const { sim } = newGame(4, 256);
    sim.run(300);
    let s = 0;
    for (let i = 0; i < sim.world.size; i++) s += sim.world.water[i]!;
    expect(sim.surfaceVolume() / 25).toBeCloseTo(s, 3);
    sim.run(300);
    s = 0;
    for (let i = 0; i < sim.world.size; i++) s += sim.world.water[i]!;
    expect(sim.surfaceVolume() / 25).toBeCloseTo(s, 3);
  }, 60_000);
});

describe('flow sub-steps', () => {
  it('keep the smoothing per second of the old step rule', () => {
    expect(thetaForSteps(0.8, 3, 3)).toBe(0.8);
    // (1 − θ) per step × steps per second stays the same.
    expect((1 - thetaForSteps(0.8, 3, 2)) * 2).toBeCloseTo(0.2 * 3, 12);
    expect((1 - thetaForSteps(0.8, 2, 1)) * 1).toBeCloseTo(0.2 * 2, 12);
    // Never below 0.5.
    expect(thetaForSteps(0.8, 6, 1)).toBe(0.5);
  });
});
