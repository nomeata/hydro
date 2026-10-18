import { describe, expect, it } from 'vitest';
import { SoilType, World } from '../../src/sim/world';
import { Simulation } from '../../src/sim/sim';
import { DAYS_PER_SEASON, STEPS_PER_DAY } from '../../src/sim/constants';
import { snowCoverByte } from '../../src/sim/hydro/soilwater';
import { LOOK_CHANNELS } from '../../src/shared/protocol';

/** A flat loamy meadow 20 m above sea level. */
function meadow(n = 48): World {
  const w = new World(n, n, 5);
  for (let i = 0; i < w.size; i++) {
    w.bedrock[i] = 20;
    w.soil[i] = 1.5;
    w.soilType[i] = SoilType.Loam;
    w.vegetation[i] = 0.4;
  }
  return w;
}

function meanCover(sim: Simulation): number {
  const look = new Uint8Array(sim.world.size * LOOK_CHANNELS);
  sim.computeLook(look);
  let s = 0;
  for (let i = 0; i < sim.world.size; i++) s += look[i * LOOK_CHANNELS + 3]!;
  return s / sim.world.size / 255;
}

describe('snow', () => {
  it('cover saturates in the water depth: a few millimetres already read as snow', () => {
    expect(snowCoverByte(0)).toBe(0);
    expect(snowCoverByte(0.001)).toBeGreaterThan(30);
    expect(snowCoverByte(0.005)).toBeGreaterThan(150);
    expect(snowCoverByte(0.03)).toBeGreaterThan(250);
    for (let s = 0; s < 0.03; s += 0.001) expect(snowCoverByte(s + 0.001)).toBeGreaterThanOrEqual(snowCoverByte(s));
  });

  it('a winter front whitens the meadow, and spring melts it', () => {
    const w = meadow();
    const sim = new Simulation(w, 1);
    sim.weather.autoFronts = false;
    // Mid-winter (season 3, day 4).
    sim.step = (3 * DAYS_PER_SEASON + 4) * STEPS_PER_DAY;
    sim.weather.addFront({ x: 24, y: 24, rx: 200, ry: 200, angle: 0, vx: 0, vy: 0, life: 2 * STEPS_PER_DAY, peak: 1 });
    sim.run(2 * STEPS_PER_DAY);
    expect(sim.ledger.snowfall).toBeGreaterThan(0);
    expect(sim.ledger.snowfall).toBeGreaterThan(10 * sim.ledger.rain);
    expect(meanCover(sim)).toBeGreaterThan(0.6);
    // It lies through the cold days that follow.
    sim.run(2 * STEPS_PER_DAY);
    expect(meanCover(sim)).toBeGreaterThan(0.5);
    // Into spring: gone.
    sim.run(10 * STEPS_PER_DAY);
    expect(sim.time.season).toBe(0);
    expect(meanCover(sim)).toBeLessThan(0.05);
  }, 60_000);
});
