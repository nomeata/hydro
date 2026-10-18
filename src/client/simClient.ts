/**
 * Main-thread wrapper around the simulation worker: typed messages, snapshot
 * delivery and buffer return, and promise-based test hooks.
 */
import type { Command, FromWorker, HistoryData, SceneId, Snapshot, ToWorker, WorldInfo } from '../shared/protocol';
import workerUrl from '../sim/worker.ts?worker&url';

/**
 * The worker script, kept in memory once the first worker has started. Every
 * deploy replaces the hashed assets, so a tab that has been open across a
 * deploy can no longer load `worker-<hash>.js` from the server; the welcome
 * panels and tool cards start their scene workers long after the game's, and
 * would fall back to their drawings. (Production only: in dev the worker
 * imports other modules by path, which a blob URL cannot resolve.)
 */
let workerBlobUrl: string | null = null;
let workerBlobPending = false;

function keepWorkerScript(): void {
  if (!import.meta.env.PROD || workerBlobUrl || workerBlobPending || typeof fetch !== 'function') return;
  workerBlobPending = true;
  fetch(workerUrl, { cache: 'force-cache' })
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))))
    .then((src) => {
      workerBlobUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    })
    .catch(() => {
      workerBlobPending = false;
    });
}

export interface ReadyData {
  info: WorldInfo;
  terrain: Float32Array;
  look: Uint8Array;
  plan: Float32Array;
  /** Fog of war (absent: everything revealed). */
  revealed?: Uint8Array;
  /** Cells the brushes leave alone (see Snapshot.fixed). */
  fixed?: Uint8Array;
}

export class SimClient {
  private readonly worker: Worker;
  private snapshotListeners: ((s: Snapshot) => void)[] = [];
  private pending = new Map<string, ((v: unknown) => void)[]>();
  /** Latest snapshot metadata. Its depth/vel buffers are detached once returned to the worker. */
  latest: Snapshot | null = null;
  readonly ready: Promise<ReadyData>;
  private speed = 1;

  /** Start a new world, resume from save-game bytes, or run a staged scene (welcome panels). */
  constructor(start: ({ seed: number; size: number } | { bytes: ArrayBuffer } | { scene: SceneId }) & { speed?: number; duty?: number }) {
    this.worker = new Worker(workerBlobUrl ?? workerUrl, { type: 'module' });
    keepWorkerScript();
    SimClient.live++;
    this.ready = new Promise((resolve, reject) => {
      this.worker.onerror = (e) => reject(new Error(e.message));
      this.rejectReady = reject;
      this.worker.onmessage = (ev: MessageEvent<FromWorker>) => {
        const msg = ev.data;
        switch (msg.type) {
          case 'ready':
            resolve({ info: msg.info, terrain: msg.terrain, look: msg.look, plan: msg.plan, revealed: msg.revealed, fixed: msg.fixed });
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
          case 'history':
            this.resolve('history', msg.history);
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
    const duty = start.duty;
    if ('scene' in start) this.post({ type: 'scene', scene: start.scene, run: this.sceneRun, speed: this.speed, duty });
    else if ('bytes' in start) this.post({ type: 'load', bytes: start.bytes, speed: this.speed, duty }, [start.bytes]);
    else this.post({ type: 'init', seed: start.seed, size: start.size, speed: this.speed, duty });
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

  /**
   * Switch to (or restart) a staged scene. All scenes share one grid size, so
   * no new `ready` follows: the next snapshot carries the whole new state.
   */
  scene(id: SceneId, speed?: number): number {
    if (speed !== undefined) this.speed = speed;
    this.post({ type: 'scene', scene: id, run: ++this.sceneRun, speed });
    return this.sceneRun;
  }

  /** The latest scene run requested (snapshots carry it as `sceneRun`). */
  sceneRun = 0;

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

  /** The game's daily history (stats chart). */
  history(): Promise<HistoryData> {
    return this.request('history', { type: 'history' }) as Promise<HistoryData>;
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
    if (this.disposed) return;
    this.disposed = true;
    SimClient.live--;
    this.worker.terminate();
  }

  private disposed = false;
  /** Whether later workers start from the in-memory copy of the script (tests). */
  static get scriptKept(): boolean {
    return workerBlobUrl !== null;
  }

  /** Workers currently running (tests check that the welcome scenes clean up). */
  static live = 0;
}
