/**
 * Scratch: the "help" idea on struggling villages (sim/ideas.ts). Runs a seed
 * hands-off, prints each village's state and the ideas every few days, and
 * with --follow applies the help idea's plan (a channel) when it first shows,
 * running a copy without it alongside.
 *
 *   npx tsx tools/playtest/diag-stuck.ts --seeds 7,8 --days 144 [--size 128] [--follow]
 */
import { STEPS_PER_DAY } from '../../src/sim/constants';
import { newGame } from '../../src/sim/newgame';
import { loadGame, saveGame } from '../../src/sim/persist';
import type { Simulation } from '../../src/sim/sim';
import { villages } from './geo';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1]! : d;
};
const seeds = opt('seeds', '7').split(',').map(Number);
const size = Number(opt('size', '128'));
const days = Number(opt('days', '144'));
const every = Number(opt('every', '4'));
const follow = args.includes('--follow');
const times = Number(opt('times', '3'));

const line = (sim: Simulation) =>
  villages(sim)
    .map((s) => `v${s.state.id}:${s.state.population}p rep ${(s.reputation * 100).toFixed(0)} wb ${(s.state.wellbeing * 100).toFixed(0)} ${s.state.limit ?? '-'}`)
    .join(' | ') + `  ideas: ${sim.ideas.list().map((i) => `${i.id}@${i.x},${i.y}r${i.r}`).join(' ')}`;

for (const seed of seeds) {
  const { sim } = newGame(seed, size);
  let ctl: Simulation | null = null;
  let followed = 0;
  let lastSpot: string | undefined;
  let nextFollow = 0;
  for (let day = 1; day <= days; day++) {
    sim.run(STEPS_PER_DAY);
    ctl?.run(STEPS_PER_DAY);
    const help = sim.ideas.list().find((i) => i.kind === 'help');
    // Follow each new help idea (a new spot), up to `times` of them, like a player would.
    const spot = help && `${help.x},${help.y}`;
    if (follow && help && followed < times && spot !== lastSpot && day >= nextFollow) {
      followed++;
      lastSpot = spot;
      nextFollow = day + 6;
      const cmds = sim.ideas.helpCommands(help.id);
      console.log(`seed ${seed} day ${day}: following "${help.text}" at ${spot} r${help.r}: ${JSON.stringify(cmds)}`);
      if (!ctl) ctl = (await loadGame(await saveGame(sim))).sim;
      const m0 = sim.brush.moved.script;
      for (const c of cmds) sim.command(c);
      console.log(`   moved ${(sim.brush.moved.script - m0).toFixed(0)} m³`);
    }
    if (day % every === 0) {
      console.log(`s${seed} d${day} ${line(sim)}`);
      if (ctl) console.log(`   ctl ${line(ctl)}`);
    }
  }
  const h = sim.ideas.list().find((i) => i.kind === 'help');
  if (h) console.log(`  help: ${h.text}`);
}
