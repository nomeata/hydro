import { describe, expect, it } from 'vitest';
import { STEPS_PER_DAY } from '../../src/sim/constants';
import { loadGame, saveGame } from '../../src/sim/persist';
import type { Footbridge } from '../../src/sim/people/bridges';
import type { Building } from '../../src/sim/people/village';
import { WEAR, condOf, liningFails, needsRepair, repair, wearLevel, weather, type Worn } from '../../src/sim/people/wear';
import { chooseJetty } from '../../src/sim/people/works';
import { Simulation } from '../../src/sim/sim';
import { CellFlag, LandUse, SoilType, World } from '../../src/sim/world';

/**
 * A 64² valley: a river along y ≈ 20 (west → east), a pond in the
 * south-east, loamy flats where the village stands at (30, 30).
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
      if (dr <= 2) w.water[i] = 0.8;
    }
  for (let y = 36; y < 52; y++)
    for (let x = 38; x < 54; x++) {
      const i = w.idx(x, y);
      const lvl = w.terrain(w.idx(46, 37)) - 0.1;
      if (w.terrain(i) < lvl) w.water[i] = lvl - w.terrain(i);
    }
  return w;
}

/** A small village by the pond with a jetty, a footbridge over the river, a well, a mill and some lining of its own. */
function village(): Simulation {
  const sim = new Simulation(valley(), 5, { people: { startX: 30, startY: 30 } });
  const p = sim.people!;
  const w = sim.world;
  p.stage({
    x: 34,
    y: 34,
    food: 2000,
    houses: [
      { x: 36, y: 33 },
      { x: 33, y: 36 },
      { x: 30, y: 33 },
    ],
    fields: [],
    people: Array.from({ length: 8 }, (_, k) => ({ x: 33 + (k % 3), y: 33 + ((k / 3) | 0), job: k < 2 ? ('builder' as const) : ('farmer' as const) })),
  });
  const st = p.settlements[0]!.state;
  // The jetty, finished.
  const j = chooseJetty(w, st.x, st.y, () => 1)!;
  expect(j).not.toBeNull();
  j.progress = 1;
  j.top = Math.max(w.terrain(j.shore), ...j.cells.map((c) => w.surface(c) + 0.25));
  for (const c of j.cells) w.landuse[c] = LandUse.Bridge;
  st.jetty = j;
  // A footbridge over the river at x = 30.
  const cells = [18, 19, 20, 21, 22].map((y) => w.idx(30, y));
  const top = Math.max(...cells.map((c) => w.surface(c))) + 0.35;
  for (const c of cells) w.landuse[c] = LandUse.Bridge;
  p.bridges.list.push({ id: 9001, settlement: 0, a: w.idx(30, 23), b: w.idx(30, 17), cells, progress: 1, top, since: 0 });
  // A well and a mill.
  const put = (id: number, kind: Building['kind'], x: number, y: number): Building => {
    const b: Building = { id, kind, settlement: 0, x, y, rot: 0, progress: 1 };
    if (kind === 'mill') Object.assign(b, { wheel: w.idx(x, y - 1), spin: 0, running: false, grain: 0, idle: 0 });
    w.landuse[w.idx(x, y)] = LandUse.Building;
    p.buildings.push(b);
    return b;
  };
  put(9002, 'well', 27, 30);
  put(9003, 'mill', 20, 23);
  // Lining the villagers laid: one by the houses (kept up), one far down the river (not).
  const lw = p.villageLining() as Map<number, Worn>;
  for (const [x, y] of [
    [32, 31],
    [58, 23],
  ] as const) {
    w.flags[w.idx(x, y)]! |= CellFlag.Lined;
    lw.set(w.idx(x, y), { used: 0 });
  }
  // And a cell the player lined, beside the far one.
  w.flags[w.idx(59, 23)]! |= CellFlag.Lined;
  return sim;
}

const bridgeOf = (sim: Simulation) => sim.people!.bridges.list.find((b) => b.id === 9001);
const building = (sim: Simulation, id: number) => sim.people!.buildings.find((b) => b.id === id);

describe('wear: the rules', () => {
  it('starts after the grace period, takes `span` days, faster when wet', () => {
    const o: Worn = {};
    expect(weather(o, 10, false)).toBe(1);
    expect(o.used).toBe(10);
    expect(weather(o, 10 + WEAR.grace, false)).toBe(1);
    let d = 10 + WEAR.grace;
    while (condOf(o) > 0) weather(o, ++d, false);
    expect(d - 10 - WEAR.grace).toBe(WEAR.span);
    const wet: Worn = { used: 0 };
    let e = WEAR.grace;
    while (condOf(wet) > 0) weather(wet, ++e, true);
    expect(e - WEAR.grace).toBeLessThan(WEAR.span / 2);
    expect(wearLevel(1)).toBe(0);
    expect(wearLevel(0.5)).toBe(1);
    expect(wearLevel(0.1)).toBe(2);
    // Mending: only what is in use again, a quarter per visit.
    const m: Worn = { used: 0, cond: 0.3 };
    expect(needsRepair(m, WEAR.grace + 5)).toBe(false);
    expect(needsRepair(m, 3)).toBe(true);
    repair(m);
    expect(m.cond).toBeCloseTo(0.55, 6);
    repair(m);
    repair(m);
    expect(m.cond).toBeUndefined();
    for (let c = 0; c < 1000; c++) expect(liningFails(c)).toBeLessThan(0.5);
  });
});

describe("wear: the villagers' structures", () => {
  it('unused, a jetty, a footbridge, a well, a mill and far lining fall into disrepair and are gone; lining by the houses stays', () => {
    const sim = village();
    const p = sim.people!;
    const w = sim.world;
    const st = p.settlements[0]!.state;
    const jetty = st.jetty!;
    const bridgeCells = [...bridgeOf(sim)!.cells];
    const near = w.idx(32, 31);
    const far = w.idx(58, 23);
    w.traffic.fill(0);
    p.tendWear(0);
    let seen1 = false;
    let seen2 = false;
    for (let d = 1; d < 2 * (WEAR.grace + WEAR.span) && (st.jetty || bridgeOf(sim) || building(sim, 9002)); d++) {
      p.tendWear(d);
      const info = p.jettyInfo().find((s) => s.kind === 'jetty');
      if (info?.wear === 1) seen1 = true;
      if (info?.wear === 2) seen2 = true;
    }
    expect(seen1 && seen2).toBe(true);
    expect(st.jetty).toBeUndefined();
    expect(st.jettyAgain).toBeGreaterThan(0);
    for (const c of jetty.cells) expect(w.landuse[c]).not.toBe(LandUse.Bridge);
    expect(bridgeOf(sim)).toBeUndefined();
    for (const c of bridgeCells) expect(w.landuse[c]).not.toBe(LandUse.Bridge);
    expect(building(sim, 9002)).toBeUndefined();
    expect(building(sim, 9003)).toBeUndefined();
    expect(w.landuse[w.idx(27, 30)]).not.toBe(LandUse.Building);
    expect(w.flags[far]! & CellFlag.Lined).toBe(0);
    expect(p.villageLining().has(far)).toBe(false);
    expect(w.flags[near]! & CellFlag.Lined).toBe(CellFlag.Lined);
    expect(condOf(p.villageLining().get(near)!)).toBe(1);
    // Player lining (not the villagers') never wears.
    expect(w.flags[w.idx(59, 23)]! & CellFlag.Lined).toBe(CellFlag.Lined);
  });

  it('what is used stays sound', () => {
    const sim = village();
    const p = sim.people!;
    const w = sim.world;
    const st = p.settlements[0]!.state;
    for (let d = 0; d < 3 * (WEAR.grace + WEAR.span); d++) {
      // Someone walks out on the jetty and over the bridge now and then; the well is drawn from, the mill grinds.
      if (d % 10 === 0) {
        w.traffic[st.jetty!.cells.at(-1)!] = 4;
        w.traffic[bridgeOf(sim)!.cells[2]!] = 4;
        building(sim, 9002)!.used = d;
        building(sim, 9003)!.used = d;
      } else {
        w.traffic.fill(0);
      }
      p.tendWear(d);
    }
    expect(condOf(st.jetty!)).toBe(1);
    expect(condOf(bridgeOf(sim)!)).toBe(1);
    expect(condOf(building(sim, 9002)!)).toBe(1);
    expect(condOf(building(sim, 9003)!)).toBe(1);
  });

  it('a jetty under water rots faster', () => {
    const a = village();
    const b = village();
    const ja = a.people!.settlements[0]!.state.jetty!;
    const jb = b.people!.settlements[0]!.state.jetty!;
    jb.top -= 2; // awash
    a.world.traffic.fill(0);
    b.world.traffic.fill(0);
    for (let d = 0; d <= WEAR.grace + 20; d++) {
      a.people!.tendWear(d);
      b.people!.tendWear(d);
    }
    expect(condOf(jb)).toBeLessThan(condOf(ja) - 0.2);
  });

  it('a structure in use again is mended by a builder', () => {
    const sim = village();
    const p = sim.people!;
    const st = p.settlements[0]!.state;
    // Neglected, now in use again.
    sim.run(1);
    const day = sim.time.day;
    const br = bridgeOf(sim) as Footbridge;
    br.cond = 0.4;
    br.used = day;
    const well = building(sim, 9002)!;
    well.cond = 0.3;
    well.used = day;
    st.jetty!.cond = 0.5;
    st.jetty!.used = day;
    for (let k = 0; k < 4 && (condOf(br) < 1 || condOf(well) < 1 || condOf(st.jetty!) < 1); k++) sim.run(STEPS_PER_DAY);
    expect(condOf(br)).toBeGreaterThan(0.6);
    expect(condOf(well)).toBeGreaterThan(0.5);
    expect(condOf(st.jetty!)).toBeGreaterThan(0.7);
  }, 120_000);

  it('a mill given up stands derelict: no longer the village mill, it decays', () => {
    const sim = village();
    const p = sim.people!;
    const m = building(sim, 9003)!;
    // The wheel's cell is dry: no head.
    for (let d = 0; d < 50 && !m.abandoned; d++) sim.run(STEPS_PER_DAY);
    expect(m.abandoned).toBe(true);
    expect(p.millOf(0)).toBeNull();
    expect(p.buildings).toContain(m);
  }, 240_000);

  it('saves and resumes exactly with worn structures and lining', async () => {
    const sim = village();
    const p = sim.people!;
    sim.world.traffic.fill(0);
    for (let d = 0; d < WEAR.grace + 10; d++) p.tendWear(d);
    expect(condOf(p.settlements[0]!.state.jetty!)).toBeLessThan(1);
    expect(condOf(p.villageLining().get(sim.world.idx(58, 23))!)).toBeLessThan(1);
    expect(p.liningWorn().size).toBe(1);
    const bytes = await saveGame(sim);
    const b = (await loadGame(bytes)).sim;
    expect(b.stateHash()).toBe(sim.stateHash());
    expect([...b.people!.liningWorn()]).toEqual([...p.liningWorn()]);
    sim.run(STEPS_PER_DAY + 31);
    b.run(STEPS_PER_DAY + 31);
    expect(b.stateHash()).toBe(sim.stateHash());
    const pack = (s: Simulation) => {
      const out = new Uint8Array(s.world.size);
      s.structures.packLining(out, s.people!.quay, s.people!.liningWorn());
      return out;
    };
    const lin = pack(sim);
    expect(lin[sim.world.idx(58, 23)]).toBeGreaterThanOrEqual(128);
    expect(lin[sim.world.idx(58, 23)]).toBeLessThan(254);
    expect(pack(b)).toEqual(lin);
  }, 120_000);
});
