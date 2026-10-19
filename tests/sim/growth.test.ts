import { describe, expect, it } from 'vitest';
import { DAYS_PER_SEASON, STEPS_PER_DAY } from '../../src/sim/constants';
import { loadGame, saveGame } from '../../src/sim/persist';
import { Task } from '../../src/sim/people/agents';
import { CAMP, ECONOMY, Settlement, campsFor, classifyGrowth, type GrowthFacts } from '../../src/sim/people/settlement';
import { Simulation } from '../../src/sim/sim';
import { LandUse, SoilType, World } from '../../src/sim/world';
import { CAMP_ID } from '../../src/shared/protocol';

const N = 64;

/** A 64² valley: a river along y ≈ 20, loamy flats to the south (ideas.test.ts style). */
function valley(): World {
  const w = new World(N, N, 11);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = w.idx(x, y);
      const dr = Math.abs(y - 20);
      const h = 30 + (N - x) * 0.01 + Math.min(3, dr * 0.5) - (dr <= 1 ? 1.2 : 0);
      w.bedrock[i] = h - 3;
      w.soil[i] = 3;
      w.soilType[i] = dr <= 2 ? SoilType.Sand : SoilType.Loam;
      w.ground[i] = 0.6;
      w.fertility[i] = 0.7;
      w.revealed[i] = 255;
    }
  return w;
}

/** A village at (30, 31): six houses, full (24 people), food for a long time. */
function village(people = 24): Simulation {
  const sim = new Simulation(valley(), 5, { people: { startX: 30, startY: 31 } });
  sim.people!.stage({
    x: 30,
    y: 31,
    food: 3000,
    houses: [
      { x: 27, y: 33 },
      { x: 33, y: 33 },
      { x: 30, y: 35 },
      { x: 27, y: 29 },
      { x: 34, y: 29 },
      { x: 36, y: 33 },
    ],
    fields: [{ x0: 22, y0: 37, x1: 38, y1: 40, crop: 40 }],
    people: Array.from({ length: people }, (_, k) => ({ x: 30 + (k % 4), y: 31 + ((k / 4) | 0) * 0.5, job: 'farmer' as const })),
  });
  sim.people!.fieldMoisture.fill(0.6);
  return sim;
}

/** Private hooks of the people system used here. */
interface Hooks {
  tendCamp(s: unknown, day: number): void;
  planHouses(s: unknown): void;
}

const facts = (f: Partial<GrowthFacts>): GrowthFacts => ({ wellbeing: 0.9, arriveAbove: 0.6, fed: 2, freeHouses: 0, building: false, goodLeft: 10, ...f });

describe('growth limits', () => {
  it('names what holds a village back, most binding first', () => {
    expect(classifyGrowth(facts({ freeHouses: 1 }))).toBe('open');
    expect(classifyGrowth(facts({ building: true }))).toBe('building');
    expect(classifyGrowth(facts({}))).toBe('room');
    expect(classifyGrowth(facts({ wellbeing: 0.55, freeHouses: 1 }))).toBe('wellbeing');
    // The store won't last: land if no good land is left, else poor yields.
    expect(classifyGrowth(facts({ fed: 0.8, freeHouses: 1 }))).toBe('food');
    expect(classifyGrowth(facts({ fed: 0.8, goodLeft: 0, freeHouses: 1 }))).toBe('land');
    expect(classifyGrowth(facts({ fed: ECONOMY.growFood, goodLeft: 0, freeHouses: 1 }))).toBe('open');
  });

  it('lets newcomers camp only when they would come but the village cannot take them', () => {
    expect(campsFor('room', 0.9, 0.6)).toBe(true);
    expect(campsFor('land', 0.9, 0.6)).toBe(true);
    expect(campsFor('land', 0.5, 0.6)).toBe(false);
    // A house going up: the next family waits at the edge for it (round 5: camps lead, houses follow).
    expect(campsFor('building', 0.9, 0.6, 20)).toBe(true);
    expect(campsFor('building', 0.9, 0.6, 6)).toBe(false);
    for (const l of ['open', 'food', 'wellbeing'] as const) expect(campsFor(l, 0.9, 0.6)).toBe(false);
  });

  it('draws families while crops stand, on spare food or spare good land (round 5)', () => {
    const s = new Settlement(0, 10, 10, 20, 0);
    const doy = 10; // spring: the harvest (day 29) is 19 days off
    const need = 20 * (s.daysToHarvest(doy) + 48 + 6);
    s.state.food = 20 * 30; // lasts to the harvest, but not the growth horizon: no window
    s.state.promiseBias = 1;
    expect(s.growSecurity(doy)).toBeLessThan(ECONOMY.growFood);
    expect(s.growth(doy)).toBe(0); // nothing stands in the fields
    // The crops promise just enough: no spare food, and no spare land.
    s.state.standing = need - s.state.food;
    expect(s.ahead(doy)).toBeCloseTo(1);
    expect(s.growth(doy)).toBe(0);
    // ...with spare good land: families come.
    s.state.spareLand = ECONOMY.spareFamily * ECONOMY.spareFamilies;
    expect(s.growth(doy)).toBe(1);
    s.state.spareLand = ECONOMY.spareFamily;
    expect(s.growth(doy)).toBeCloseTo(1 / ECONOMY.spareFamilies);
    // A poor harvest ahead: not even on spare land.
    s.state.standing = 0.8 * need - s.state.food;
    expect(s.growth(doy)).toBe(0);
    // A rich one: spare food alone draws them.
    delete s.state.spareLand;
    s.state.standing = (ECONOMY.spareAhead + 0.2) * need - s.state.food;
    expect(s.growth(doy)).toBeCloseTo(Math.min(1, (0.2 * need) / ECONOMY.spareFamily / ECONOMY.spareFamilies));
  });

  it('judges each village daily', () => {
    const sim = village(16);
    sim.run(STEPS_PER_DAY);
    const st = sim.people!.settlements[0]!.state;
    // Two houses free, plenty of food, good land about: open to newcomers (or one moved in already).
    expect(['open', 'building', 'room']).toContain(st.limit);
  });
});

describe('newcomers camping at the edge', () => {
  it('camp with cart and tent while there is no room, move in when a house is free, and are not villagers meanwhile', async () => {
    const sim = village();
    sim.run(STEPS_PER_DAY);
    const p = sim.people!;
    const s = p.settlements[0]!;
    const st = s.state;
    const hooks = p as unknown as Hooks;
    const pop = st.population;
    st.wellbeing = 0.9;
    st.limit = 'room';
    delete st.campAgain;
    hooks.tendCamp(s, 10);
    expect(st.camp).toBeDefined();
    const campers = () => p.agents.filter((a) => a.camper && a.task !== Task.Leave);
    const n = campers().length;
    expect(n).toBeGreaterThanOrEqual(2);
    expect(st.population).toBe(pop);
    // The camp is shown like a building, beyond where the houses stand.
    const info = p.buildingInfo().find((b) => b.kind === 'camp')!;
    expect(info.id).toBe(CAMP_ID + st.id);
    expect(Math.hypot(info.x - st.x, info.y - st.y)).toBeGreaterThanOrEqual(CAMP.dist - 1);
    // Saved with the game.
    const copy = (await loadGame(await saveGame(sim))).sim;
    expect(copy.people!.settlements[0]!.state.camp).toEqual(st.camp);
    expect(copy.people!.agents.filter((a) => a.camper).length).toBe(n);
    // Still no room a few days later: they wait.
    hooks.tendCamp(s, 14);
    expect(st.camp).toBeDefined();
    // A house is free: they move in.
    st.limit = 'open';
    hooks.tendCamp(s, 15);
    expect(st.camp).toBeUndefined();
    expect(st.population).toBe(pop + n);
    expect(campers().length).toBe(0);
    expect(p.buildingInfo().some((b) => b.kind === 'camp')).toBe(false);
  });

  it('move on after a while if nothing changes, and come back only later', () => {
    const sim = village();
    sim.run(STEPS_PER_DAY);
    const p = sim.people!;
    const s = p.settlements[0]!;
    const st = s.state;
    const hooks = p as unknown as Hooks;
    st.wellbeing = 0.9;
    st.limit = 'land';
    delete st.campAgain;
    hooks.tendCamp(s, 10);
    expect(st.camp).toBeDefined();
    const pop = st.population;
    hooks.tendCamp(s, 10 + CAMP.stay);
    expect(st.camp).toBeUndefined();
    expect(st.population).toBe(pop);
    expect(p.agents.filter((a) => a.camper).every((a) => a.task === Task.Leave)).toBe(true);
    hooks.tendCamp(s, 11 + CAMP.stay);
    expect(st.camp).toBeUndefined();
    hooks.tendCamp(s, 10 + CAMP.stay + CAMP.again);
    expect(st.camp).toBeDefined();
    // The village stops drawing people (hungry for a reason other than land): they leave at once.
    st.limit = 'food';
    hooks.tendCamp(s, 12 + CAMP.stay + CAMP.again);
    expect(st.camp).toBeUndefined();
  });

  it('camp on dry open ground, not on fields', () => {
    const sim = village();
    sim.run(STEPS_PER_DAY);
    const p = sim.people!;
    const s = p.settlements[0]!;
    s.state.wellbeing = 0.9;
    s.state.limit = 'room';
    (p as unknown as Hooks).tendCamp(s, 10);
    const c = s.state.camp!.cell;
    expect(sim.world.landuse[c]).toBe(LandUse.None);
    expect(sim.world.water[c]).toBeLessThan(0.01);
  });
});

describe('ideas point at the growth limit', () => {
  it('suggests watering the dry ground when the good land is used up, and room when houses have none', () => {
    const sim = village();
    const p = sim.people!;
    const w = sim.world;
    // Dry ground to the east of the village.
    for (let y = 26; y <= 36; y++) for (let x = 38; x <= 46; x++) p.fieldMoisture[w.idx(x, y)] = 0.1;
    const st = p.settlements[0]!.state;
    st.limit = 'land';
    const day = DAYS_PER_SEASON * 2 + 2;
    sim.ideas.look(sim, day);
    sim.ideas.look(sim, day + 2);
    const land = sim.ideas.list().find((i) => i.kind === 'land')!;
    expect(land).toBeDefined();
    expect(land.tool).toBe('dig');
    expect(land.x).toBeGreaterThan(36);
    expect(land.text).toMatch(/good land/);
    st.limit = 'room';
    sim.ideas.look(sim, day + 4);
    sim.ideas.look(sim, day + 6);
    expect(sim.ideas.list().some((i) => i.kind === 'room' && i.tool === 'even')).toBe(true);
  });
});

describe('houses and fields', () => {
  it('build a house on a field next to the village when the fields have closed in (no stall for room)', () => {
    const sim = village();
    sim.run(STEPS_PER_DAY);
    const p = sim.people!;
    const w = sim.world;
    const s = p.settlements[0]!;
    const st = s.state;
    st.wellbeing = 0.9;
    st.population = st.houses * ECONOMY.houseCapacity;
    const hooks = p as unknown as Hooks;
    const houses = () => p.buildings.filter((b) => b.kind === 'house');
    // Open ground about: the new house does not take a field.
    const n0 = houses().length;
    const fieldsBefore = new Set<number>();
    for (let i = 0; i < w.size; i++) if (w.landuse[i] === LandUse.Field) fieldsBefore.add(i);
    if (!p.buildings.some((b) => b.kind === 'house' && b.progress < 1)) hooks.planHouses(s);
    const fresh = houses().filter((b) => b.progress < 1);
    expect(fresh.length).toBe(1);
    expect(fieldsBefore.has(w.idx(fresh[0]!.x, fresh[0]!.y))).toBe(false);
    expect(houses().length).toBeLessThanOrEqual(n0 + 1);
    // Finish it, fill it, and farm every open cell around the village.
    fresh[0]!.progress = 1;
    st.houses++;
    st.population = st.houses * ECONOMY.houseCapacity;
    for (let y = 16; y <= 46; y++)
      for (let x = 15; x <= 45; x++) {
        const i = w.idx(x, y);
        if (w.landuse[i] === LandUse.None && w.water[i]! < 0.01) w.landuse[i] = LandUse.Field;
      }
    const before = p.housesOnFields;
    hooks.planHouses(s);
    const onField = houses().filter((b) => b.progress < 1);
    expect(onField.length).toBe(1);
    expect(p.housesOnFields).toBe(before + 1);
    const b = onField[0]!;
    expect(Math.hypot(b.x - st.x, b.y - st.y)).toBeLessThanOrEqual(6);
    expect(w.landuse[w.idx(b.x, b.y)]).toBe(LandUse.Building);
  });
});
