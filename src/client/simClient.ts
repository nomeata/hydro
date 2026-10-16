/**
 * Main-thread wrapper around the simulation worker: typed messages, snapshot
 * delivery and buffer return, and promise-based test hooks.
 */
import type { Command, FromWorker, Snapshot, ToWorker, WorldInfo } from '../shared/protocol';

export interface ReadyData {
  info: WorldInfo;
  terrain: Float32Array;
  look: Uint8Array;
  plan: Float32Array;
}

export class SimClient {
  private readonly worker: Worker;
  private snapshotListeners: ((s: Snapshot) => void)[] = [];
  private pending = new Map<string, ((v: unknown) => void)[]>();
  /** Latest snapshot metadata. Its depth/vel buffers are detached once returned to the worker. */
  latest: Snapshot | null = null;
  readonly ready: Promise<ReadyData>;
  private speed = 1;

  /** Start a new world, or resume from save-game bytes. */
  constructor(start: ({ seed: number; size: number } | { bytes: ArrayBuffer }) & { speed?: number }) {
    this.worker = new Worker(new URL('../sim/worker.ts', import.meta.url), { type: 'module' });
    this.ready = new Promise((resolve, reject) => {
      this.worker.onerror = (e) => reject(new Error(e.message));
      this.rejectReady = reject;
      this.worker.onmessage = (ev: MessageEvent<FromWorker>) => {
        const msg = ev.data;
        switch (msg.type) {
          case 'ready':
            resolve({ info: msg.info, terrain: msg.terrain, look: msg.look, plan: msg.plan });
            break;
          case 'snapshot': {
            const { type: _type, ...snap } = msg;
            this.latest = snap;
            for (const l of this.snapshotListeners) l(snap);
            // Return the pooled buffers once everyone has consumed them.
            this.post({ type: 'ack', poolId: snap.poolId, depth: snap.depth, vel: snap.vel }, [
              snap.depth.buffer,
              snap.vel.buffer,
            ]);
            break;
          }
          case 'ranDays':
            this.resolve('ranDays', msg.days);
            break;
          case 'hash':
            this.resolve('hash', msg.hash);
            break;
          case 'saved':
            this.resolve('saved', msg.bytes);
            break;
          case 'loadFailed':
            this.rejectReady?.(new Error(msg.message));
            break;
          case 'log':
            console[msg.level](`[sim] ${msg.message}`);
            break;
        }
      };
    });
    this.speed = start.speed ?? 1;
    if ('bytes' in start) this.post({ type: 'load', bytes: start.bytes, speed: this.speed }, [start.bytes]);
    else this.post({ type: 'init', seed: start.seed, size: start.size, speed: this.speed });
  }

  private rejectReady: ((e: Error) => void) | null = null;

  /** Serialise the running game (gzip'd bytes). */
  save(): Promise<ArrayBuffer> {
    return this.request('saved', { type: 'save' }) as Promise<ArrayBuffer>;
  }

  /**
   * Listeners must copy what they need synchronously: the depth and velocity
   * buffers are returned to the worker right after the listeners run.
   */
  onSnapshot(fn: (s: Snapshot) => void): void {
    this.snapshotListeners.push(fn);
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.post({ type: 'setSpeed', speed });
  }

  getSpeed(): number {
    return this.speed;
  }

  command(command: Command): void {
    this.post({ type: 'command', command });
  }

  runDays(days: number): Promise<number> {
    return this.request('ranDays', { type: 'runDays', days }) as Promise<number>;
  }

  stateHash(): Promise<string> {
    return this.request('hash', { type: 'hash' }) as Promise<string>;
  }

  private request(key: string, msg: ToWorker): Promise<unknown> {
    return new Promise((resolve) => {
      const list = this.pending.get(key) ?? [];
      list.push(resolve);
      this.pending.set(key, list);
      this.post(msg);
    });
  }

  private resolve(key: string, value: unknown): void {
    const list = this.pending.get(key);
    const fn = list?.shift();
    fn?.(value);
  }

  private post(msg: ToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer);
  }

  dispose(): void {
    this.worker.terminate();
  }
}
