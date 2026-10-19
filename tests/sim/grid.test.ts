import { describe, expect, it } from 'vitest';
import { LandUse, SoilType, World, CellFlag } from '../../src/sim/world';
import { PowerGrid, type Turbine } from '../../src/sim/power/grid';
import { LINES } from '../../src/sim/power/lines';
import { LINK_SPAN, SUPPLY_RADIUS } from '../../src/sim/power/power';
import { Simulation } from '../../src/sim/sim';
import { STEPS_PER_DAY } from '../../src/sim/constants';
import { loadGame, saveGame } from '../../src/sim/persist';

const DAY = STEPS_PER_DAY;

/** Flat meadow (10 m) on rock. */
function meadow(W = 90, H = 70): World {
  const w = new World(W, H, 5);
  for (let i = 0; i < w.size; i++) {
    w.bedrock[i] = 10;
    w.soil[i] = 0;
    w.soilType[i] = SoilType.Rock;
  }
  return w;
}

function water(w: World, x0: number, x1: number, y0: number, y1: number, d = 0.5): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) w.water[w.idx(x, y)] = d;
}

/** A house with its yard. */
function house(w: World, x: number, y: number): void {
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (w.landuse[w.idx(x + dx, y + dy)] === LandUse.None) w.landuse[w.idx(x + dx, y + dy)] = LandUse.Yard;
  w.landuse[w.idx(x, y)] = LandUse.Building;
}

/** A turbine as the grid holds it, finished and having made power. */
function turbine(w: World, x: number, y: number): Turbine {
  return { id: 9000, x, y, rot: 0, a: w.idx(x - 1, y), b: w.idx(x + 1, y), crest: 12, progress: 1, flow: 0, head: 0, power: 0, produced: 1, water: 0 };
}

const HOUSES = [
  [60, 36],
  [62, 44],
  [68, 35],
  [71, 43],
  [65, 48],
  [74, 38],
  [58, 41],
] as const;

/** The meadow with a stream (x 39..41), a turbine in the west, a village in the east, a path between and a field. */
function scene(): { w: World; grid: PowerGrid; houses: { id: number; x: number; y: number; settlement: number }[] } {
  const w = meadow();
  water(w, 39, 41, 0, 69, 0.4);
  for (let x = 12; x <= 38; x++) w.landuse[w.idx(x, 33)] = LandUse.Path;
  for (let x = 42; x <= 63; x++) w.landuse[w.idx(x, 39)] = LandUse.Path;
  for (let y = 50; y <= 58; y++) for (let x = 52; x <= 60; x++) w.landuse[w.idx(x, y)] = LandUse.Field;
  w.landuse[w.idx(65, 40)] = LandUse.Building;
  const houses = HOUSES.map(([x, y], k) => {
    house(w, x, y);
    return { id: 100 + k, x, y, settlement: 1 };
  });
  const grid = new PowerGrid(w);
  grid.turbines.push(turbine(w, 10, 35));
  grid.houses = () => houses;
  grid.villages = () => [{ id: 1, x: 65, y: 40 }];
  return { w, grid, houses };
}

/** Plan and build day by day (every pole goes up the day it is planned). */
function grow(grid: PowerGrid, days: number, from = 1): number {
  let day = from;
  for (; day < from + days; day++) {
    grid.planGrid(day);
    for (const p of grid.poles) while (p.progress < 1) grid.workPole(p.id);
  }
  return day;
}

/** Node ids reachable over the wires from `start`. */
function reach(grid: PowerGrid, start: number): Set<number> {
  const seen = new Set([start]);
  const todo = [start];
  while (todo.length) {
    const a = todo.pop()!;
    for (let k = 0; k + 1 < grid.wires.length; k += 2) {
      const [u, v] = [grid.wires[k]!, grid.wires[k + 1]!];
      const o = u === a ? v : v === a ? u : -1;
      if (o >= 0 && !seen.has(o)) {
        seen.add(o);
        todo.push(o);
      }
    }
  }
  return seen;
}

function pos(grid: PowerGrid, id: number): [number, number] {
  const t = grid.turbines.find((o) => o.id === id);
  if (t) return [t.x, t.y];
  const p = grid.poles.find((o) => o.id === id)!;
  return [p.x, p.y];
}

function spans(grid: PowerGrid): number[] {
  const out: number[] = [];
  for (let k = 0; k + 1 < grid.wires.length; k += 2) {
    const a = pos(grid, grid.wires[k]!);
    const b = pos(grid, grid.wires[k + 1]!);
    out.push(Math.hypot(a[0] - b[0], a[1] - b[1]));
  }
  return out;
}

describe('the villagers’ grid', () => {
  it('waits for the first turbine to make power', () => {
    const { grid } = scene();
    grid.turbines[0]!.produced = 0;
    grow(grid, 5);
    expect(grid.poles.length).toBe(0);
  });

  it('runs a line from the turbine to the village and reaches every house', () => {
    const { w, grid, houses } = scene();
    grow(grid, 8);
    const on = reach(grid, 9000);
    const live = grid.poles.filter((p) => on.has(p.id));
    expect(live.length).toBe(grid.poles.length);
    for (const h of houses) expect(live.some((p) => Math.hypot(p.x - h.x, p.y - h.y) <= SUPPLY_RADIUS)).toBe(true);
    // Every house is reached, and a pole stands right beside some of them.
    expect(houses.filter((h) => live.some((p) => Math.hypot(p.x - h.x, p.y - h.y) <= LINES.endNear + 0.5)).length).toBeGreaterThan(0);
    // Even spans, none too long; poles keep apart.
    const s = spans(grid);
    expect(Math.max(...s)).toBeLessThanOrEqual(LINK_SPAN);
    expect(Math.min(...s)).toBeGreaterThanOrEqual(LINES.minSpan - 1e-9);
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    expect(mean).toBeGreaterThan(4.5);
    expect(mean).toBeLessThan(7.5);
    // Never in the water, a house, a yard's house, a field or on a bridge.
    for (const p of grid.poles) {
      const i = w.idx(p.x, p.y);
      expect(w.water[i]!).toBeLessThan(LINES.dry);
      expect([LandUse.Building, LandUse.Field, LandUse.Bridge]).not.toContain(w.landuse[i]);
    }
    // One wire spans the stream.
    expect(grid.wires.some((_, k) => k % 2 === 0 && (pos(grid, grid.wires[k]!)[0] - 40) * (pos(grid, grid.wires[k + 1]!)[0] - 40) < 0)).toBe(true);
    // The trunk follows the paths: most poles between turbine and village stand on or beside one.
    const byPath = (x: number, y: number) => {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (w.landuse[w.idx(x + dx, y + dy)] === LandUse.Path) return true;
      return false;
    };
    const trunk = grid.poles.filter((p) => p.x > 14 && p.x < 56);
    expect(trunk.length).toBeGreaterThan(4);
    expect(trunk.filter((p) => byPath(p.x, p.y)).length / trunk.length).toBeGreaterThan(0.6);
    // Straight runs, gentle turns: few sharp bends.
    let sharp = 0;
    for (const p of grid.poles) {
      const nb: [number, number][] = [];
      for (let k = 0; k + 1 < grid.wires.length; k += 2) {
        if (grid.wires[k] === p.id) nb.push(pos(grid, grid.wires[k + 1]!));
        if (grid.wires[k + 1] === p.id) nb.push(pos(grid, grid.wires[k]!));
      }
      if (nb.length !== 2) continue;
      const [a, b] = nb as [[number, number], [number, number]];
      const cos = ((a[0] - p.x) * (b[0] - p.x) + (a[1] - p.y) * (b[1] - p.y)) / (Math.hypot(a[0] - p.x, a[1] - p.y) * Math.hypot(b[0] - p.x, b[1] - p.y));
      if (cos > -0.5) sharp++;
    }
    expect(sharp).toBeLessThanOrEqual(2);
    // Nothing more to do: the plan settles.
    const n = grid.poles.length;
    grow(grid, 5, 20);
    expect(grid.poles.length).toBe(n);
  });

  it('goes round water too wide for a span', () => {
    const w = meadow();
    // A lake between the turbine and the village, open land only in the south.
    water(w, 30, 55, 0, 52, 1.5);
    const grid = new PowerGrid(w);
    grid.turbines.push(turbine(w, 10, 30));
    const houses = [{ id: 1, x: 72, y: 30, settlement: 1 }];
    house(w, 72, 30);
    grid.houses = () => houses;
    grid.villages = () => [{ id: 1, x: 72, y: 30 }];
    grow(grid, 6);
    const on = reach(grid, 9000);
    expect(grid.poles.some((p) => on.has(p.id) && Math.hypot(p.x - 72, p.y - 30) <= SUPPLY_RADIUS)).toBe(true);
    // No span over the lake.
    for (let k = 0; k + 1 < grid.wires.length; k += 2) {
      const a = pos(grid, grid.wires[k]!);
      const b = pos(grid, grid.wires[k + 1]!);
      let wet = 0;
      for (let t = 0; t <= 20; t++) if (w.water[w.idx(Math.round(a[0] + ((b[0] - a[0]) * t) / 20), Math.round(a[1] + ((b[1] - a[1]) * t) / 20))]! > 0.05) wet++;
      expect(wet).toBeLessThan(20);
    }
    expect(grid.poles.every((p) => p.y > 50 || p.x < 30 || p.x > 55)).toBe(true);
  });

  it('puts poles knocked down by a flood or by moved ground up again, and moves them out of the way of houses and fields', () => {
    const { w, grid, houses } = scene();
    let day = grow(grid, 8);
    const n = grid.poles.length;
    // A flood over a pole.
    const p = grid.poles[2]!;
    const i = w.idx(p.x, p.y);
    w.water[i] = 1.2;
    expect(grid.floods(day)).toBe(true);
    expect(p.progress).toBe(LINES.stump);
    // Not while the water stands; once it is gone, the builders come back.
    expect(grid.poleSite(1, day, () => false)?.id).not.toBe(p.id);
    w.water[i] = 0;
    expect(grid.poleSite(1, day, () => false)?.id).toBe(p.id);
    while (!grid.workPole(p.id));
    expect(p.progress).toBe(1);
    // Ground dug out from under a pole.
    const q = grid.poles[3]!;
    w.bedrock[w.idx(q.x, q.y)]! -= 0.6;
    expect(grid.groundCheck(day)).toBe(true);
    expect(q.progress).toBeLessThan(1);
    day = grow(grid, 1, day);
    expect(q.progress).toBe(1);
    // A new house where a pole stands: the pole moves aside.
    const r = grid.poles[1]!;
    const at = [r.x, r.y];
    house(w, r.x, r.y);
    day = grow(grid, 1, day);
    expect([r.x, r.y]).not.toEqual(at);
    expect(w.landuse[w.idx(r.x, r.y)]).not.toBe(LandUse.Building);
    // A new field under a standing pole: a new one goes up beside it first, then it comes down.
    const f = grid.poles[4]!;
    w.landuse[w.idx(f.x, f.y)] = LandUse.Field;
    grid.planGrid(day);
    expect(grid.poles.some((o) => o.id === f.id && o.progress >= 1)).toBe(true);
    const repl = grid.poles.find((o) => o.replaces === f.id)!;
    expect(repl).toBeDefined();
    while (!grid.workPole(repl.id));
    expect(grid.poles.some((o) => o.id === f.id)).toBe(false);
    day = grow(grid, 2, day + 1);
    expect(grid.poles.length).toBe(n);
    const on = reach(grid, 9000);
    for (const h of houses) expect(grid.poles.some((o) => on.has(o.id) && Math.hypot(o.x - h.x, o.y - h.y) <= SUPPLY_RADIUS)).toBe(true);
  });

  it('joins a second village and a second turbine into one grid', () => {
    const { w, grid, houses } = scene();
    house(w, 30, 62);
    house(w, 34, 64);
    houses.push({ id: 200, x: 30, y: 62, settlement: 2 }, { id: 201, x: 34, y: 64, settlement: 2 });
    grid.villages = () => [
      { id: 1, x: 65, y: 40 },
      { id: 2, x: 32, y: 60 },
    ];
    grid.turbines.push({ ...turbine(w, 80, 8), id: 9001 });
    grow(grid, 14);
    const on = reach(grid, 9000);
    expect(on.has(9001)).toBe(true);
    for (const h of houses) expect(grid.poles.some((o) => on.has(o.id) && Math.hypot(o.x - h.x, o.y - h.y) <= SUPPLY_RADIUS)).toBe(true);
  });

  it('is deterministic and resumes exactly from its saved state', () => {
    const a = scene();
    grow(a.grid, 3);
    const st = a.grid.getState();
    const b = scene();
    b.grid.setState(st);
    grow(a.grid, 6, 4);
    grow(b.grid, 6, 4);
    expect(b.grid.getState()).toEqual(a.grid.getState());
    expect(a.grid.poles.length).toBeGreaterThan(3);
  });
});

/**
 * A river along x (rows 9..15) with a weir at x = 30, gentle banks rising
 * to a flat terrace (3 m up), a village staged on it to the south.
 */
function valley(): World {
  const W = 72;
  const H = 60;
  const w = new World(W, H, 3);
  const bed = (x: number) => 20 - 0.03 * x;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = w.idx(x, y);
      const d = Math.abs(y - 12);
      let h = bed(x) + (d <= 3 ? 0 : Math.min(3.5, (d - 3) * 0.6));
      if (x === 30 && d <= 5) h = Math.max(h, bed(30) + 2);
      w.bedrock[i] = h;
      w.soil[i] = 0;
      w.soilType[i] = SoilType.Rock;
      if (x === 30 && d <= 5) w.flags[i]! |= CellFlag.Lined;
      if (d <= 3) w.water[i] = x < 30 ? Math.max(0, bed(30) + 2.1 - h) : 0.3;
    }
  for (let y = 9; y <= 15; y++) {
    w.flags[w.idx(W - 1, y)] |= CellFlag.Outlet;
    w.inflow[w.idx(0, y)] = 6 / 7;
  }
  return w;
}

function village(): Simulation {
  const w = valley();
  const sim = new Simulation(w, 1, { people: { startX: 44, startY: 42 } });
  sim.fog = false;
  w.revealed.fill(255);
  sim.vegetationOn = false;
  sim.weather.autoFronts = false;
  sim.people!.stage({
    x: 44,
    y: 42,
    food: 400,
    houses: [
      [40, 38],
      [48, 38],
      [41, 46],
      [47, 47],
      [52, 43],
    ].map(([x, y]) => ({ x: x!, y: y! })),
    fields: [],
    people: Array.from({ length: 8 }, (_, k) => ({ x: 43 + (k % 4), y: 43 + Math.floor(k / 4), job: k < 2 ? ('builder' as const) : ('farmer' as const) })),
  });
  sim.run(DAY / 2);
  return sim;
}

describe('the villagers build the grid', () => {
  it('builders put the poles up, a few a day, and the houses light up; saved and resumed exactly', async () => {
    const sim = village();
    sim.command({ type: 'placeTurbine', points: [[30, 12]] });
    for (let d = 0; d < 3 && sim.power.turbines[0]!.produced <= 0; d++) sim.run(DAY);
    expect(sim.power.turbines[0]!.produced).toBeGreaterThan(0);
    const houses = sim.people!.houses().length;
    let first = -1;
    let save: Uint8Array | null = null;
    for (let d = 0; d < 12 && sim.power.stats().houses < houses; d++) {
      sim.run(DAY);
      if (first < 0 && sim.power.poles.some((p) => p.progress >= 1)) first = d;
      if (!save && sim.power.poles.length) save = await saveGame(sim);
    }
    expect(sim.power.stats().houses).toBe(houses);
    expect(sim.power.info().lit.length).toBe(2 * houses);
    // The village's builders put them up (not the spirit crew), over a few days.
    expect(sim.power.poles.every((p) => p.settlement === sim.people!.settlements[0]!.state.id)).toBe(true);
    expect(sim.power.poles.length).toBeGreaterThan(3);
    // The resumed game goes on exactly as the uninterrupted one.
    const { sim: b } = await loadGame(save!);
    // (As the test set up the original: no fog, vegetation or rain fronts.)
    b.fog = false;
    b.vegetationOn = false;
    b.weather.autoFronts = false;
    const steps = sim.step - b.step;
    b.run(steps);
    expect(b.stateHash()).toBe(sim.stateHash());
  }, 240_000);
});

