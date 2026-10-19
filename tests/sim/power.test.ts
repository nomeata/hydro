import { describe, expect, it } from 'vitest';
import { CellFlag, SoilType, World } from '../../src/sim/world';
import { Simulation } from '../../src/sim/sim';
import { CELL_AREA, STEPS_PER_DAY } from '../../src/sim/constants';
import { loadGame, saveGame } from '../../src/sim/persist';
import {
  POWER,
  RHO,
  houseDemand,
  polePositions,
  pumpFlow,
  pumpPower,
  pumpSite,
  turbineFlow,
  turbinePower,
  turbineSite,
} from '../../src/sim/power/power';
import { GRAVITY } from '../../src/sim/constants';

const DAY = STEPS_PER_DAY;

/** Bed height of the river at column x. */
const bed = (x: number) => 20 - 0.03 * x;
/** The weir's crest (m), across the valley at x = 30. */
const CREST = bed(30) + 2;

/**
 * A straight river along x (centre row 16, 7 cells wide) on rock, a weir
 * across it at x = 30 with its crest 2 m above the bed, and to the south a
 * walled basin on a terrace (x 36..44, y 25..31) 4 m above the river bed.
 */
function valley(inflow = 6, crest = CREST): World {
  const W = 64;
  const H = 36;
  const w = new World(W, H, 3);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = w.idx(x, y);
      const d = Math.abs(y - 16);
      let h = bed(x) + (d <= 3 ? 0 : Math.min(6, (d - 3) * 1.5));
      if (x === 30) h = Math.max(h, crest);
      if (y >= 24 && y <= 32 && x >= 35 && x <= 45) {
        const edge = y === 24 || y === 32 || x === 35 || x === 45;
        h = edge ? bed(40) + 6.5 : bed(40) + 4;
      }
      w.bedrock[i] = h;
      w.soil[i] = 0;
      w.soilType[i] = SoilType.Rock;
      if (x === 30) w.flags[i]! |= CellFlag.Lined;
      // Start with the pool full to the crest (a small river takes days to fill it) and the river running below.
      if (x < 30) w.water[i] = Math.max(0, Math.min(crest, bed(x) + 2.2) - h);
      else if (d <= 3 && y < 24) w.water[i] = 0.3;
    }
  for (let y = 13; y <= 19; y++) {
    w.flags[w.idx(W - 1, y)] |= CellFlag.Outlet;
    if (inflow > 0) w.inflow[w.idx(0, y)] = inflow / 7;
  }
  return w;
}

function totalStored(w: World): number {
  let s = 0;
  for (let i = 0; i < w.size; i++) s += w.water[i]! + w.ground[i]! + w.snow[i]!;
  return s * CELL_AREA;
}

function flowing(inflow = 6, crest = CREST): Simulation {
  const sim = new Simulation(valley(inflow, crest), 1);
  sim.vegetationOn = false;
  sim.weather.autoFronts = false;
  sim.run(2 * DAY);
  return sim;
}

function build(sim: Simulation): void {
  for (let k = 0; k < 40 && sim.power.pending; k++) sim.run(DAY / 10);
  expect(sim.power.pending).toBe(false);
}

const grid = (w: World) => ({ width: w.width, height: w.height, terrain: (i: number) => w.terrain(i), depth: (i: number) => w.water[i]! });

describe('power formulas', () => {
  it('turbine: Q from the head through the penstock, P = η ρ g Q H', () => {
    expect(turbineFlow(0.2)).toBe(0);
    const q = turbineFlow(2);
    expect(q).toBeCloseTo(POWER.penstockCdA * Math.sqrt(2 * GRAVITY * 2), 9);
    expect(turbineFlow(400)).toBe(POWER.turbineMaxFlow);
    expect(turbinePower(3, 2)).toBeCloseTo(0.8 * RHO * GRAVITY * 3 * 2, 6);
  });

  it('pump: Q = η P / (ρ g H), and its inverse', () => {
    const q = pumpFlow(20000, 5);
    expect(q).toBeCloseTo((0.7 * 20000) / (RHO * GRAVITY * 5), 9);
    expect(pumpPower(q, 5)).toBeCloseTo(20000, 6);
    // Below the minimum head it counts as that.
    expect(pumpFlow(1000, 0.1)).toBeCloseTo(pumpFlow(1000, POWER.pumpMinHead), 9);
  });

  it('house demand peaks in winter evenings', () => {
    const evening = houseDemand(0.8, 0.875);
    expect(evening).toBeGreaterThan(houseDemand(0.1, 0.875) * 2);
    expect(evening).toBeGreaterThan(houseDemand(0.8, 0.375) * 1.4);
    expect(evening).toBeLessThan(POWER.houseDemand * 1.6);
  });

  it('poles every few cells along a stroke, both ends included', () => {
    const p = polePositions([
      [0, 0],
      [20, 0],
    ]);
    expect(p).toEqual([
      [0, 0],
      [6, 0],
      [12, 0],
      [20, 0],
    ]);
  });
});

describe('turbine', () => {
  it('sits on the weir crest with its penstock across the wall', () => {
    const sim = flowing();
    const s = turbineSite(grid(sim.world), [30.3, 16.2])!;
    expect(s.ok).toBe(true);
    expect([s.x, s.y]).toEqual([30, 16]);
    expect(s.a).toBe(sim.world.idx(29, 16));
    // Downstream: the lowest bed within reach.
    expect(s.b).toBe(sim.world.idx(34, 16));
    expect(s.head).toBeGreaterThan(1.5);
    expect(s.power).toBeGreaterThan(30000);
    // Flat river bed: no wall to fall through.
    expect(turbineSite(grid(sim.world), [20, 16])!.ok).toBe(false);
  });

  it('turns the head and flow into power, passing the water on (mass conserved)', () => {
    const sim = flowing();
    const w = sim.world;
    sim.command({ type: 'placeTurbine', points: [[30, 16]] });
    expect(sim.power.turbines.length).toBe(1);
    build(sim);
    sim.run(DAY / 2);
    const before = totalStored(w);
    const L = sim.ledger;
    const l0 = { ...L };
    const p0 = { ...sim.power.ledger };
    sim.run(DAY);
    const t = sim.power.turbines[0]!;
    // Run of the river: the pool stands at the crest, so it runs at full flow.
    expect(t.flow).toBeGreaterThan(3); // from a (upstream, x = 29) to b
    expect(t.power).toBeCloseTo(turbinePower(t.flow, t.head), 6);
    expect(t.power).toBeGreaterThan(40000);
    const P = sim.power.ledger;
    expect(P.turbined - p0.turbined).toBeGreaterThan(3 * DAY * 0.5 * 0.9);
    // Energy book: everything produced went somewhere (no houses here: all unused).
    expect(P.produced - p0.produced).toBeCloseTo(P.houses - p0.houses + P.pumps - p0.pumps + P.dumped - p0.dumped, 0);
    expect(P.dumped - p0.dumped).toBeGreaterThan(0);
    // Mass balance: the turbine moved the water across the weir, it made none.
    const expected = before + L.inflow - l0.inflow - (L.outflow - l0.outflow) - (L.evaporation - l0.evaporation) - (L.seepage - l0.seepage) + L.rain - l0.rain;
    expect(Math.abs(totalStored(w) - expected) / (L.inflow - l0.inflow)).toBeLessThan(1e-3);
    // It took water off the spillway: less spills over the crest beside it.
    const spill = (s: Simulation) => {
      let q = 0;
      for (let y = 13; y <= 19; y++) if (y !== 16) q += s.world.water[s.world.idx(30, y)]!;
      return q;
    };
    const ref = flowing();
    ref.run(DAY * 1.5 + 200);
    expect(spill(sim)).toBeLessThan(spill(ref));
  });

  it('run of the river: with little water it takes what comes; a drawn-down pool is storage, run only for the houses', () => {
    // A small river behind a high dam.
    const sim = flowing(0.6, bed(30) + 3);
    const w = sim.world;
    sim.command({ type: 'placeTurbine', points: [[30, 16]] });
    build(sim);
    sim.run(6 * DAY);
    // The pool settles where the turbine takes about what the river brings.
    const t = sim.power.turbines[0]!;
    expect(t.flow).toBeGreaterThan(0.3);
    expect(t.flow).toBeLessThan(1.5);
    // Drawn down well below its high-water mark, the pool is storage.
    for (let y = 0; y < w.height; y++) for (let x = 0; x < 30; x++) w.water[w.idx(x, y)] = Math.max(0, w.water[w.idx(x, y)]! - 0.8);
    sim.run(5);
    expect(Math.abs(t.flow)).toBe(0);
    sim.power.houses = () => Array.from({ length: 6 }, (_, k) => ({ id: 100 + k, x: 28 + k, y: 21, settlement: 1 }));
    sim.run(20);
    expect(Math.abs(t.flow)).toBeGreaterThan(0);
    // It gives just what the houses want.
    const st = sim.power.stats();
    expect(st.houses).toBe(6);
    expect(st.supplied).toBeCloseTo(st.demand, 3);
    expect(st.produced).toBeCloseTo(st.demand, 3);
  });
});

describe('power grid', () => {
  it('poles carry the power to houses within their radius; too little power dims them', () => {
    const sim = flowing();
    sim.command({ type: 'placeTurbine', points: [[30, 16]] });
    build(sim);
    let houses = [{ id: 1, x: 33, y: 30, settlement: 1 }];
    sim.power.houses = () => houses;
    sim.run(10);
    // Too far from the powerhouse.
    expect(sim.power.stats().houses).toBe(0);
    sim.command({ type: 'placePoles', points: [[31, 16], [31, 21], [31, 29]] });
    expect(sim.power.poles.length).toBeGreaterThanOrEqual(2);
    // The line hangs on the turbine.
    expect(sim.power.wires.slice(0, 2)).toContain(sim.power.turbines[0]!.id);
    build(sim);
    sim.run(10);
    expect(sim.power.stats().houses).toBe(1);
    expect(sim.power.info().lit).toEqual([1, 1]);
    sim.run(60);
    expect(sim.achievements.hasEarned('brightWindows')).toBe(true);
    // A town of houses: the turbine cannot light them all.
    houses = Array.from({ length: 80 }, (_, k) => ({ id: 10 + k, x: 27 + (k % 9), y: 27 + Math.floor(k / 9) * 0.5, settlement: 1 }));
    sim.run(10);
    const st = sim.power.stats();
    expect(st.houses).toBe(80);
    expect(st.supplied).toBeLessThan(st.demand);
    expect(st.supplied).toBeCloseTo(st.produced, 3);
    sim.run(60);
    expect(sim.achievements.hasEarned('villageLights')).toBe(true);
    // Poles never stand in the water.
    for (const p of sim.power.poles) expect(sim.world.water[sim.world.idx(p.x, p.y)]!).toBeLessThan(0.1);
    const lit = sim.power.info().lit;
    expect(lit[1]!).toBeLessThan(1);
    expect(lit[1]!).toBeGreaterThan(0);
    // A pole knocked down by a flood: the line is cut, the houses go dark.
    const far = sim.power.poles[sim.power.poles.length - 1]!;
    sim.world.water[sim.world.idx(far.x, far.y)] = 1.5;
    sim.power.floods(sim.time.day);
    sim.run(2);
    expect(sim.power.stats().houses).toBeLessThan(80);
  });

  it('an electric pump lifts water with the surplus into the basin; energy and water are booked', () => {
    const sim = flowing();
    const w = sim.world;
    sim.command({ type: 'placeTurbine', points: [[30, 16]] });
    const ps = pumpSite(grid(w), [
      [40, 17],
      [40, 28],
    ])!;
    expect(ps.reason).toBeUndefined();
    expect(ps.ok).toBe(true);
    expect(ps.lift).toBeGreaterThan(3);
    sim.command({ type: 'placePoles', points: [[31, 16], [36, 21]] });
    sim.command({ type: 'placePump', points: [[40, 17], [40, 28]] });
    expect(sim.power.pumps.length).toBe(1);
    build(sim);
    sim.run(10);
    const before = totalStored(w);
    const L = sim.ledger;
    const l0 = { ...L };
    const p0 = { ...sim.power.ledger };
    sim.run(DAY / 2);
    const pump = sim.power.pumps[0]!;
    expect(pump.power).toBeCloseTo(POWER.pumpRating, 0);
    expect(pump.flow).toBeGreaterThan(0.2);
    expect(w.water[w.idx(40, 28)]!).toBeGreaterThan(0.05);
    const P = sim.power.ledger;
    expect(P.pumps - p0.pumps).toBeCloseTo(POWER.pumpRating * (DAY / 2) * 0.5, -3);
    expect(P.produced - p0.produced).toBeCloseTo(P.houses - p0.houses + P.pumps - p0.pumps + P.dumped - p0.dumped, 0);
    // The lifted water: E_pump · η = ρ g V H.
    const lifted = P.pumpedWater - p0.pumpedWater;
    expect(lifted).toBeGreaterThan(50);
    const expected = before + L.inflow - l0.inflow - (L.outflow - l0.outflow) - (L.evaporation - l0.evaporation) - (L.seepage - l0.seepage) + L.rain - l0.rain;
    expect(Math.abs(totalStored(w) - expected) / (L.inflow - l0.inflow)).toBeLessThan(1e-3);
  });

  it('pumped storage: the pump fills the basin on spare power, the basin turbine gives it back when the houses want more', () => {
    const sim = flowing();
    sim.command({ type: 'placeTurbine', points: [[30, 16]] });
    sim.command({ type: 'placeTurbine', points: [[40, 24]] });
    expect(sim.power.turbines.length).toBe(2);
    sim.command({ type: 'placePump', points: [[40, 17], [40, 28]] });
    sim.command({ type: 'placePoles', points: [[31, 16], [36, 21], [40, 24]] });
    build(sim);
    // A town: more than the river turbine can give at the evening peak, much less at night.
    sim.power.houses = () => Array.from({ length: 30 }, (_, k) => ({ id: 100 + k, x: 34 + (k % 6), y: 20 + Math.floor(k / 6) * 0.2, settlement: 1 }));
    sim.run(3 * DAY);
    const d = sim.power.lastDay;
    expect(d.pumps).toBeGreaterThan(0);
    expect(d.storage).toBeGreaterThan(0);
    // The basin turbine never runs free: it only covers the evening's shortfall.
    const basin = sim.power.turbines[1]!;
    expect(basin.produced).toBeGreaterThan(0);
    expect(d.produced).toBeCloseTo(d.houses + d.pumps + d.dumped, -2);
    sim.run(DAY);
    expect(sim.achievements.hasEarned('nightAndDay')).toBe(true);
  });

  it('a pump drawing beside a lone turbine does not stop it: with nothing else to fill its pool, the turbine runs free and the pump on its surplus', () => {
    const sim = flowing();
    sim.command({ type: 'placeTurbine', points: [[30, 16]] });
    build(sim);
    sim.run(DAY / 4);
    const t = sim.power.turbines[0]!;
    const before = t.power;
    expect(before).toBeGreaterThan(30000);
    // From the tailwater right below the wall up onto the wall beside the turbine (as in the e2e power spec).
    sim.command({ type: 'placePump', points: [[32, 16], [30, 20]] });
    expect(sim.power.pumps.length).toBe(1);
    build(sim);
    sim.run(DAY / 4);
    expect(t.power).toBeGreaterThan(before * 0.8);
    const pump = sim.power.pumps[0]!;
    expect(pump.flow).toBeGreaterThan(0);
    expect(pump.power).toBeCloseTo(POWER.pumpRating, 0);
  });

  it('a pump whose outlet stands above the pool (on the wall or a bank) does not make the turbine storage', () => {
    // A small river behind a high dam: the pool settles below the crest.
    const sim = flowing(3, bed(30) + 3);
    sim.command({ type: 'placeTurbine', points: [[30, 16]] });
    sim.command({ type: 'placeTurbine', points: [[40, 24]] });
    sim.command({ type: 'placePoles', points: [[31, 16], [36, 21], [40, 24]] });
    build(sim);
    sim.run(4 * DAY);
    const t = sim.power.turbines[0]!;
    const before = Math.abs(t.flow);
    expect(before).toBeGreaterThan(0.3);
    // From the deepest tailwater onto the dam's crest, above the pool: that water is not stored behind it.
    const w = sim.world;
    let inlet: [number, number] = [31, 16];
    for (let x = 31; x <= 34; x++) for (let y = 14; y <= 18; y++) if (w.water[w.idx(x, y)]! > w.water[w.idx(...inlet)]!) inlet = [x, y];
    sim.command({ type: 'placePump', points: [inlet, [30, 20]] });
    expect(sim.power.pumps.length).toBe(1);
    build(sim);
    sim.run(DAY / 2);
    expect(Math.abs(t.flow)).toBeGreaterThan(before * 0.5);
  });

  it('is saved and resumes exactly; saves without power still load', async () => {
    const sim = flowing();
    sim.command({ type: 'placeTurbine', points: [[30, 16]] });
    sim.command({ type: 'placePoles', points: [[31, 16], [36, 21]] });
    sim.command({ type: 'placePump', points: [[40, 17], [40, 28]] });
    build(sim);
    sim.run(200);
    const bytes = await saveGame(sim);
    const { sim: b } = await loadGame(bytes);
    expect(b.power.turbines.length).toBe(1);
    sim.run(300);
    b.run(300);
    expect(b.stateHash()).toBe(sim.stateHash());
    const st = sim.getState();
    delete st.power;
    const c = new Simulation(valley(), 1);
    c.setState(st);
    expect(c.power.empty).toBe(true);
    c.run(10);
  });
});
