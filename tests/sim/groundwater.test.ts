import { describe, expect, it } from 'vitest';
import { SOIL_PROPS, SoilType, World } from '../../src/sim/world';
import { GroundwaterScratch, groundwaterStep } from '../../src/sim/hydro/groundwater';

function plain(n: number, type = SoilType.Loam): World {
  const w = new World(n, n, 1);
  for (let i = 0; i < w.size; i++) {
    w.soil[i] = 2;
    w.soilType[i] = type;
    w.ground[i] = 0.2;
  }
  return w;
}

const total = (w: World) => w.ground.reduce((a, b) => a + b, 0);

describe('lateral groundwater', () => {
  it('conserves water and keeps a flat table flat', () => {
    const w = plain(32);
    const s = new GroundwaterScratch(w.size);
    const t0 = total(w);
    for (let k = 0; k < 200; k++) groundwaterStep(w, s);
    expect(Math.abs(total(w) - t0) / t0).toBeLessThan(1e-4);
    expect(Math.max(...w.ground) - Math.min(...w.ground)).toBeLessThan(1e-5);
  });

  it('spreads water from a canal into the soil beside it', () => {
    const w = plain(40);
    const s = new GroundwaterScratch(w.size);
    const cap = 2 * SOIL_PROPS[SoilType.Loam]!.porosity;
    // A canal keeps column x = 20 saturated (as infiltration would).
    for (let hour = 0; hour < 24 * 12; hour++) {
      for (let y = 0; y < 40; y++) w.ground[w.idx(20, y)] = cap;
      groundwaterStep(w, s);
    }
    const near = w.ground[w.idx(22, 20)]! / cap;
    const far = w.ground[w.idx(34, 20)]! / cap;
    expect(near).toBeGreaterThan(0.45);
    expect(far).toBeLessThan(near);
    for (const g of w.ground) expect(g).toBeGreaterThanOrEqual(0);
  });

  it('drains a hillside towards the valley', () => {
    const w = plain(32, SoilType.Sand);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) w.bedrock[w.idx(x, y)] = x * 0.5;
    const s = new GroundwaterScratch(w.size);
    for (let k = 0; k < 500; k++) groundwaterStep(w, s);
    expect(w.ground[w.idx(1, 16)]!).toBeGreaterThan(w.ground[w.idx(30, 16)]!);
  });
});
