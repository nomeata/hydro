import { describe, expect, it } from 'vitest';
import { World, CellFlag } from '../../src/sim/world';
import { CELL_AREA, DT } from '../../src/sim/constants';
import { DEFAULT_FLOW_PARAMS, FlowScratch, flowStep, stableDt, type FlowStats } from '../../src/sim/hydro/inertial';

function volume(w: World): number {
  let s = 0;
  for (let i = 0; i < w.size; i++) s += w.water[i]!;
  return s * CELL_AREA;
}

function bowl(n: number): World {
  const w = new World(n, n, 1);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const dx = x - n / 2;
      const dy = y - n / 2;
      w.bedrock[w.idx(x, y)] = 0.01 * (dx * dx + dy * dy) + 0.3 * Math.sin(x * 0.7) * Math.cos(y * 0.5);
    }
  return w;
}

function run(w: World, steps: number, onStep?: (s: FlowStats) => void): void {
  const scratch = new FlowScratch(w.size);
  const stats: FlowStats = { outflow: 0, maxDepth: 1, maxSpeed: 0 };
  for (let s = 0; s < steps; s++) {
    // Sub-step for stability, as the sim orchestrator does.
    const n = Math.max(1, Math.ceil(DT / stableDt(stats.maxDepth, stats.maxSpeed)));
    for (let k = 0; k < n; k++) flowStep(w, scratch, DEFAULT_FLOW_PARAMS, DT / n, stats);
    onStep?.(stats);
  }
}

function checkFinite(w: World): void {
  for (let i = 0; i < w.size; i++) {
    expect(Number.isFinite(w.water[i]!)).toBe(true);
    expect(w.water[i]!).toBeGreaterThanOrEqual(0);
  }
}

describe('local inertial flow', () => {
  it('conserves water in a closed basin through a 30 m dam break', () => {
    const w = bowl(64);
    for (let y = 4; y < 24; y++) for (let x = 4; x < 24; x++) w.water[w.idx(x, y)] = 30;
    const v0 = volume(w);
    run(w, 2000);
    expect(Math.abs(volume(w) - v0) / v0).toBeLessThan(1e-4);
    checkFinite(w);
  });

  it('settles to a level, calm lake', () => {
    const w = bowl(32);
    for (let i = 0; i < w.size; i++) w.water[i] = Math.max(0, 2 - w.bedrock[i]!);
    w.water[w.idx(16, 16)]! += 5;
    let speed = 0;
    run(w, 3000, (s) => (speed = s.maxSpeed));
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < w.size; i++) {
      if (w.water[i]! > 0.05) {
        const h = w.surface(i);
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
    }
    expect(hi - lo).toBeLessThan(0.01);
    expect(speed).toBeLessThan(0.05);
  });

  it('carries water down a sloped channel to an outlet', () => {
    const n = 64;
    const w = new World(n, 16, 1);
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < n; x++) {
        const i = w.idx(x, y);
        w.bedrock[i] = (n - x) * 0.1 + (y === 7 || y === 8 ? 0 : 3);
      }
    w.flags[w.idx(n - 1, 7)] |= CellFlag.Outlet;
    w.flags[w.idx(n - 1, 8)] |= CellFlag.Outlet;
    let out = 0;
    const scratch = new FlowScratch(w.size);
    const stats: FlowStats = { outflow: 0, maxDepth: 1, maxSpeed: 0 };
    for (let s = 0; s < 4000; s++) {
      w.water[w.idx(1, 7)]! += (2 * DT) / CELL_AREA; // 2 m³/s inflow
      w.water[w.idx(1, 8)]! += (2 * DT) / CELL_AREA;
      flowStep(w, scratch, DEFAULT_FLOW_PARAMS, DT, stats);
      if (s > 3000) out += stats.outflow;
    }
    // Steady state: outflow ≈ inflow (4 m³/s over 999 steps of 0.5 s).
    expect(out / (999 * DT)).toBeGreaterThan(3.5);
    expect(out / (999 * DT)).toBeLessThan(4.5);
    checkFinite(w);
  });
});
