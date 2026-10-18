import { describe, expect, it } from 'vitest';
import { FieldCrop, type SimTime } from '../../src/shared/protocol';
import { DAYS_PER_SEASON } from '../../src/sim/constants';
import { FARMING, HARDY, PEGS, PeopleSystem, kindGrowth, kindYield, milletGrowth } from '../../src/sim/people/village';
import { LandUse, SoilType, World } from '../../src/sim/world';

/**
 * Hardy crops and pegged plots (docs/PEOPLE.md §3.1): the daily field
 * decisions of a staged village on a flat 64² whose field moisture the test
 * sets directly.
 */
const N = 64;
const C = 32;

function setup(farmers: number, food: number): { w: World; p: PeopleSystem } {
  const w = new World(N, N, 1);
  for (let i = 0; i < w.size; i++) {
    w.bedrock[i] = 10;
    w.soil[i] = 1;
    w.soilType[i] = SoilType.Loam;
    w.fertility[i] = 0.8;
    w.vegetation[i] = 0.2;
  }
  const p = new PeopleSystem(w, 1, C, C);
  p.stage({
    x: C,
    y: C,
    food,
    houses: [],
    fields: [],
    people: Array.from({ length: farmers }, (_, k) => ({ x: C + 1, y: C + (k % 3), job: 'farmer' as const })),
  });
  return { w, p };
}

function time(season: number, dayOfSeason = 2): SimTime {
  return { step: 0, day: 400 + season * DAYS_PER_SEASON + dayOfSeason, year: 1, season, dayOfSeason, yearFrac: 0, timeOfDay: 0.5 };
}

/** One day's field decisions (moisture as set by the test, not recomputed). */
function manage(p: PeopleSystem, t: SimTime, days = 1): void {
  const q = p as unknown as { manageLand(s: unknown, t: SimTime): void };
  for (let d = 0; d < days; d++) q.manageLand(p.settlements[0], t);
}

function census(w: World, p: PeopleSystem): Record<'common' | 'millet' | 'paddy' | 'pegged', number[]> {
  const out = { common: [] as number[], millet: [] as number[], paddy: [] as number[], pegged: [] as number[] };
  for (let i = 0; i < w.size; i++) {
    const k = p.fieldCropAt(i);
    if (w.landuse[i] === LandUse.Field) (k === FieldCrop.Millet ? out.millet : k === FieldCrop.Paddy ? out.paddy : out.common).push(i);
    else if (k === FieldCrop.Pegged) out.pegged.push(i);
  }
  return out;
}

/** Marginal (dry) land everywhere but a small block of good land east of the store, and a shallow pond to the west. */
function shortLand(w: World, p: PeopleSystem, dry = 0.25): { good: number[]; pond: number[] } {
  p.fieldMoisture.fill(dry);
  const good: number[] = [];
  const pond: number[] = [];
  for (let y = C - 2; y <= C + 1; y++)
    for (let x = C + 5; x <= C + 7; x++) {
      const i = w.idx(x, y);
      p.fieldMoisture[i] = 0.6;
      good.push(i);
    }
  for (let y = C - 1; y <= C + 1; y++)
    for (let x = C - 9; x <= C - 7; x++) {
      const i = w.idx(x, y);
      w.water[i] = 0.1;
      p.fieldMoisture[i] = 0.8;
      pond.push(i);
    }
  return { good, pond };
}

describe('hardy crops', () => {
  it('are less picky and give less', () => {
    expect(milletGrowth(0.25)).toBeGreaterThan(FARMING.minGrowth);
    expect(kindGrowth(FieldCrop.Common, 0.25, 0)).toBeLessThan(FARMING.minGrowth);
    expect(kindGrowth(FieldCrop.Paddy, 0.3, 0.1)).toBe(1);
    expect(kindGrowth(FieldCrop.Common, 0.6, 0.1)).toBeLessThan(0.5);
    expect(kindYield(FieldCrop.Millet)).toBeCloseTo(0.4);
    expect(kindYield(FieldCrop.Paddy)).toBeLessThan(0.5);
  });

  it('shortage: good land first, then millet on dry and paddies in shallow water, gently capped', () => {
    const { w, p } = setup(2, 0);
    const { good, pond } = shortLand(w, p);
    manage(p, time(0), 6);
    const c = census(w, p);
    for (const i of good) expect(c.common).toContain(i);
    expect(c.common.length).toBe(good.length);
    expect(c.millet.length).toBeGreaterThan(0);
    for (const i of c.paddy) expect(pond).toContain(i);
    const hardy = c.millet.length + c.paddy.length;
    expect(hardy).toBe(Math.floor(HARDY.base + HARDY.share * good.length));
    expect(c.pegged.length).toBe(0);
    // Where the dry land is too poor even for millet, the pond is laid out in paddies.
    const s2 = setup(2, 0);
    const land = shortLand(s2.w, s2.p, 0.05);
    manage(s2.p, time(0), 6);
    const c2 = census(s2.w, s2.p);
    expect(c2.millet.length).toBe(0);
    expect(c2.paddy.length).toBe(Math.min(land.pond.length, Math.floor(HARDY.base + HARDY.share * land.good.length)));
    for (const i of c2.paddy) expect(land.pond).toContain(i);
  });

  it('no hardy crops while the village has food enough to grow', () => {
    const { w, p } = setup(2, 1e5);
    shortLand(w, p);
    manage(p, time(0), 6);
    const c = census(w, p);
    expect(c.common.length).toBeGreaterThan(0);
    expect(c.millet.length + c.paddy.length).toBe(0);
  });

  it('improvement: hardy fields go back to the ordinary crop when the land is watered, a drained paddy to millet', () => {
    const { w, p } = setup(2, 0);
    const { pond } = shortLand(w, p);
    manage(p, time(0), 6);
    const before = census(w, p);
    expect(before.millet.length).toBeGreaterThan(1);
    // A young millet crop and a bare one: a canal now wets them well.
    const [young, bare] = before.millet;
    w.crop[young!] = 40;
    w.crop[bare!] = 0;
    for (const i of before.millet) p.fieldMoisture[i] = 0.8;
    // The pond is drained; the land there stays marginal.
    for (const i of pond) {
      w.water[i] = 0;
      p.fieldMoisture[i] = 0.25;
    }
    manage(p, time(0, 3));
    const after = census(w, p);
    expect(after.common).toContain(young);
    expect(after.common).toContain(bare);
    expect(w.crop[young!]).toBe(0); // ploughed under, to be sown with the ordinary crop
    expect(after.millet.filter((i) => before.millet.includes(i))).toEqual([]);
    for (const i of before.paddy) expect(after.millet).toContain(i);
    // A crop well on its way is left to ripen; it is changed after the harvest.
    const { w: w2, p: p2 } = setup(2, 0);
    shortLand(w2, p2);
    manage(p2, time(0), 6);
    const m = census(w2, p2).millet[0]!;
    w2.crop[m] = 150;
    p2.fieldMoisture[m] = 0.8;
    manage(p2, time(1, 10));
    expect(p2.fieldCropAt(m)).toBe(FieldCrop.Millet);
    w2.crop[m] = 0;
    manage(p2, time(1, 11));
    expect(p2.fieldCropAt(m)).toBe(FieldCrop.Common);
  });

  it('a wet spring alone does not turn millet into the ordinary crop', () => {
    const { w, p } = setup(2, 0);
    shortLand(w, p);
    manage(p, time(0), 6);
    const millet = census(w, p).millet;
    for (const i of millet) p.fieldMoisture[i] = 0.4; // good enough to claim as ordinary land, not to give up millet
    manage(p, time(0, 4));
    for (const i of millet) expect(p.fieldCropAt(i)).toBe(FieldCrop.Millet);
  });
});

describe('pegged plots', () => {
  it('surplus: the best few unclaimed good plots are pegged, and claimed first when a farmer comes', () => {
    const { w, p } = setup(1, 1e5);
    p.fieldMoisture.fill(0.6);
    manage(p, time(0), 4);
    const c = census(w, p);
    expect(c.common.length).toBe(FARMING.fieldsPerFarmer);
    expect(c.millet.length + c.paddy.length).toBe(0);
    expect(c.pegged.length).toBe(PEGS.max);
    expect(p.settlements[0]!.state.pegs).toEqual(expect.arrayContaining(c.pegged));
    // Pegged land is not ploughed.
    for (const i of c.pegged) expect(w.landuse[i]).toBe(LandUse.None);
    // A second farmer: the pegged plots are the first new fields.
    const a = p.agents[0]!;
    p.agents.push({ ...a, id: 999, path: [] });
    manage(p, time(0, 5));
    for (const i of c.pegged) expect(w.landuse[i]).toBe(LandUse.Field);
  });

  it('not without surplus: neither when land is short nor when good land and hands match', () => {
    const { w, p } = setup(2, 0);
    shortLand(w, p);
    manage(p, time(0), 4);
    expect(census(w, p).pegged.length).toBe(0);
    expect(p.settlements[0]!.state.pegs).toBeUndefined();
  });

  it('hardy fields and pegs are saved and restored', () => {
    const { w, p } = setup(2, 0);
    shortLand(w, p);
    manage(p, time(0), 6);
    const st = p.getState();
    expect(st.hardy!.length).toBeGreaterThan(0);
    const q = new PeopleSystem(w, 1, C, C);
    q.setState(JSON.parse(JSON.stringify(st)));
    for (let i = 0; i < w.size; i++) expect(q.fieldCropAt(i)).toBe(p.fieldCropAt(i));
    // Old saves: no hardy fields, no pegs.
    const old = JSON.parse(JSON.stringify(st));
    delete old.hardy;
    q.setState(old);
    for (let i = 0; i < w.size; i++) if (w.landuse[i] === LandUse.Field) expect(q.fieldCropAt(i)).toBe(FieldCrop.Common);
    const { w: w2, p: p2 } = setup(1, 1e5);
    p2.fieldMoisture.fill(0.6);
    manage(p2, time(0), 4);
    const q2 = new PeopleSystem(w2, 1, C, C);
    q2.setState(p2.getState());
    for (let i = 0; i < w2.size; i++) expect(q2.fieldCropAt(i)).toBe(p2.fieldCropAt(i));
  });
});
