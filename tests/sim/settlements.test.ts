import { afterAll, describe, expect, it } from 'vitest';
import { generateWorld } from '../../src/sim/worldgen';
import { Simulation } from '../../src/sim/sim';
import { LandUse } from '../../src/sim/world';
import { DAYS_PER_YEAR, STEPS_PER_DAY } from '../../src/sim/constants';
import { loadGame, saveGame } from '../../src/sim/persist';
import { FOUNDING } from '../../src/sim/people/village';
import { SiteKind } from '../../src/sim/people/agents';
import { REVEALED } from '../../src/sim/fog';

async function runDays(sim: Simulation, days: number, until?: () => boolean): Promise<number> {
  for (let d = 0; d < days; d++) {
    sim.run(STEPS_PER_DAY);
    await new Promise((r) => setImmediate(r));
    if (until?.()) return d + 1;
  }
  return days;
}

// Make founding quick so the test stays short: the rules are the same,
// only the population threshold and the interval are lowered.
const saved = { ...FOUNDING };
FOUNDING.minPopulation = 4;
FOUNDING.interval = 4;
// Migrants judge the land at the end of summer as well: survey it on day 1.
FOUNDING.summerDay = 1;
afterAll(() => Object.assign(FOUNDING, saved));

describe('more settlements', () => {
  let sim: Simulation;

  it('founds a second village on attractive land, away from the first', async () => {
    const gen = generateWorld({ seed: 3, size: 128 });
    sim = new Simulation(gen.world, 3, { people: { startX: gen.startX, startY: gen.startY } });
    const p = sim.people!;
    const days = await runDays(sim, DAYS_PER_YEAR, () => p.settlements.length >= 2);
    expect(p.settlements.length).toBe(2);
    const [a, b] = p.settlements.map((s) => s.state);
    const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
    console.log(`second village after ${days} days at ${b!.x},${b!.y}, ${d.toFixed(0)} cells from the first`);
    expect(d).toBeGreaterThanOrEqual(20);
    // Founded on known land (or its edge), with a store and a family.
    expect(sim.world.revealed[sim.world.idx(b!.x, b!.y)]!).toBeGreaterThanOrEqual(REVEALED / 2);
    expect(p.buildings.some((x) => x.settlement === b!.id && x.kind === 'store')).toBe(true);
    expect(p.agents.filter((x) => x.settlement === b!.id).length).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it('runs both villages on their own land', async () => {
    const p = sim.people!;
    const w = sim.world;
    // Let a few weeks of farming pass (founding again is held off).
    FOUNDING.interval = 1000;
    await runDays(sim, 16);
    const b = p.settlements[1]!.state;
    // The new village is known land now.
    expect(w.revealed[w.idx(b.x, b.y)]).toBe(255);
    let own = 0;
    for (let i = 0; i < w.size; i++) {
      if (w.landuse[i] !== LandUse.Field) continue;
      if (p.ownerOf(i % w.width, (i / w.width) | 0) === p.settlements[1]) own++;
    }
    console.log(`village 2: pop ${b.population}, fields ${own}, food ${b.food.toFixed(0)}`);
    expect(own).toBeGreaterThan(0);
    // Everybody farms the fields of their own village.
    for (const a of p.agents) {
      if (a.siteKind !== SiteKind.Sow && a.siteKind !== SiteKind.Tend && a.siteKind !== SiteKind.Harvest) continue;
      if (a.task !== 1 && a.task !== 2) continue;
      expect(p.ownerOf(a.site % w.width, (a.site / w.width) | 0)!.state.id).toBe(a.settlement);
    }
  }, 120_000);

  it('saves and resumes two villages exactly', async () => {
    const b = (await loadGame(await saveGame(sim))).sim;
    expect(b.people!.settlements.length).toBe(2);
    expect(b.stateHash()).toBe(sim.stateHash());
    sim.run(STEPS_PER_DAY * 2);
    b.run(STEPS_PER_DAY * 2);
    expect(b.stateHash()).toBe(sim.stateHash());
  }, 120_000);

  it('is deterministic', async () => {
    const run = async () => {
      FOUNDING.interval = 4;
      const gen = generateWorld({ seed: 3, size: 128 });
      const s = new Simulation(gen.world, 3, { people: { startX: gen.startX, startY: gen.startY } });
      await runDays(s, 10);
      return s.stateHash() + '/' + s.people!.settlements.length;
    };
    expect(await run()).toBe(await run());
  }, 120_000);
});
