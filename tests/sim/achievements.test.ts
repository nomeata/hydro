import { describe, expect, it } from 'vitest';
import { Achievements, rle, unrle, type AchievementHost } from '../../src/sim/achievements';
import { ACH, ACHIEVEMENTS, POPULATION_ACHIEVEMENTS, achievementInfo } from '../../src/shared/achievements';
import { CellFlag, LandUse, SoilType, World } from '../../src/sim/world';
import { Simulation } from '../../src/sim/sim';
import { DAYS_PER_YEAR, STEPS_PER_DAY } from '../../src/sim/constants';
import { loadGame, saveGame } from '../../src/sim/persist';
import { generateWorld } from '../../src/sim/worldgen';
import type { PeopleSystem } from '../../src/sim/people/village';

const DAY = STEPS_PER_DAY;
const tick = () => new Promise((r) => setImmediate(r));

async function runDays(sim: Simulation, days: number): Promise<void> {
  for (let d = 0; d < days; d++) {
    sim.run(DAY);
    await tick();
  }
}

/** Run until all plans and structures are built. */
async function build(sim: Simulation, maxDays = 20): Promise<void> {
  for (let d = 0; d < maxDays * 10; d++) {
    if (sim.crew.pending === 0 && !sim.structures.pending) return;
    sim.run(DAY / 10);
    if (d % 10 === 9) await tick();
  }
  throw new Error('not built in time');
}

/** A flat rock plain at 20 m (nothing soaks away); `cliff`: drops to 10 m east of x = 32. */
function plain(n = 64, cliff = false): World {
  const w = new World(n, n, 5);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = w.idx(x, y);
      w.bedrock[i] = cliff ? (x <= 31 ? 20 : x === 32 ? 15 : 10 - 0.02 * (x - 33)) : 20;
      w.soil[i] = 0;
      w.soilType[i] = SoilType.Rock;
    }
  if (cliff) for (let y = 0; y < n; y++) w.flags[w.idx(n - 1, y)] |= CellFlag.Outlet;
  return w;
}

const ids = (a: Achievements) => a.earned.map((e) => e.id);

/** A stand-in for the villages (only what the checks read). */
function fakePeople(w: World, over: Record<string, unknown> = {}): PeopleSystem {
  return {
    settlements: [],
    peakPopulation: 0,
    population: 0,
    fieldMoisture: new Float32Array(w.size),
    quay: new Uint8Array(w.size),
    floods: { cells: 0, ruined: 0 },
    buildings: [],
    herds: { cows: () => 0 },
    ...over,
  } as unknown as PeopleSystem;
}

function host(w: World, people: PeopleSystem | null = null): AchievementHost {
  return { world: w, people, structures: { weirs: [] } as unknown as AchievementHost['structures'] };
}

describe('achievement table', () => {
  it('has unique ids, a title, description and icon for each', () => {
    const seen = new Set<string>();
    for (const a of ACHIEVEMENTS) {
      expect(seen.has(a.id)).toBe(false);
      seen.add(a.id);
      expect(a.title.length).toBeGreaterThan(2);
      expect(a.description.length).toBeGreaterThan(8);
      expect(a.icon.length).toBeGreaterThan(0);
    }
    expect(ACHIEVEMENTS.length).toBeGreaterThanOrEqual(15);
    for (const [id] of POPULATION_ACHIEVEMENTS) expect(achievementInfo(id)).toBeDefined();
  });

  it('run-length encodes bitsets', () => {
    const a = new Uint8Array(50);
    a.fill(1, 3, 9);
    a[20] = 1;
    a.fill(1, 45);
    const r = rle(a);
    expect(r).toEqual([3, 6, 20, 1, 45, 5]);
    const b = new Uint8Array(50);
    unrle(b, r);
    expect(b).toEqual(a);
  });
});

describe('waterworks', () => {
  it('First Spade and Long Canal when a long trench is finished', async () => {
    const sim = new Simulation(plain(), 1);
    sim.command({ type: 'planTrench', points: [[5, 20], [5 + ACH.canalCells + 2, 20]], width: 2, depth: 1 });
    expect(ids(sim.achievements)).toEqual([]);
    await build(sim);
    sim.run(100);
    expect(ids(sim.achievements)).toEqual(['firstSpade', 'longCanal']);
    // Noticed within a fraction of a day, on the day it happened.
    expect(sim.achievements.earned[0]!.day).toBe(sim.time.day);
    const u = sim.achievements.take();
    expect(u.fresh).toEqual(['firstSpade', 'longCanal']);
    expect(sim.achievements.take().fresh).toEqual([]);
  });

  it('a short trench is only a First Spade; a cancelled one is nothing', async () => {
    const sim = new Simulation(plain(), 1);
    sim.command({ type: 'planTrench', points: [[5, 20], [40, 20]], width: 2, depth: 1 });
    sim.command({ type: 'cancelPlan', x: 22, y: 20, radius: 30 });
    await build(sim);
    sim.run(100);
    expect(ids(sim.achievements)).toEqual([]);
    sim.command({ type: 'planTrench', points: [[5, 30], [15, 30]], width: 2, depth: 1 });
    await build(sim);
    sim.run(100);
    expect(ids(sim.achievements)).toEqual(['firstSpade']);
  });

  it('Lake Maker: a dug basin filled with water, but not a pond that was there at the start', async () => {
    const make = async (pondAtStart: boolean) => {
      const w = plain();
      const sim = new Simulation(w, 1);
      const fill = () => {
        for (let y = 20; y <= 36; y++) for (let x = 16; x <= 40; x++) w.water[w.idx(x, y)] = Math.max(0, 19.9 - w.terrain(w.idx(x, y)));
      };
      for (const y of [25, 28, 31]) sim.command({ type: 'planTrench', points: [[20, y], [36, y]], width: 4, depth: 1.5 });
      await build(sim);
      if (pondAtStart) {
        fill();
        sim.achievements.baseline(sim);
        sim.achievements.touch(w.idx(28, 28));
      } else fill();
      await runDays(sim, 3);
      return ids(sim.achievements);
    };
    expect(await make(false)).toContain('lakeMaker');
    expect(await make(true)).not.toContain('lakeMaker');
  });

  it('Waterfall: a canal led over the edge of a cliff', async () => {
    const w = plain(64, true);
    const sim = new Simulation(w, 1);
    for (let y = 18; y <= 22; y++) w.inflow[w.idx(0, y)] = 0;
    sim.command({ type: 'planTrench', points: [[1, 20], [31, 20]], width: 2, depth: 1 });
    await build(sim);
    expect(sim.achievements.waterfall(sim)).toBe(false);
    for (const y of [19, 20, 21]) w.inflow[w.idx(1, y)] = 1;
    await runDays(sim, 1);
    expect(ids(sim.achievements)).toContain('waterfall');
  });

  it('Stone by Stone, Weir Builder and Gatekeeper', async () => {
    const w = plain();
    const sim = new Simulation(w, 1);
    sim.command({ type: 'planLining', points: [[10, 10], [20, 10]], width: 2 });
    await build(sim);
    expect(ids(sim.achievements)).toEqual(['stoneByStone']);
    sim.command({ type: 'planWeir', points: [[30, 5], [30, 20]], width: 2, height: 1 });
    await build(sim);
    await runDays(sim, 1);
    expect(ids(sim.achievements)).toContain('weirBuilder');
    sim.command({ type: 'planDike', points: [[45, 5], [45, 40]], width: 2, height: 2 });
    await build(sim);
    sim.command({ type: 'placeGate', points: [[45, 20]], width: 1, height: 0 });
    const g = sim.structures.gates[0]!;
    // Opening an unfinished gate does not count.
    sim.command({ type: 'toggleGate', id: g.id, open: true });
    sim.command({ type: 'toggleGate', id: g.id, open: false });
    expect(ids(sim.achievements)).not.toContain('gatekeeper');
    await build(sim);
    sim.command({ type: 'toggleGate', id: g.id });
    expect(ids(sim.achievements)).toContain('gatekeeper');
  });
});

describe('the land and the people', () => {
  it('New Ground and Green Desert: dry land watered near the works', () => {
    const w = plain();
    const people = fakePeople(w);
    const h = host(w, people);
    const a = new Achievements(w.width, w.height);
    people.fieldMoisture.fill(0.05);
    a.baseline(h);
    // Far from any works: neither counts.
    for (let i = 0; i < w.size; i++) people.fieldMoisture[i] = 0.6;
    w.landuse[w.idx(30, 30)] = LandUse.Field;
    a.daily(h, 3);
    a.daily(h, 4);
    expect(ids(a)).toEqual([]);
    a.touch(w.idx(30, 30));
    a.daily(h, 5);
    expect(ids(a)).toEqual(['newGround']);
    a.daily(h, 6);
    expect(ids(a)).toEqual(['newGround', 'greenDesert']);
  });

  it('villages, population, harvests, fish, quays, jetties and rebuilt houses', () => {
    const w = plain();
    const s = (jetty?: number) => ({ state: { jetty: jetty === undefined ? undefined : { progress: jetty } } });
    const people = fakePeople(w, { settlements: [s()], peakPopulation: 12, population: 9 });
    const h = host(w, people);
    const a = new Achievements(w.width, w.height);
    w.water.fill(1, w.idx(0, 10), w.idx(0, 12)); // a river along rows 10–11
    a.baseline(h);
    a.quick(h, 1);
    expect(ids(a)).toEqual(['founders', 'pop10']);
    (people as { settlements: unknown[] }).settlements = [s(), s(0.5), s(1)];
    people.peakPopulation = 260;
    a.quick(h, 2);
    expect(ids(a)).toEqual(['founders', 'pop10', 'newHome', 'threeVillages', 'pop50', 'pop100', 'pop250']);
    // Harvests: a year's worth, counted per calendar year.
    for (let k = 0; k < ACH.harvests - 1; k++) a.peopleEvent('harvest', 0, 40);
    a.peopleEvent('harvest', 0, DAYS_PER_YEAR + 1);
    expect(ids(a)).toContain('firstHarvest');
    expect(ids(a)).not.toContain('goldenYear');
    for (let k = 0; k < ACH.harvests - 1; k++) a.peopleEvent('harvest', 0, DAYS_PER_YEAR + 2);
    expect(ids(a)).toContain('goldenYear');
    // Fish from the river don't count; fish from water made by the player do.
    a.touch(w.idx(40, 40));
    a.peopleEvent('catch', w.idx(40, 12), 5);
    a.peopleEvent('catch', w.idx(5, 40), 5);
    expect(ids(a)).not.toContain('goneFishing');
    a.peopleEvent('catch', w.idx(40, 41), 5);
    expect(ids(a)).toContain('goneFishing');
    a.daily(h, 6);
    expect(ids(a)).toContain('jetty');
    expect(ids(a)).not.toContain('quayside');
    people.quay[w.idx(3, 3)] = 1;
    a.daily(h, 7);
    expect(ids(a)).toContain('quayside');
    a.peopleEvent('rebuilt', 0, 8);
    expect(ids(a)).toContain('rebuilt');
  });

  it('Weathered the Storm: a spring flood with no house lost', () => {
    const w = plain();
    const house = { kind: 'house', progress: 1 };
    const people = fakePeople(w, { settlements: [{ state: {} }], buildings: [house] });
    const h = host(w, people);
    const run = (year: number, flood: boolean, ruin: boolean) => {
      const a = new Achievements(w.width, w.height);
      a.baseline(h);
      for (let d = year * DAYS_PER_YEAR; d < year * DAYS_PER_YEAR + 12; d++) {
        w.floodMemory.fill(0);
        if (flood && d % DAYS_PER_YEAR === 4)
          for (let k = 0; k < ACH.floodCells; k++) {
            w.landuse[k] = LandUse.Field;
            w.floodMemory[k] = 255;
          }
        if (ruin && d % DAYS_PER_YEAR === 5) people.floods.ruined++;
        a.daily(h, d);
      }
      return ids(a).includes('weathered');
    };
    expect(run(1, true, false)).toBe(true);
    expect(run(1, false, false)).toBe(false);
    expect(run(2, true, true)).toBe(false);
  });

  it('Years Go By and A Decade', () => {
    const w = plain(16);
    const a = new Achievements(16, 16);
    a.baseline(host(w));
    a.daily(host(w), DAYS_PER_YEAR - 2);
    expect(ids(a)).toEqual([]);
    a.daily(host(w), DAYS_PER_YEAR - 1);
    expect(a.earned).toEqual([{ id: 'year1', day: DAYS_PER_YEAR - 1 }]);
    a.daily(host(w), 10 * DAYS_PER_YEAR - 1);
    expect(ids(a)).toEqual(['year1', 'decade']);
  });

  it('a real village: Founders, First Harvest and Hamlet in its first weeks', async () => {
    const gen = generateWorld({ seed: 3, size: 128 });
    const sim = new Simulation(gen.world, 3, { people: { startX: gen.startX, startY: gen.startY } });
    await runDays(sim, 20);
    expect(ids(sim.achievements)).toEqual(expect.arrayContaining(['founders', 'firstHarvest', 'pop10']));
  }, 120_000);
});

describe('saving', () => {
  it('saves and loads achievements and their baseline; no fanfare after loading', async () => {
    const w = plain();
    const sim = new Simulation(w, 1);
    w.water.fill(1, w.idx(0, 5), w.idx(0, 6));
    sim.achievements.baseline(sim);
    sim.command({ type: 'planTrench', points: [[5, 20], [20, 20]], width: 2, depth: 1 });
    sim.command({ type: 'planTrench', points: [[5, 40], [20, 40]], width: 2, depth: 1 });
    sim.run(20);
    expect(ids(sim.achievements)).toEqual([]);
    const loaded = (await loadGame(await saveGame(sim))).sim;
    expect(loaded.achievements.getState()).toEqual(sim.achievements.getState());
    expect(loaded.achievements.take().fresh).toEqual([]);
    await build(sim);
    await build(loaded);
    sim.run(100);
    loaded.run(100);
    expect(ids(loaded.achievements)).toEqual(['firstSpade']);
    expect(loaded.achievements.getState()).toEqual(sim.achievements.getState());
    expect(loaded.stateHash()).toBe(sim.stateHash());
    // Loading again: the list comes along, but nothing is fresh.
    const again = (await loadGame(await saveGame(loaded))).sim;
    const u = again.achievements.take();
    expect(u.earned.map((e) => e.id)).toEqual(['firstSpade']);
    expect(u.fresh).toEqual([]);
  });

  it('old saves without achievements load, quietly recording what is already true', async () => {
    const gen = generateWorld({ seed: 3, size: 64 });
    const sim = new Simulation(gen.world, 3, { people: { startX: gen.startX, startY: gen.startY } });
    sim.run(DAY * 2);
    const bytes = await saveGame(sim);
    // Strip the achievements as an older version would have written it.
    const st = sim.getState();
    delete st.achievements;
    const orig = sim.getState.bind(sim);
    sim.getState = () => st;
    const old = await saveGame(sim);
    sim.getState = orig;
    const loaded = (await loadGame(old)).sim;
    expect(ids(loaded.achievements)).toContain('founders');
    expect(loaded.achievements.take().fresh).toEqual([]);
    expect((await loadGame(bytes)).sim.achievements.getState()).toEqual(sim.achievements.getState());
  }, 60_000);

  it('is deterministic and never changes the simulation', async () => {
    const run = async () => {
      const gen = generateWorld({ seed: 5, size: 64 });
      const sim = new Simulation(gen.world, 5, { people: { startX: gen.startX, startY: gen.startY } });
      sim.command({ type: 'planTrench', points: [[gen.startX - 8, gen.startY], [gen.startX + 8, gen.startY]], width: 2, depth: 1 });
      await runDays(sim, 4);
      return sim;
    };
    const a = await run();
    const b = await run();
    expect(a.achievements.getState()).toEqual(b.achievements.getState());
    expect(a.stateHash()).toBe(b.stateHash());
    // Without the observer (no hooks), the world comes out the same.
    const gen = generateWorld({ seed: 5, size: 64 });
    const c = new Simulation(gen.world, 5, { people: { startX: gen.startX, startY: gen.startY } });
    c.people!.onEvent = null;
    c.structures.onLined = null;
    const ach = c.achievements as unknown as Record<string, unknown>;
    for (const k of ['daily', 'update', 'touch', 'stroke', 'cancelled']) ach[k] = () => {};
    c.command({ type: 'planTrench', points: [[gen.startX - 8, gen.startY], [gen.startX + 8, gen.startY]], width: 2, depth: 1 });
    await runDays(c, 4);
    expect(c.stateHash()).toBe(a.stateHash());
  }, 120_000);
});
