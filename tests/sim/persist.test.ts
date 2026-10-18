import { describe, expect, it } from 'vitest';
import { generateWorld } from '../../src/sim/worldgen';
import { Simulation } from '../../src/sim/sim';
import { loadGame, saveGame } from '../../src/sim/persist';

describe('save games', () => {
  it('round-trips: save, load, continue == continue', async () => {
    const make = () => {
      const { world } = generateWorld({ seed: 5, size: 64 });
      const sim = new Simulation(world, 5);
      sim.run(1500); // past the erosion spin-up, so inflow sediment is learned
      sim.command({ type: 'shapeLine', tool: 'dig', points: [[10, 10], [40, 30]], width: 2, amount: 1 });
      sim.run(100);
      return sim;
    };
    const a = make();
    const bytes = await saveGame(a, { startX: 3 });
    const { sim: b, meta } = await loadGame(bytes);
    expect(meta.startX).toBe(3);
    expect(b.stateHash()).toBe(a.stateHash());
    a.run(500);
    b.run(500);
    expect(b.stateHash()).toBe(a.stateHash());
    expect(b.crew.pending).toBe(a.crew.pending);
    expect(b.sedLedger).toEqual(a.sedLedger);
    expect(Array.from(b.world.soilType)).toEqual(Array.from(a.world.soilType));
  });

  it('rejects garbage', async () => {
    await expect(loadGame(new Uint8Array([1, 2, 3]).buffer)).rejects.toThrow();
  });
});
