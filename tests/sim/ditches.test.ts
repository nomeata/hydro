import { describe, expect, it } from 'vitest';
import { DITCH, chooseDitch } from '../../src/sim/people/ditches';
import { CellFlag, LandUse, SoilType, World } from '../../src/sim/world';

/**
 * A 48² flat with a player's canal along x = 24 (dug 1 m, 0.6 m of water)
 * and dry fields east of it.
 */
function flat(): { w: World; moisture: Float32Array } {
  const n = 48;
  const w = new World(n, n, 1);
  const moisture = new Float32Array(n * n).fill(0.25);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = w.idx(x, y);
      w.bedrock[i] = 9;
      w.soil[i] = 1;
      w.soilType[i] = SoilType.Loam;
      w.fertility[i] = 0.7;
      if (x === 24) {
        w.soil[i] = 0;
        w.water[i] = 0.6;
        w.flags[i] |= CellFlag.Canal;
      } else if (x > 26 && x < 40) w.landuse[i] = LandUse.Field;
    }
  return { w, moisture };
}

describe('field ditches', () => {
  it('run from the canal into the dry fields, their floor just below its water', () => {
    const { w, moisture } = flat();
    const d = chooseDitch(w, 30, 24, moisture, () => true, () => false, 0.4);
    expect(d).not.toBeNull();
    expect(d!.cells.length).toBeGreaterThanOrEqual(DITCH.minLen);
    expect(d!.cells.length).toBeLessThanOrEqual(DITCH.maxLen);
    const surface = 9 + 0.6;
    expect(d!.floor).toBeCloseTo(surface - DITCH.belowSurface, 5);
    // A straight line off the canal, next to it first.
    const x0 = d!.cells[0]! % w.width;
    expect(Math.abs(x0 - 24)).toBe(1);
    const y = (d!.cells[0]! / w.width) | 0;
    for (const c of d!.cells) expect((c / w.width) | 0).toBe(y);
  });

  it('not where the land is wet already, nor where the canal is dry', () => {
    const { w, moisture } = flat();
    moisture.fill(0.6);
    expect(chooseDitch(w, 30, 24, moisture, () => true, () => false, 0.4)).toBeNull();
    const dry = flat();
    for (let i = 0; i < dry.w.size; i++) dry.w.water[i] = 0;
    expect(chooseDitch(dry.w, 30, 24, dry.moisture, () => true, () => false, 0.4)).toBeNull();
  });

  it('not up a slope it would have to cut deep into', () => {
    const { w, moisture } = flat();
    for (let i = 0; i < w.size; i++) if ((w.flags[i]! & CellFlag.Canal) === 0) w.bedrock[i] = 11;
    expect(chooseDitch(w, 30, 24, moisture, () => true, () => false, 0.4)).toBeNull();
  });
});
