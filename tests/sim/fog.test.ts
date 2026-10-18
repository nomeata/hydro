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
    expect(revealRadius(100)).toBe(106);
    sim.run(STEPS_PER_DAY);
    const after = countRevealed(sim);
    // (On this small test map most land is known from the start.)
    expect(after).toBeGreaterThan(before);
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

  it('leaves unrevealed land alone', () => {
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
    const before = Float64Array.from({ length: w.size }, (_, i) => w.terrain(i));
    sim.command({ type: 'shapeLine', tool: 'dig', points: [[hx - 2, hy], [hx + 2, hy]], width: 1, amount: 1 });
    sim.command({ type: 'shapeLine', tool: 'even', points: [[hx, hy - 2], [hx, hy + 2]], width: 2 });
    sim.command({ type: 'sculpt', tool: 'dig', radius: 2.5, stroke: 1, samples: [hx, hy, 0.2] });
    for (let i = 0; i < w.size; i++) if (w.revealed[i]! < REVEALED) expect(w.terrain(i)).toBe(before[i]);
    // Known land can be shaped (away from the houses).
    const x = gen.startX + 12;
    const z = w.terrain(w.idx(x, gen.startY));
    sim.command({ type: 'sculpt', tool: 'raise', radius: 2.5, stroke: 2, samples: [x, gen.startY, 0.2] });
    expect(w.terrain(w.idx(x, gen.startY))).toBeGreaterThan(z);
  });

  it('is off without villages (shaping anywhere)', () => {
    const gen = generateWorld({ seed: 3, size: 64 });
    const sim = new Simulation(gen.world, 3);
    expect(sim.fog).toBe(false);
    const z = sim.world.terrain(sim.world.idx(5, 2));
    sim.command({ type: 'shapeLine', tool: 'dig', points: [[2, 2], [8, 2]], width: 1, amount: 1 });
    expect(sim.world.terrain(sim.world.idx(5, 2))).toBeLessThan(z - 0.5);
  });
});
