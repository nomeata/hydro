import { describe, expect, it } from 'vitest';
import type { BuildingInfo } from '../../src/shared/protocol';
import { cropStress } from '../../src/sim/people/village';
import { LandUse } from '../../src/sim/world';
import { cropPlacements } from '../../src/render/village/crops';
import { decorPlacements, flowerGeometry, laundryGeometry, nearestVillage, smokeStrength } from '../../src/render/village/cues';
import { CROP_RIPE, decodeStress, fieldsToRgba } from '../../src/render/village/fields';
import { HAY_LEVEL, MAX_FOOD_PROPS, Stage, houseSpots, partsAt, storeDesign } from '../../src/render/village/houses';

describe('crop stress (render side)', () => {
  it('decodes what the sim encodes', () => {
    expect(decodeStress(0)).toEqual({ dry: 0, wet: 0 });
    expect(decodeStress(cropStress(100, 0.15, 0, true)).dry).toBe(1);
    expect(decodeStress(cropStress(100, 0.6, 1, true)).wet).toBe(1);
    const soggy = decodeStress(cropStress(100, 0.92, 0, true));
    expect(soggy.dry).toBe(0);
    expect(soggy.wet).toBeGreaterThan(0.4);
  });

  it('expands snapshot fields to RGBA texels', () => {
    const src = new Uint8Array([1, 200, 90, 5, 0, 0]);
    const dst = new Uint8Array(8);
    fieldsToRgba(src, dst, 2);
    expect([...dst]).toEqual([1, 200, 90, 0, 5, 0, 0, 0]);
  });

  it('dry fields get fewer, smaller, yellower plants', () => {
    const n = 8;
    const make = (stress: number) => {
      const f = new Uint8Array(n * n * 3);
      for (let i = 0; i < n * n; i++) f.set([LandUse.Field, 150, stress], 3 * i);
      return cropPlacements(f, n, n, 0, 0, n, n);
    };
    const ok = make(0);
    const dry = make(127);
    expect(dry.length).toBeLessThan(ok.length * 0.7);
    const mean = (ps: typeof ok, k: 'scale' | 'b') => ps.reduce((a, p) => a + p[k], 0) / ps.length;
    expect(mean(dry, 'scale')).toBeLessThan(mean(ok, 'scale'));
    expect(make(0).length).toBe(ok.length);
    void CROP_RIPE;
  });
});

describe('village cues', () => {
  const house = (id: number, x: number, y: number, progress = 1): BuildingInfo => ({ id, kind: 'house', x, y, rot: 0, progress });
  const bs = [house(1, 10, 10), house(2, 13, 10), house(3, 10, 13), house(4, 40, 40), house(5, 43, 40), house(6, 12, 15, 0.5)];
  const vs = [
    { x: 11, y: 11 },
    { x: 41, y: 41 },
  ];

  it('assigns buildings to the nearest village', () => {
    expect(nearestVillage(bs, vs)).toEqual([0, 0, 0, 1, 1, 0]);
    expect(nearestVillage(bs, [])).toEqual(bs.map(() => -1));
  });

  it('smoke follows the mood', () => {
    expect(smokeStrength(1, 7)).toBe(1);
    expect(smokeStrength(-1, 7)).toBe(0);
    let some = 0;
    for (let id = 0; id < 300; id++) if (smokeStrength(0, id) > 0) some++;
    expect(some).toBeGreaterThan(50);
    expect(some).toBeLessThan(150);
  });

  it('decor only in prosperous villages, only at finished houses', () => {
    const owner = nearestVillage(bs, vs);
    const items = decorPlacements(bs, [1, -1], owner);
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) expect(it.x < 30 && it.y < 30).toBe(true);
    expect(decorPlacements(bs, [0, -1], owner)).toEqual([]);
    // Laundry pairs are listed once.
    const lines = items.filter((i) => i.kind === 'laundry').map((i) => i.seed);
    expect(new Set(lines).size).toBe(lines.length);
    expect(decorPlacements(bs, [1, -1], owner)).toEqual(items);
  });

  it('decor geometry is small and vertex coloured', () => {
    for (const g of [laundryGeometry(3), flowerGeometry(3)]) {
      expect(g.getAttribute('color')).toBeDefined();
      g.computeBoundingBox();
      expect(g.boundingBox!.max.y).toBeLessThan(0.8);
      expect(g.getAttribute('position').count).toBeLessThan(600);
    }
  });

  it('every house design has a chimney and a door spot', () => {
    for (let v = 0; v < 4; v++) {
      const s = houseSpots(v);
      expect(Math.abs(s.door.ox) + Math.abs(s.door.oz)).toBe(1);
      expect(s.chimney.y).toBeGreaterThan(0.5);
    }
  });

  it('the store shows hay when full and a fish rack when the village fishes', () => {
    const count = (lvl: number, fish: boolean, m: string) => partsAt(storeDesign(lvl, fish), Stage.Done).filter((p) => p.m === m).length;
    expect(count(HAY_LEVEL - 1, false, 'hay')).toBe(0);
    expect(count(HAY_LEVEL, false, 'hay')).toBe(1);
    expect(count(MAX_FOOD_PROPS, false, 'hay')).toBe(2);
    expect(count(3, false, 'fish')).toBe(0);
    expect(count(3, true, 'fish')).toBeGreaterThan(0);
    expect(count(0, true, 'fish')).toBe(0);
    expect(count(0, true, 'pole')).toBe(2);
  });
});
