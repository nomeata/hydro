import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/shared/rng';
import { Settlement } from '../../src/sim/people/settlement';
import { DAYS_PER_YEAR } from '../../src/sim/constants';

/**
 * Mock land: farm cells ranked best first with diminishing yields; a share
 * of people farm, each tending a few cells; one harvest per year; a little
 * fish income all year. Houses get built when wanted.
 */
function simulate(years: number, opts: { landScale?: number; disasterYear?: number; seed?: number } = {}) {
  const rng = new Rng(opts.seed ?? 1);
  const s = new Settlement(0, 0, 0, 5, 200);
  s.state.houses = 2;
  const L = 300 * (opts.landScale ?? 1);
  const popByYear: number[] = [];
  let houseTimer = 0;
  for (let day = 0; day < years * DAYS_PER_YEAR; day++) {
    const doy = day % DAYS_PER_YEAR;
    const year = Math.floor(day / DAYS_PER_YEAR);
    const pop = s.state.population;
    if (doy === s.state.harvestDay) {
      const farmers = Math.floor(pop * 0.6);
      const cells = farmers * 6;
      let food = 0;
      for (let k = 0; k < cells; k++) food += 30 * Math.exp(-k / L);
      s.bookFood(food);
    }
    if (doy < 36) s.bookFood(pop * 0.15); // fish/dairy outside winter
    if (s.wantsHouse() && ++houseTimer >= 4) {
      s.state.houses++;
      houseTimer = 0;
    }
    if (opts.disasterYear !== undefined && day === opts.disasterYear * DAYS_PER_YEAR + 10) {
      s.state.population = Math.floor(s.state.population / 2);
      s.state.food *= 0.3;
    }
    s.day(doy, rng);
    if (doy === DAYS_PER_YEAR - 1) popByYear.push(s.state.population);
  }
  return popByYear;
}

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const cv = (a: number[]) => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2))) / m;
};

describe('settlement economy', () => {
  it('grows from a family and settles to a stationary level', () => {
    for (const seed of [1, 2, 3]) {
      const pop = simulate(40, { seed });
      const late = pop.slice(20);
      expect(mean(late)).toBeGreaterThan(30);
      expect(cv(late)).toBeLessThan(0.15);
    }
  });

  it('carrying capacity follows the land', () => {
    const small = mean(simulate(40, { landScale: 0.5 }).slice(20));
    const big = mean(simulate(40, { landScale: 2 }).slice(20));
    expect(big).toBeGreaterThan(small * 1.4);
  });

  it('recovers from a disaster within a few years', () => {
    const base = mean(simulate(40).slice(15, 20));
    const pop = simulate(40, { disasterYear: 20 });
    expect(pop[20]!).toBeLessThan(base * 0.8);
    const recovered = pop.slice(21).findIndex((p) => p > base * 0.9);
    expect(recovered).toBeGreaterThanOrEqual(0);
    expect(recovered).toBeLessThanOrEqual(8);
  });
});
