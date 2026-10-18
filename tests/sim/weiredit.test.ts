/**
 * Weir vs dike, editing and removing structures, and earthworks that take
 * up what stands on the ground (docs/DESIGN.md §4).
 */
import { describe, expect, it } from 'vitest';
import { CellFlag, LandUse, SoilType, World } from '../../src/sim/world';
import { Simulation } from '../../src/sim/sim';
import { STEPS_PER_DAY } from '../../src/sim/constants';
import { loadGame, saveGame } from '../../src/sim/persist';

const DAY = STEPS_PER_DAY;
const tick = () => new Promise((r) => setImmediate(r));

/** A straight channel along x (centre row y = 16, 7 cells wide) between high banks; outlet at the east end. */
function channel(inflow = 0, soil = 0): World {
  const W = 64;
  const H = 32;
  const w = new World(W, H, 3);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = w.idx(x, y);
      const d = Math.abs(y - 16);
      w.bedrock[i] = 20 - soil - 0.01 * x + (d <= 3 ? 0 : Math.min(4, (d - 3) * 1.2));
      w.soil[i] = soil;
      w.soilType[i] = soil > 0 ? SoilType.Loam : SoilType.Rock;
    }
  for (let y = 13; y <= 19; y++) {
    w.flags[w.idx(W - 1, y)] |= CellFlag.Outlet;
    if (inflow > 0) w.inflow[w.idx(0, y)] = inflow;
  }
  return w;
}

async function build(sim: Simulation, maxDays = 30): Promise<void> {
  for (let d = 0; d < maxDays * 10; d++) {
    if (sim.crew.pending === 0 && !sim.structures.pending) return;
    sim.run(DAY / 10);
    if (d % 10 === 9) await tick();
  }
  throw new Error('not built in time');
}

async function runDays(sim: Simulation, days: number): Promise<void> {
  for (let d = 0; d < days; d++) {
    sim.run(DAY);
    await tick();
  }
}

const lined = (w: World, x: number, y: number) => (w.flags[w.idx(x, y)]! & CellFlag.Lined) !== 0;
const ground = (w: World, x: number, y: number) => w.terrain(w.idx(x, y));

/** Lowest crest of a wall across the channel at column x. */
function crestMin(w: World, x: number): number {
  let m = Infinity;
  for (let y = 13; y <= 19; y++) m = Math.min(m, ground(w, x, y));
  return m;
}

describe('weir vs dike', () => {
  it('an overtopped dike notches and breaches; a weir of the same height holds its crest', async () => {
    const dike = new Simulation(channel(1.0, 1), 1);
    dike.vegetationOn = false;
    dike.command({ type: 'planDike', points: [[32, 8], [32, 24]], width: 2, height: 1.5 });
    const crest = crestMin(dike.world, 32) + 1.5;
    await build(dike, 10);
    await runDays(dike, 8);
    // The water poured over and cut a notch well below the crest.
    expect(crestMin(dike.world, 32)).toBeLessThan(crest - 0.6);
    // The notch is where the water went: the high ends of the dike stand.
    expect(ground(dike.world, 32, 9)).toBeGreaterThan(crest - 0.1);

    const weir = new Simulation(channel(1.0, 1), 1);
    weir.vegetationOn = false;
    weir.command({ type: 'planWeir', points: [[32, 8], [32, 24]], height: 1.5 });
    const wr = weir.structures.weirs[0]!;
    await build(weir, 15);
    await runDays(weir, 8);
    expect(lined(weir.world, 32, 16)).toBe(true);
    expect(crestMin(weir.world, 32)).toBeGreaterThan(wr.top - 0.05);
    // And it spills: water downstream of it.
    expect(weir.world.water[weir.world.idx(44, 16)]!).toBeGreaterThan(0.005);
  }, 120_000);

  it('a dike that is not overtopped stays whole', async () => {
    const sim = new Simulation(channel(0, 1), 1);
    sim.command({ type: 'planDike', points: [[32, 8], [32, 24]], width: 2, height: 2 });
    await build(sim, 10);
    const before = crestMin(sim.world, 32);
    // A pond behind it, a metre below the crest.
    const w = sim.world;
    for (let y = 13; y <= 19; y++) for (let x = 1; x <= 30; x++) w.water[w.idx(x, y)] = Math.max(0, before - 1 - ground(w, x, y));
    await runDays(sim, 4);
    expect(crestMin(w, 32)).toBeGreaterThan(before - 0.02);
  }, 60_000);

  it('weir faces follow from the height: a taller weir has a broader foot', () => {
    const a = new Simulation(channel(), 1);
    a.command({ type: 'planWeir', points: [[32, 10], [32, 22]], width: 4, height: 1 });
    const b = new Simulation(channel(), 1);
    b.command({ type: 'planWeir', points: [[32, 10], [32, 22]], width: 1, height: 4 });
    expect(b.structures.weirs[0]!.cells.length).toBeGreaterThan(a.structures.weirs[0]!.cells.length);
    // The old `width` makes no difference.
    const c = new Simulation(channel(), 1);
    c.command({ type: 'planWeir', points: [[32, 10], [32, 22]], width: 1, height: 1 });
    expect(c.structures.weirs[0]!.cells).toEqual(a.structures.weirs[0]!.cells);
  });
});

describe('editing a weir', () => {
  async function built(): Promise<Simulation> {
    const sim = new Simulation(channel(), 1);
    sim.command({ type: 'planWeir', points: [[32, 10], [32, 22]], height: 1.5 });
    await build(sim, 15);
    return sim;
  }

  it('raises and lowers the crest, keeping its id', async () => {
    const sim = await built();
    const w = sim.world;
    const wr = sim.structures.weirs[0]!;
    const top = wr.top;
    expect(ground(w, 32, 16)).toBeCloseTo(top, 1);
    expect(sim.structures.info().find((s) => s.kind === 'weir')!.sill).toBeCloseTo(top - 1.5, 1);
    sim.command({ type: 'editWeir', id: wr.id, points: [[32, 10], [32, 22]], top: top + 0.5 });
    expect(sim.crew.pending).toBeGreaterThan(0);
    await build(sim, 15);
    expect(sim.structures.weirs.length).toBe(1);
    expect(sim.structures.weirs[0]!.id).toBe(wr.id);
    expect(ground(w, 32, 16)).toBeCloseTo(top + 0.5, 1);
    expect(lined(w, 32, 16)).toBe(true);
    // The crest is measured from the ground it was built on, not from the old crest.
    expect(sim.structures.info().find((s) => s.kind === 'weir')!.sill).toBeCloseTo(top - 1.5, 1);
    sim.command({ type: 'editWeir', id: wr.id, points: [[32, 10], [32, 22]], top: top - 0.5 });
    await build(sim, 15);
    expect(ground(w, 32, 16)).toBeCloseTo(top - 0.5, 1);
    expect(lined(w, 32, 16)).toBe(true);
  }, 120_000);

  it('moves its ends: what is left behind goes back to its ground, unlined', async () => {
    const sim = await built();
    const w = sim.world;
    const wr = sim.structures.weirs[0]!;
    const before = ground(w, 32, 13);
    expect(before).toBeCloseTo(wr.top, 1);
    // Pull the south end in to y = 14 (the channel floor at y = 19 is no longer weir).
    sim.command({ type: 'editWeir', id: wr.id, points: [[32, 10], [32, 14]], top: wr.top });
    await build(sim, 15);
    expect(lined(w, 32, 19)).toBe(false);
    expect(ground(w, 32, 19)).toBeLessThan(wr.top - 1);
    expect(lined(w, 32, 13)).toBe(true);
    expect(ground(w, 32, 13)).toBeCloseTo(before, 1);
    // Drag it out again further than before.
    sim.command({ type: 'editWeir', id: wr.id, points: [[32, 8], [32, 24]], top: wr.top });
    await build(sim, 15);
    expect(lined(w, 32, 19)).toBe(true);
    expect(ground(w, 32, 19)).toBeCloseTo(wr.top, 1);
  }, 120_000);

  it('is removed: the crew lowers it back to the ground', async () => {
    const sim = await built();
    const w = sim.world;
    const wr = sim.structures.weirs[0]!;
    const bed = wr.top - 1.5;
    sim.command({ type: 'removeStructure', kind: 'weir', id: wr.id });
    expect(sim.structures.weirs.length).toBe(0);
    await build(sim, 15);
    expect(ground(w, 32, 16)).toBeLessThan(bed + 0.3);
    expect(lined(w, 32, 16)).toBe(false);
  }, 60_000);

  it('saves its ground; old saves without it still load and edit', async () => {
    const sim = await built();
    const bytes = await saveGame(sim);
    const { sim: b } = await loadGame(bytes);
    expect(b.stateHash()).toBe(sim.stateHash());
    expect(b.structures.weirs[0]!.base?.length).toBe(sim.structures.weirs[0]!.cells.length);
    // An old weir: no ground recorded.
    const st = b.structures.getState();
    delete st.weirs[0]!.base;
    b.structures.setState(st);
    const wr = b.structures.weirs[0]!;
    expect(b.structures.info().find((s) => s.kind === 'weir')!.sill).toBeCloseTo(wr.top - 1, 5);
    b.command({ type: 'editWeir', id: wr.id, points: [[32, 10], [32, 22]], top: wr.top + 0.5 });
    await build(b, 15);
    expect(ground(b.world, 32, 16)).toBeCloseTo(wr.top, 1);
  }, 60_000);
});

describe('earthworks take up what stands on the ground', () => {
  it('a trench through a field turns it back to plain land when dug', async () => {
    const sim = new Simulation(channel(), 1);
    const w = sim.world;
    for (let x = 10; x <= 20; x++) {
      w.landuse[w.idx(x, 6)] = LandUse.Field;
      w.crop[w.idx(x, 6)] = 120;
    }
    sim.command({ type: 'planTrench', points: [[15, 3], [15, 9]], width: 2, depth: 1 });
    // Untouched until the crew gets there.
    expect(w.landuse[w.idx(15, 6)]).toBe(LandUse.Field);
    await build(sim, 10);
    expect(w.landuse[w.idx(15, 6)]).toBe(LandUse.None);
    expect(w.crop[w.idx(15, 6)]).toBe(0);
    expect(w.landuse[w.idx(10, 6)]).toBe(LandUse.Field);
  }, 60_000);

  it('plans go round houses and footbridges', () => {
    const sim = new Simulation(channel(), 1);
    const w = sim.world;
    w.landuse[w.idx(15, 6)] = LandUse.Building;
    w.landuse[w.idx(15, 16)] = LandUse.Bridge;
    sim.command({ type: 'planDike', points: [[15, 2], [15, 24]], width: 2, height: 1 });
    expect(Number.isNaN(w.plan[w.idx(15, 6)]!)).toBe(true);
    expect(Number.isNaN(w.plan[w.idx(15, 16)]!)).toBe(true);
    expect(Number.isNaN(w.plan[w.idx(15, 14)]!)).toBe(false);
    sim.command({ type: 'planWeir', points: [[15, 10], [15, 22]], height: 1 });
    expect(Number.isNaN(w.plan[w.idx(15, 16)]!)).toBe(true);
    expect(sim.structures.lining.has(w.idx(15, 16))).toBe(false);
  });

  it('a trench across a weir cuts it in two weirs; through a gate, wheel or pole removes them', async () => {
    const sim = new Simulation(channel(), 1);
    const w = sim.world;
    sim.command({ type: 'planWeir', points: [[32, 4], [32, 28]], height: 1.5 });
    const id = sim.structures.weirs[0]!.id;
    await build(sim, 20);
    sim.command({ type: 'planTrench', points: [[26, 16], [38, 16]], width: 2, depth: 0.5 });
    const weirs = sim.structures.weirs;
    expect(weirs.length).toBe(2);
    expect(weirs.map((o) => o.id)).toContain(id);
    expect(lined(w, 32, 16)).toBe(false);
    expect(lined(w, 32, 6)).toBe(true);
    for (const o of weirs) expect(Math.abs(o.y - 16) >= 1 && Math.abs(o.y2 - 16) >= 1).toBe(true);

    // A gate tapped into a dike, and a pole: a trench through both.
    const g = new Simulation(channel(), 1);
    g.command({ type: 'planDike', points: [[40, 6], [40, 26]], width: 2, height: 3 });
    await build(g, 10);
    g.command({ type: 'placeGate', points: [[40, 16]], width: 1, height: 0 });
    expect(g.structures.gates.length).toBe(1);
    g.command({ type: 'placePoles', points: [[44, 6], [44, 7]] });
    expect(g.power.poles.length).toBeGreaterThan(0);
    const pole = g.power.poles[0]!;
    g.command({ type: 'planTrench', points: [[36, 16], [44, 16]], width: 2, depth: 0.5 });
    expect(g.structures.gates.length).toBe(0);
    g.command({ type: 'planLevel', points: [[pole.x, pole.y]], width: 1 });
    // (A level stroke over flat ground changes nothing, so nothing is taken down.)
    g.command({ type: 'planTrench', points: [[pole.x - 2, pole.y], [pole.x + 2, pole.y]], width: 2, depth: 0.5 });
    expect(g.power.poles.some((p) => p.id === pole.id)).toBe(false);
  }, 120_000);

  it('removing a gate plugs its opening; removing a pole drops its wires', async () => {
    const sim = new Simulation(channel(), 1);
    const w = sim.world;
    sim.command({ type: 'planDike', points: [[40, 6], [40, 26]], width: 2, height: 3 });
    await build(sim, 10);
    sim.command({ type: 'placeGate', points: [[40, 16]], width: 1, height: 0 });
    await build(sim, 10);
    const gate = sim.structures.gates[0]!;
    expect(ground(w, 40, 16)).toBeLessThan(gate.top - 1);
    sim.command({ type: 'removeStructure', kind: 'gate', id: gate.id });
    expect(sim.structures.gates.length).toBe(0);
    expect(sim.structures.walls.count).toBe(0);
    await build(sim, 10);
    expect(ground(w, 40, 16)).toBeCloseTo(gate.top, 1);

    sim.command({ type: 'placePoles', points: [[50, 4], [50, 10], [50, 16]] });
    const n = sim.power.poles.length;
    expect(n).toBeGreaterThan(1);
    sim.command({ type: 'removeStructure', kind: 'pole', id: sim.power.poles[0]!.id });
    expect(sim.power.poles.length).toBe(n - 1);
    const ids = new Set(sim.power.poles.map((p) => p.id));
    for (const v of sim.power.wires) expect(ids.has(v)).toBe(true);
  }, 60_000);

  it('is deterministic', async () => {
    const run = async () => {
      const sim = new Simulation(channel(0.6, 1), 4);
      sim.command({ type: 'planWeir', points: [[32, 8], [32, 24]], height: 1.5 });
      sim.command({ type: 'planDike', points: [[45, 8], [45, 24]], width: 2, height: 1 });
      sim.run(DAY * 3);
      sim.command({ type: 'editWeir', id: sim.structures.weirs[0]!.id, points: [[32, 10], [32, 22]], top: sim.structures.weirs[0]!.top + 0.3 });
      sim.run(DAY * 2);
      return sim.stateHash();
    };
    expect(await run()).toBe(await run());
  }, 60_000);
});
