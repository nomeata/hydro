import { describe, expect, it } from 'vitest';
import { CellFlag, LandUse, SoilType, World } from '../../src/sim/world';
import { Simulation } from '../../src/sim/sim';
import { CELL_AREA, STEPS_PER_DAY } from '../../src/sim/constants';
import { BRUSH, brushSample, brushWeight, passDepth, strokeSamples, type SculptGrid } from '../../src/sim/plans/sculpt';
import { loadGame, saveGame } from '../../src/sim/persist';
import type { BrushTool, Command } from '../../src/shared/protocol';

/** A flat meadow at 10 m, with a pond in one corner. */
function meadow(n = 48): World {
  const w = new World(n, n, 3);
  for (let i = 0; i < w.size; i++) {
    w.bedrock[i] = 8;
    w.soil[i] = 2;
    w.soilType[i] = SoilType.Loam;
    w.ground[i] = 0.3;
  }
  for (let y = 30; y < 44; y++) for (let x = 30; x < 44; x++) w.water[w.idx(x, y)] = 0.8;
  return w;
}

function totalWater(w: World): number {
  let s = 0;
  for (let i = 0; i < w.size; i++) s += w.water[i]! + w.ground[i]!;
  return s * CELL_AREA;
}

const hold = (tool: BrushTool, x: number, y: number, seconds: number, radius = 2.5, stroke = 1): Command => {
  const samples: number[] = [];
  for (let t = 0; t < seconds - 1e-9; t += 1 / 60) samples.push(x, y, 1 / 60);
  return { type: 'sculpt', tool, radius, stroke, samples };
};

describe('brush kernel', () => {
  const flat: SculptGrid = { width: 20, height: 20, terrain: () => 5, fixed: () => false };

  it('raises by rate × time at the centre, with a soft falloff to nothing at the rim', () => {
    const dz = new Map<number, number>();
    brushSample(flat, 'raise', 10, 10, 3, 0.2, (i, d) => dz.set(i, d));
    expect(dz.get(10 * 20 + 10)).toBeCloseTo(BRUSH.rate * 0.2, 6);
    expect(dz.get(10 * 20 + 12)!).toBeCloseTo(BRUSH.rate * 0.2 * brushWeight(2, 3), 6);
    expect(dz.has(10 * 20 + 13)).toBe(false);
    const dig = new Map<number, number>();
    brushSample(flat, 'dig', 10, 10, 3, 0.2, (i, d) => dig.set(i, d));
    expect(dig.get(210)).toBeCloseTo(-BRUSH.rate * 0.2, 6);
  });

  it('a quick swipe does little; holding does a lot', () => {
    expect(passDepth(2.5, 30)).toBeLessThan(0.15);
    expect(BRUSH.rate * 2).toBeGreaterThan(2);
    const s = strokeSamples([[0, 0], [10, 0]], 5);
    let t = 0;
    for (let k = 2; k < s.length; k += 3) t += s[k]!;
    expect(t).toBeCloseTo(2, 1);
  });

  it('leaves fixed cells alone and fades out beside them', () => {
    const fixed: SculptGrid = { ...flat, fixed: (i) => i === 10 * 20 + 10 };
    const dz = new Map<number, number>();
    brushSample(fixed, 'dig', 10, 10, 4, 0.2, (i, d) => dz.set(i, d));
    expect(dz.has(210)).toBe(false);
    const next = Math.abs(dz.get(211)!);
    const far = Math.abs(dz.get(213)!);
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThan(0.5 * BRUSH.rate * 0.2 * brushWeight(1, 4));
    expect(far).toBeCloseTo(BRUSH.rate * 0.2 * brushWeight(3, 4), 6);
  });

  it('even pulls the ground towards its mean', () => {
    const bumpy: SculptGrid = { ...flat, terrain: (i) => ((i % 20) + ((i / 20) | 0)) % 2 ? 6 : 4 };
    let before = 0;
    let after = 0;
    brushSample(bumpy, 'even', 10, 10, 3, 0.2, (i, d) => {
      before += Math.abs(bumpy.terrain(i) - 5);
      after += Math.abs(bumpy.terrain(i) + d - 5);
    });
    expect(after).toBeLessThan(before * 0.9);
  });
});

describe('sculpting in the sim', () => {
  it('changes the ground at once, also while no time passes, and marks it loose earth', () => {
    const w = meadow();
    const sim = new Simulation(w, 1);
    const i = w.idx(12, 12);
    const z = w.terrain(i);
    sim.command(hold('raise', 12, 12, 1));
    expect(w.terrain(i)).toBeGreaterThan(z + 1);
    expect(w.flags[i]! & CellFlag.Fill).toBeTruthy();
    sim.command(hold('dig', 20, 12, 1, 2.5, 2));
    const j = w.idx(20, 12);
    expect(w.terrain(j)).toBeLessThan(z - 1);
    expect(w.flags[j]! & CellFlag.Canal).toBeTruthy();
    expect(w.flags[j]! & CellFlag.Fill).toBeFalsy();
    expect(sim.step).toBe(0);
    expect(sim.brush.moved.brush).toBeGreaterThan(40);
    expect(sim.achievements.hasEarned('firstSpade')).toBe(true);
  });

  it('conserves water: raising under water lifts it, digging makes room', () => {
    const w = meadow();
    const sim = new Simulation(w, 1);
    const before = totalWater(w);
    sim.command(hold('raise', 36, 36, 1.5, 4));
    sim.command(hold('dig', 32, 40, 1.5, 4, 2));
    sim.command(hold('even', 34, 38, 1, 4, 3));
    sim.command({ type: 'undoSculpt' });
    expect(totalWater(w)).toBeCloseTo(before, 3);
    // The raised water runs off: still conserved while it flows (closed meadow, no rain).
    sim.vegetationOn = false;
    sim.run(200);
    const L = sim.ledger;
    expect(totalWater(w)).toBeCloseTo(before + L.rain + L.inflow - L.outflow - L.evaporation - L.seepage, 0);
  });

  it('goes round houses, bridges and structures, and clears fields under it', () => {
    const w = meadow();
    const sim = new Simulation(w, 1);
    const house = w.idx(12, 12);
    const bridge = w.idx(14, 12);
    const struct = w.idx(12, 14);
    const field = w.idx(10, 12);
    w.landuse[house] = LandUse.Building;
    w.landuse[bridge] = LandUse.Bridge;
    w.flags[struct]! |= CellFlag.Structure;
    w.landuse[field] = LandUse.Field;
    w.crop[field] = 100;
    const z = [house, bridge, struct].map((i) => w.terrain(i));
    // (A structure flag is derived from the structures: keep it for this test.)
    sim.syncStructureFlags = () => {};
    sim.command(hold('dig', 12, 12, 1.5, 4));
    expect([house, bridge, struct].map((i) => w.terrain(i))).toEqual(z);
    expect(w.terrain(field)).toBeLessThan(z[0]! - 0.2);
    expect(w.landuse[field]).toBe(LandUse.None);
    expect(w.terrain(w.idx(12, 9))).toBeLessThan(z[0]! - 0.1);
  });

  it('undoes the last strokes, one at a time', () => {
    const w = meadow();
    const sim = new Simulation(w, 1);
    const orig = Float32Array.from({ length: w.size }, (_, i) => w.terrain(i));
    sim.command(hold('raise', 10, 10, 1, 2.5, 1));
    const after1 = Float32Array.from({ length: w.size }, (_, i) => w.terrain(i));
    sim.command(hold('dig', 12, 10, 1, 2.5, 2));
    sim.command(hold('dig', 13, 10, 0.5, 2.5, 2)); // the same stroke
    expect(sim.brush.undoable).toBe(2);
    sim.command({ type: 'undoSculpt' });
    for (let i = 0; i < w.size; i++) expect(w.terrain(i)).toBeCloseTo(after1[i]!, 5);
    sim.command({ type: 'undoSculpt' });
    for (let i = 0; i < w.size; i++) expect(w.terrain(i)).toBeCloseTo(orig[i]!, 5);
    expect(sim.brush.undoable).toBe(0);
    sim.command({ type: 'undoSculpt' });
  });

  it('is deterministic and survives save and resume', async () => {
    const make = () => {
      const sim = new Simulation(meadow(), 4);
      sim.command(hold('dig', 10, 20, 1));
      sim.command(hold('raise', 25, 20, 1, 2.5, 2));
      sim.run(50);
      return sim;
    };
    const a = make();
    const b = make();
    expect(a.stateHash()).toBe(b.stateHash());
    const { sim: c } = await loadGame(await saveGame(a, {}));
    expect(c.stateHash()).toBe(a.stateHash());
    expect(c.brush.moved).toEqual(a.brush.moved);
    a.run(300);
    c.run(300);
    expect(c.stateHash()).toBe(a.stateHash());
  });

  it('a channel dug from the pond fills with its water', () => {
    const w = meadow();
    const sim = new Simulation(w, 1);
    sim.command({ type: 'shapeLine', tool: 'dig', points: [[36, 30], [36, 20]], width: 2, amount: 1 });
    sim.run(STEPS_PER_DAY / 4);
    expect(w.water[w.idx(36, 24)]!).toBeGreaterThan(0.05);
  });

  it('finishes the earthwork plans of old saves on load', async () => {
    const sim = new Simulation(meadow(), 1);
    const w = sim.world;
    const i = w.idx(5, 5);
    const z = w.terrain(i);
    w.plan[i] = z - 1;
    const { sim: b } = await loadGame(await saveGame(sim, {}));
    expect(b.world.terrain(i)).toBeCloseTo(z - 1, 4);
    expect(Number.isNaN(b.world.plan[i]!)).toBe(true);
  });
});
