import { World } from '../src/sim/world';
import { DEFAULT_FLOW_PARAMS, FlowScratch, flowStep, type FlowStats } from '../src/sim/hydro/inertial';

for (const n of [256, 512]) {
  const w = new World(n, n, 1);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = w.idx(x, y);
      w.bedrock[i] = 20 * Math.sin(x * 0.03) * Math.cos(y * 0.02) + 0.05 * x;
      w.water[i] = 0.2;
    }
  const scratch = new FlowScratch(w.size);
  const stats: FlowStats = { outflow: 0, maxDepth: 0, maxSpeed: 0 };
  for (let s = 0; s < 20; s++) flowStep(w, scratch, DEFAULT_FLOW_PARAMS, 0.5, stats);
  const t0 = performance.now();
  const steps = 100;
  for (let s = 0; s < steps; s++) flowStep(w, scratch, DEFAULT_FLOW_PARAMS, 0.5, stats);
  const ms = (performance.now() - t0) / steps;
  console.log(`flow ${n}x${n}: ${ms.toFixed(2)} ms/step, ${((ms * 1e6) / w.size).toFixed(1)} ns/cell (${(1000 / ms).toFixed(0)} steps/s)`);
}
