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
    expect(p.agents.length).toBe(s.population + p.agents.filter((a) => a.task === 4).length);
  }, 240_000);

  it('builders realise a plan near the village', async () => {
    const sim = village(3);
    sim.run(STEPS_PER_DAY);
    const s = sim.people!.settlements[0]!.state;
    const x = Math.round(s.x) + 6;
    const y = Math.round(s.y);
    sim.command({ type: 'planTrench', points: [[x, y - 3], [x, y + 3]], width: 1, depth: 0.8 });
    const i = sim.world.idx(x, y);
    const before = sim.world.terrain(i);
    await runDays(sim, 4);
    expect(sim.world.terrain(i)).toBeLessThan(before - 0.5);
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
