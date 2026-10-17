/// <reference lib="webworker" />
/**
 * Simulation worker: owns the Simulation, paces it in real time, and posts
 * snapshots using a small pool of transferable buffers. When no buffer set
 * is free (the main thread hasn't acked), the snapshot is skipped.
 */
import { VEL_SCALE, type FromWorker, type Snapshot, type ToWorker } from '../shared/protocol';
import { CELL, STEPS_PER_DAY, STEPS_PER_SECOND_1X } from './constants';
import { loadGame, saveGame } from './persist';
import { Simulation } from './sim';
import { generateWorld } from './worldgen';

declare const self: DedicatedWorkerGlobalScope;

const SNAPSHOT_INTERVAL_MS = 100;
/** Max time per work slice before yielding to the message loop. */
const SLICE_MS = 8;
/** Steps run at startup so that rivers are flowing when the player arrives. */
const SPINUP_STEPS = 600;

interface BufferSet {
  id: number;
  depth: Float32Array;
  vel: Int8Array;
}

let sim: Simulation | null = null;
/** Generator info stored alongside saves. */
let meta: Record<string, unknown> = {};
let speed = 1;
let pool: BufferSet[] = [];
let accumulator = 0;
let lastTick = 0;
let lastSnapshot = 0;
let msPerStep = 1;
let achieved = 0;
let ticking = false;
/** Fraction of one core the sim may use (lower on phones to save battery and heat). */
let duty = 1;

const channel = new MessageChannel();
channel.port1.onmessage = () => tick();

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

function log(level: 'info' | 'warn' | 'error', message: string): void {
  post({ type: 'log', level, message });
}

function init(seed: number, size: number): void {
  const t0 = performance.now();
  const gen = generateWorld({ seed, size });
  const t1 = performance.now();
  const fresh = new Simulation(gen.world, seed, { people: { startX: gen.startX, startY: gen.startY } });
  fresh.run(SPINUP_STEPS);
  fresh.step = 0;
  const t2 = performance.now();
  log('info', `worldgen ${(t1 - t0).toFixed(0)} ms, spin-up ${(t2 - t1).toFixed(0)} ms`);
  start(fresh, { startX: gen.startX, startY: gen.startY, riverScale: gen.riverScale });
}

async function load(bytes: ArrayBuffer): Promise<void> {
  const { sim: loaded, meta: m } = await loadGame(bytes);
  start(loaded, m);
}

/** Begin running `s`, announcing it to the main thread. */
function start(s: Simulation, m: Record<string, unknown>): void {
  sim = s;
  meta = m;
  const w = s.world;
  pool = [0, 1, 2].map((id) => ({ id, depth: new Float32Array(w.size), vel: new Int8Array(w.size * 2) }));
  const terrain = new Float32Array(w.size);
  s.terrainRows(0, w.height, terrain);
  const look = new Uint8Array(w.size * 4);
  s.computeLook(look);
  const plan = w.plan.slice();
  const revealed = s.fog ? w.revealed.slice() : undefined;
  s.revealDirty = false;
  s.takeDirtyRows();
  s.lookDirty = false;
  s.planDirty = false;
  post(
    {
      type: 'ready',
      info: {
        seed: w.seed,
        width: w.width,
        height: w.height,
        cellSize: CELL,
        startX: Number(m.startX ?? w.width / 2),
        startY: Number(m.startY ?? w.height / 2),
      },
      terrain,
      look,
      plan,
      revealed,
    },
    revealed ? [terrain.buffer, look.buffer, plan.buffer, revealed.buffer] : [terrain.buffer, look.buffer, plan.buffer],
  );
  lastTick = performance.now();
  schedule(0);
}

function schedule(delayMs: number): void {
  if (ticking) return;
  ticking = true;
  if (delayMs <= 0) channel.port2.postMessage(0);
  else setTimeout(() => channel.port2.postMessage(0), delayMs);
}

function tick(): void {
  ticking = false;
  if (!sim) return;
  const now = performance.now();
  const elapsed = Math.min(0.25, (now - lastTick) / 1000);
  lastTick = now;
  accumulator += elapsed * STEPS_PER_SECOND_1X * speed;
  // Don't build up an unbounded backlog when we can't keep up.
  accumulator = Math.min(accumulator, STEPS_PER_SECOND_1X * Math.max(speed, 1) * 0.25);

  let ran = 0;
  const sliceStart = performance.now();
  while (accumulator >= 1 && performance.now() - sliceStart < SLICE_MS) {
    sim.advance();
    accumulator -= 1;
    ran++;
  }
  if (ran > 0) {
    const per = (performance.now() - sliceStart) / ran;
    msPerStep = msPerStep * 0.9 + per * 0.1;
  }
  // Achieved speed, smoothed: steps per second relative to 1×.
  const inst = elapsed > 0 ? ran / elapsed / STEPS_PER_SECOND_1X : 0;
  achieved = achieved * 0.95 + inst * 0.05;

  if (now - lastSnapshot >= SNAPSHOT_INTERVAL_MS) {
    if (sendSnapshot()) lastSnapshot = now;
  }
  // CPU cap: after working for w ms, rest for w·(1/duty − 1) ms.
  const worked = performance.now() - sliceStart;
  const rest = duty < 1 ? worked * (1 / duty - 1) : 0;
  schedule(accumulator >= 1 ? rest : Math.max(5, rest));
}

function sendSnapshot(): boolean {
  if (!sim) return false;
  const set = pool.pop();
  if (!set) return false;
  const w = sim.world;
  set.depth.set(w.water);
  const { velX, velY, size } = w;
  const vel = set.vel;
  const k = 127 / VEL_SCALE;
  for (let i = 0; i < size; i++) {
    vel[2 * i] = Math.max(-127, Math.min(127, Math.round(velX[i]! * k)));
    vel[2 * i + 1] = Math.max(-127, Math.min(127, Math.round(velY[i]! * k)));
  }
  const transfer: Transferable[] = [set.depth.buffer, set.vel.buffer];
  const snap: Snapshot = {
    time: sim.time,
    climate: sim.weather.climateState(sim.time),
    stats: {
      speedRequested: speed,
      speedAchieved: achieved,
      msPerStep,
      surfaceWater: sim.surfaceVolume(),
      outflowPerDay: sim.outflowLastDay,
    },
    poolId: set.id,
    depth: set.depth,
    vel: set.vel,
  };
  const rows = sim.takeDirtyRows();
  if (rows) {
    const data = new Float32Array((rows.y1 - rows.y0) * w.width);
    sim.terrainRows(rows.y0, rows.y1, data);
    snap.terrain = { ...rows, data };
    transfer.push(data.buffer);
  }
  if (sim.lookDirty) {
    const look = new Uint8Array(w.size * 4);
    sim.computeLook(look);
    snap.look = look;
    sim.lookDirty = false;
    transfer.push(look.buffer);
  }
  if (sim.people) {
    const ent = sim.people.entities(speed);
    snap.entities = ent;
    transfer.push(ent.id.buffer, ent.info.buffer, ent.pos.buffer);
    if (sim.people.buildingsDirty) {
      snap.buildings = sim.people.buildings.map(({ id, kind, x, y, rot, progress }) => ({ id, kind, x, y, rot, progress }));
      sim.people.buildingsDirty = false;
    }
    const vs = sim.people.settlements.map(({ state: v }) => ({
      x: v.x,
      y: v.y,
      population: v.population,
      houses: v.houses,
      food: v.food,
      wellbeing: v.wellbeing,
    }));
    if (vs.length) {
      const pop = vs.reduce((n, v) => n + v.population, 0);
      snap.stats.villages = vs;
      snap.stats.village = {
        x: vs[0]!.x,
        y: vs[0]!.y,
        population: pop,
        houses: vs.reduce((n, v) => n + v.houses, 0),
        food: vs.reduce((n, v) => n + v.food, 0),
        wellbeing: pop > 0 ? vs.reduce((n, v) => n + v.wellbeing * v.population, 0) / pop : vs[0]!.wellbeing,
        count: vs.length,
      };
    }
    if (sim.takeFieldsDirty()) {
      const f = new Uint8Array(w.size * 2);
      sim.packFields(f);
      snap.fields = f;
      transfer.push(f.buffer);
    }
  }
  if (sim.fog && sim.revealDirty) {
    snap.revealed = w.revealed.slice();
    sim.revealDirty = false;
    transfer.push(snap.revealed.buffer);
  }
  if (sim.planDirty) {
    snap.plan = w.plan.slice();
    sim.planDirty = false;
    transfer.push(snap.plan.buffer);
  }
  post({ type: 'snapshot', ...snap }, transfer);
  return true;
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'init':
        if (msg.speed !== undefined) speed = msg.speed;
        if (msg.duty !== undefined) duty = msg.duty;
        init(msg.seed, msg.size);
        break;
      case 'setSpeed':
        speed = Math.max(0, msg.speed);
        accumulator = 0;
        break;
      case 'command':
        sim?.command(msg.command);
        break;
      case 'ack':
        pool.push({ id: msg.poolId, depth: msg.depth, vel: msg.vel });
        break;
      case 'runDays':
        if (sim) {
          sim.run(Math.round(msg.days * STEPS_PER_DAY));
          post({ type: 'ranDays', days: msg.days });
        }
        break;
      case 'hash':
        if (sim) post({ type: 'hash', hash: sim.stateHash() });
        break;
      case 'load':
        if (msg.speed !== undefined) speed = msg.speed;
        if (msg.duty !== undefined) duty = msg.duty;
        load(msg.bytes).catch((e) => post({ type: 'loadFailed', message: String(e) }));
        break;
      case 'save':
        if (sim) {
          void saveGame(sim, meta).then((bytes) => post({ type: 'saved', bytes }, [bytes]));
        }
        break;
    }
  } catch (e) {
    log('error', String(e instanceof Error ? (e.stack ?? e.message) : e));
  }
};
