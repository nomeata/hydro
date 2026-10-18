/**
 * A new game as the player gets it: a generated world with villages, spun
 * up so that rivers are flowing, the clock and history reset, and the
 * achievements' baseline taken. Shared by the worker and headless tools
 * (tools/playtest.ts), so both start from exactly the same state.
 */
import { Simulation } from './sim';
import { generateWorld, type GenResult } from './worldgen';

/** Steps run at startup so that rivers are flowing when the player arrives. */
export const SPINUP_STEPS = 600;

export function newGame(seed: number, size: number, onGenerated?: () => void): { sim: Simulation; gen: GenResult } {
  const gen = generateWorld({ seed, size });
  onGenerated?.();
  const sim = new Simulation(gen.world, seed, { people: { startX: gen.startX, startY: gen.startY }, rain: gen.rain });
  sim.spinUp(SPINUP_STEPS);
  sim.step = 0;
  sim.resetHistory();
  // The world as the player first sees it is the baseline for the achievements.
  sim.achievements.baseline(sim);
  return { sim, gen };
}
