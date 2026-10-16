/** The ?bench=1 page: runs the sim kernels in a worker on this device. */
import { formatResult, type BenchResult } from './sim/bench';

export function runBenchPage(): void {
  document.getElementById('loading')?.remove();
  document.body.style.overflow = 'auto';
  const pre = document.createElement('pre');
  pre.style.cssText = 'position:fixed;inset:0;margin:0;padding:16px;background:#fbf5e6;color:#3b3328;font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap;overflow:auto;z-index:5';
  pre.textContent = `Hydro kernel benchmark\n${navigator.userAgent}\ncores: ${navigator.hardwareConcurrency}\n\nRunning…\n`;
  document.body.append(pre);
  const worker = new Worker(new URL('./sim/benchWorker.ts', import.meta.url), { type: 'module' });
  const t0 = performance.now();
  worker.onmessage = (ev: MessageEvent<{ type: string; result?: BenchResult }>) => {
    if (ev.data.type === 'result' && ev.data.result) pre.textContent += formatResult(ev.data.result) + '\n';
    if (ev.data.type === 'done') {
      pre.textContent += `\nDone in ${((performance.now() - t0) / 1000).toFixed(1)} s. At 1× the game needs 20 steps/s.\n`;
      worker.terminate();
    }
  };
  worker.postMessage('start');
}
