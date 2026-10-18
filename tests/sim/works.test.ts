import { describe, expect, it } from 'vitest';
import { CellFlag, LandUse, SoilType, World } from '../../src/sim/world';
import { Simulation } from '../../src/sim/sim';
import { DAYS_PER_YEAR, STEPS_PER_DAY } from '../../src/sim/constants';
import { loadGame, saveGame } from '../../src/sim/persist';
import { LINING_QUAY } from '../../src/shared/protocol';

/**
 * A 64² valley: a sandy river along y ≈ 20 (west → east), a pond in the
 * south-east, loamy flats in between where the village stands at (30, 30).
 */
function valley(): World {
  const n = 64;
  const w = new World(n, n, 11);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = w.idx(x, y);
      const dr = Math.abs(y - 20);
      let h = 30 + (n - x) * 0.03 + Math.min(3, dr * 0.5) - (dr <= 2 ? 1.2 : 0);
      const dp = Math.hypot(x - 46, y - 44);
      if (dp < 7) h -= Math.min(2.5, (7 - dp) * 0.8);
      w.bedrock[i] = h - 2;
      w.soil[i] = 2;
      w.soilType[i] = dr <= 3 ? SoilType.Sand : SoilType.Loam;
      w.fertility[i] = 0.7;
      w.revealed[i] = 255;
    }
  for (let y = 17; y <= 23; y++) {
    w.inflow[w.idx(0, y)] = Math.abs(y - 20) <= 1 ? 1.2 : 0;
    w.flags[w.idx(n - 1, y)] |= CellFlag.Outlet;
  }
  // Fill the pond.
  for (let y = 36; y < 52; y++)
    for (let x = 38; x < 54; x++) {
      const i = w.idx(x, y);
      const lvl = w.terrain(w.idx(46, 37)) - 0.1;
      if (w.terrain(i) < lvl) w.water[i] = lvl - w.terrain(i);
    }
  return w;
}

function village(houses: { x: number; y: number }[], people = 10): Simulation {
  const w = valley();
  const sim = new Simulation(w, 5, { people: { startX: 30, startY: 30 } });
  sim.people!.stage({
    x: 30,
    y: 30,
    food: 2000,
    houses,
    fields: [{ x0: 24, y0: 31, x1: 28, y1: 35, crop: 40 }],
    people: Array.from({ length: people }, (_, k) => ({ x: 30 + (k % 3), y: 31 + ((k / 3) | 0), job: k < 2 ? ('builder' as const) : ('farmer' as const) })),
  });
  // Let the river settle into its bed first.
  sim.run(STEPS_PER_DAY);
  return sim;
}

function linedNear(w: World, x0: number, y0: number, x1: number, y1: number): number {
  let n = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (w.flags[w.idx(x, y)]! & CellFlag.Lined) n++;
  return n;
}

async function runDays(sim: Simulation, days: number): Promise<void> {
  for (let d = 0; d < days; d++) {
    sim.run(STEPS_PER_DAY);
    await new Promise((r) => setImmediate(r));
  }
}

describe("villagers' own works", () => {
  it('line an eroding bank near their houses within a year', async () => {
    // Houses right on the river's south bank.
    const sim = village([
      { x: 28, y: 25 },
      { x: 32, y: 25 },
      { x: 30, y: 28 },
    ]);
    const w = sim.world;
    expect(linedNear(w, 0, 0, 63, 63)).toBe(0);
    await runDays(sim, DAYS_PER_YEAR);
    // Banks of the river by the houses (within ~3 cells of them).
    const bank = linedNear(w, 24, 18, 36, 25);
    const far = linedNear(w, 0, 0, 12, 63) + linedNear(w, 52, 0, 63, 30);
    const s = sim.people!.settlements[0]!.state;
    console.log(`lined by the houses: ${bank}, far away: ${far}, pop ${s.population}, w ${s.wellbeing.toFixed(2)}`);
    expect(bank).toBeGreaterThanOrEqual(5);
    expect(far).toBe(0);
    // Their first lined bank earns Stone by Stone.
    expect(sim.achievements.earned.map((e) => e.id)).toContain('stoneByStone');
    // Every lined cell is near water and near the village.
    for (let i = 0; i < w.size; i++) {
      if (!(w.flags[i]! & CellFlag.Lined)) continue;
      expect(Math.hypot((i % 64) - 30, ((i / 64) | 0) - 30)).toBeLessThan(26);
    }
  }, 240_000);

  it('a player canal near the village becomes lined over time', async () => {
    const sim = village([
      { x: 30, y: 33 },
      { x: 34, y: 33 },
    ]);
    const w = sim.world;
    // A canal from the river south towards the pond, past the village.
    sim.command({ type: 'shapeLine', tool: 'dig', points: [[38, 22], [38, 40]], width: 2, amount: 3.5 });
    let canal = 0;
    for (let i = 0; i < w.size; i++) if (w.flags[i]! & CellFlag.Canal) canal++;
    expect(canal).toBeGreaterThan(20);
    await runDays(sim, DAYS_PER_YEAR);
    let linedCanal = 0;
    for (let i = 0; i < w.size; i++) {
      if (!(w.flags[i]! & CellFlag.Lined)) continue;
      const x = i % 64;
      if (x >= 36 && x <= 40 && ((i / 64) | 0) > 23) linedCanal++;
    }
    console.log(`canal cells lined after a year: ${linedCanal}`);
    expect(linedCanal).toBeGreaterThanOrEqual(6);
  }, 240_000);

  it('build a jetty for the fishers and show quays by the houses; deterministic across save/load', async () => {
    const sim = village(
      [
        { x: 40, y: 40 },
        { x: 44, y: 37 },
        { x: 36, y: 33 },
      ],
      12,
    );
    const p = sim.people!;
    await runDays(sim, 20);
    const s = p.settlements[0]!.state;
    const fishers = p.agents.filter((a) => a.job === 3).length;
    console.log(`day 20: fishers ${fishers}, jetty ${JSON.stringify(s.jetty)}`);
    expect(s.jetty).toBeDefined();
    const bytes = await saveGame(sim);
    const b = (await loadGame(bytes)).sim;
    expect(b.stateHash()).toBe(sim.stateHash());
    await runDays(sim, 25);
    await runDays(b, 25);
    expect(b.stateHash()).toBe(sim.stateHash());
    expect(s.jetty!.progress).toBe(1);
    for (const c of s.jetty!.cells) expect(sim.world.landuse[c]).toBe(LandUse.Bridge);
    // Quays: lined banks by the houses facing the pond.
    const lining = new Uint8Array(sim.world.size);
    sim.structures.packLining(lining, p.quay);
    let quays = 0;
    for (const v of lining) if (v === LINING_QUAY) quays++;
    console.log(`quay cells: ${quays}`);
    expect(quays).toBeGreaterThan(0);
  }, 240_000);
});
