import { describe, expect, it } from 'vitest';
import { CellFlag, LandUse, SoilType, World } from '../../src/sim/world';
import { Simulation } from '../../src/sim/sim';
import { DAYS_PER_SEASON, STEPS_PER_DAY } from '../../src/sim/constants';
import { loadGame, saveGame } from '../../src/sim/persist';
import { GATEKEEPING, GateMode } from '../../src/sim/structures/gatekeeper';
import { LIFT_STEPS } from '../../src/sim/structures/structures';

const DAY = STEPS_PER_DAY;
const tick = () => new Promise((r) => setImmediate(r));

async function runDays(sim: Simulation, days: number): Promise<void> {
  for (let d = 0; d < Math.floor(days); d++) {
    sim.run(DAY);
    await tick();
  }
  const rest = Math.round((days - Math.floor(days)) * DAY);
  if (rest > 0) sim.run(rest);
}

async function build(sim: Simulation, maxDays = 30): Promise<void> {
  for (let d = 0; d < maxDays * 10; d++) {
    if (sim.crew.pending === 0 && !sim.structures.pending) return;
    sim.run(DAY / 10);
    if (d % 10 === 9) await tick();
  }
  throw new Error('not built in time');
}

/**
 * A canal-fed gate: a river (7 cells wide, bed 20.6 m falling north to
 * south, `q` m³/s) runs down the west edge between high ground (22.5 m);
 * a canal (floor 19.5 m) leaves it along y = 31..33 to the gate's dike at
 * x = 20 and goes on east as in `valley`.
 */
function canalFed(q: number): World {
  const w = valley(0);
  for (let y = 0; y < w.height; y++)
    for (let x = 0; x < 20; x++) {
      const i = w.idx(x, y);
      const river = x >= 2 && x <= 8;
      const canal = x > 8 && Math.abs(y - 32) <= 1;
      w.soilType[i] = SoilType.Rock;
      w.soil[i] = 0;
      w.bedrock[i] = river ? 20.6 - 0.01 * y : canal ? 19.5 : 22.5;
      w.water[i] = 0;
    }
  setRiver(w, q);
  for (let x = 2; x <= 8; x++) w.flags[w.idx(x, w.height - 1)] |= CellFlag.Outlet;
  return w;
}

function setRiver(w: World, q: number): void {
  for (let x = 2; x <= 8; x++) w.inflow[w.idx(x, 0)] = q / 7;
}

/** Shares of the field cells that are dry, waterlogged (crop stress) and under water. */
function fieldState(sim: Simulation): { dry: number; wet: number; flooded: number } {
  const p = sim.people!;
  const w = sim.world;
  let n = 0;
  let dry = 0;
  let wet = 0;
  let flooded = 0;
  for (let i = 0; i < w.size; i++) {
    if (w.landuse[i] !== LandUse.Field) continue;
    n++;
    const s = p.stressAt(i, sim.time.season);
    if (s >= 1 && s <= 127) dry++;
    else if (s >= 128) wet++;
    if (w.water[i]! > 0.05) flooded++;
  }
  return { dry: dry / n, wet: wet / n, flooded: flooded / n };
}

/**
 * A reservoir held by a dike (crest 22 m) along x = 20 over a dry loam plain
 * at 20 m. A canal (floor 19.5 m) runs east from the dike along y = 31..33
 * to an outlet; `fields` and the village lie beside it.
 */
function valley(pool = 1.5): World {
  const W = 64;
  const H = 64;
  const w = new World(W, H, 11);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = w.idx(x, y);
      const canal = x > 20 && Math.abs(y - 32) <= 1;
      const h = x === 20 ? 22 : x === 19 || x === 21 ? (canal ? 19.5 : 21) : canal ? 19.5 - 0.005 * x : 20;
      const rock = x < 22;
      w.soilType[i] = rock ? SoilType.Rock : SoilType.Loam;
      w.soil[i] = rock ? 0 : 1;
      w.bedrock[i] = h - w.soil[i]!;
      w.ground[i] = 0;
      w.fertility[i] = 0.8;
      if (x < 19) w.water[i] = pool;
      // A dug canal: its water wets the fields beside it (CAPILLARY.canalReach).
      if (canal && x > 21) w.flags[i] |= CellFlag.Canal;
      w.revealed[i] = 255;
    }
  for (let y = 31; y <= 33; y++) w.flags[w.idx(W - 1, y)] |= CellFlag.Outlet;
  return w;
}

/** Start of the given season (0 spring, 1 summer, 2 autumn) plus a few days. */
const seasonStep = (season: number, day = 2) => (season * DAYS_PER_SEASON + day) * DAY + DAY / 3;

async function withGate(opts: { village: boolean; pool?: number; season?: number; day?: number; river?: number }): Promise<Simulation> {
  const w = opts.river ? canalFed(opts.river) : valley(opts.pool);
  const sim = new Simulation(w, 5, opts.village ? { people: { startX: 34, startY: 44 } } : {});
  sim.fog = false;
  sim.weather.autoFronts = false;
  sim.vegetationOn = false;
  sim.step = seasonStep(opts.season ?? 1, opts.day);
  if (sim.people) {
    sim.people.stage({
      x: 34,
      y: 44,
      food: 400,
      houses: [
        { x: 31, y: 42 },
        { x: 37, y: 42 },
        { x: 34, y: 47 },
      ],
      fields: [
        { x0: 24, y0: 35, x1: 44, y1: 37, crop: 100 },
        { x0: 24, y0: 27, x1: 44, y1: 29, crop: 100 },
      ],
      people: [
        { x: 33, y: 45, job: 'builder' },
        { x: 35, y: 45, job: 'builder' },
        { x: 30, y: 36, job: 'farmer' },
        { x: 38, y: 28, job: 'farmer' },
      ],
    });
  }
  sim.command({ type: 'placeGate', points: [[20, 32]], width: 1, height: 0 });
  await build(sim);
  return sim;
}

describe('villager-operated sluice gates', () => {
  it('a villager walks to the gate and opens it part way in summer when the fields below are dry; it settles', async () => {
    const sim = await withGate({ village: true });
    const g = sim.structures.gates[0]!;
    expect(g.progress).toBe(1);
    expect(g.open).toBe(false);
    const p = sim.people!;
    // Before: the fields beside the empty canal are dry.
    const field = sim.world.idx(30, 35);
    expect(sim.world.landuse[field]).toBe(LandUse.Field);
    expect(p.stressAt(field, 1)).toBeGreaterThan(0);
    expect(p.stressAt(field, 1)).toBeLessThan(128);
    let walker = -1;
    let lifts: number[] = [];
    for (let k = 0; k < 2 * DAY && !g.open; k++) {
      sim.run(1);
      const a = p.agents.find((a) => a.siteKind === 14);
      if (a && walker < 0) walker = a.id;
    }
    expect(walker).toBeGreaterThan(0);
    expect(g.open).toBe(true);
    expect(g.operator).toBe(walker);
    expect(g.mode).toBe(GateMode.Irrigate);
    // Part way, not fully up: only as far as the fields need.
    const aim = g.aim!;
    expect(aim).toBeGreaterThan(0.1);
    expect(aim).toBeLessThan(0.9);
    // The villager is at the gate, turning the wheel, and the leaf rises over a few game hours.
    const a = p.agents.find((a) => a.id === walker)!;
    expect(Math.hypot(a.x - g.x, a.y - g.y)).toBeLessThan(3);
    for (let k = 0; k < LIFT_STEPS + 10; k++) {
      sim.run(1);
      lifts.push(g.lift!);
    }
    expect(lifts[0]!).toBeLessThan(0.1);
    expect(lifts[Math.floor((aim * LIFT_STEPS) / 2)]!).toBeGreaterThan(aim * 0.3);
    expect(lifts[Math.floor((aim * LIFT_STEPS) / 2)]!).toBeLessThan(aim * 0.7);
    expect(lifts[lifts.length - 1]).toBe(aim);
    lifts = [];
    expect(sim.achievements.earned.map((e) => e.id)).toContain('gatekeeper');
    // Water reaches the canal and the fields beside it get moist (not flooded).
    await runDays(sim, 2);
    expect(sim.world.water[sim.world.idx(30, 32)]!).toBeGreaterThan(0.05);
    expect(p.stressAt(field, 1)).toBe(0);
    // Settled: the gate stays part way open, the fields neither dry nor wet.
    const aims: number[] = [];
    for (let d = 0; d < 8; d++) {
      await runDays(sim, 0.5);
      aims.push(g.aim!);
      const f = fieldState(sim);
      expect(f.flooded).toBe(0);
      expect(f.dry).toBeLessThan(0.05);
      expect(f.wet).toBeLessThan(0.05);
    }
    expect(Math.min(...aims)).toBeGreaterThan(0);
    expect(Math.max(...aims) - Math.min(...aims)).toBeLessThan(0.15);
  }, 120_000);

  it('closes within hours when the fields below stand in water', async () => {
    const sim = await withGate({ village: true });
    const w = sim.world;
    const g = sim.structures.gates[0]!;
    for (let k = 0; k < 2 * DAY && !(g.open && g.lift === g.aim); k++) sim.run(1);
    expect(g.open).toBe(true);
    // Half the fields waterlogged (a flood from elsewhere), right after the last change: no two-day wait.
    let steps = 0;
    for (; steps < DAY && (g.open || g.lift! > 0); steps++) {
      for (let y = 35; y <= 37; y++) for (let x = 24; x <= 44; x++) w.water[w.idx(x, y)] = 0.1;
      sim.run(1);
    }
    expect(g.open).toBe(false);
    expect(g.lift).toBe(0);
    expect(steps).toBeLessThan(DAY / 2);
  }, 60_000);

  it('stays closed in autumn (the reservoir refills), and with no dry fields', async () => {
    const sim = await withGate({ village: true, season: 2 });
    await runDays(sim, 3);
    expect(sim.structures.gates[0]!.open).toBe(false);
  }, 60_000);

  it('never opens for the fields while houses below are in water', async () => {
    const sim = await withGate({ village: true });
    const w = sim.world;
    const g = sim.structures.gates[0]!;
    for (let k = 0; k < 2 * DAY; k++) {
      // A puddle at a house below the gate (a flood).
      w.water[w.idx(31, 42)] = 0.3;
      sim.run(1);
    }
    expect(g.open).toBe(false);
  }, 60_000);

  it('without a village, opens by itself as far as needed before the water spills over the dike, then closes', async () => {
    const sim = await withGate({ village: false, pool: 1.5 });
    const w = sim.world;
    const g = sim.structures.gates[0]!;
    await runDays(sim, 1);
    expect(g.open).toBe(false);
    const raise = (d: number) => {
      for (let y = 0; y < w.height; y++) for (let x = 0; x < 19; x++) w.water[w.idx(x, y)] = d;
    };
    // Raise the pool to 0.2 m below the crest: flood relief, part way.
    raise(1.8);
    sim.run(GATEKEEPING.every + 1);
    expect(g.open).toBe(true);
    expect(g.mode).toBe(GateMode.Relief);
    expect(g.operator).toBe(-1);
    const some = g.aim!;
    expect(some).toBeLessThan(0.9);
    // Higher still (0.1 m below): more, at once.
    raise(1.9);
    sim.run(GATEKEEPING.every);
    expect(g.aim!).toBeGreaterThan(some + 0.05);
    // The pool goes down; once it is well below the crest the gate closes again.
    await runDays(sim, 4);
    expect(w.surface(w.idx(10, 32))).toBeLessThan(22 - GATEKEEPING.reliefKeep + 0.02);
    expect(w.surface(w.idx(10, 32))).toBeGreaterThan(21);
    expect(g.open).toBe(false);
    expect(sim.achievements.earned.map((e) => e.id)).toContain('safetyValve');
    expect(sim.achievements.earned.map((e) => e.id)).not.toContain('gatekeeper');
  }, 60_000);

  it('in a canal fed from a river: waters the fields without flooding them, backs the water up when closed, and relieves a flood part way', async () => {
    const sim = await withGate({ village: true, river: 10, season: 1, day: 0 });
    const w = sim.world;
    const g = sim.structures.gates[0]!;
    const kp = sim.gatekeeper;
    await runDays(sim, 1.5);
    expect(g.open).toBe(true);
    expect(g.mode).toBe(GateMode.Irrigate);
    expect(g.aim!).toBeLessThan(0.9);
    // Steady state in summer: the fields are watered, none flooded.
    await runDays(sim, 2);
    for (let d = 0; d < 6 && sim.time.season === 1; d++) {
      await runDays(sim, 0.5);
      const f = fieldState(sim);
      expect(f.flooded).toBe(0);
      expect(f.dry).toBeLessThan(0.05);
      expect(g.open).toBe(true);
    }
    // Autumn: nothing needed, the gate closes; the canal backs up to the river's level and the bank holds.
    while (sim.time.season === 1) await runDays(sim, 0.5);
    await runDays(sim, 3);
    expect(g.open).toBe(false);
    expect(g.lift).toBe(0);
    const v = kp.view(g);
    expect(Math.abs(v.hU - w.surface(w.idx(5, 32)))).toBeLessThan(0.1);
    expect(v.overtopped).toBe(false);
    expect(fieldState(sim).flooded).toBe(0);
    // A flood in the river brings the canal near the crest: relief, part way, and the bank is not overtopped.
    setRiver(w, 160);
    let maxAim = 0;
    let over = false;
    for (let k = 0; k < 16; k++) {
      await runDays(sim, 0.25);
      maxAim = Math.max(maxAim, g.aim!);
      over ||= kp.view(g).overtopped;
    }
    expect(g.open).toBe(true);
    expect(g.mode).toBe(GateMode.Relief);
    expect(maxAim).toBeLessThan(0.9);
    expect(over).toBe(false);
    expect(kp.view(g).hU).toBeLessThan(22 - 0.15);
  }, 180_000);

  it('is deterministic and resumes exactly from a save while a villager works the gate', async () => {
    const make = async () => {
      const sim = await withGate({ village: true });
      // Save while the villager is on the way to the gate.
      for (let k = 0; k < 2 * DAY && !sim.people!.agents.some((a) => a.siteKind === 14 && a.task === 1); k++) sim.run(1);
      sim.run(5);
      return sim;
    };
    const a = await make();
    const b = await make();
    expect(b.stateHash()).toBe(a.stateHash());
    expect(a.people!.agents.some((a) => a.siteKind === 14)).toBe(true);
    expect(a.structures.gates[0]!.want).toBeGreaterThan(0);
    const { sim: c } = await loadGame(await saveGame(a));
    expect(c.stateHash()).toBe(a.stateHash());
    // Test-only switches are not part of a save.
    c.vegetationOn = false;
    c.weather.autoFronts = false;
    c.fog = false;
    for (let d = 0; d < 3; d++) {
      a.run(DAY / 2);
      c.run(DAY / 2);
      await tick();
    }
    expect(c.stateHash()).toBe(a.stateHash());
    expect(c.structures.gates[0]!.open).toBe(a.structures.gates[0]!.open);
  }, 120_000);

  it('loads gates from older saves (no gatekeeping fields) as they were', async () => {
    const sim = await withGate({ village: false });
    const st = sim.structures.getState();
    const old = st.gates.map(({ id, cells, passage, x, y, rot, width, top, top0, sill, progress }) => ({
      id,
      cells,
      passage,
      x,
      y,
      rot,
      width,
      top,
      top0,
      sill,
      progress,
      open: true,
    }));
    sim.structures.setState({ ...st, gates: old });
    const g = sim.structures.gates[0]!;
    expect(g.lift).toBe(1);
    expect(sim.structures.walls.count).toBe(0);
    sim.run(DAY);
  }, 60_000);
});
