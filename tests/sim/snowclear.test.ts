import { describe, expect, it } from 'vitest';
import type { SimTime } from '../../src/shared/protocol';
import { CELL_AREA } from '../../src/sim/constants';
import { SiteKind } from '../../src/sim/people/agents';
import { PEOPLE_TICK, PeopleSystem, SNOW_CLEARING, clearSnow, snowPiles, type PeopleHost } from '../../src/sim/people/village';
import { PARAMS } from '../../src/sim/params';
import { LandUse, SoilType, World } from '../../src/sim/world';

/** Farmers shovel the snow off a field before they sow it (docs/PEOPLE.md §3.1). */
const N = 64;
const C = 32;

function flat(): World {
  const w = new World(N, N, 1);
  for (let i = 0; i < w.size; i++) {
    w.bedrock[i] = 10;
    w.soil[i] = 1;
    w.soilType[i] = SoilType.Loam;
    w.fertility[i] = 0.8;
    w.vegetation[i] = 0.2;
    w.ground[i] = 0.1;
  }
  return w;
}

const total = (w: World) => {
  let s = 0;
  for (let i = 0; i < w.size; i++) s += w.snow[i]! + w.water[i]! + w.ground[i]!;
  return s;
};

describe('clearing snow', () => {
  it('piles a cell’s snow beyond the field edge, or soaks it in, conserving water', () => {
    const w = flat();
    for (let y = 10; y <= 30; y++) for (let x = 10; x <= 30; x++) w.landuse[w.idx(x, y)] = LandUse.Field;
    w.snow.fill(0.03);
    const before = total(w);
    const edge = w.idx(10, 20);
    clearSnow(w, edge);
    expect(w.snow[edge]).toBe(0);
    expect(w.snow[w.idx(9, 20)]).toBeCloseTo(0.06, 6);
    // A bank holds at most SNOW_CLEARING.pile above the snow cleared; the rest spreads along the edge.
    for (let y = 10; y <= 30; y++) for (let x = 10; x <= 12; x++) clearSnow(w, w.idx(x, y));
    for (let i = 0; i < w.size; i++) expect(w.snow[i]).toBeLessThanOrEqual(0.03 + SNOW_CLEARING.pile + 1e-6);
    const inner = w.idx(20, 20);
    const g0 = w.ground[inner]!;
    clearSnow(w, inner);
    expect(w.snow[inner]).toBe(0);
    expect(w.ground[inner]).toBeCloseTo(g0 + 0.03, 6);
    expect(total(w)).toBeCloseTo(before, 6);
  });

  it('leaves piles that melt within a week at +10 °C', () => {
    const w = flat();
    for (let y = 10; y <= 30; y++) for (let x = 10; x <= 30; x++) w.landuse[w.idx(x, y)] = LandUse.Field;
    w.snow.fill(0.05);
    const banks = new Map<number, number>();
    for (let y = 10; y <= 30; y++) for (let x = 10; x <= 30; x++) clearSnow(w, w.idx(x, y), banks);
    // The banks are known (for drawing them), each holding at most `pile` above the snow around.
    const piles = snowPiles(w, banks);
    expect(piles.length).toBe(banks.size * 3);
    for (let k = 2; k < piles.length; k += 3) expect(piles[k]).toBeLessThanOrEqual(SNOW_CLEARING.pile + 1e-6);
    // Degree-day melt (soilwater.ts) at +10 °C, as on every cell.
    const perDay = PARAMS.meltPerDegreeDay * 10;
    const maxSnow = Math.max(...Array.from(w.snow));
    expect(maxSnow / perDay).toBeLessThan(7);
    for (let i = 0; i < w.size; i++) w.snow[i] = Math.max(0, w.snow[i]! - 2 * perDay);
    // Two warm days in, the land around is bare and only low banks remain, soon gone.
    expect(Math.max(...Array.from(w.snow)) / perDay).toBeLessThan(2);
  });

  it('comes before sowing in a snowy spring, and the fields get sown', () => {
    const w = flat();
    w.snow.fill(0.02);
    const p = new PeopleSystem(w, 1, C, C);
    p.stage({
      x: C,
      y: C,
      food: 200,
      houses: [],
      fields: [{ x0: C + 3, y0: C - 2, x1: C + 8, y1: C + 2, crop: 0 }],
      people: Array.from({ length: 3 }, (_, k) => ({ x: C + 1, y: C + k, job: 'farmer' as const })),
    });
    const fields: number[] = [];
    for (let i = 0; i < w.size; i++) if (w.landuse[i] === LandUse.Field) fields.push(i);
    p.fieldMoisture.fill(0.6);
    let used = 0;
    const host: PeopleHost = {
      terrainChanged() {},
      planChanged() {},
      planCells: () => [],
      waterUsed: (m3) => (used += m3),
      lined() {},
    };
    const before = total(w);
    const t: SimTime = { step: 0, day: 400 + 2, year: 1, season: 0, dayOfSeason: 2, yearFrac: 0.02, timeOfDay: 0.4 };
    let shovelled = false;
    let sownOnSnow = 0;
    for (let step = 0; step < 6000; step += PEOPLE_TICK) {
      p.tick(step, { ...t, step }, host);
      for (const a of p.agents) if (a.siteKind === SiteKind.ClearSnow && a.task !== 0) shovelled = true;
      for (const i of fields) if (w.crop[i]! > 0 && w.snow[i]! > SNOW_CLEARING.min) sownOnSnow++;
    }
    expect(shovelled).toBe(true);
    expect(sownOnSnow).toBe(0);
    const sown = fields.filter((i) => w.landuse[i] === LandUse.Field && w.crop[i]! > 0);
    expect(sown.length).toBeGreaterThan(fields.length * 0.8);
    for (const i of sown) expect(w.snow[i]).toBe(0);
    // The snow went to banks beyond the field.
    expect(Math.max(...Array.from(w.snow))).toBeGreaterThan(0.03);
    expect(p.snowBanks.size).toBeGreaterThan(0);
    for (const i of p.snowBanks.keys()) expect(w.landuse[i]).not.toBe(LandUse.Field);
    expect(snowPiles(w, p.snowBanks).length).toBeGreaterThan(0);
    // Saved and restored with the people.
    const q = new PeopleSystem(w, 1, C, C);
    q.setState(p.getState());
    expect([...q.snowBanks]).toEqual([...p.snowBanks]);
    expect(total(w) + used / CELL_AREA).toBeCloseTo(before, 3);
  }, 60_000);
});
