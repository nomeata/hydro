import { describe, expect, it } from 'vitest';
import { CellFlag, LandUse, SoilType, World } from '../../src/sim/world';
import { Simulation } from '../../src/sim/sim';
import { STEPS_PER_DAY } from '../../src/sim/constants';
import { loadGame, saveGame } from '../../src/sim/persist';
import { PathFinder } from '../../src/sim/people/path';
import { WalkMap } from '../../src/sim/people/reach';
import { BRIDGE, Bridges, chooseCrossing } from '../../src/sim/people/bridges';

/**
 * A 64² valley: a river along y ≈ 20 (west → east) across the whole map,
 * the village south of it at (30, 30), good land north of it.
 */
function valley(): World {
  const n = 64;
  const w = new World(n, n, 11);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = w.idx(x, y);
      const dr = Math.abs(y - 20);
      const h = 30 + (n - x) * 0.03 + Math.min(3, dr * 0.5) - (dr <= 1 ? 1.4 : 0);
      w.bedrock[i] = h - 2;
      w.soil[i] = 2;
      w.soilType[i] = dr <= 3 ? SoilType.Sand : SoilType.Loam;
      w.fertility[i] = 0.7;
      w.revealed[i] = 255;
    }
  for (let y = 17; y <= 23; y++) {
    w.inflow[w.idx(0, y)] = Math.abs(y - 20) <= 1 ? 1.4 : 0;
    w.flags[w.idx(n - 1, y)] |= CellFlag.Outlet;
  }
  return w;
}

function village(fields: { x0: number; y0: number; x1: number; y1: number; crop: number }[], people = 10): Simulation {
  const w = valley();
  const sim = new Simulation(w, 5, { people: { startX: 30, startY: 30 } });
  sim.people!.stage({
    x: 30,
    y: 30,
    food: 2000,
    houses: [
      { x: 27, y: 32 },
      { x: 33, y: 32 },
    ],
    fields,
    people: Array.from({ length: people }, (_, k) => ({ x: 30 + (k % 3), y: 31 + ((k / 3) | 0), job: k < 2 ? ('builder' as const) : ('farmer' as const) })),
  });
  sim.run(STEPS_PER_DAY);
  return sim;
}

async function runDays(sim: Simulation, days: number): Promise<void> {
  for (let d = 0; d < days; d++) {
    sim.run(STEPS_PER_DAY);
    await new Promise((r) => setImmediate(r));
  }
}

function fieldsIn(w: World, x0: number, y0: number, x1: number, y1: number): number {
  let n = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (w.landuse[w.idx(x, y)] === LandUse.Field) n++;
  return n;
}

describe('footbridges', () => {
  it('the walking map and the crossing choice see across a ditch', () => {
    const n = 48;
    const w = new World(n, n, 1);
    for (let i = 0; i < w.size; i++) w.soil[i] = 1;
    for (let x = 0; x < n; x++) for (let y = 20; y <= 21; y++) w.water[w.idx(x, y)] = 1;
    const map = new WalkMap(w, 24, 30);
    const across = w.idx(24, 14);
    expect(map.at(across)).toBe(Infinity);
    expect(map.tooFar(across)).toBe(true);
    expect(map.claimable(w.idx(24, 26))).toBe(true);
    const demand = [];
    for (let x = 20; x <= 28; x++) for (let y = 12; y <= 15; y++) demand.push(w.idx(x, y));
    const c = chooseCrossing(w, map, demand, () => false)!;
    expect(c).not.toBeNull();
    expect(c.cells.length).toBe(2);
    // Straight across, near the land it serves.
    expect(Math.abs((c.a % n) - 24)).toBeLessThanOrEqual(4);
    // Deck cells as bridge: now the land across is near by path.
    for (const k of c.cells) w.landuse[k] = LandUse.Bridge;
    const bridge = (i: number) => w.landuse[i] === LandUse.Bridge;
    expect(new PathFinder(w).find(w.idx(24, 30), across, { bridge })).not.toBeNull();
    const after = new WalkMap(w, 24, 30, undefined, bridge);
    expect(after.tooFar(across)).toBe(false);
  });

  it('a bridge beside one that joins the same shores saves nothing; one over another arm does', () => {
    // Two ditches (y 20–21 and y 36–37), the village between them at (24, 28).
    const n = 64;
    const w = new World(n, n, 1);
    for (let i = 0; i < w.size; i++) w.soil[i] = 1;
    for (let x = 0; x < n; x++) for (const y of [20, 21, 36, 37]) w.water[w.idx(x, y)] = 1;
    const north: number[] = [];
    const south: number[] = [];
    for (let x = 20; x <= 28; x++)
      for (let k = 0; k < 4; k++) {
        north.push(w.idx(x, 12 + k));
        south.push(w.idx(x, 41 + k));
      }
    const first = chooseCrossing(w, new WalkMap(w, 24, 28), north, () => false)!;
    expect(first).not.toBeNull();
    expect(first.saving).toBeGreaterThanOrEqual(BRIDGE.minSaving);
    for (const k of first.cells) w.landuse[k] = LandUse.Bridge;
    const bridge = (i: number) => w.landuse[i] === LandUse.Bridge;
    const taken = (i: number) => first.cells.includes(i) || i === first.a || i === first.b;
    const net = new WalkMap(w, 24, 28, undefined, bridge);
    // The same shores again: nothing worth building, anywhere along the ditch.
    expect(chooseCrossing(w, net, north, taken, bridge)).toBeNull();
    // The other arm: a bridge over it, however near the first.
    const second = chooseCrossing(w, net, [...north, ...south], taken, bridge)!;
    expect(second).not.toBeNull();
    expect((second.a / n) | 0).toBeGreaterThan(30);
  });

  it('bridges per village scale with its size, one project at a time, spaced in time', () => {
    const n = 64;
    const w = new World(n, n, 1);
    for (let i = 0; i < w.size; i++) w.soil[i] = 1;
    for (let x = 0; x < n; x++) for (const y of [20, 21, 36, 37]) w.water[w.idx(x, y)] = 1;
    const demand: number[] = [];
    for (let x = 20; x <= 28; x++) for (let k = 0; k < 4; k++) demand.push(w.idx(x, 12 + k), w.idx(x, 41 + k));
    let id = 1;
    const br = new Bridges(w, () => id++);
    const onBridge = (i: number) => w.landuse[i] === LandUse.Bridge;
    const plan = (pop: number, day: number) => br.plan(0, pop, new WalkMap(w, 24, 28, undefined, onBridge), demand, day);
    plan(10, 0);
    expect(br.list.length).toBe(1);
    plan(10, 1);
    expect(br.list.length).toBe(1); // being built
    while (!br.work(br.list[0]!.id));
    plan(10, 40);
    expect(br.list.length).toBe(1); // ten people: one bridge
    plan(40, 10);
    expect(br.list.length).toBe(1); // too soon after the last
    plan(40, 40);
    expect(br.list.length).toBe(2);
  });

  it('villagers bridge the river to their fields, walk over it, and keep it across save/load', async () => {
    // Fields north of the river, 12–16 cells from the store as the crow flies.
    const sim = village([{ x0: 26, y0: 13, x1: 33, y1: 16, crop: 40 }]);
    const p = sim.people!;
    const w = sim.world;
    console.log(`river depth at (30,20): ${w.water[w.idx(30, 20)]!.toFixed(2)}, (30,19) ${w.water[w.idx(30, 19)]!.toFixed(2)}`);
    // Save while it is being built.
    for (let k = 0; k < 40 && !((p.bridges.list[0]?.progress ?? 0) > 0); k++) sim.run(50);
    expect(p.bridges.list.length).toBe(1);
    const br = p.bridges.list[0]!;
    expect(br.progress).toBeLessThan(1);
    console.log(`bridge: ${JSON.stringify(br)}`);
    // Fields wait for the bridge instead of being given up.
    expect(fieldsIn(w, 26, 13, 33, 16)).toBeGreaterThan(20);
    const bytes = await saveGame(sim);
    const b = (await loadGame(bytes)).sim;
    expect(b.stateHash()).toBe(sim.stateHash());
    await runDays(sim, 12);
    await runDays(b, 12);
    expect(b.stateHash()).toBe(sim.stateHash());
    expect(br.progress).toBe(1);
    for (const c of br.cells) expect(w.landuse[c]).toBe(LandUse.Bridge);
    expect(br.top).toBeGreaterThan(w.terrain(br.cells[0]!) + w.water[br.cells[0]!]!);
    // Farmers cross it: footfall on the deck.
    await runDays(sim, 6);
    let feet = 0;
    for (const c of br.cells) feet += w.traffic[c]!;
    expect(feet).toBeGreaterThan(0);
    expect(fieldsIn(w, 26, 13, 33, 16)).toBeGreaterThan(20);
    expect(p.jettyInfo().map((s) => s.kind)).toContain('bridge');
  }, 240_000);

  it('a flood sweeps the deck away; the villagers rebuild it, higher', async () => {
    const sim = village([{ x0: 26, y0: 13, x1: 33, y1: 16, crop: 40 }]);
    const p = sim.people!;
    const w = sim.world;
    await runDays(sim, 18);
    const br = p.bridges.list[0]!;
    expect(br.progress).toBe(1);
    const top0 = br.top;
    // A flood: the river rises over the deck.
    for (const c of br.cells) w.water[c] = top0 + 0.3 - w.terrain(c);
    p.bridges.flood(sim.time.day);
    expect(br.broken).toBe(true);
    expect(br.progress).toBe(BRIDGE.wreck);
    for (const c of br.cells) expect(w.landuse[c]).not.toBe(LandUse.Bridge);
    // The far fields are not given up while the bridge waits to be rebuilt.
    await runDays(sim, 16);
    expect(br.broken).toBeUndefined();
    expect(br.progress).toBe(1);
    expect(br.top).toBeGreaterThan(top0);
    for (const c of br.cells) expect(w.landuse[c]).toBe(LandUse.Bridge);
    expect(fieldsIn(w, 26, 13, 33, 16)).toBeGreaterThan(10);
  }, 240_000);

  it('fields cut off by the water, with no way to bridge it, are given up for land near by path', async () => {
    const span = BRIDGE.maxSpan;
    BRIDGE.maxSpan = 0; // nothing can be bridged
    try {
      const sim = village([{ x0: 26, y0: 13, x1: 33, y1: 16, crop: 0 }]);
      const w = sim.world;
      const p = sim.people!;
      await runDays(sim, 4);
      expect(p.bridges.list.length).toBe(0);
      expect(fieldsIn(w, 0, 0, 63, 18)).toBe(0);
      // New fields on the village side instead.
      expect(fieldsIn(w, 0, 23, 63, 63)).toBeGreaterThan(10);
    } finally {
      BRIDGE.maxSpan = span;
    }
  }, 240_000);
});
