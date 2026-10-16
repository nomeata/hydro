/// <reference lib="webworker" />
import { runBench } from './bench';

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = () => {
  runBench([256, 512], (r) => self.postMessage({ type: 'result', result: r }));
  self.postMessage({ type: 'done' });
};
