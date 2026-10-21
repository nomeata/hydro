import { describe, expect, it } from 'vitest';
import { mounds, type SnowPile } from '../../src/render/village/snowPiles';

/** Snow banks are drawn as a few low, broad mounds per bank (render/village/snowPiles.ts). */
describe('snow pile mounds', () => {
  it('strings a few low, broad, overlapping mounds along a bank', () => {
    const bank: SnowPile[] = Array.from({ length: 12 }, (_, k) => ({ x: 10 + k, y: 5, swe: 0.02 }));
    const ms = mounds(bank);
    expect(ms.length).toBeGreaterThanOrEqual(2);
    expect(ms.length).toBeLessThanOrEqual(7);
    ms.sort((a, b) => a.x - b.x);
    for (const m of ms) {
      // Low and broad: far wider (m) than high.
      expect(m.h / (m.b * 5)).toBeLessThan(0.2);
      expect(m.a).toBeGreaterThanOrEqual(m.b * 0.9);
      // Along the bank (x).
      expect(Math.abs(Math.cos(m.ang))).toBeGreaterThan(0.9);
    }
    // Neighbours overlap: one continuous bank.
    for (let k = 1; k < ms.length; k++) expect(ms[k]!.x - ms[k - 1]!.x).toBeLessThan(ms[k]!.a + ms[k - 1]!.a);
  });

  it('leaves out banks holding too little snow', () => {
    expect(mounds([{ x: 3, y: 3, swe: 0.01 }])).toEqual([]);
    expect(mounds([{ x: 3, y: 3, swe: 0.025 }, { x: 4, y: 4, swe: 0.025 }]).length).toBe(1);
  });
});
