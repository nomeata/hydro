import { describe, expect, it } from 'vitest';
import { CellFlag, SoilType, World } from '../../src/sim/world';
import { Simulation } from '../../src/sim/sim';
import { CELL_AREA, STEPS_PER_DAY } from '../../src/sim/constants';
import { loadGame, saveGame } from '../../src/sim/persist';
import { WHEEL_MAX_LIFT, wheelLift, wheelSite } from '../../src/sim/structures/wheel';

const DAY = STEPS_PER_DAY;
const tick = () => new Promise((r) => setImmediate(r));

/**
 * A straight river along x (centre row y = 16, 7 cells wide) on rock, with
 * a terrace on the south side `terrace` m above the bed from y = 20 on, and
 * a shallow trench across the terrace along x = 30 (y 20..30) ending in a basin.
 */
function river(inflow = 1.2, terrace = 3): World {
  const W = 64;
  const H = 36;
  const w = new World(W, H, 3);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = w.idx(x, y);
      const d = Math.abs(y - 16);
      let h = 20 - 0.03 * x + (d <= 3 ? 0 : Math.min(4, (d - 3) * 1.5));
      if (y >= 20) h = 20 - 0.03 * 30 + terrace - (y - 20) * 0.02;
      if (y >= 21 && Math.abs(x - 30) <= 0 && y <= 30) h -= 0.3;
      w.bedrock[i] = h;
      w.soil[i] = 0;
      w.soilType[i] = SoilType.Rock;
    }
  for (let y = 13; y <= 19; y++) {
    w.flags[w.idx(W - 1, y)] |= CellFlag.Outlet;
    if (inflow > 0) w.inflow[w.idx(0, y)] = inflow;
  }
  return w;
}

function totalStored(w: World): number {
  let s = 0;
  for (let i = 0; i < w.size; i++) s += w.water[i]! + w.ground[i]! + w.snow[i]!;
  return s * CELL_AREA;
}

async function runDays(sim: Simulation, days: number): Promise<void> {
  for (let d = 0; d < days; d++) {
    sim.run(DAY);
    await tick();
  }
}

/** The river's surface at the wheel cell (30, 17) is about 19.35 m; the terrace (y ≥ 20) 3 m above the bed. */
function grid(w: World) {
  return { width: w.width, height: w.height, terrain: (i: number) => w.terrain(i), depth: (i: number) => w.water[i]! };
}

async function flowing(inflow = 1.2, terrace = 3): Promise<Simulation> {
  const sim = new Simulation(river(inflow, terrace), 1);
  sim.vegetationOn = false;
  sim.weather.autoFronts = false;
  await runDays(sim, 1);
  return sim;
}

async function build(sim: Simulation): Promise<void> {
  for (let k = 0; k < 40 && sim.structures.pending; k++) sim.run(DAY / 10);
  expect(sim.structures.pending).toBe(false);
}

describe('water wheel site', () => {
  it('stands in the river and lifts to the first dry cell along the stroke', async () => {
    const sim = await flowing();
    const s = wheelSite(grid(sim.world), [
      [30, 18],
      [30, 23],
    ])!;
    expect(s.ok).toBe(true);
    expect([s.x, s.y, s.hx, s.hy]).toEqual([30, 18, 30, 20]);
    expect(s.lift).toBeGreaterThan(2.4);
    expect(s.lift).toBeLessThan(3);
    // A tap on the water: the lowest dry cell beside it (the trench's start).
    const t = wheelSite(grid(sim.world), [[30, 19]])!;
    expect(t.ok).toBe(true);
    expect([t.hx, t.hy]).toEqual([30, 21]);
  });

  it('refuses dry land, a stroke along the water, and banks too high', async () => {
    const sim = await flowing();
    expect(wheelSite(grid(sim.world), [[30, 25], [30, 28]])!.reason).toMatch(/river/);
    expect(wheelSite(grid(sim.world), [[20, 16], [26, 16]])!.reason).toMatch(/bank/);
    const high = await flowing(1.2, WHEEL_MAX_LIFT + 1.5);
    const r = wheelSite(grid(high.world), [[30, 18], [30, 23]])!;
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Too high/);
    high.command({ type: 'placeWheel', points: [[30, 18], [30, 23]] });
    expect(high.structures.wheels.length).toBe(0);
  });
});

describe('water wheel', () => {
  it('lifts in proportion to the current and the depth, against the head', () => {
    expect(wheelLift(0.2, 0.6, 3)).toBe(0);
    const ref = wheelLift(1, 0.6, 3);
    expect(ref).toBeGreaterThan(0.05);
    expect(wheelLift(0.8, 0.6, 3)).toBeCloseTo(ref * 0.512, 6);
    expect(wheelLift(1, 0.3, 3)).toBeCloseTo(ref / 2, 6);
    expect(wheelLift(1, 0.6, 4.5)).toBeCloseTo(ref / 1.5, 6);
    expect(wheelLift(4, 1, 1)).toBeLessThanOrEqual(0.2);
  });

  it('is built by the crew and lifts river water into the trench, conserving it', async () => {
    const sim = await flowing();
    const w = sim.world;
    sim.command({ type: 'placeWheel', points: [[30, 18], [30, 23]] });
    expect(sim.structures.wheels.length).toBe(1);
    const head = w.idx(30, 20);
    await build(sim);
    expect(w.flags[head]! & CellFlag.Lined).toBeTruthy();
    const before = totalStored(w);
    const L = sim.ledger;
    const l0 = { ...L };
    await runDays(sim, 2);
    const wh = sim.structures.wheels[0]!;
    expect(wh.speed).toBeGreaterThan(0.5);
    expect(wh.lifted).toBeGreaterThan(10);
    expect(L.lifted! - (l0.lifted ?? 0)).toBeGreaterThan(10);
    // Water runs along the trench, down to its end.
    expect(w.water[w.idx(30, 25)]!).toBeGreaterThan(0.002);
    expect(w.water[w.idx(30, 29)]!).toBeGreaterThan(0.002);
    // Mass balance: nothing made or lost by the lifting.
    const expected = before + L.rain - l0.rain + L.snowfall - l0.snowfall + L.inflow - l0.inflow - (L.outflow - l0.outflow) - (L.evaporation - l0.evaporation) - (L.seepage - l0.seepage);
    expect(Math.abs(totalStored(w) - expected) / (L.inflow - l0.inflow)).toBeLessThan(1e-3);
    // Without a wheel the terrace stays dry.
    const dry = await flowing();
    await runDays(dry, 2);
    expect(dry.world.water[dry.world.idx(30, 25)]!).toBeLessThan(1e-4);
  });

  it('stands still in a pond', async () => {
    const sim = await flowing(0);
    const w = sim.world;
    for (let i = 0; i < w.size; i++) w.flags[i]! &= ~CellFlag.Outlet;
    for (let x = 0; x < w.width; x++) for (let y = 12; y <= 20; y++) w.water[w.idx(x, y)] = Math.max(0, 20.4 - w.terrain(w.idx(x, y)));
    await runDays(sim, 1);
    sim.command({ type: 'placeWheel', points: [[30, 18], [30, 23]] });
    expect(sim.structures.wheels.length).toBe(1);
    await build(sim);
    await runDays(sim, 1);
    expect(sim.structures.wheels[0]!.lifted).toBe(0);
    expect(sim.structures.wheels[0]!.speed).toBe(0);
    expect(w.water[w.idx(30, 20)]!).toBeLessThan(1e-4);
  });

  it('is saved and resumes exactly; saves without wheels still load', async () => {
    const sim = await flowing();
    sim.command({ type: 'placeWheel', points: [[30, 18], [30, 23]] });
    await build(sim);
    sim.run(200);
    const bytes = await saveGame(sim);
    const { sim: b } = await loadGame(bytes);
    expect(b.structures.wheels.length).toBe(1);
    sim.run(300);
    b.run(300);
    expect(b.stateHash()).toBe(sim.stateHash());
    // An older save: no wheels in the structures.
    const st = sim.getState();
    delete st.structures!.wheels;
    delete st.ledger.lifted;
    const c = new Simulation(river(), 1);
    c.setState(st);
    expect(c.structures.wheels).toEqual([]);
    c.run(10);
  });
});
