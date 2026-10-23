/**
 * The sim worker (src/sim/worker.ts) in a Node worker thread, driven like
 * the main thread drives it: load a save, set a speed, ack every snapshot.
 * Reports the worker's event-loop utilisation (its CPU duty), wake-ups and
 * snapshots per second.
 *
 *   npx tsx tools/perfworker.ts <save.hydro> [--speed 1] [--seconds 20] [--duty 1]
 */
import { readFileSync } from 'node:fs';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { performance as nodePerf } from 'node:perf_hooks';

if (isMainThread) {
  const args = process.argv.slice(2);
  const opt = (k: string, d: string): string => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1]! : d;
  };
  const file = args[0]!;
  const speed = Number(opt('speed', '1'));
  const seconds = Number(opt('seconds', '20'));
  const duty = Number(opt('duty', '1'));
  const worker = new Worker(fileURLToPath(import.meta.url), {});
  const b = readFileSync(file);
  const bytes = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  let snaps = 0;
  let bytesIn = 0;
  let t0 = 0;
  let measuring = false;
  let readyAt = 0;
  let lastStep = 0;
  let step0 = -1;
  worker.on('error', (e) => console.error('worker error', e));
  worker.on('message', (m: { type: string; [k: string]: unknown }) => {
    if (m.type !== 'snapshot') console.error('msg', m.type);
    if (m.type === 'ready') {
      readyAt = performance.now();
      worker.postMessage({ type: 'setSpeed', speed });
      // Settle for 3 s, then measure.
      setTimeout(() => {
        measuring = true;
        snaps = 0;
        bytesIn = 0;
        worker.postMessage({ type: 'perfStart' });
        t0 = performance.now();
        setTimeout(() => worker.postMessage({ type: 'perfStop' }), seconds * 1000);
      }, 3000);
    } else if (m.type === 'snapshot') {
      lastStep = (m.time as { step: number }).step;
      if (measuring && step0 < 0) step0 = lastStep;
      if (measuring) {
        snaps++;
        for (const v of Object.values(m)) if (ArrayBuffer.isView(v)) bytesIn += v.byteLength;
      }
      worker.postMessage({ type: 'ack', poolId: m.poolId, depth: m.depth, vel: m.vel }, [(m.depth as Float32Array).buffer as ArrayBuffer, (m.vel as Int8Array).buffer as ArrayBuffer]);
    } else if (m.type === 'perf') {
      const wall = (performance.now() - t0) / 1000;
      const r = m as unknown as { elu: number; wakes: number };
      const gameSeconds = (lastStep - Math.max(0, step0)) / 20;
      console.log(
        `${file.split('/').pop()} at ${speed}× (duty ${duty}): worker busy ${(100 * r.elu).toFixed(1)} % of a core, ${(r.wakes / wall).toFixed(0)} wake-ups/s, ${(snaps / wall).toFixed(1)} snapshots/s (${(bytesIn / wall / 1024).toFixed(0)} KiB/s), game ${(gameSeconds / wall).toFixed(2)} s/s`,
      );
      void worker.terminate();
    } else if (m.type === 'log') console.error('[worker]', m.message);
    void readyAt;
  });
  worker.postMessage({ type: 'load', bytes, speed: 0, duty }, [bytes]);
} else {
  // The worker side: a DedicatedWorkerGlobalScope for worker.ts.
  const port = parentPort!;
  const g = globalThis as unknown as Record<string, unknown>;
  g.self = globalThis;
  g.postMessage = (msg: unknown, transfer?: Transferable[]) => port.postMessage(msg, transfer as never);
  let handler: ((ev: { data: unknown }) => void) | null = null;
  // Messages that arrive while worker.ts is still loading wait for its handler.
  const early: unknown[] = [];
  Object.defineProperty(globalThis, 'onmessage', {
    set(fn: (ev: { data: unknown }) => void) {
      handler = fn;
      for (const data of early.splice(0)) fn({ data });
    },
    get: () => handler,
  });
  // Count wake-ups: every timer and MessageChannel delivery runs a macrotask.
  let wakes = 0;
  const st = globalThis.setTimeout;
  g.setTimeout = ((fn: () => void, ms?: number) => st(() => (wakes++, fn()), ms)) as typeof setTimeout;
  const MC = globalThis.MessageChannel;
  g.MessageChannel = class extends MC {
    constructor() {
      super();
      const p1 = this.port1;
      let fn: ((ev: MessageEvent) => void) | null = null;
      Object.defineProperty(p1, 'onmessage', {
        set(f: (ev: MessageEvent) => void) {
          fn = f;
          p1.addEventListener('message', (ev) => {
            wakes++;
            fn?.(ev as MessageEvent);
          });
          p1.start();
        },
        get: () => fn,
      });
    }
  };
  let elu0 = nodePerf.eventLoopUtilization();
  port.on('message', (data: { type: string }) => {
    if (data.type === 'perfStart') {
      elu0 = nodePerf.eventLoopUtilization();
      wakes = 0;
      return;
    }
    if (data.type === 'perfStop') {
      const elu = nodePerf.eventLoopUtilization(elu0).utilization;
      port.postMessage({ type: 'perf', elu, wakes });
      return;
    }
    if (handler) handler({ data });
    else early.push(data);
  });
  // (Node strips the types of this file itself; worker.ts's imports need tsx.)
  const { register } = await import('tsx/esm/api');
  register();
  await import('../src/sim/worker');
}
