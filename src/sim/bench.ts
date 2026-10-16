/**
 * Kernel benchmarks, shared by `npm run bench` (Node) and the in-browser
 * bench page (`?bench=1`) that runs them in a worker on the target device.
 */
import { DEFAULT_FLOW_PARAMS, FlowScratch, flowStep, type FlowStats } from './hydro/inertial';
import { Simulation } from './sim';
import { SoilType, World } from './world';

export interface BenchResult {
  name: string;
  size: number;
  msPerStep: number;
  nsPerCell: number;
  stepsPerSecond: number;
}

function testWorld(n: number): World {
  const w = new World(n, n, 1);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = w.idx(x, y);
      w.bedrock[i] = 20 * Math.sin(x * 0.03) * Math.cos(y * 0.02) + 0.05 * x;
      w.soil[i] = 1;
      w.soilType[i] = SoilType.Loam;
      w.water[i] = 0.2;
    }
  return w;
}

function measure(name: string, n: number, steps: number, fn: () => void): BenchResult {
  for (let s = 0; s < Math.min(20, steps); s++) fn();
  const t0 = performance.now();
  for (let s = 0; s < steps; s++) fn();
  const ms = (performance.now() - t0) / steps;
  return { name, size: n, msPerStep: ms, nsPerCell: (ms * 1e6) / (n * n), stepsPerSecond: 1000 / ms };
}

export function runBench(sizes: number[] = [256, 512], onResult?: (r: BenchResult) => void): BenchResult[] {
  const results: BenchResult[] = [];
  for (const n of sizes) {
    const w = testWorld(n);
    const scratch = new FlowScratch(w.size);
    const stats: FlowStats = { outflow: 0, maxDepth: 0, maxSpeed: 0 };
    const steps = n <= 256 ? 100 : 30;
    const r1 = measure('flow kernel', n, steps, () => flowStep(w, scratch, DEFAULT_FLOW_PARAMS, 0.5, stats));
    results.push(r1);
    onResult?.(r1);
    const sim = new Simulation(testWorld(n), 1);
    const r2 = measure('full sim step', n, steps, () => sim.advance());
    results.push(r2);
    onResult?.(r2);
  }
  return results;
}

export function formatResult(r: BenchResult): string {
  return `${r.name.padEnd(14)} ${String(r.size).padStart(3)}²: ${r.msPerStep.toFixed(2).padStart(6)} ms/step, ${r.nsPerCell.toFixed(1).padStart(5)} ns/cell, ${r.stepsPerSecond.toFixed(0).padStart(4)} steps/s`;
}
