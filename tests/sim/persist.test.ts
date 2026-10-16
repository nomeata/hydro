import { describe, expect, it } from 'vitest';
import { generateWorld } from '../../src/sim/worldgen';
import { Simulation } from '../../src/sim/sim';
import { loadGame, saveGame } from '../../src/sim/persist';

describe('save games', () => {
  it('round-trips: save, load, continue == continue', async () => {
    const make = () => {
      const { world } = generateWorld({ seed: 5, size: 64 });
      const sim = new Simulation(world, 5);
      sim.run(300);
      sim.command({ type: 'planTrench', points: [[10, 10], [40, 30]], width: 2, depth: 1 });
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
  });

  it('rejects garbage', async () => {
    await expect(loadGame(new Uint8Array([1, 2, 3]).buffer)).rejects.toThrow();
  });
});
