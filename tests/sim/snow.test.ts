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

describe('snow on frozen land', () => {
  /** A ramp rising eastwards to 1200 m: the snow line is a north–south contour. */
  function ramp(n = 96): World {
    const w = new World(n, n, 5);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const i = w.idx(x, y);
        w.bedrock[i] = (1200 * x) / (n - 1);
        w.soil[i] = 1.5;
        w.soilType[i] = SoilType.Loam;
        w.vegetation[i] = 0.4;
      }
    return w;
  }

  it('follows elevation the same inside and outside the active land, without tile steps', () => {
    const w = ramp();
    const sim = new Simulation(w, 1);
    sim.weather.autoFronts = false;
    sim.weather.updateElevation();
    // Only the northern third is known (and so simulated).
    sim.fog = true;
    for (let y = 0; y < 16; y++) for (let x = 0; x < w.width; x++) w.revealed[w.idx(x, y)] = 255;
    sim.updateActive();
    expect(sim.active.at(10, 20)).toBe(true);
    expect(sim.active.at(10, 70)).toBe(false);
    // Late winter: the valley floor thaws, the heights stay white.
    sim.step = (3 * DAYS_PER_SEASON + 10) * STEPS_PER_DAY;
    sim.weather.addFront({ x: 48, y: 48, rx: 300, ry: 300, angle: 0.3, vx: 0, vy: 0, life: 2 * STEPS_PER_DAY, peak: 1 });
    sim.run(4 * STEPS_PER_DAY);
    const s = (x: number, y: number) => w.snow[w.idx(x, y)]!;
    // Snow on the heights, both in the active north and the frozen south.
    expect(s(90, 10)).toBeGreaterThan(0.005);
    expect(s(90, 80)).toBeGreaterThan(0.005);
    // The same depth at the same height, whether simulated in full or not.
    for (let x = 0; x < w.width; x += 5) expect(Math.abs(s(x, 20) - s(x, 70))).toBeLessThanOrEqual(0.15 * Math.max(s(x, 20), s(x, 70)) + 1e-4);
    // The snow line is a contour: more snow uphill, none on the warm floor.
    expect(s(5, 50)).toBeLessThan(0.25 * s(90, 50));
    // No steps across tile edges (rain is interpolated between tile centres).
    for (let x = 0; x < w.width; x += 3)
      for (let y = 1; y < w.height - 1; y++) {
        const d = Math.abs(s(x, y + 1) - s(x, y));
        expect(d).toBeLessThanOrEqual(0.03 * Math.max(s(x, y), s(x, y + 1)) + 1e-5);
      }
    // The snow on frozen land is booked apart (it does not count as the valley's precipitation).
    expect(sim.ledger.frozenSnow).toBeGreaterThan(0);
  }, 60_000);
});
