import { describe, expect, it } from 'vitest';
import { CellFlag, SoilType, World } from '../../src/sim/world';
import { Simulation } from '../../src/sim/sim';
import { CELL_AREA, DAYS_PER_YEAR, STEPS_PER_DAY } from '../../src/sim/constants';
import { applyEarthwork, planTrench } from '../../src/sim/plans/plans';
import { TalusScratch, talusStep } from '../../src/sim/hydro/talus';
import { defaultGeoParams, newSedimentLedger, type RowRange } from '../../src/sim/hydro/erosion';
import { generateWorld } from '../../src/sim/worldgen/index';

const YEAR = STEPS_PER_DAY * DAYS_PER_YEAR;

/** A meandering sandy/loamy valley with a river entering at x = 0 and leaving at x = W-1. */
function valley(n = 64): World {
  const w = new World(n, n, 7);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = w.idx(x, y);
      const c = n / 2 + 6 * Math.sin(x * 0.15);
      const dy = Math.abs(y - c);
      w.bedrock[i] = 50 + (n - x) * 0.04 + dy * 0.3 - (dy < 3 ? 1.5 : 0);
      w.soil[i] = 2;
      w.soilType[i] = dy < 6 ? SoilType.Sand : SoilType.Loam;
      w.bedrock[i]! -= 2;
    }
  for (let y = 0; y < n; y++) {
    const c0 = n / 2;
    const c1 = n / 2 + 6 * Math.sin((n - 1) * 0.15);
    if (Math.abs(y - c0) <= 2) w.inflow[w.idx(0, y)] = 1.2;
    if (Math.abs(y - c1) <= 3) w.flags[w.idx(n - 1, y)] |= CellFlag.Outlet;
  }
  return w;
}

/** Bedrock + soil + suspended sediment, m³ (f64). */
function solids(w: World): number {
  let s = 0;
  for (let i = 0; i < w.size; i++) s += (w.bedrock[i]! + w.soil[i]!) * CELL_AREA + w.sediment[i]!;
  return s;
}

function checkFinite(w: World): void {
  for (let i = 0; i < w.size; i++) {
    for (const f of [w.bedrock, w.soil, w.water, w.sediment, w.ground, w.fertility] as const) {
      expect(Number.isFinite(f[i]!)).toBe(true);
    }
    expect(w.soil[i]!).toBeGreaterThanOrEqual(0);
    expect(w.water[i]!).toBeGreaterThanOrEqual(0);
    expect(w.sediment[i]!).toBeGreaterThanOrEqual(0);
    expect(w.fertility[i]!).toBeLessThanOrEqual(1);
  }
}

describe('erosion and deposition', () => {
  it('conserves bedrock + soil + sediment apart from inflow and outflow', () => {
    const w = valley();
    const sim = new Simulation(w, 2);
    sim.geo.morfac *= 10;
    const before = solids(w);
    sim.run(STEPS_PER_DAY * 6);
    const L = sim.sedLedger;
    expect(L.eroded).toBeGreaterThan(10);
    expect(L.deposited).toBeGreaterThan(10);
    expect(L.inflow).toBeGreaterThan(0);
    expect(L.outflow).toBeGreaterThan(0);
    const err = solids(w) - (before + L.inflow - L.outflow);
    expect(Math.abs(err)).toBeLessThan(1e-3 * (L.eroded + L.deposited + L.inflow));
    checkFinite(w);
  });

  it('keeps every field finite and non-negative under stress', () => {
    const w = valley(48);
    // Adversarial bumps: a spike, a pit and a cliff in the channel.
    w.soil[w.idx(20, 24)]! += 4;
    w.soil[w.idx(30, 24)] = 0;
    for (let y = 0; y < 48; y++) w.bedrock[w.idx(10, y)]! += 3;
    const sim = new Simulation(w, 4);
    sim.geo.morfac *= 20;
    sim.command({ type: 'debugWater', x: 24, y: 24, radius: 6, depth: 3 });
    sim.run(STEPS_PER_DAY * 3);
    checkFinite(w);
  });

  it('turns slow-water deposits into fertile silt', () => {
    const w = valley();
    // A deep pond across the valley floor halfway down slows the river.
    for (let y = 20; y < 44; y++) for (let x = 30; x < 40; x++) w.soil[w.idx(x, y)]! -= 1.5;
    const sim = new Simulation(w, 2);
    sim.geo.morfac *= 10;
    const f0 = new Float32Array(w.fertility);
    sim.run(STEPS_PER_DAY * 8);
    let silt = 0;
    let fertGain = 0;
    for (let i = 0; i < w.size; i++) {
      if (w.soilType[i] === SoilType.Silt) silt++;
      fertGain += Math.max(0, w.fertility[i]! - f0[i]!);
    }
    expect(silt).toBeGreaterThan(0);
    expect(fertGain).toBeGreaterThan(0.5);
  });
});

describe('talus', () => {
  it('is conservative, moves only soil and flattens a spike', () => {
    const n = 16;
    const w = new World(n, n, 1);
    for (let i = 0; i < w.size; i++) {
      w.bedrock[i] = 10;
      w.soil[i] = 1;
      w.soilType[i] = SoilType.Sand;
    }
    const c = w.idx(8, 8);
    w.soil[c] = 8;
    w.bedrock[w.idx(3, 3)] = 30; // a bedrock tower with a thin soil cap
    const bed0 = new Float32Array(w.bedrock);
    let soil0 = 0;
    for (let i = 0; i < w.size; i++) soil0 += w.soil[i]!;
    const scratch = new TalusScratch(w.size);
    const L = newSedimentLedger();
    const dirty: RowRange = { y0: Infinity, y1: -Infinity };
    for (let k = 0; k < 200; k++) talusStep(w, scratch, 0.3, defaultGeoParams(), L, dirty);
    let soil1 = 0;
    for (let i = 0; i < w.size; i++) {
      soil1 += w.soil[i]!;
      expect(w.bedrock[i]).toBe(bed0[i]);
      expect(w.soil[i]!).toBeGreaterThanOrEqual(0);
    }
    expect(Math.abs(soil1 - soil0)).toBeLessThan(1e-3);
    expect(w.soil[c]!).toBeLessThan(5);
    // The tower keeps its bedrock but loses its soil cap.
    expect(w.soil[w.idx(3, 3)]!).toBeLessThan(0.05);
    expect(dirty.y0).toBeLessThanOrEqual(2);
    expect(dirty.y1).toBeGreaterThanOrEqual(9);
  });
});

/** A sandy plain with a dug trench that carries water from x = 0 to x = W-1. */
function trenchWorld(lined: boolean): { w: World; cells: number[] } {
  const W = 64;
  const H = 32;
  const w = new World(W, H, 3);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = w.idx(x, y);
      w.bedrock[i] = 100 + (W - x) * 0.025;
      w.soil[i] = 3;
      w.soilType[i] = SoilType.Sand;
      w.ground[i] = 0.5;
    }
  const cells = planTrench(w, [[0, 16], [W - 1, 16]], 2, 1.5);
  for (const i of cells) {
    applyEarthwork(w, i, w.plan[i]! - w.terrain(i));
    w.plan[i] = NaN;
    if (lined) w.flags[i] |= CellFlag.Lined;
  }
  for (let y = 15; y <= 17; y++) {
    w.inflow[w.idx(0, y)] = 0.5;
    w.flags[w.idx(W - 1, y)] |= CellFlag.Outlet;
  }
  return { w, cells };
}

describe('trenches', () => {
  it('an unlined trench in sand slumps within a season; a lined one does not', () => {
    const results: number[] = [];
    for (const lined of [false, true]) {
      const { w, cells } = trenchWorld(lined);
      const z0 = cells.map((i) => w.terrain(i));
      const sim = new Simulation(w, 5);
      sim.run(YEAR / 4);
      let change = 0;
      cells.forEach((i, k) => (change += Math.abs(w.terrain(i) - z0[k]!)));
      results.push(change / cells.length);
      if (lined) cells.forEach((i, k) => expect(w.terrain(i)).toBe(z0[k]));
      checkFinite(w);
    }
    // Unlined: the steep sand banks under water slump by a good fraction of a metre.
    expect(results[0]!).toBeGreaterThan(0.05);
    expect(results[1]!).toBe(0);
  });
});

/**
 * Long-horizon stationarity on a real generated world with the full
 * simulation (rain, rivers, erosion, talus, weathering). By default two game
 * years with MORFAC ×3 (≈ 6 morphological years) to keep the suite fast;
 * HYDRO_LONG=1 runs ten years at the normal MORFAC.
 */
const LONG = !!process.env.HYDRO_LONG;

describe('long-horizon geomorphology', () => {
  it('stays stationary: bounded change, no spikes, rivers and sediment balance persist', { timeout: LONG ? 3_600_000 : 300_000 }, () => {
    const years = LONG ? 10 : 2;
    const { world: w } = generateWorld({ seed: 6, size: 128 });
    const sim = new Simulation(w, 6);
    if (!LONG) sim.geo.morfac *= 3;
    sim.run(STEPS_PER_DAY * 5);
    const W = w.width;
    const H = w.height;
    const z0 = Float32Array.from({ length: w.size }, (_, i) => w.terrain(i));
    const bump = (z: (i: number) => number, i: number): number => z(i) - 0.25 * (z(i - 1) + z(i + 1) + z(i - W) + z(i + W));
    const rivers = (): number => w.water.reduce((n, h) => n + (h > 0.3 ? 1 : 0), 0);
    const wet0 = Uint8Array.from(w.water, (h) => (h > 0.1 ? 1 : 0));
    const river0 = rivers();
    const outflow0 = sim.outflowLastDay;
    let last = { ...sim.sedLedger };
    for (let y = 0; y < years; y++) {
      last = { ...sim.sedLedger };
      sim.run(YEAR);
    }
    checkFinite(w);
    const L = sim.sedLedger;

    // Near-river mask: cells within 6 cells of water at the start or end.
    const near = new Uint8Array(w.size);
    const R = 6;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!wet0[i] && w.water[i]! <= 0.1) continue;
        for (let yy = Math.max(0, y - R); yy <= Math.min(H - 1, y + R); yy++)
          for (let xx = Math.max(0, x - R); xx <= Math.min(W - 1, x + R); xx++) near[yy * W + xx] = 1;
      }
    let sumAbs = 0;
    let maxFar = 0;
    let spikes = 0;
    for (let i = 0; i < w.size; i++) {
      const d = Math.abs(w.terrain(i) - z0[i]!);
      sumAbs += d;
      if (!near[i]) maxFar = Math.max(maxFar, d);
      const x = i % W;
      const y = (i - x) / W;
      if (x > 0 && y > 0 && x < W - 1 && y < H - 1) {
        const b = bump((j) => w.terrain(j), i) - bump((j) => z0[j]!, i);
        if (Math.abs(b) > 1) spikes++;
      }
    }
    const meanAbs = sumAbs / w.size;
    const sedIn = L.inflow - last.inflow;
    const sedOut = L.outflow - last.outflow;
    const summary = JSON.stringify({ meanAbs, maxFar, spikes, river0, river: rivers(), outflow0, outflow: sim.outflowLastDay, sedIn, sedOut });
    // Bounded drift: centimetres on average, nothing big away from the rivers.
    expect(meanAbs, summary).toBeLessThan(0.05);
    expect(maxFar, summary).toBeLessThan(0.5);
    // No single-cell spikes or pits.
    expect(spikes, summary).toBeLessThan(w.size * 0.002);
    // Rivers persist and still drain through the outlets.
    expect(rivers() / river0, summary).toBeGreaterThan(0.7);
    expect(rivers() / river0, summary).toBeLessThan(1.4);
    expect(sim.outflowLastDay, summary).toBeGreaterThan(0.6 * outflow0);
    // Sediment budget roughly balanced over the last year.
    expect(sedIn, summary).toBeGreaterThan(0);
    expect(Math.abs(sedIn - sedOut) / Math.max(sedIn, sedOut), summary).toBeLessThan(0.3);
    // The land does move.
    expect(L.eroded, summary).toBeGreaterThan(1000);
  });
});
