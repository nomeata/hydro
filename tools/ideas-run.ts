import { STEPS_PER_DAY } from '../src/sim/constants';
import { newGame } from '../src/sim/newgame';
const seed = Number(process.argv[2] ?? 3);
const size = Number(process.argv[3] ?? 128);
const days = Number(process.argv[4] ?? 150);
const { sim } = newGame(seed, size);
let last = '';
for (let d = 0; d < days; d++) {
  sim.run(STEPS_PER_DAY);
  const l = sim.ideas.list().map((i) => `${i.id} (${i.x},${i.y}) ${i.text}`).join('\n   ');
  if (l !== last) {
    console.log(`day ${sim.time.day} pop ${sim.people?.population} villages ${sim.people?.settlements.length}:\n   ${l || '(none)'}`);
    last = l;
  }
}
