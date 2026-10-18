import { describe, expect, it } from 'vitest';
import { CellFlag, SoilType, World } from '../../src/sim/world';
import { Simulation } from '../../src/sim/sim';
import { CELL_AREA, STEPS_PER_DAY } from '../../src/sim/constants';

/** A tilted valley with a river entering at x = 0 and leaving at x = W-1. */
function valley(n = 64): World {
  const w = new World(n, n, 7);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = w.idx(x, y);
      const dy = Math.abs(y - n / 2);
      w.bedrock[i] = (n - x) * 0.05 + dy * 0.4 - (dy < 3 ? 1.5 : 0);
      w.soil[i] = 1.5;
      w.soilType[i] = SoilType.Loam;
    }
  for (let y = n / 2 - 2; y <= n / 2 + 2; y++) {
    w.inflow[w.idx(0, y)] = 1;
    w.flags[w.idx(n - 1, y)] |= CellFlag.Outlet;
  }
  return w;
}

function totalStored(w: World): number {
  let s = 0;
  for (let i = 0; i < w.size; i++) s += w.water[i]! + w.ground[i]! + w.snow[i]!;
  return s * CELL_AREA;
}

describe('Simulation', () => {
  it('balances its water ledger', () => {
    const w = valley();
    const sim = new Simulation(w, 1);
    const before = totalStored(w);
    sim.run(STEPS_PER_DAY * 2);
    const L = sim.ledger;
    const expected = before + L.rain + L.snowfall + L.inflow - L.outflow - L.evaporation - L.seepage;
    const after = totalStored(w);
    expect(Math.abs(after - expected) / Math.max(1, L.inflow + L.rain)).toBeLessThan(1e-3);
    expect(L.outflow).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const a = new Simulation(valley(), 3);
    const b = new Simulation(valley(), 3);
    a.run(500);
    b.run(500);
    expect(a.stateHash()).toBe(b.stateHash());
  });

  it('shapes a trench at once (no plan, no crew)', () => {
    const w = valley();
    const sim = new Simulation(w, 1);
    const i = w.idx(25, 10);
    const before = w.terrain(i);
    sim.command({ type: 'shapeLine', tool: 'dig', points: [[10, 10], [40, 10]], width: 2, amount: 1.5 });
    expect(w.terrain(i)).toBeLessThan(before - 1.3);
    expect(Number.isNaN(w.plan[i]!)).toBe(true);
    expect(sim.crew.pending).toBe(0);
  });

  it('builds a dike with a level crest', () => {
    const w = valley();
    const sim = new Simulation(w, 1);
    sim.command({ type: 'shapeLine', tool: 'raise', points: [[30, 20], [30, 44]], width: 2, amount: 3 });
    sim.run(STEPS_PER_DAY * 4);
    const crest = [24, 28, 32, 36, 40].map((y) => w.terrain(w.idx(30, y)));
    const lowest = Math.min(...crest);
    // Where the valley floor is low, the crest is level.
    expect(w.terrain(w.idx(30, 32))).toBeGreaterThan(lowest - 0.01);
    expect(Math.abs(w.terrain(w.idx(30, 31)) - w.terrain(w.idx(30, 33)))).toBeLessThan(0.05);
  });
});

describe('level tool', () => {
  it('flattens a brushed area to the starting height', () => {
    const w = valley();
    const sim = new Simulation(w, 1);
    const start = w.terrain(w.idx(10, 12));
    sim.command({ type: 'shapeLine', tool: 'even', points: [[10, 12], [20, 12], [20, 20]], width: 4 });
    sim.run(STEPS_PER_DAY * 4);
    for (const [x, y] of [[15, 12], [20, 16], [19, 19]] as const) {
      expect(Math.abs(w.terrain(w.idx(x, y)) - start)).toBeLessThan(0.05);
    }
  });
});
