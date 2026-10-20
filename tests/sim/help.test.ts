import { describe, expect, it } from 'vitest';
import { HELP, planHelp, struggling } from '../../src/sim/help';
import { Simulation } from '../../src/sim/sim';
import { SoilType, World } from '../../src/sim/world';
import { loadGame, saveGame } from '../../src/sim/persist';

const N = 64;

/**
 * A 64² valley (ideas.test.ts style): a river along y ≈ 20 (west → east),
 * loamy land to the south rising `shelf` m onto a shelf. `fall` is the
 * valley's fall per cell eastwards: steep, with a low shelf, a channel from
 * the river upstream can run along the slope onto the fields; on a high
 * shelf the river runs too far below them.
 */
function valley(fall: number, shelf: number): World {
  const w = new World(N, N, 11);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = w.idx(x, y);
      const dr = Math.abs(y - 20);
      const h = 40 - x * fall + Math.min(shelf, dr * 0.5) - (dr <= 1 ? 1.2 : 0);
      w.bedrock[i] = h - 3;
      w.soil[i] = 3;
      w.soilType[i] = dr <= 2 ? SoilType.Sand : SoilType.Loam;
      w.ground[i] = 0.3;
      w.fertility[i] = 0.7;
      w.revealed[i] = 255;
      if (dr <= 1) {
        w.water[i] = 0.5;
        w.velX[i] = 0.6;
      }
    }
  return w;
}

/** A struggling village at (30, 31) with dry fields to the south (x 22..38, y 37..40). */
function village(fall: number, shelf: number, reputation = 0.2): Simulation {
  const sim = new Simulation(valley(fall, shelf), 5, { people: { startX: 30, startY: 31 } });
  sim.people!.stage({
    x: 30,
    y: 31,
    food: 100,
    houses: [
      { x: 27, y: 33 },
      { x: 33, y: 33 },
      { x: 30, y: 35 },
    ],
    fields: [{ x0: 22, y0: 37, x1: 38, y1: 40, crop: 40 }],
    people: Array.from({ length: 8 }, (_, k) => ({ x: 30 + (k % 4), y: 31, job: 'farmer' as const })),
  });
  // Dry, but for the river's own banks (village.ts fieldMoisture: 0.8·e^(−d/2.5)).
  const m = sim.people!.fieldMoisture;
  for (let i = 0; i < m.length; i++) m[i] = Math.max(0.1, 0.8 * Math.exp(-Math.max(0, Math.abs(((i / N) | 0) - 20) - 1) / 2.5));
  sim.people!.settlements[0]!.state.reputation = reputation;
  return sim;
}

const ids = (sim: Simulation) => sim.ideas.list().map((i) => i.id);

/** Look on `days` (from the first day the village is seen struggling). */
function looks(sim: Simulation, days: number[]): void {
  for (const d of days) sim.ideas.look(sim, d);
}

describe('help for a struggling village', () => {
  it('knows a struggling village: low reputation, or stuck at the floor; with hysteresis', () => {
    const s = village(0.2, 1.5).people!.settlements[0]!;
    s.state.reputation = 0.3;
    expect(struggling(s, false)).toBe(true);
    s.state.reputation = 0.45;
    expect(struggling(s, false)).toBe(false);
    expect(struggling(s, true)).toBe(true);
    s.state.reputation = 0.55;
    expect(struggling(s, true)).toBe(false);
    // At the floor of eight and drawing nobody.
    s.state.population = 8;
    s.state.reputation = 0.42;
    expect(struggling(s, false)).toBe(true);
  });

  it('suggests a channel from the stream upstream onto the dry fields, after a while, in place of the dry-land ideas', () => {
    const sim = village(0.2, 1.5);
    const s = sim.people!.settlements[0]!;
    const plan = planHelp(sim, s)!;
    expect(plan.what).toBe('channel');
    expect(plan.tool).toBe('dig');
    expect(plan.commands).toHaveLength(1);
    const c = plan.commands[0]!;
    expect(c.type === 'shapeLine' && c.tool === 'dig').toBe(true);
    if (c.type !== 'shapeLine') return;
    // It starts by the river upstream (west of the fields) and its floor falls gently.
    expect(Math.abs(c.points[0]![1] - 20)).toBeLessThanOrEqual(3);
    expect(c.points[0]![0]).toBeLessThan(22);
    expect(c.floor![1]).toBeLessThan(c.floor![0]);
    expect(c.floor![0] - c.floor![1]).toBeLessThan(1);
    // The ring takes in the fields it waters.
    expect(Math.hypot(plan.at[0] - 30, plan.at[1] - 38.5)).toBeLessThan(12);
    expect(plan.fields).toBe(true);
    expect(plan.stream).toBe(true);

    // Not at once: only once the village has struggled for HELP.days.
    looks(sim, [0, 2, 4]);
    expect(ids(sim)).not.toContain('help:0');
    looks(sim, [HELP.days, HELP.days + 2]);
    const idea = sim.ideas.list().find((i) => i.id === 'help:0')!;
    expect(idea.tool).toBe('dig');
    expect(idea.text).toMatch(/^The village is struggling: .*Dig a channel to them from the stream above/);
    expect(sim.ideas.list()[0]!.id).toBe('help:0');
    // It stands in for the village's own dry-land ideas.
    expect(ids(sim).some((id) => id === 'land:0' || id === 'dry:0')).toBe(false);
    expect(sim.ideas.helpCommands('help:0')).toEqual(plan.commands);

    // Prosperity recovers: it goes.
    s.state.reputation = 0.7;
    looks(sim, [HELP.days + 4, HELP.days + 6, HELP.days + 8]);
    expect(ids(sim)).not.toContain('help:0');
  });

  it('suggests nothing it could not do: no water above the dry fields, no floods, no wet ground', () => {
    const sim = village(0.01, 3);
    expect(planHelp(sim, sim.people!.settlements[0]!)).toBeNull();
    looks(sim, [0, HELP.days, HELP.days + 2]);
    expect(ids(sim)).not.toContain('help:0');
  });

  it('suggests nothing for a village doing well', () => {
    const sim = village(0.2, 1.5, 0.7);
    looks(sim, [0, HELP.days, HELP.days + 2]);
    expect(ids(sim)).not.toContain('help:0');
  });

  it('suggests a bank where floods reach the fields', () => {
    const sim = village(0.01, 3);
    const w = sim.world;
    for (let x = 22; x <= 38; x++) w.floodMemory[w.idx(x, 37)] = 250;
    const plan = planHelp(sim, sim.people!.settlements[0]!)!;
    expect(plan.what).toBe('bank');
    expect(plan.tool).toBe('raise');
    expect(Math.abs(plan.at[1] - 37)).toBeLessThanOrEqual(1);
    looks(sim, [0, HELP.days, HELP.days + 2]);
    const idea = sim.ideas.list().find((i) => i.id === 'help:0')!;
    expect(idea.tool).toBe('raise');
    expect(idea.text).toContain('Raise a bank');
    // It stands in for the flood idea.
    expect(ids(sim)).not.toContain('flood:0');
  });

  it('suggests a ditch from waterlogged fields down to lower water', () => {
    const sim = village(0.01, 3);
    const w = sim.world;
    for (let y = 37; y <= 40; y++)
      for (let x = 22; x <= 38; x++) {
        w.ground[w.idx(x, y)] = 3;
        sim.people!.fieldMoisture[w.idx(x, y)] = 0.95;
      }
    // A pond in a hollow below the fields.
    for (let y = 46; y <= 48; y++)
      for (let x = 29; x <= 31; x++) {
        w.bedrock[w.idx(x, y)] -= 2;
        w.water[w.idx(x, y)] = 0.5;
      }
    const plan = planHelp(sim, sim.people!.settlements[0]!)!;
    expect(plan.what).toBe('drain');
    expect(plan.tool).toBe('dig');
    const c = plan.commands[0]!;
    if (c.type !== 'shapeLine') throw new Error('a dig');
    // From the wet fields down to the pond.
    expect(c.points[0]![1]).toBeGreaterThanOrEqual(36);
    expect(c.points[0]![1]).toBeLessThanOrEqual(41);
    expect(c.points[c.points.length - 1]![1]).toBeGreaterThanOrEqual(45);
    expect(c.floor![1]).toBeLessThan(c.floor![0]);
  });

  it('remembers since when a village struggles, with the world', async () => {
    const sim = village(0.2, 1.5);
    looks(sim, [0, 2]);
    const { sim: back } = await loadGame(await saveGame(sim));
    looks(back, [HELP.days, HELP.days + 2]);
    expect(ids(back)).toContain('help:0');
  });
});
