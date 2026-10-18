// Scratch: start site per seed, and the first village's year.
import { generateWorld } from '../../src/sim/worldgen';
const size = Number(process.argv[2] ?? 128);
for (const seed of (process.argv[3] ?? '1,2,3,4,5,6,7,8').split(',').map(Number)) {
  const g = generateWorld({ seed, size });
  console.log(`seed ${seed}: start ${g.startX},${g.startY} ${JSON.stringify(g.start)}`);
}
