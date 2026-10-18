/**
 * Full-game step bench: a generated world with a village, after the
 * worker's spin-up, timing Simulation.advance(). Usage:
 *   npx tsx tools/benchgame.ts [size=256] [seed=7] [steps=600]
 */
import { generateWorld } from '../src/sim/worldgen';
import { Simulation } from '../src/sim/sim';

const size = Number(process.argv[2] ?? 256);
const seed = Number(process.argv[3] ?? 7);
const steps = Number(process.argv[4] ?? 600);
const gen = generateWorld({ seed, size });
const sim = new Simulation(gen.world, seed, { people: { startX: gen.startX, startY: gen.startY }, rain: gen.rain });
// As the worker does: spin up the whole map, then start the game.
const s = sim as unknown as { spinUp?: (n: number) => void };
if (s.spinUp) s.spinUp(600);
else sim.run(600);
sim.step = 0;
sim.run(60);
const t0 = performance.now();
sim.run(steps);
const ms = (performance.now() - t0) / steps;
const a = (sim as unknown as { active?: { stats(): string } }).active;
console.log(`game step ${size}² seed ${seed}: ${ms.toFixed(2)} ms/step${a ? ` (${a.stats()})` : ''}`);
