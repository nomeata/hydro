/**
 * M3-δ "more life": living vegetation, woodcutters, herds and herders,
 * desire paths, and their achievements.
 */
import { describe, expect, it } from 'vitest';
import { Achievements, type AchievementHost } from '../../src/sim/achievements';
import { ACH } from '../../src/shared/achievements';
import { CarryKind, EntityKind } from '../../src/shared/protocol';
import { timeAt, seaLevelTemperature } from '../../src/sim/climate/calendar';
import { DAYS_PER_YEAR, STEPS_PER_DAY } from '../../src/sim/constants';
import { ErosionScratch, defaultGeoParams, erosionStep, newSedimentLedger } from '../../src/sim/hydro/erosion';
import { newLedger, soilWaterStep } from '../../src/sim/hydro/soilwater';
import { Job, walk, type Walker } from '../../src/sim/people/agents';
import { DESIRE, longestPath, updateDesirePaths } from '../../src/sim/people/desire';
import { HERD } from '../../src/sim/people/herds';
import type { PeopleSystem } from '../../src/sim/people/village';
import { WOOD } from '../../src/sim/people/village';
import { loadGame, saveGame } from '../../src/sim/persist';
import { Simulation } from '../../src/sim/sim';
import { VEG, Vegetation, forestCover } from '../../src/sim/vegetation';
import { LandUse, SOIL_PROPS, SoilType, World } from '../../src/sim/world';
import { generateWorld } from '../../src/sim/worldgen';

const tick = () => new Promise((r) => setImmediate(r));

/** A flat loam meadow, soil `sat` saturated. */
function meadow(n = 16, sat = 0.6, veg = 0): World {
  const w = new World(n, n, 7);
  for (let i = 0; i < w.size; i++) {
    w.bedrock[i] = 20;
    w.soil[i] = 2;
    w.soilType[i] = SoilType.Loam;
    w.ground[i] = sat * 2 * SOIL_PROPS[SoilType.Loam]!.porosity;
    w.vegetation[i] = veg;
  }
  return w;
}

/** Run the daily vegetation step for `days` days starting at game day `from` (seasons from the calendar). */
function grow(v: Vegetation, days: number, from = 0, temp?: number): void {
  for (let d = from; d < from + days; d++) {
    const t = timeAt(d * STEPS_PER_DAY + STEPS_PER_DAY / 2);
    v.daily(temp ?? seaLevelTemperature({ ...t, timeOfDay: 0.375 }), d);
  }
}

function village(seed: number, size = 128) {
  const gen = generateWorld({ seed, size });
  return new Simulation(gen.world, seed, { people: { startX: gen.startX, startY: gen.startY } });
}

describe('living vegetation', () => {
  it('colonises bare moist ground with grass quickly in the growing season', () => {
    const w = meadow();
    const v = new Vegetation(w);
    grow(v, 12, 12, 18); // summer
    const i = w.idx(8, 8);
    expect(w.vegetation[i]).toBeGreaterThan(0.2);
    expect(w.vegetation[i]).toBeLessThan(0.5); // grass, not forest
  });

  it('pauses in the cold and under snow', () => {
    const w = meadow();
    const v = new Vegetation(w);
    grow(v, 12, 36, -2);
    expect(w.vegetation[w.idx(8, 8)]).toBe(0);
    const w2 = meadow();
    w2.snow.fill(0.05);
    new Vegetation(w2).daily(18, 0);
    expect(w2.vegetation[w2.idx(8, 8)]).toBe(0);
  });

  it('spreads forest only from forested neighbours, slowly', () => {
    const w = meadow(32, 0.7, 0.4);
    const v = new Vegetation(w);
    // Everything here could carry forest: force the patch noise high.
    v.patch.fill(0.5);
    for (let y = 0; y < 32; y++) w.vegetation[w.idx(0, y)] = 0.9; // a wood along the west edge
    grow(v, 48, 0, 16);
    expect(w.vegetation[w.idx(1, 16)]).toBeGreaterThan(0.55); // next to the wood: forest
    expect(w.vegetation[w.idx(20, 16)]).toBeLessThan(0.5); // far from it: still meadow
    // Over years, the edge advances a few cells, not across the whole meadow at once.
    grow(v, 2 * DAYS_PER_YEAR, 48, 16);
    let front = 0;
    while (front < 31 && w.vegetation[w.idx(front + 1, 16)]! >= VEG.forestLevel) front++;
    expect(front).toBeGreaterThanOrEqual(3);
    expect(front).toBeLessThan(31);
  });

  it('thins forest slowly in a drought, browning but not baring the ground', () => {
    const w = meadow(16, 0.02, 0.9);
    const v = new Vegetation(w);
    const i = w.idx(8, 8);
    grow(v, 12, 12, 18);
    expect(w.vegetation[i]).toBeLessThan(0.9);
    expect(w.vegetation[i]).toBeGreaterThan(0.75); // slowly
    grow(v, 3 * DAYS_PER_YEAR, 24, 18);
    expect(w.vegetation[i]).toBeLessThan(VEG.forestLevel);
    expect(w.vegetation[i]).toBeGreaterThan(0.1);
  });

  it('drowns under standing water', () => {
    const w = meadow(16, 1, 0.8);
    w.water.fill(0.5);
    const v = new Vegetation(w);
    grow(v, 48, 0, 18);
    expect(w.vegetation[w.idx(8, 8)]).toBeLessThan(0.1);
  });

  it('raises infiltration and holds the soil against erosion', () => {
    // Infiltration: the same puddle on bare and on grown ground.
    const inf = (veg: number) => {
      const w = meadow(4, 0.1, veg);
      w.water.fill(0.05);
      const g0 = w.ground[5]!;
      soilWaterStep(w, { tileRain: new Float32Array(1), tileElevation: new Float32Array(1), tilesWide: 1, seaLevelTemp: 10, steps: 4 }, newLedger());
      return w.ground[5]! - g0;
    };
    expect(inf(0)).toBeGreaterThan(0);
    expect(inf(1)).toBeGreaterThan(inf(0) * 1.2);
    // Erosion: fast sheet flow over a slope, bare vs. grassed.
    const eroded = (veg: number) => {
      const n = 24;
      const w = new World(n, n, 1);
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          const i = w.idx(x, y);
          w.bedrock[i] = 10 - 0.2 * x;
          w.soil[i] = 2;
          w.soilType[i] = SoilType.Silt;
          w.water[i] = 0.3;
          w.velX[i] = 1.5;
          w.vegetation[i] = veg;
        }
      const led = newSedimentLedger();
      erosionStep(w, new ErosionScratch(w.size), 4, defaultGeoParams(), led, { y0: Infinity, y1: -Infinity });
      return led.eroded;
    };
    const bare = eroded(0);
    expect(bare).toBeGreaterThan(0);
    expect(eroded(1)).toBeLessThan(bare * 0.6);
  });

  it('keeps forest cover stationary over 20 years (neither collapsing nor taking over)', async () => {
    const gen = generateWorld({ seed: 3, size: 128 });
    const sim = new Simulation(gen.world, 3);
    const w = sim.world;
    const f0 = forestCover(w);
    // A season of real hydrology, then the daily vegetation step alone on that land for 20 years.
    for (let d = 0; d < 12; d++) {
      sim.run(STEPS_PER_DAY);
      await tick();
    }
    const v0 = w.vegetation.slice();
    const covers: number[] = [];
    for (let y = 0; y < 20; y++) {
      grow(sim.vegetation, DAYS_PER_YEAR, 12 + y * DAYS_PER_YEAR);
      covers.push(forestCover(w));
    }
    // eslint-disable-next-line no-console
    console.log(`forest cover: start ${(100 * f0).toFixed(1)}%, yearly ${covers.map((c) => (100 * c).toFixed(1)).join(' ')}`);
    for (const c of covers) {
      expect(c).toBeGreaterThan(f0 * 0.6);
      expect(c).toBeLessThan(Math.max(0.3, f0 * 1.8));
    }
    // Levelled off: the last five years barely move.
    expect(Math.abs(covers[19]! - covers[14]!)).toBeLessThan(0.02);
    // Not frozen: gaps open and close somewhere.
    let moved = 0;
    for (let i = 0; i < w.size; i++) if (Math.abs(w.vegetation[i]! - v0[i]!) > 0.2) moved++;
    expect(moved).toBeGreaterThan(20);
  }, 240_000);

  it.runIf(process.env.HYDRO_LONG)('keeps forest cover stationary in the full simulation (20 years)', async () => {
    const gen = generateWorld({ seed: 3, size: 128 });
    const sim = new Simulation(gen.world, 3);
    const f0 = forestCover(sim.world);
    const covers: number[] = [];
    for (let y = 0; y < 20; y++) {
      for (let d = 0; d < DAYS_PER_YEAR; d++) {
        sim.run(STEPS_PER_DAY);
        await tick();
      }
      covers.push(forestCover(sim.world));
    }
    console.log(`forest cover (full sim): start ${(100 * f0).toFixed(1)}%, yearly ${covers.map((c) => (100 * c).toFixed(1)).join(' ')}`);
    for (const c of covers) {
      expect(c).toBeGreaterThan(f0 * 0.6);
      expect(c).toBeLessThan(Math.max(0.3, f0 * 1.8));
    }
    expect(Math.abs(covers[19]! - covers[14]!)).toBeLessThan(0.03);
  }, 3_600_000);
});

describe('desire paths', () => {
  it('form where people walk every day, and fade when the way is no longer used', () => {
    const w = meadow(24, 0.5, 0.3);
    const a: Walker = { x: 2, y: 12, heading: 0, path: [], pathPos: 0, vx: 0, vy: 0 };
    const route = (from: number, to: number) => {
      const p: number[] = [];
      for (let x = from; from < to ? x <= to : x >= to; x += from < to ? 1 : -1) p.push(w.idx(x, 12));
      return p;
    };
    for (let day = 0; day < 20; day++) {
      // Three round trips a day.
      for (let k = 0; k < 3; k++) {
        for (const [f, t] of [[2, 20], [20, 2]] as const) {
          a.path = route(f, t);
          a.pathPos = 0;
          while (!walk(w, a, 2));
        }
      }
      updateDesirePaths(w);
    }
    expect(w.landuse[w.idx(10, 12)]).toBe(LandUse.Path);
    expect(w.landuse[w.idx(10, 14)]).toBe(LandUse.None);
    expect(longestPath(w)).toBeGreaterThanOrEqual(15);
    // Walking is quicker on the path.
    a.x = 2;
    a.path = route(2, 20);
    a.pathPos = 0;
    walk(w, a, 20);
    const onPath = a.x - 2;
    const w2 = meadow(24, 0.5, 0.3);
    const b: Walker = { x: 2, y: 12, heading: 0, path: route(2, 20), pathPos: 0, vx: 0, vy: 0 };
    walk(w2, b, 20);
    expect(onPath).toBeGreaterThan((b.x - 2) * 1.1);
    // Unused, it fades back to meadow within about a season or two.
    let days = 0;
    while (w.landuse[w.idx(10, 12)] === LandUse.Path && days < 200) {
      updateDesirePaths(w);
      days++;
    }
    expect(days).toBeGreaterThan(20);
    expect(days).toBeLessThan(2 * DAYS_PER_YEAR);
    expect(DESIRE.off).toBeLessThan(DESIRE.on);
  });
});

describe('woodcutters and herds', () => {
  it('a growing village keeps a herd, leads it to pasture, brings milk home, cuts wood away from the water', async () => {
    const sim = village(3);
    const p = sim.people!;
    const w = sim.world;
    let milk = 0;
    let out = 0;
    let felled = 0;
    let chopping = 0;
    let lastV = w.vegetation.slice();
    for (let d = 0; d < 60; d++) {
      for (let k = 0; k < 6; k++) {
        sim.run(STEPS_PER_DAY / 6);
        for (const a of p.agents) {
          if (a.job === Job.Herder && a.carry === CarryKind.Bucket) milk++;
          if (a.job === Job.Woodcutter && a.anim === 9) chopping++;
        }
        const s0 = p.settlements[0]?.state;
        if (s0?.herd?.out) {
          // Cows far out from the village while the herd is out.
          if (p.herds.animals.some((c) => c.settlement === 0 && c.kind === EntityKind.Cow && Math.hypot(c.x - s0.x, c.y - s0.y) > HERD.pastureMin - 1)) out++;
        }
        // Trees felled since the last look: never close to water.
        for (let i = 0; i < w.size; i++) {
          if (lastV[i]! >= WOOD.minForest && w.vegetation[i] === Math.fround(WOOD.felled)) {
            felled++;
            const x = i % w.width;
            const y = (i / w.width) | 0;
            for (let dy = -WOOD.waterMargin + 1; dy < WOOD.waterMargin; dy++)
              for (let dx = -WOOD.waterMargin + 1; dx < WOOD.waterMargin; dx++)
                if (w.inBounds(x + dx, y + dy) && Math.hypot(dx, dy) < WOOD.waterMargin - 1) expect(w.water[w.idx(x + dx, y + dy)]).toBeLessThan(0.3);
          }
        }
        lastV = w.vegetation.slice();
      }
      await tick();
    }
    const s = p.settlements[0]!.state;
    const cows = p.herds.cows(0);
    // eslint-disable-next-line no-console
    console.log(`day 60: pop ${s.population}, cows ${cows}, animals ${p.herds.animals.length}, milk ticks ${milk}, out ${out}, felled ${felled}, chopping ${chopping}, wood ${s.wood?.toFixed(1)}`);
    expect(cows).toBeGreaterThanOrEqual(2);
    expect(p.herds.animals.some((a) => a.kind === EntityKind.Chick)).toBe(true);
    expect(out).toBeGreaterThan(0);
    expect(milk).toBeGreaterThan(0);
    expect(felled).toBeGreaterThan(0);
    expect(chopping).toBeGreaterThan(0);
    expect(s.wood ?? 0).toBeGreaterThan(0);
    // The entity frame carries people and animals.
    const f = p.entities(1);
    expect(f.count).toBe(p.agents.length + p.herds.animals.length);
  }, 400_000);

  it('felled forest grows back from the stand around it', () => {
    const w = meadow(16, 0.7, 0.9);
    const v = new Vegetation(w);
    v.patch.fill(0.5);
    const i = w.idx(8, 8);
    w.vegetation[i] = WOOD.felled;
    grow(v, 2 * DAYS_PER_YEAR, 0, 16);
    expect(w.vegetation[i]).toBeGreaterThan(VEG.forestLevel);
  });

  it('saves and resumes villages with animals exactly', async () => {
    const a = village(4);
    for (let d = 0; d < 16; d++) {
      a.run(STEPS_PER_DAY);
      await tick();
    }
    expect(a.people!.herds.animals.length).toBeGreaterThan(0);
    a.run(STEPS_PER_DAY / 3); // mid-day, animals on their way
    const b = (await loadGame(await saveGame(a))).sim;
    expect(b.stateHash()).toBe(a.stateHash());
    a.run(STEPS_PER_DAY * 2);
    b.run(STEPS_PER_DAY * 2);
    expect(b.stateHash()).toBe(a.stateHash());
    expect(b.people!.herds.animals.length).toBe(a.people!.herds.animals.length);
  }, 240_000);

  it('is deterministic with animals', async () => {
    const run = async () => {
      const s = village(5, 96);
      for (let d = 0; d < 14; d++) {
        s.run(STEPS_PER_DAY);
        await tick();
      }
      return s.stateHash();
    };
    expect(await run()).toBe(await run());
  }, 240_000);
});

describe('achievements of the living land', () => {
  const host = (w: World, people: PeopleSystem | null): AchievementHost => ({ world: w, people, structures: { weirs: [] } as unknown as AchievementHost['structures'] });
  const fakePeople = (w: World, over: Record<string, unknown> = {}) =>
    ({ settlements: [], peakPopulation: 0, population: 0, fieldMoisture: new Float32Array(w.size), quay: new Uint8Array(w.size), floods: { cells: 0, ruined: 0 }, buildings: [], ...over }) as unknown as PeopleSystem;

  it('Well Trodden: a path of 30 cells', () => {
    const w = meadow(64);
    const h = host(w, fakePeople(w));
    const a = new Achievements(64, 64);
    a.baseline(h);
    for (let x = 5; x < 5 + ACH.pathCells - 1; x++) w.landuse[w.idx(x, 10)] = LandUse.Path;
    a.daily(h, 1);
    expect(a.hasEarned('wellTrodden')).toBe(false);
    w.landuse[w.idx(5 + ACH.pathCells - 1, 11)] = LandUse.Path; // diagonal step still connects
    a.daily(h, 2);
    expect(a.hasEarned('wellTrodden')).toBe(true);
  });

  it('Cattle Country: five cows in one village', () => {
    const w = meadow(32);
    let cows = 4;
    const h = host(w, fakePeople(w, { settlements: [{ state: { id: 0 } }], herds: { cows: () => cows } }));
    const a = new Achievements(32, 32);
    a.baseline(h);
    a.quick(h, 3);
    expect(a.hasEarned('cattleCountry')).toBe(false);
    cows = ACH.herdCows;
    a.quick(h, 4);
    expect(a.hasEarned('cattleCountry')).toBe(true);
  });

  it('Forest Keeper: new woods near the works, two days in a row', () => {
    const w = meadow(64, 0.6, 0.3);
    const h = host(w, null);
    const a = new Achievements(64, 64);
    a.baseline(h);
    a.touch(w.idx(20, 20));
    // New forest far from the works does not count.
    for (let y = 50; y < 60; y++) for (let x = 50; x < 60; x++) w.vegetation[w.idx(x, y)] = 0.8;
    a.daily(h, 1);
    a.daily(h, 2);
    expect(a.hasEarned('forestKeeper')).toBe(false);
    for (let y = 16; y < 24; y++) for (let x = 16; x < 24; x++) w.vegetation[w.idx(x, y)] = 0.8;
    a.daily(h, 3);
    expect(a.hasEarned('forestKeeper')).toBe(false);
    a.daily(h, 4);
    expect(a.hasEarned('forestKeeper')).toBe(true);
    // Saved and loaded, the start's forest is kept.
    const b = new Achievements(64, 64);
    b.setState(a.getState());
    expect(b.forest0[w.idx(20, 20)]).toBe(0);
  });
});


