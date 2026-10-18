import { describe, expect, it } from 'vitest';
import { CellFlag, SoilType, World } from '../../src/sim/world';
import { Simulation } from '../../src/sim/sim';
import { DAYS_PER_YEAR, STEPS_PER_DAY } from '../../src/sim/constants';
import { loadGame, saveGame } from '../../src/sim/persist';

const DAY = STEPS_PER_DAY;

/**
 * A straight channel along x (centre row y = 16, 7 cells wide) between high
 * banks, on rock so nothing soaks away; outlet at the east end.
 */
function channel(inflow = 0): World {
  const W = 64;
  const H = 32;
  const w = new World(W, H, 3);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = w.idx(x, y);
      const d = Math.abs(y - 16);
      w.bedrock[i] = 20 - 0.01 * x + (d <= 3 ? 0 : Math.min(4, (d - 3) * 1.2));
      w.soil[i] = 0;
      w.soilType[i] = SoilType.Rock;
    }
  for (let y = 13; y <= 19; y++) {
    w.flags[w.idx(W - 1, y)] |= CellFlag.Outlet;
    if (inflow > 0) w.inflow[w.idx(0, y)] = inflow;
  }
  return w;
}

/** Run until all plans and structures are built (or `maxDays` passed). */
async function build(sim: Simulation, maxDays = 30): Promise<void> {
  for (let d = 0; d < maxDays * 10; d++) {
    if (sim.crew.pending === 0 && !sim.structures.pending) return;
    sim.run(DAY / 10);
    if (d % 10 === 9) await tick();
  }
  throw new Error('not built in time');
}

/** Yield to the test runner (long synchronous runs starve its RPC). */
const tick = () => new Promise((r) => setImmediate(r));

/** Run whole days (fractions allowed), yielding between them. */
async function runDays(sim: Simulation, days: number): Promise<void> {
  for (let d = 0; d < Math.floor(days); d++) {
    sim.run(DAY);
    await tick();
  }
  const rest = Math.round((days - Math.floor(days)) * DAY);
  if (rest > 0) sim.run(rest);
}

const surf = (w: World, x: number, y: number) => w.surface(w.idx(x, y));
const depth = (w: World, x: number, y: number) => w.water[w.idx(x, y)]!;

/** The erosion tests' meandering valley: a sandy river entering at x = 0. */
function valley(n = 64, sandy = false): World {
  const w = new World(n, n, 7);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = w.idx(x, y);
      const c = n / 2 + 6 * Math.sin(x * 0.15);
      const dy = Math.abs(y - c);
      w.bedrock[i] = 48 + (n - x) * 0.04 + dy * 0.3 - (dy < 3 ? 1.5 : 0);
      w.soil[i] = sandy ? 4 : 2;
      w.soilType[i] = dy < 6 || sandy ? SoilType.Sand : SoilType.Loam;
    }
  for (let y = 0; y < n; y++) {
    const c1 = n / 2 + 6 * Math.sin((n - 1) * 0.15);
    if (Math.abs(y - n / 2) <= 2) w.inflow[w.idx(0, y)] = 1.2;
    if (Math.abs(y - c1) <= 3) w.flags[w.idx(n - 1, y)] |= CellFlag.Outlet;
  }
  return w;
}

describe('stone lining', () => {
  it('is built by the crew after the earthworks and stops erosion', async () => {
    const w = valley();
    const sim = new Simulation(w, 2);
    sim.geo.morfac *= 10;
    // Line the river bed along its course.
    const pts: [number, number][] = [];
    for (let x = 10; x <= 40; x += 2) pts.push([x, 32 + 6 * Math.sin(x * 0.15)]);
    sim.command({ type: 'planLining', points: pts, width: 6 });
    expect(sim.structures.lining.size).toBeGreaterThan(100);
    await build(sim, 5);
    const lined: number[] = [];
    for (let i = 0; i < w.size; i++) if (w.flags[i]! & CellFlag.Lined) lined.push(i);
    expect(lined.length).toBeGreaterThan(100);
    const before = lined.map((i) => w.terrain(i));
    const all = Array.from({ length: w.size }, (_, i) => w.terrain(i));
    await runDays(sim, 6);
    expect(lined.map((i) => w.terrain(i))).toEqual(before);
    let changed = 0;
    for (let i = 0; i < w.size; i++) if (Math.abs(w.terrain(i) - all[i]!) > 0.01) changed++;
    expect(changed).toBeGreaterThan(20);
  });

  it('keeps a canal dug from a river from slumping for a year', async () => {
    const run = async (line: boolean) => {
      const w = valley(48, true);
      const sim = new Simulation(w, 4);
      // A canal branching off the river at x = 30 heading south (+y), ending in a pond.
      const c = 24 + 6 * Math.sin(30 * 0.15);
      const pts: [number, number][] = [
        [30, c + 2],
        [30, c + 22],
      ];
      sim.command({ type: 'planTrench', points: pts, width: 2, depth: 2.5 });
      if (line) sim.command({ type: 'planLining', points: pts, width: 7 });
      await build(sim, 10);
      const floor: number[] = [];
      for (let y = Math.ceil(c + 4); y <= c + 20; y++) floor.push(w.idx(30, y));
      const h0 = floor.map((i) => w.terrain(i));
      await runDays(sim, DAYS_PER_YEAR);
      // Mean change of the canal floor (slumped banks fill it; scour would deepen it).
      let change = 0;
      floor.forEach((i, k) => (change += Math.abs(w.terrain(i) - h0[k]!)));
      return change / floor.length;
    };
    const lined = await run(true);
    const bare = await run(false);
    expect(lined).toBeLessThan(0.01);
    expect(bare).toBeGreaterThan(0.05);
  }, 120_000);
});

describe('weir', () => {
  it('holds water to its crest and spills over evenly above it', async () => {
    const w = channel(1.0);
    const sim = new Simulation(w, 1);
    sim.command({ type: 'planWeir', points: [[32, 9], [32, 23]], width: 2, height: 1.5 });
    const weir = sim.structures.weirs[0]!;
    expect(weir.top).toBeCloseTo(20 - 0.32 + 1.5, 1);
    await build(sim, 10);
    expect(w.flags[w.idx(32, 16)]! & CellFlag.Lined).toBeTruthy();
    expect(w.terrain(w.idx(32, 16))).toBeCloseTo(weir.top, 1);
    await runDays(sim, 5);
    // Spilling: upstream a little above the crest, water flowing on downstream.
    const up = surf(w, 24, 16);
    expect(up).toBeGreaterThan(weir.top);
    expect(up).toBeLessThan(weir.top + 0.6);
    expect(depth(w, 44, 16)).toBeGreaterThan(0.005);
    expect(surf(w, 44, 16)).toBeLessThan(weir.top - 0.5);
    // Spill is even across the crest.
    const spill = [14, 15, 16, 17, 18].map((y) => depth(w, 32, y));
    expect(Math.max(...spill) - Math.min(...spill)).toBeLessThan(0.1);
    // Inflow stops: the pool stays at the crest.
    for (let i = 0; i < w.size; i++) w.inflow[i] = 0;
    await runDays(sim, 2);
    expect(surf(w, 24, 16)).toBeGreaterThan(weir.top - 0.1);
    expect(surf(w, 24, 16)).toBeLessThan(weir.top + 0.1);
  }, 60_000);
});

describe('sluice gate', () => {
  /** A dike across the channel with a gate tapped into it, built, the reservoir filled ~1 m deep. */
  async function reservoir(seed = 1): Promise<Simulation> {
    const w = channel();
    const sim = new Simulation(w, seed);
    sim.command({ type: 'planDike', points: [[32, 6], [32, 26]], width: 2, height: 3 });
    await build(sim, 10);
    sim.command({ type: 'placeGate', points: [[32, 16]], width: 1, height: 0 });
    expect(sim.structures.gates.length).toBe(1);
    await build(sim, 10);
    for (let y = 13; y <= 19; y++) for (let x = 1; x <= 31; x++) {
      const i = w.idx(x, y);
      w.water[i] = Math.max(0, 21 - w.terrain(i));
    }
    return sim;
  }

  it('is placed into a dike by a tap and dug down to the sill', async () => {
    const sim = await reservoir();
    const w = sim.world;
    const g = sim.structures.gates[0]!;
    expect(g.progress).toBe(1);
    expect(g.rot).toBeCloseTo(Math.PI / 2);
    expect(g.sill).toBeLessThan(20);
    expect(g.top).toBeGreaterThan(22);
    // The passage through the dike is dug to the sill and lined.
    for (const c of g.passage) {
      expect(w.terrain(c)).toBeLessThan(g.sill + 0.02);
      expect(w.flags[c]! & CellFlag.Lined).toBeTruthy();
    }
  });

  it('holds a reservoir when closed and drains it to the sill when opened', async () => {
    const sim = await reservoir();
    const w = sim.world;
    const g = sim.structures.gates[0]!;
    await runDays(sim, 1);
    expect(surf(w, 28, 16)).toBeGreaterThan(20.95);
    expect(depth(w, 40, 16)).toBeLessThan(0.02);
    sim.command({ type: 'toggleGate', id: g.id });
    expect(g.open).toBe(true);
    // The flat channel downstream is the bottleneck: it drains over a few days.
    await runDays(sim, 3);
    expect(depth(w, 40, 16)).toBeGreaterThan(0);
    expect(surf(w, 28, 16)).toBeLessThan(g.sill + 0.5);
    expect(w.terrain(w.idx(32, 16))).toBeCloseTo(g.sill, 1);
    // Close again: the (now low) water stays low and refills only from rain.
    sim.command({ type: 'toggleGate', id: g.id, open: false });
    expect(g.open).toBe(false);
  }, 60_000);

  it('builds a dike with a gate when drawn across a channel', async () => {
    const w = channel(1.0);
    const sim = new Simulation(w, 1);
    sim.command({ type: 'placeGate', points: [[30, 8], [30, 24]], width: 3, height: 2 });
    const g = sim.structures.gates[0]!;
    expect(g.width).toBe(3);
    expect(g.rot).toBeCloseTo(Math.PI / 2);
    expect(g.top - g.sill).toBeCloseTo(2, 1);
    await build(sim, 10);
    expect(g.progress).toBe(1);
    // Held closed (no flood relief): the river backs up behind the gate; nothing gets through below the top.
    sim.command({ type: 'toggleGate', id: g.id, open: false });
    await runDays(sim, 4);
    expect(surf(w, 26, 16)).toBeGreaterThan(g.sill + 0.8);
    expect(surf(w, 26, 16)).toBeLessThan(g.top + 0.3);
  }, 60_000);

  it('is deterministic and survives save/load', async () => {
    const make = async () => {
      const sim = await reservoir(9);
      sim.run(200);
      sim.command({ type: 'toggleGate', id: sim.structures.gates[0]!.id });
      sim.run(100);
      return sim;
    };
    const a = await make();
    const b = await make();
    expect(b.stateHash()).toBe(a.stateHash());
    const bytes = await saveGame(a);
    const { sim: c } = await loadGame(bytes);
    expect(c.stateHash()).toBe(a.stateHash());
    expect(c.structures.gates[0]!.open).toBe(true);
    a.run(400);
    c.run(400);
    expect(c.stateHash()).toBe(a.stateHash());
    expect(Array.from(c.world.water)).toEqual(Array.from(a.world.water));
  }, 60_000);
});
