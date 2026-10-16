import { describe, expect, it } from 'vitest';
import { rayBox, rayMarchHeightfield } from '../../src/render/picking';
import { HeightField } from '../../src/render/heights';
import { packPlan, PLAN_NONE } from '../../src/render/textures';

const box = { minX: 0, maxX: 100, minY: -10, maxY: 60, minZ: 0, maxZ: 100 };

describe('rayBox', () => {
  it('finds entry and exit', () => {
    const r = rayBox({ x: -10, y: 5, z: 50 }, { x: 1, y: 0, z: 0 }, box);
    expect(r).not.toBeNull();
    expect(r![0]).toBeCloseTo(10);
    expect(r![1]).toBeCloseTo(110);
  });
  it('misses', () => {
    expect(rayBox({ x: -10, y: 100, z: 50 }, { x: 1, y: 0, z: 0 }, box)).toBeNull();
    expect(rayBox({ x: -10, y: 5, z: 50 }, { x: -1, y: 0, z: 0 }, box)).toBeNull();
  });
});

describe('rayMarchHeightfield', () => {
  it('hits a flat plane exactly', () => {
    const hit = rayMarchHeightfield({ x: 10, y: 50, z: 10 }, { x: 1, y: -1, z: 0.5 }, () => 2, box);
    expect(hit).not.toBeNull();
    expect(hit!.y).toBeCloseTo(2, 4);
    expect(hit!.x).toBeCloseTo(58, 3);
    expect(hit!.z).toBeCloseTo(34, 3);
  });

  it('hits the front of a hill rather than the ground behind it', () => {
    // A ridge at x in [40, 50] of height 20; ground 0 elsewhere.
    const f = (x: number): number => (x >= 40 && x <= 50 ? 20 : 0);
    const hit = rayMarchHeightfield({ x: 0, y: 40, z: 50 }, { x: 1, y: -0.5, z: 0 }, f, box, 0.25);
    expect(hit).not.toBeNull();
    // The ray is at y=20 at x=40, i.e. it hits the ridge face at x≈40.
    expect(hit!.x).toBeGreaterThan(39.7);
    expect(hit!.x).toBeLessThan(40.3);
  });

  it('works for a vertical ray', () => {
    const hit = rayMarchHeightfield({ x: 30, y: 50, z: 30 }, { x: 0, y: -1, z: 0 }, (x, z) => x * 0.1 + z * 0.1, box);
    expect(hit!.y).toBeCloseTo(6, 4);
  });

  it('returns null when the ray leaves the field without hitting', () => {
    expect(rayMarchHeightfield({ x: 10, y: 50, z: 10 }, { x: 1, y: 0.1, z: 0 }, () => 0, box)).toBeNull();
  });

  it('agrees with a HeightField surface', () => {
    const hf = new HeightField(8, 8);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) hf.terrain[y * 8 + x] = x * 2;
    hf.recomputeRange();
    const hit = rayMarchHeightfield(
      { x: 3, y: 30, z: 3 },
      { x: 0.2, y: -1, z: 0.1 },
      (x, z) => hf.surfaceAt(x, z),
      { minX: 0, maxX: 7, minY: 0, maxY: 40, minZ: 0, maxZ: 7 },
      0.1,
    );
    expect(hit).not.toBeNull();
    expect(hit!.y).toBeCloseTo(hf.terrainAt(hit!.x, hit!.z), 3);
  });
});

describe('HeightField', () => {
  const hf = new HeightField(4, 3);
  hf.terrain.set([0, 1, 2, 3, 10, 11, 12, 13, 20, 21, 22, 23]);
  hf.depth.set([0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0]);
  hf.recomputeRange();

  it('interpolates bilinearly with cell centres at integers', () => {
    expect(hf.terrainAt(1, 1)).toBeCloseTo(11);
    expect(hf.terrainAt(1.5, 1)).toBeCloseTo(11.5);
    expect(hf.terrainAt(1.5, 1.5)).toBeCloseTo(16.5);
    expect(hf.terrainAt(3, 2)).toBeCloseTo(23);
  });
  it('clamps outside the map', () => {
    expect(hf.terrainAt(-5, -5)).toBeCloseTo(0);
    expect(hf.terrainAt(10, 10)).toBeCloseTo(23);
  });
  it('samples depth at the nearest cell', () => {
    expect(hf.depthAt(1.4, 0.6)).toBe(5);
    expect(hf.depthAt(1.6, 1)).toBe(0);
    expect(hf.surfaceAt(1, 1)).toBeCloseTo(16);
  });
  it('tracks range and row updates', () => {
    expect(hf.minTerrain).toBe(0);
    expect(hf.maxTerrain).toBe(23);
    hf.setRows(1, 2, new Float32Array([50, 50, 50, 50]));
    expect(hf.terrainAt(2, 1)).toBe(50);
    expect(hf.maxTerrain).toBe(50);
  });
});

describe('packPlan', () => {
  it('maps NaN to the sentinel and reports presence', () => {
    const dst = new Float32Array(3);
    expect(packPlan(new Float32Array([NaN, 4, NaN]), dst)).toBe(true);
    expect([...dst]).toEqual([PLAN_NONE, 4, PLAN_NONE]);
    expect(packPlan(new Float32Array([NaN, NaN, NaN]), dst)).toBe(false);
  });
});
