/**
 * Weir vs heaped earth, editing and removing structures, and shaping the
 * ground around what stands on it (docs/DESIGN.md §4).
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
    dike.command({ type: 'shapeLine', tool: 'raise', points: [[32, 8], [32, 24]], width: 2, amount: 1.5 });
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
    sim.command({ type: 'shapeLine', tool: 'raise', points: [[32, 8], [32, 24]], width: 2, amount: 2 });
    await build(sim, 10);
    const before = crestMin(sim.world, 32);
    // A pond behind it, a metre below the crest.
    const w = sim.world;
    for (let y = 13; y <= 19; y++) for (let x = 1; x <= 30; x++) w.water[w.idx(x, y)] = Math.max(0, before - 1 - ground(w, x, y));
    await runDays(sim, 4);
    expect(crestMin(w, 32)).toBeGreaterThan(before - 0.02);
  }, 60_000);

  it('a weir is a stone wall on the ground: same footprint at any height, at most 4 m above its lower side', () => {
    const a = new Simulation(channel(), 1);
    a.command({ type: 'planWeir', points: [[32, 10], [32, 22]], width: 4, height: 1 });
    const b = new Simulation(channel(), 1);
    b.command({ type: 'planWeir', points: [[32, 10], [32, 22]], width: 1, height: 4 });
    expect(b.structures.weirs[0]!.cells).toEqual(a.structures.weirs[0]!.cells);
    // The wall itself is one cell thick here; only its line is raised (no earth faces).
    const w = b.world;
    expect(Number.isNaN(w.plan[w.idx(32, 16)]!)).toBe(false);
    expect(Number.isNaN(w.plan[w.idx(31, 16)]!)).toBe(true);
    expect(Number.isNaN(w.plan[w.idx(33, 16)]!)).toBe(true);
    // Too tall: kept to 4 m above the lowest ground at its foot.
    const c = new Simulation(channel(), 1);
    c.command({ type: 'planWeir', points: [[32, 10], [32, 22]], height: 6 });
    const foot = Math.min(...[31, 32, 33].map((x) => ground(c.world, x, 16)));
    expect(c.structures.weirs[0]!.top).toBeCloseTo(foot + 4, 5);
  });

  it('a gate drawn across a channel builds a stone wall with the gate at its lowest point', async () => {
    const sim = new Simulation(channel(), 1);
    sim.command({ type: 'placeGate', points: [[30, 10], [30, 22]], width: 1, height: 2 });
    expect(sim.structures.weirs.length).toBe(1);
    expect(sim.structures.gates.length).toBe(1);
    const g = sim.structures.gates[0]!;
    expect(g.top).toBeCloseTo(sim.structures.weirs[0]!.top, 5);
    await build(sim, 15);
    expect(ground(sim.world, 30, 12)).toBeCloseTo(g.top, 1);
  }, 60_000);
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

describe('shaping the ground and what stands on it', () => {
  it('a canal dug through a field turns it back to plain land at once', () => {
    const sim = new Simulation(channel(), 1);
    const w = sim.world;
    for (let x = 10; x <= 20; x++) {
      w.landuse[w.idx(x, 6)] = LandUse.Field;
      w.crop[w.idx(x, 6)] = 120;
    }
    sim.command({ type: 'shapeLine', tool: 'dig', points: [[15, 3], [15, 9]], width: 2, amount: 1 });
    expect(w.landuse[w.idx(15, 6)]).toBe(LandUse.None);
    expect(w.crop[w.idx(15, 6)]).toBe(0);
    expect(w.landuse[w.idx(10, 6)]).toBe(LandUse.Field);
  });

  it('goes round houses and footbridges (and weirs leave out footbridges)', () => {
    const sim = new Simulation(channel(), 1);
    const w = sim.world;
    w.landuse[w.idx(15, 6)] = LandUse.Building;
    w.landuse[w.idx(15, 16)] = LandUse.Bridge;
    const z = [ground(w, 15, 6), ground(w, 15, 16), ground(w, 15, 13)];
    sim.command({ type: 'shapeLine', tool: 'raise', points: [[15, 2], [15, 24]], width: 2, amount: 1 });
    expect(ground(w, 15, 6)).toBe(z[0]);
    expect(ground(w, 15, 16)).toBe(z[1]);
    expect(ground(w, 15, 13)).toBeGreaterThan(z[2]! + 0.5);
    sim.command({ type: 'planWeir', points: [[25, 10], [25, 22]], height: 1 });
    w.landuse[w.idx(35, 16)] = LandUse.Bridge;
    sim.command({ type: 'planWeir', points: [[35, 10], [35, 22]], height: 1 });
    expect(Number.isNaN(w.plan[w.idx(35, 16)]!)).toBe(true);
    expect(sim.structures.lining.has(w.idx(35, 16))).toBe(false);
  });

  it('leaves weirs and gates standing: shaping never touches structures; a pole it digs under falls, to be put up again', async () => {
    const sim = new Simulation(channel(), 1);
    const w = sim.world;
    sim.command({ type: 'planWeir', points: [[32, 4], [32, 28]], height: 1.5 });
    await build(sim, 20);
    const crest = ground(w, 32, 16);
    sim.command({ type: 'shapeLine', tool: 'dig', points: [[26, 16], [38, 16]], width: 2, amount: 0.5 });
    sim.command({ type: 'sculpt', tool: 'dig', radius: 4, stroke: 1, samples: [32, 16, 0.25, 32, 16, 0.25] });
    expect(sim.structures.weirs.length).toBe(1);
    expect(ground(w, 32, 16)).toBe(crest);
    expect(lined(w, 32, 16)).toBe(true);
    // The canal either side of it is dug.
    expect(ground(w, 27, 16)).toBeLessThan(ground(w, 27, 15) + 0.1);

    const g = new Simulation(channel(), 1);
    g.command({ type: 'shapeLine', tool: 'raise', points: [[40, 6], [40, 26]], width: 2, amount: 3 });
    g.command({ type: 'placeGate', points: [[40, 16]], width: 1, height: 0 });
    expect(g.structures.gates.length).toBe(1);
    g.command({ type: 'placePoles', points: [[44, 6], [44, 12]] });
    g.power.crewWork(1);
    const pole = g.power.poles[0]!;
    expect(pole.progress).toBe(1);
    g.command({ type: 'shapeLine', tool: 'dig', points: [[36, 16], [44, 16]], width: 2, amount: 0.5 });
    g.command({ type: 'shapeLine', tool: 'dig', points: [[pole.x - 2, pole.y], [pole.x + 2, pole.y]], width: 2, amount: 0.5 });
    expect(g.structures.gates.length).toBe(1);
    expect(g.power.poles.some((p) => p.id === pole.id && p.progress < 1)).toBe(true);
  }, 120_000);

  it('removing a gate plugs its opening; a pole is the villagers’ and stays', async () => {
    const sim = new Simulation(channel(), 1);
    const w = sim.world;
    sim.command({ type: 'shapeLine', tool: 'raise', points: [[40, 6], [40, 26]], width: 2, amount: 3 });
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
    expect(sim.power.poles.length).toBe(n);
  }, 60_000);

  it('is deterministic', async () => {
    const run = async () => {
      const sim = new Simulation(channel(0.6, 1), 4);
      sim.command({ type: 'planWeir', points: [[32, 8], [32, 24]], height: 1.5 });
      sim.command({ type: 'shapeLine', tool: 'raise', points: [[45, 8], [45, 24]], width: 2, amount: 1 });
      sim.run(DAY * 3);
      sim.command({ type: 'editWeir', id: sim.structures.weirs[0]!.id, points: [[32, 10], [32, 22]], top: sim.structures.weirs[0]!.top + 0.3 });
      sim.run(DAY * 2);
      return sim.stateHash();
    };
    expect(await run()).toBe(await run());
  }, 60_000);
});

describe('the Remove brush', () => {
  /** Put one of each kind in (wheels, turbines and pumps directly, so the test does not hang on their siting rules). */
  function stocked(progress: number): Simulation {
    const sim = new Simulation(channel(), 1);
    const w = sim.world;
    sim.command({ type: 'planWeir', points: [[10, 10], [10, 22]], height: 1.5 });
    sim.command({ type: 'shapeLine', tool: 'raise', points: [[20, 6], [20, 26]], width: 2, amount: 3 });
    const st = sim.structures;
    st.wheels.push({ id: 900, cell: w.idx(30, 15), head: w.idx(30, 20), x: 30, y: 15, hx: 30, hy: 20, progress, speed: 0, flow: 0, lifted: 0 });
    const pw = sim.power;
    pw.turbines.push({ id: 901, x: 40, y: 16, rot: 0, a: w.idx(39, 16), b: w.idx(41, 16), crest: 21, progress, flow: 0, head: 0, power: 0, produced: 0, water: 0 });
    pw.poles.push({ id: 902, x: 50, y: 6, progress });
    pw.pumps.push({ id: 903, x: 56, y: 16, hx: 56, hy: 21, ox: 56, oy: 24, progress, flow: 0, power: 0, pumped: 0 });
    return sim;
  }
  const brush = (sim: Simulation, x: number, y: number) => sim.command({ type: 'cancelPlan', x, y, radius: 2 });

  for (const built of [false, true]) {
    it(`takes away every kind of structure, ${built ? 'built' : 'unfinished'}`, async () => {
      const sim = stocked(built ? 1 : 0);
      const w = sim.world;
      if (built) await build(sim, 20);
      sim.command({ type: 'placeGate', points: [[20, 16]], width: 1, height: 0 });
      expect(sim.structures.gates.length).toBe(1);
      if (built) {
        await build(sim, 10);
        expect(sim.structures.gates[0]!.progress).toBe(1);
        expect(sim.structures.weirs[0]!.cells.every((c) => (w.flags[c]! & CellFlag.Lined) !== 0)).toBe(true);
      }
      const weirTop = sim.structures.weirs[0]!.top;
      const gateTop = sim.structures.gates[0]!.top;
      // A stroke over each (the brush sends several points along it).
      for (let y = 14; y <= 18; y++) brush(sim, 10, y);
      for (let y = 14; y <= 18; y++) brush(sim, 20, y);
      brush(sim, 30, 15);
      brush(sim, 40, 16);
      brush(sim, 50, 6);
      brush(sim, 56, 21);
      expect(sim.structures.weirs.length).toBe(0);
      expect(sim.structures.gates.length).toBe(0);
      expect(sim.structures.wheels.length).toBe(0);
      expect(sim.power.turbines.length).toBe(0);
      // (Not the villagers' poles.)
      expect(sim.power.poles.length).toBe(1);
      expect(sim.power.pumps.length).toBe(0);
      // The crew takes the built ones down: the weir back to its ground, the gate's opening plugged.
      await build(sim, 20);
      if (built) {
        expect(ground(w, 10, 16)).toBeLessThan(weirTop - 1);
        expect(lined(w, 10, 16)).toBe(false);
        expect(ground(w, 20, 16)).toBeCloseTo(gateTop, 1);
      }
      expect(sim.structures.lining.size).toBe(0);
    }, 120_000);
  }

  it('survives save/load while the crew is still taking a weir down', async () => {
    const sim = new Simulation(channel(), 1);
    sim.command({ type: 'planWeir', points: [[10, 10], [10, 22]], height: 1.5 });
    await build(sim, 15);
    brush(sim, 10, 16);
    expect(sim.structures.restoring.size).toBeGreaterThan(0);
    const { sim: b } = await loadGame(await saveGame(sim));
    expect(b.stateHash()).toBe(sim.stateHash());
    sim.run(500);
    b.run(500);
    expect(b.stateHash()).toBe(sim.stateHash());
  }, 60_000);
});

describe('villagers do not farm on works', () => {
  it('fields on a weir, a gate, a dike crest or a planned cell go back to plain land; a levelled terrace stays farmable', async () => {
    const sim = new Simulation(channel(0, 1), 1);
    const w = sim.world;
    sim.command({ type: 'planWeir', points: [[10, 10], [10, 22]], height: 1.5 });
    sim.command({ type: 'shapeLine', tool: 'raise', points: [[30, 10], [30, 22]], width: 2, amount: 2 });
    sim.command({ type: 'shapeLine', tool: 'even', points: [[44, 5], [52, 5]], width: 4 });
    await build(sim, 20);
    const weirCell = w.idx(10, 16);
    const crest = w.idx(30, 16);
    const terrace = w.idx(48, 5);
    const planned = w.idx(56, 8);
    expect(w.flags[weirCell]! & CellFlag.Structure).toBeTruthy();
    expect((w.flags[crest]! & CellFlag.Fill) !== 0).toBe(true);
    w.plan[planned] = w.terrain(planned) - 1;
    for (const i of [weirCell, crest, terrace, planned, w.idx(40, 26)]) {
      w.landuse[i] = LandUse.Field;
      w.crop[i] = 100;
    }
    await runDays(sim, 1);
    expect(w.landuse[weirCell]).toBe(LandUse.None);
    expect(w.landuse[crest]).toBe(LandUse.None);
    expect(w.landuse[planned]).toBe(LandUse.None);
    expect(w.landuse[terrace]).toBe(LandUse.Field);
    expect(w.landuse[w.idx(40, 26)]).toBe(LandUse.Field);
    // Structure footprints follow the structures: a removed weir frees its ground.
    sim.command({ type: 'removeStructure', kind: 'weir', id: sim.structures.weirs[0]!.id });
    expect(w.flags[weirCell]! & CellFlag.Structure).toBeFalsy();
  }, 60_000);
});
