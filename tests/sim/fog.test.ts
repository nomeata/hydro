import { describe, expect, it } from 'vitest';
import { generateWorld } from '../../src/sim/worldgen';
import { Simulation } from '../../src/sim/sim';
import { STEPS_PER_DAY } from '../../src/sim/constants';
import { loadGame, saveGame } from '../../src/sim/persist';
import { REVEALED, START_REVEAL, revealRadius } from '../../src/sim/fog';

function game(seed: number) {
  const gen = generateWorld({ seed, size: 128 });
  return { sim: new Simulation(gen.world, seed, { people: { startX: gen.startX, startY: gen.startY } }), gen };
}

function countRevealed(sim: Simulation): number {
  let n = 0;
  for (let i = 0; i < sim.world.size; i++) if (sim.world.revealed[i]! >= REVEALED) n++;
  return n;
}

describe('fog of war', () => {
  it('starts with a disc around the start point', () => {
    const { sim, gen } = game(3);
    const w = sim.world;
    expect(w.revealed[w.idx(gen.startX, gen.startY)]).toBe(255);
    const n = countRevealed(sim);
    // Roughly π·40², clipped by the map.
    expect(n).toBeGreaterThan(2000);
    expect(n).toBeLessThan(Math.PI * (START_REVEAL + 6) ** 2);
    // Somewhere far away is hidden.
    const fx = gen.startX < 64 ? 127 : 0;
    const fy = gen.startY < 64 ? 127 : 0;
    expect(w.revealed[w.idx(fx, fy)]).toBe(0);
  });

  it('grows with the population and never shrinks', async () => {
    const { sim } = game(3);
    sim.run(STEPS_PER_DAY);
    const before = countRevealed(sim);
    const snap = sim.world.revealed.slice();
    const s = sim.people!.settlements[0]!.state;
    s.population = 100; // pretend the village has grown
    expect(revealRadius(100)).toBe(80);
    sim.run(STEPS_PER_DAY);
    const after = countRevealed(sim);
    expect(after).toBeGreaterThan(before * 1.5);
    for (let i = 0; i < snap.length; i++) expect(sim.world.revealed[i]! >= snap[i]!).toBe(true);
  }, 60_000);

  it('is saved and loaded', async () => {
    const { sim } = game(4);
    sim.run(STEPS_PER_DAY * 2);
    const b = (await loadGame(await saveGame(sim))).sim;
    expect(Array.from(b.world.revealed)).toEqual(Array.from(sim.world.revealed));
    expect(b.fog).toBe(true);
    expect(b.stateHash()).toBe(sim.stateHash());
  }, 60_000);

  it('ignores plans on unrevealed land', () => {
    const { sim, gen } = game(3);
    const w = sim.world;
    // A hidden cell and a known one.
    let hidden = -1;
    for (let i = 0; i < w.size && hidden < 0; i++) {
      const x = i % w.width;
      const y = (i / w.width) | 0;
      if (w.revealed[i] === 0 && x > 4 && y > 4 && x < 123 && y < 123) hidden = i;
    }
    expect(hidden).toBeGreaterThanOrEqual(0);
    const hx = hidden % w.width;
    const hy = (hidden / w.width) | 0;
    sim.command({ type: 'planTrench', points: [[hx - 2, hy], [hx + 2, hy]], width: 1, depth: 1 });
    sim.command({ type: 'planLevel', points: [[hx, hy - 2], [hx, hy + 2]], width: 2 });
    for (let i = 0; i < w.size; i++) if (w.revealed[i]! < REVEALED) expect(Number.isNaN(w.plan[i]!)).toBe(true);
    // Known land takes plans.
    sim.command({ type: 'planDike', points: [[gen.startX - 3, gen.startY], [gen.startX + 3, gen.startY]], width: 1, height: 1 });
    expect(Number.isNaN(w.plan[w.idx(gen.startX, gen.startY)]!)).toBe(false);
  });

  it('is off without villages (plans anywhere)', () => {
    const gen = generateWorld({ seed: 3, size: 64 });
    const sim = new Simulation(gen.world, 3);
    expect(sim.fog).toBe(false);
    sim.command({ type: 'planTrench', points: [[2, 2], [8, 2]], width: 1, depth: 1 });
    expect(Number.isNaN(sim.world.plan[sim.world.idx(5, 2)]!)).toBe(false);
  });
});
