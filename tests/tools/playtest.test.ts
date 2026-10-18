/**
 * Smoke test of the playtest harness (tools/playtest.ts): on a small world
 * the bots find places to act and issue real plans, and a short job forks
 * an identical control copy and records its metrics.
 */
import { describe, expect, it } from 'vitest';
import { newGame } from '../../src/sim/newgame';
import { BOT_NAMES, makeBot } from '../../tools/playtest/bots';
import { runJob } from '../../tools/playtest/run';

const SEED = 3;
const SIZE = 64;

describe('playtest harness', () => {
  it('bots place plans on a small world', () => {
    const { sim } = newGame(SEED, SIZE);
    sim.run(600 * 6);
    const acted: string[] = [];
    // (`undo` starts with the vandal's works, already placed here.)
    for (const name of BOT_NAMES.filter((n) => n !== 'undo')) {
      const bot = makeBot(name, { ignoreUnlocks: true });
      const acts = bot.check(sim, 6);
      for (const a of acts) {
        expect(a.commands.length).toBeGreaterThan(0);
        const before = sim.world.plan.filter((p) => !Number.isNaN(p)).length;
        for (const c of a.commands) sim.command(c);
        const after = sim.world.plan.filter((p) => !Number.isNaN(p)).length;
        expect(after).toBeGreaterThan(before);
      }
      if (acts.length) acted.push(name);
    }
    expect(acted).toContain('irrigate');
    expect(acted).toContain('vandal');
    expect(acted).toContain('dike');
  });

  it('a short job forks an identical control and records the response', async () => {
    const r = await runJob({ seed: SEED, size: SIZE, days: 5, bot: 'vandal', actDay: 3, checkEvery: 12, window: 2 });
    expect(r.actions.length).toBe(1);
    expect(r.response?.forkMatches).toBe(true);
    expect(r.response?.series.depth.length).toBe(2);
    expect(r.daily.population.length).toBe(5);
    expect(r.outcome.population).toBeGreaterThan(0);
  });
});
