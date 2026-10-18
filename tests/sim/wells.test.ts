import { describe, expect, it } from 'vitest';
import { CELL_AREA, STEPS_PER_DAY } from '../../src/sim/constants';
import { loadGame, saveGame } from '../../src/sim/persist';
import { Job, SiteKind } from '../../src/sim/people/agents';
import { MILL, chooseMillSite, headAt, isHeadSite } from '../../src/sim/people/mills';
import { WELL, aquifer, canDig, chooseWellSite, drawWell, tableDepth, waterAccess, wellWorks } from '../../src/sim/people/wells';
import { Simulation } from '../../src/sim/sim';
import { CellFlag, LandUse, SoilType, World } from '../../src/sim/world';

const N = 64;
/** The step in the river bed (a lined drop, like a weir's spill), and how high it is. */
const STEP_X = 26;
const STEP = 1.5;

/**
 * A 64² valley: a river along y ≈ 20 (west → east) with a lined 1.5 m step
 * in its bed at x = 26, loamy flats to the south with the water table
 * `depth` m below the ground, where the village stands at (30, 31).
 */
function valley(depth = 1.5, soil = 3): World {
  const w = new World(N, N, 11);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = w.idx(x, y);
      const dr = Math.abs(y - 20);
      let h = 30 + (N - x) * 0.01 + Math.min(3, dr * 0.5) - (dr <= 1 ? 1.2 : 0);
      if (x < STEP_X) h += STEP;
      w.bedrock[i] = h - soil;
      w.soil[i] = soil;
      w.soilType[i] = dr <= 2 ? SoilType.Sand : SoilType.Loam;
      w.ground[i] = Math.max(0, soil - depth) * 0.4;
      w.fertility[i] = 0.7;
      w.revealed[i] = 255;
      if (Math.abs(x - STEP_X) <= 1 && dr <= 3) w.flags[i]! |= CellFlag.Lined;
    }
  for (let y = 17; y <= 23; y++) {
    w.inflow[w.idx(0, y)] = Math.abs(y - 20) <= 1 ? 1.2 : 0;
    w.flags[w.idx(N - 1, y)]! |= CellFlag.Outlet;
  }
  return w;
}

function village(depth = 1.5, people = 24): Simulation {
  const w = valley(depth);
  const sim = new Simulation(w, 5, { people: { startX: 30, startY: 31 } });
  sim.people!.stage({
    x: 30,
    y: 31,
    food: 3000,
    houses: [
      { x: 27, y: 33 },
      { x: 33, y: 33 },
      { x: 30, y: 35 },
      { x: 27, y: 29 },
      { x: 34, y: 29 },
      { x: 36, y: 33 },
    ],
    fields: [{ x0: 22, y0: 37, x1: 38, y1: 40, crop: 40 }],
    people: Array.from({ length: people }, (_, k) => ({ x: 30 + (k % 4), y: 31 + ((k / 4) | 0) * 0.5, job: k < 3 ? ('builder' as const) : ('farmer' as const) })),
  });
  return sim;
}

function days(sim: Simulation, n: number): void {
  for (let d = 0; d < n; d++) sim.run(STEPS_PER_DAY);
}

describe('wells: the water table', () => {
  it('measures the table and whether villagers can dig to it', () => {
    const w = valley(1.5);
    const i = w.idx(30, 31);
    expect(tableDepth(w, i)).toBeCloseTo(1.5, 5);
    expect(aquifer(w, i)).toBeCloseTo(1.5, 5);
    expect(canDig(w, i)).toBe(true);
    const deep = valley(5, 8);
    expect(tableDepth(deep, i)).toBeCloseTo(5, 5);
    expect(canDig(deep, i)).toBe(false);
    // Dry below 6 m (or with a thin aquifer); working again only above 5.5 m (hysteresis).
    expect(wellWorks(deep, i, false)).toBe(true);
    deep.ground[i] = (8 - 5.8) * 0.4;
    expect(wellWorks(deep, i, false)).toBe(true);
    expect(wellWorks(deep, i, true)).toBe(false);
    deep.ground[i] = (8 - 6.5) * 0.4;
    expect(wellWorks(deep, i, false)).toBe(false);
    // Thin soil over bedrock: the table is near, but there is hardly any water.
    const thin = valley(0.5, 0.6);
    expect(canDig(thin, i)).toBe(false);
  });

  it('gives full water access with a well, less far from water without one', () => {
    expect(waterAccess(20, true)).toBe(1);
    expect(waterAccess(5, false)).toBe(1);
    expect(waterAccess(18, false)).toBeCloseTo(0.75, 5);
    expect(waterAccess(200, false)).toBe(WELL.accessFloor);
  });

  it('picks a dry, open cell near the centre with the shallowest table', () => {
    const w = valley(1.5);
    for (let y = 27; y <= 35; y++) for (let x = 26; x <= 34; x++) if (x < 30) w.ground[w.idx(x, y)] = 0; // the west side is dry
    const site = chooseWellSite(w, 30, 31, [], () => true, () => 0);
    expect(site).toBeGreaterThanOrEqual(0);
    expect(site % N).toBeGreaterThanOrEqual(30);
    expect(Math.hypot((site % N) - 30, ((site / N) | 0) - 31)).toBeLessThanOrEqual(WELL.radius);
    // Not next to another well.
    const again = chooseWellSite(w, 30, 31, [{ x: site % N, y: (site / N) | 0 }], () => true, () => 0);
    if (again >= 0) expect(Math.hypot((again % N) - (site % N), ((again / N) | 0) - ((site / N) | 0))).toBeGreaterThanOrEqual(WELL.spacing);
    // Too deep everywhere: no well.
    expect(chooseWellSite(valley(5, 8), 30, 31, [], () => true, () => 0)).toBe(-1);
  });

  it('draws groundwater from the cone around the well, conserving mass', () => {
    const w = valley(1.5);
    const c = w.idx(30, 31);
    const before = w.ground.reduce((a, b) => a + b, 0);
    const got = drawWell(w, c, 0.5, CELL_AREA);
    const after = w.ground.reduce((a, b) => a + b, 0);
    expect(got).toBeCloseTo(0.5, 6);
    expect((before - after) * CELL_AREA).toBeCloseTo(got, 3);
    // Only the 5×5 cone changed.
    expect(w.ground[w.idx(33, 31)]).toBeCloseTo(1.5 * 0.4, 6);
    expect(w.ground[w.idx(32, 31)]!).toBeLessThan(1.5 * 0.4);
  });
});

describe('mills: head sites', () => {
  it('finds the step in the river as a head site with a bank beside it', () => {
    const sim = village();
    days(sim, 1);
    const w = sim.world;
    let best = 0;
    for (let y = 17; y <= 23; y++) for (let x = STEP_X - 3; x <= STEP_X + 3; x++) best = Math.max(best, headAt(w, w.idx(x, y)).power);
    expect(best).toBeGreaterThan(MILL.minPower);
    days(sim, 2);
    const site = chooseMillSite(w, 30, 31, () => true, () => 0)!;
    expect(site).not.toBeNull();
    expect(Math.abs((site.wheel % N) - STEP_X)).toBeLessThanOrEqual(3);
    expect(w.water[site.bank]!).toBeLessThan(0.01);
    expect(w.water[site.side]!).toBeGreaterThan(0.05);
    expect(Math.abs((site.side % N) - (site.bank % N)) + Math.abs(((site.side / N) | 0) - ((site.bank / N) | 0))).toBe(1);
    expect(isHeadSite(headAt(w, site.wheel))).toBe(true);
    // A calm river without the step has no head.
    for (let y = 17; y <= 23; y++) for (let x = 40; x <= 55; x++) expect(isHeadSite(headAt(w, w.idx(x, y)))).toBe(false);
  });
});

describe('a village digs a well and builds a mill', () => {
  it('builds a well when the river is far and the table near, then carries water from it', () => {
    const sim = village(1.5);
    const p = sim.people!;
    days(sim, 6);
    const wells = p.wellsOf(0);
    expect(wells.length).toBe(1);
    expect(wells[0]!.progress).toBe(1);
    expect(sim.world.landuse[sim.world.idx(wells[0]!.x, wells[0]!.y)]).toBe(LandUse.Building);
    expect(p.settlements[0]!.state.waterAccess).toBe(1);
    // Someone fetches water at the well now and then.
    let fetching = false;
    for (let k = 0; k < 40 && !fetching; k++) {
      sim.run(60);
      fetching = p.agents.some((a) => a.siteKind === SiteKind.Fetch && a.site === wells[0]!.id);
    }
    expect(fetching).toBe(true);
    // The table falls deep (a drought): the well runs dry and water access drops.
    for (let i = 0; i < sim.world.size; i++) sim.world.ground[i] = 0;
    days(sim, 1);
    expect(p.wellsOf(0)[0]!.dry).toBe(true);
    expect(p.settlements[0]!.state.waterAccess).toBeLessThan(1);
    expect(p.buildingInfo().find((b) => b.kind === 'well')!.dry).toBe(true);
  }, 120_000);

  it('digs no well when the water table is out of reach', () => {
    const sim = new Simulation(valley(5, 8), 5, { people: { startX: 30, startY: 31 } });
    sim.people!.stage({ x: 30, y: 31, food: 3000, houses: [{ x: 27, y: 33 }, { x: 33, y: 33 }], fields: [], people: Array.from({ length: 10 }, (_, k) => ({ x: 30 + (k % 4), y: 32, job: k < 2 ? ('builder' as const) : ('farmer' as const) })) });
    days(sim, 5);
    expect(sim.people!.wellsOf(0).length).toBe(0);
  }, 120_000);

  it('builds a mill at the head, grinds grain while the wheel turns, and idles when the river runs dry', () => {
    const sim = village(1.5);
    const p = sim.people!;
    const w = sim.world;
    let mill = null as ReturnType<typeof p.millOf>;
    for (let d = 0; d < 20 && !(mill && mill.progress >= 1); d++) {
      days(sim, 1);
      mill = p.millOf(0);
    }
    expect(mill).not.toBeNull();
    expect(mill!.progress).toBe(1);
    expect(Math.abs(mill!.x - STEP_X)).toBeLessThanOrEqual(4);
    sim.run(MILL.grind);
    sim.run(60);
    expect(mill!.spin!).toBeGreaterThan(0.2);
    expect(mill!.running).toBe(true);
    days(sim, 1);
    expect(p.settlements[0]!.state.milling).toBe(true);
    // Grain at the mill: a miller grinds it and carries the flour to the store.
    mill!.grain = 40;
    let miller = false;
    for (let k = 0; k < 2 * STEPS_PER_DAY && mill!.grain > 0; k += 60) {
      sim.run(60);
      miller ||= p.agents.some((a) => a.job === Job.Miller);
      if (process.env.DBG) console.log(k, mill!.grain, p.agents.filter((a) => a.job === Job.Miller || a.siteKind === SiteKind.Grind).map((a) => `${a.id}:${a.job}:${a.task}:${a.siteKind}`).join(' '), p.buildings.filter((b) => b.kind === 'mill').length);
    }
    expect(miller).toBe(true);
    expect(mill!.grain).toBe(0);
    // The river runs dry: the wheel stops.
    for (let y = 17; y <= 23; y++) w.inflow[w.idx(0, y)] = 0;
    for (let i = 0; i < w.size; i++) w.ground[i] = 0; // and no springs either
    days(sim, 3);
    expect(mill!.running).toBe(false);
    for (let d = 0; d < 8 && mill!.spin! > 0; d++) days(sim, 1);
    expect(mill!.spin).toBe(0);
    expect(p.settlements[0]!.state.milling).toBe(false);
    expect(p.buildingInfo().find((b) => b.kind === 'mill')!.spin).toBe(0);
  }, 180_000);

  it('saves and resumes exactly with a well and a mill', async () => {
    const sim = village(1.5);
    days(sim, 8);
    expect(sim.people!.wellsOf(0).length).toBeGreaterThan(0);
    expect(sim.people!.millOf(0)).not.toBeNull();
    sim.people!.millOf(0)!.grain = 30;
    const bytes = await saveGame(sim);
    const b = (await loadGame(bytes)).sim;
    expect(b.stateHash()).toBe(sim.stateHash());
    sim.run(STEPS_PER_DAY + 77);
    b.run(STEPS_PER_DAY + 77);
    expect(b.stateHash()).toBe(sim.stateHash());
  }, 180_000);
});
