import { describe, expect, it } from 'vitest';
import { generateWorld } from '../../src/sim/worldgen';
import { Simulation } from '../../src/sim/sim';
import { LandUse } from '../../src/sim/world';
import { DAYS_PER_YEAR, STEPS_PER_DAY } from '../../src/sim/constants';
import { loadGame, saveGame } from '../../src/sim/persist';

function village(seed: number) {
  const gen = generateWorld({ seed, size: 128 });
  return new Simulation(gen.world, seed, { people: { startX: gen.startX, startY: gen.startY } });
}

/** Run whole days, yielding between them so the test runner stays responsive. */
async function runDays(sim: Simulation, days: number): Promise<void> {
  for (let d = 0; d < days; d++) {
    sim.run(STEPS_PER_DAY);
    await new Promise((r) => setImmediate(r));
  }
}

describe('first village', () => {
  it('is founded, builds houses, farms fields and harvests within a year', async () => {
    const sim = village(3);
    const p = sim.people!;
    sim.run(STEPS_PER_DAY);
    expect(p.settlements.length).toBe(1);
    expect(p.agents.length).toBe(4);
    await runDays(sim, DAYS_PER_YEAR - 1);
    const s = p.settlements[0]!.state;
    let fields = 0;
    for (let i = 0; i < sim.world.size; i++) if (sim.world.landuse[i] === LandUse.Field) fields++;
    // eslint-disable-next-line no-console
    console.log(`after 1 year: pop ${s.population}, houses ${s.houses}, food ${s.food.toFixed(0)}, w ${s.wellbeing.toFixed(2)}, fields ${fields}, agents ${p.agents.length}`);
    expect(s.houses).toBeGreaterThanOrEqual(1);
    expect(fields).toBeGreaterThan(10);
    expect(s.population).toBeGreaterThanOrEqual(4);
    const adults = p.agents.filter((a) => !a.child);
    // All villages (a second one may be founded from the fog within the year); children are not counted.
    expect(adults.length).toBe(p.population + adults.filter((a) => a.task === 4).length);
  }, 240_000);

  it('fishers go fishing when there is stocked water nearby', async () => {
    // Seed 3 has a lake by its river meadow at (74, 84) (the terrace start lies away from calm water).
    const gen = generateWorld({ seed: 3, size: 128 });
    const sim = new Simulation(gen.world, 3, { people: { startX: 74, startY: 84 } });
    await runDays(sim, 20);
    const p = sim.people!;
    const fishers = p.agents.filter((a) => a.job === 3);
    const s = p.settlements[0]!.state;
    let stock = 0;
    let cap = 0;
    for (let b = 0; b < p.fish.length; b++) {
      stock += p.fish[b]!;
      cap += p.fishCap[b]!;
    }
    console.log(`day 20: pop ${s.population}, fishers ${fishers.length}, fish ${stock.toFixed(0)}/${cap.toFixed(0)}`);
    expect(cap).toBeGreaterThan(0);
    expect(fishers.length).toBeGreaterThan(0);
    expect(stock).toBeLessThan(cap); // they have caught something
  }, 240_000);

  it('earth shaped near the village stays shaped', async () => {
    const sim = village(3);
    sim.run(STEPS_PER_DAY);
    const s = sim.people!.settlements[0]!.state;
    const x = Math.round(s.x) + 6;
    const y = Math.round(s.y);
    const i = sim.world.idx(x, y);
    const before = sim.world.terrain(i);
    sim.command({ type: 'shapeLine', tool: 'dig', points: [[x, y - 3], [x, y + 3]], width: 1, amount: 0.8 });
    expect(sim.world.terrain(i)).toBeLessThan(before - 0.7);
    await runDays(sim, 4);
    expect(sim.world.terrain(i)).toBeLessThan(before - 0.4);
  }, 120_000);

  it('saves and resumes villages exactly', async () => {
    const a = village(4);
    a.run(STEPS_PER_DAY * 3);
    const b = (await loadGame(await saveGame(a))).sim;
    expect(b.stateHash()).toBe(a.stateHash());
    a.run(STEPS_PER_DAY * 2);
    b.run(STEPS_PER_DAY * 2);
    expect(b.stateHash()).toBe(a.stateHash());
  }, 120_000);
});

describe('floods', () => {
  it('ruin flooded houses and send people running uphill', async () => {
    const gen = generateWorld({ seed: 3, size: 128 });
    const sim = new Simulation(gen.world, 3, { people: { startX: gen.startX, startY: gen.startY } });
    await runDays(sim, 12);
    const p = sim.people!;
    const house = p.buildings.find((b) => b.kind === 'house' && b.progress >= 1)!;
    expect(house).toBeDefined();
    const housesBefore = p.settlements[0]!.state.houses;

    // A flood: deep water around the house and the village centre.
    const s = p.settlements[0]!.state;
    sim.command({ type: 'debugWater', x: house.x, y: house.y, radius: 6, depth: 1.5 });
    sim.command({ type: 'debugWater', x: s.x, y: s.y, radius: 6, depth: 1.5 });
    // …and around a villager wherever they are (on a terrace the water soon runs off).
    const caught = p.agents.find((a) => !a.child)!;
    sim.command({ type: 'debugWater', x: Math.round(caught.x), y: Math.round(caught.y), radius: 4, depth: 3 });
    // Whoever is caught in it runs (some may reach dry ground within the 40 steps).
    const fled = new Set<number>();
    for (let k = 0; k < 20; k++) {
      sim.run(2);
      for (const a of p.agents) if (a.flee) fled.add(a.id);
    }
    const fleeing = fled.size;
    await runDays(sim, 1);
    expect(p.buildings.find((b) => b.id === house.id)!.kind).toBe('ruin');
    expect(p.settlements[0]!.state.houses).toBeLessThan(housesBefore);
    expect(fleeing).toBeGreaterThan(0);
    expect(sim.world.floodMemory[sim.world.idx(house.x, house.y)]!).toBeGreaterThan(200);
    // Wading through a ford is no flood: knee-deep water around someone sends nobody running.
    await runDays(sim, 1);
    const wader = p.agents.find((a) => !a.child && !a.flee)!;
    sim.command({ type: 'debugWater', x: Math.round(wader.x), y: Math.round(wader.y), radius: 1.5, depth: 0.32 });
    for (let k = 0; k < 20; k++) {
      sim.run(2);
      expect(wader.flee ?? false).toBe(false);
    }
  }, 240_000);
});
