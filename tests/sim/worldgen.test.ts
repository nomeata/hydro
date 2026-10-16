import { describe, expect, it } from 'vitest';
import { generateWorld, generateWorldDebug } from '../../src/sim/worldgen/index';
import { CellFlag, FIELD_SPECS, SOIL_PROPS, SOIL_TYPE_COUNT, type World } from '../../src/sim/world';
import { CELL_AREA, DT } from '../../src/sim/constants';
import { DEFAULT_FLOW_PARAMS, FlowScratch, flowStep, stableDt, type FlowStats } from '../../src/sim/hydro/inertial';
import { MinHeap } from '../../src/sim/worldgen/util';

/** Lowest possible "spill" height on any 4-connected path from each cell to an outlet. */
function spillToOutlets(w: World): Float32Array {
  const W = w.width;
  const H = w.height;
  const spill = new Float32Array(w.size).fill(Infinity);
  const heap = new MinHeap();
  for (let i = 0; i < w.size; i++)
    if (w.flags[i]! & CellFlag.Outlet) {
      spill[i] = w.terrain(i);
      heap.push(spill[i]!, i);
    }
  const done = new Uint8Array(w.size);
  while (heap.size > 0) {
    const c = heap.pop();
    if (done[c]) continue;
    done[c] = 1;
    const x = c % W;
    const y = (c - x) / W;
    const nbs = [x > 0 ? c - 1 : -1, x < W - 1 ? c + 1 : -1, y > 0 ? c - W : -1, y < H - 1 ? c + W : -1];
    for (const nb of nbs) {
      if (nb < 0 || done[nb]) continue;
      const s = Math.max(spill[c]!, w.terrain(nb));
      if (s < spill[nb]!) {
        spill[nb] = s;
        heap.push(s, nb);
      }
    }
  }
  return spill;
}

function checkSane(w: World): void {
  const bad: string[] = [];
  const fail = (i: number, what: string): void => {
    if (bad.length < 10) bad.push(`cell ${i % w.width},${Math.floor(i / w.width)}: ${what}`);
  };
  let zmin = Infinity;
  let zmax = -Infinity;
  for (let i = 0; i < w.size; i++) {
    const z = w.terrain(i);
    if (!Number.isFinite(z)) fail(i, `terrain ${z}`);
    zmin = Math.min(zmin, z);
    zmax = Math.max(zmax, z);
    const t = w.soilType[i]!;
    if (t >= SOIL_TYPE_COUNT) fail(i, `soil type ${t}`);
    const soil = w.soil[i]!;
    if (!(soil > 0 && soil <= 5)) fail(i, `soil ${soil}`);
    const g = w.ground[i]!;
    const cap = soil * (SOIL_PROPS[t]?.porosity ?? 0);
    if (!(g >= 0 && g <= cap + 1e-5)) fail(i, `ground ${g} > capacity ${cap}`);
    const water = w.water[i]!;
    if (!(water >= 0 && water < 15)) fail(i, `water ${water}`);
    const f = w.fertility[i]!;
    if (!(f >= 0 && f <= 1)) fail(i, `fertility ${f}`);
    const v = w.vegetation[i]!;
    if (!(v >= 0 && v <= 1)) fail(i, `vegetation ${v}`);
    const q = w.inflow[i]!;
    if (!(q >= 0 && q < 100)) fail(i, `inflow ${q}`);
  }
  expect(bad).toEqual([]);
  expect(zmax - zmin).toBeGreaterThan(5);
  expect(zmax - zmin).toBeLessThan(400);
}

describe('world generator', () => {
  it('is deterministic', () => {
    const a = generateWorld({ seed: 42, size: 128 });
    const b = generateWorld({ seed: 42, size: 128 });
    expect(a.startX).toBe(b.startX);
    expect(a.startY).toBe(b.startY);
    for (const spec of FIELD_SPECS) {
      const fa = a.world.field(spec.name);
      const fb = b.world.field(spec.name);
      expect(Buffer.from(fa.buffer).equals(Buffer.from(fb.buffer)), spec.name).toBe(true);
    }
  });

  it('gives different seeds different maps', () => {
    const a = generateWorld({ seed: 1, size: 128 }).world;
    const b = generateWorld({ seed: 2, size: 128 }).world;
    let diff = 0;
    for (let i = 0; i < a.size; i++) diff += Math.abs(a.terrain(i) - b.terrain(i));
    expect(diff / a.size).toBeGreaterThan(1);
  });

  it('base terrain is a pure function of global coordinates', () => {
    const a = generateWorldDebug({ seed: 7, size: 128, originX: 0, originY: 0 }).debug.base;
    const b = generateWorldDebug({ seed: 7, size: 128, originX: 64, originY: 32 }).debug.base;
    for (let y = 0; y < 96; y++)
      for (let x = 0; x < 64; x++) if (b[y * 128 + x] !== a[(y + 32) * 128 + x + 64]) throw new Error(`base differs at ${x},${y}`);
  });

  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`seed ${seed}: sane values, outlets, inflows that drain`, () => {
      const t0 = performance.now();
      const { world: w, startX, startY } = generateWorld({ seed, size: 256 });
      const ms = performance.now() - t0;
      // Budget is 1.5 s standalone; allow slack for parallel test workers.
      expect(ms).toBeLessThan(4000);
      checkSane(w);

      let outlets = 0;
      let inflow = 0;
      for (let i = 0; i < w.size; i++) {
        if (w.flags[i]! & CellFlag.Outlet) {
          outlets++;
          const x = i % w.width;
          const y = (i - x) / w.width;
          // Outlets are boundary cells and never inflow cells.
          expect(x === 0 || y === 0 || x === w.width - 1 || y === w.height - 1).toBe(true);
          expect(w.inflow[i]).toBe(0);
        }
        inflow += w.inflow[i]!;
      }
      expect(outlets).toBeGreaterThan(0);
      expect(inflow).toBeGreaterThan(0.5);
      expect(inflow).toBeLessThan(400);

      // Water entering at an inflow cell reaches an outlet without having to
      // rise above the inflow cell's ground (it may pass through lakes).
      const spill = spillToOutlets(w);
      const blocked: number[] = [];
      for (let i = 0; i < w.size; i++) if (w.inflow[i]! > 0 && spill[i]! - w.terrain(i) > 0.05) blocked.push(i);
      expect(blocked).toEqual([]);

      // Start point: inside the map away from the edge, on dry land.
      const m = 16;
      expect(startX).toBeGreaterThanOrEqual(m);
      expect(startY).toBeGreaterThanOrEqual(m);
      expect(startX).toBeLessThan(w.width - m);
      expect(startY).toBeLessThan(w.height - m);
      expect(w.water[startY * w.width + startX]!).toBeLessThan(0.01);
    });
  }

  it('has wet channels: some cells start with water', () => {
    const { world: w } = generateWorld({ seed: 1, size: 256 });
    let wet = 0;
    for (let i = 0; i < w.size; i++) if (w.water[i]! > 0.1) wet++;
    expect(wet / w.size).toBeGreaterThan(0.005);
    expect(wet / w.size).toBeLessThan(0.3);
  });

  it('works at 128 and 512', () => {
    const small = generateWorld({ seed: 3, size: 128 });
    checkSane(small.world);
    const t0 = performance.now();
    const big = generateWorld({ seed: 3, size: 512 });
    expect(performance.now() - t0).toBeLessThan(15000);
    checkSane(big.world);
  }, 30000);

  it('rivers flow through the map to the outlets under the inertial model', () => {
    const { world: w } = generateWorld({ seed: 3, size: 128 });
    let qin = 0;
    for (let i = 0; i < w.size; i++) qin += w.inflow[i]!;
    expect(qin).toBeGreaterThan(1);
    const vol = (): number => {
      let s = 0;
      for (let i = 0; i < w.size; i++) s += w.water[i]!;
      return s * CELL_AREA;
    };
    const v0 = vol();
    const scratch = new FlowScratch(w.size);
    const stats: FlowStats = { outflow: 0, maxDepth: 1, maxSpeed: 0 };
    const steps = 800;
    let out = 0;
    let outLate = 0;
    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < w.size; i++) if (w.inflow[i]! > 0) w.water[i] = w.water[i]! + (w.inflow[i]! * DT) / CELL_AREA;
      // The cell-velocity diagnostic can spike in thin cells; the face fluxes
      // are clamped to maxVelocity, so cap it for the CFL estimate.
      const n = Math.max(1, Math.ceil(DT / stableDt(stats.maxDepth, Math.min(stats.maxSpeed, 2 * DEFAULT_FLOW_PARAMS.maxVelocity))));
      for (let k = 0; k < n; k++) {
        flowStep(w, scratch, DEFAULT_FLOW_PARAMS, DT / n, stats);
        out += stats.outflow;
        if (s >= steps - 200) outLate += stats.outflow;
      }
    }
    let badWater = 0;
    for (let i = 0; i < w.size; i++) if (!(w.water[i]! >= 0 && w.water[i]! < 20)) badWater++;
    expect(badWater).toBe(0);
    // Mass balance: nothing created.
    expect(vol()).toBeLessThanOrEqual(v0 + qin * steps * DT - out + 1);
    // Near steady state, most of the inflow leaves through the outlets.
    const qout = outLate / (200 * DT);
    expect(qout).toBeGreaterThan(0.5 * qin);
    expect(qout).toBeLessThan(3 * qin);
  }, 120000);
});
