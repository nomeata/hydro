import { describe, expect, it } from 'vitest';
import { CLIMATE, Climate, bigFreshet, seasonalInflow } from '../../src/sim/climate/climate';
import type { SimTime } from '../../src/shared/protocol';

const newYear = (year: number): SimTime => ({ year, season: 0 }) as SimTime;

describe('river climate', () => {
  it('big freshets: none in the first year, often in the next two (round 5), about one in four years after, likelier when wet', () => {
    let n = 0;
    let wet = 0;
    let dry = 0;
    let early = 0;
    for (let seed = 1; seed <= 200; seed++) {
      expect(bigFreshet(seed, 0, 0.5)).toBe(0);
      // The dry second year (a ≈ −0.35) or the third: the floodplain learns floods early.
      if (bigFreshet(seed, 1, -0.35) > 0 || bigFreshet(seed, 2, 0) > 0) early++;
      for (let year = 3; year < 13; year++) if (bigFreshet(seed, year, 0) > 0) n++;
      if (bigFreshet(seed, 5, 0.4) > 0) wet++;
      if (bigFreshet(seed, 5, -0.4) > 0) dry++;
    }
    const perYear = n / 2000;
    expect(perYear).toBeGreaterThan(1 / 5);
    expect(perYear).toBeLessThan(1 / 3);
    expect(wet).toBeGreaterThan(dry * 2);
    expect(early / 200).toBeGreaterThan(0.65);
    // Deterministic, and several times an ordinary freshet.
    expect(bigFreshet(7, 4, 0.1)).toBe(bigFreshet(7, 4, 0.1));
    const big = [...Array(200).keys()].map((s) => bigFreshet(s, 3, 0.3)).find((b) => b > 0)!;
    expect(big).toBeGreaterThanOrEqual(CLIMATE.bigFactor);
    const peak = (b: number) => Math.max(...[...Array(40).keys()].map((k) => seasonalInflow(k / 40 / 4, 1, b)));
    expect(peak(big)).toBeGreaterThan(2 * peak(0));
  });

  it('the second year is a dry one', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const c = new Climate(seed);
      c.update(newYear(1), 0);
      expect(c.yearFactor()).toBeLessThan(0.75);
    }
  });
});
