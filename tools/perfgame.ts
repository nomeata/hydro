/**
 * Worker CPU profile of a realistic game (docs/ARCHITECTURE.md §3.8).
 *
 *   npx tsx tools/perfgame.ts make [--seed 3] [--size 256] [--days 120] [--out out/perf-s3-256.hydro]
 *   npx tsx tools/perfgame.ts prof <save.hydro> [--days 4] [--speed 1] [--json out.json]
 *
 * `make` plays a new game with the playtest's "good" bot (canal, drain,
 * dikes, weir + canal; tools unlocked) and puts a turbine into its weir once
 * built, so the villagers run a grid, then saves it.
 *
 * `prof` loads a save and runs it as the worker does: Simulation.advance()
 * plus a snapshot every 100 ms of game time at the given speed (every 2
 * steps at 1×, every 20 at 10×). It reports ms per game second (20 steps)
 * at that speed, split into phases (timed by wrapping the subsystems'
 * methods), and the worst single steps and snapshots.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { FIELD_BYTES, VEL_SCALE } from '../src/shared/protocol';
import { STEPS_PER_DAY, STEPS_PER_SECOND_1X } from '../src/sim/constants';
import { newGame } from '../src/sim/newgame';
import { loadGame, saveGame } from '../src/sim/persist';
import type { Simulation } from '../src/sim/sim';
import { snowPiles } from '../src/sim/people/village';
import { makeBot } from './playtest/bots';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1]! : d;
};

async function make(): Promise<void> {
  const seed = Number(opt('seed', '3'));
  const size = Number(opt('size', '256'));
  const days = Number(opt('days', '120'));
  const out = opt('out', `out/perf-s${seed}-${size}.hydro`);
  const { sim } = newGame(seed, size);
  const bot = makeBot('good', { ignoreUnlocks: true, budget: 12000 });
  for (let d = 0; d < days; d++) {
    if (d >= 16 && (d - 16) % 12 === 0) {
      for (const a of bot.check(sim, d)) {
        for (const c of a.commands) sim.command(c);
        console.log(`day ${d}: ${a.note}`);
      }
    }
    if (d % 6 === 0 && sim.power.turbines.length === 0) {
      for (const wr of sim.structures.weirs) {
        if (sim.power.turbines.length) break;
        for (const c of wr.cells) {
          sim.command({ type: 'placeTurbine', points: [[c % size, Math.floor(c / size)]] });
          if (sim.power.turbines.length) {
            console.log(`day ${d}: turbine at ${c % size},${Math.floor(c / size)}`);
            break;
          }
        }
      }
    }
    sim.run(STEPS_PER_DAY);
    if (d % 12 === 11) console.log(`day ${d + 1}: pop ${sim.people?.population} villages ${sim.people?.settlements.length} weirs ${sim.structures.weirs.length} turbines ${sim.power.turbines.length} poles ${sim.power.poles.length}`);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, new Uint8Array(await saveGame(sim, {})));
  console.log(`saved ${out}`);
}

/**
 * The clock: process CPU time by default (less disturbed by other load in a
 * shared container), or wall time with `--clock wall`.
 */
const clock: () => number =
  opt('clock', 'cpu') === 'wall'
    ? () => performance.now()
    : () => {
        const u = process.cpuUsage();
        return (u.user + u.system) / 1000;
      };

/** Timers per phase. */
class Timers {
  readonly ms = new Map<string, number>();
  readonly worst = new Map<string, number>();
  readonly calls = new Map<string, number>();
  add(name: string, dt: number): void {
    this.ms.set(name, (this.ms.get(name) ?? 0) + dt);
    this.calls.set(name, (this.calls.get(name) ?? 0) + 1);
    if (dt > (this.worst.get(name) ?? 0)) this.worst.set(name, dt);
  }
  /** Wrap obj[key] (a method) so its time is booked under `name` (exclusive of nested wrapped calls). */
  wrap(obj: object, key: string, name: string): void {
    const o = obj as Record<string, (...a: unknown[]) => unknown>;
    const f = o[key];
    if (typeof f !== 'function') return;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    o[key] = function (this: unknown, ...a: unknown[]) {
      const t0 = clock();
      self.depth.push(0);
      try {
        return f.apply(this, a);
      } finally {
        const inner = self.depth.pop()!;
        const dt = clock() - t0;
        self.add(name, dt - inner);
        if (self.depth.length) self.depth[self.depth.length - 1]! += dt;
      }
    };
  }
  depth: number[] = [];
}

/** The worker's snapshot packing (sim/worker.ts sendSnapshot), without posting. */
export function packSnapshot(sim: Simulation, speed: number, bufs: { depth: Float32Array; vel: Int8Array }, t: Timers): void {
  const w = sim.world;
  let t0 = clock();
  bufs.depth.set(w.water);
  const { velX, velY, size } = w;
  const k = 127 / VEL_SCALE;
  const vel = bufs.vel;
  for (let i = 0; i < size; i++) {
    vel[2 * i] = Math.max(-127, Math.min(127, Math.round(velX[i]! * k)));
    vel[2 * i + 1] = Math.max(-127, Math.min(127, Math.round(velY[i]! * k)));
  }
  sim.weather.climateState(sim.time);
  sim.surfaceVolume();
  let t1 = clock();
  t.add('snap: depth+vel', t1 - t0);
  t0 = t1;
  const rows = sim.takeDirtyRows();
  if (rows) {
    const data = new Float32Array((rows.y1 - rows.y0) * w.width);
    sim.terrainRows(rows.y0, rows.y1, data);
  }
  if (sim.lookDirty) {
    const look = new Uint8Array(w.size * 4);
    sim.computeLook(look);
    sim.lookDirty = false;
    if (sim.people) snowPiles(w, sim.people.snowBanks);
  }
  t1 = clock();
  t.add('snap: terrain+look', t1 - t0);
  t0 = t1;
  if (sim.people) {
    sim.people.entities(speed);
    if (sim.people.buildingsDirty) {
      sim.people.buildingInfo();
      sim.people.buildingsDirty = false;
    }
    sim.people.settlements.forEach(({ state: v }) => sim.people!.fishersOf(v.id));
    t1 = clock();
    t.add('snap: entities', t1 - t0);
    t0 = t1;
    if (sim.takeFieldsDirty()) {
      const f = new Uint8Array(w.size * FIELD_BYTES);
      sim.packFields(f);
    }
    t1 = clock();
    t.add('snap: fields', t1 - t0);
    t0 = t1;
  }
  if (!sim.power.empty) sim.power.stats();
  if (sim.power.dirty) {
    sim.power.info();
    sim.power.dirty = false;
  }
  const st = sim.structures;
  const people = sim.people;
  let structs = false;
  if (st.structuresDirty || people?.jettyDirty || people?.bridges.dirty) {
    structs = true;
    if (people) [...st.info(), ...people.jettyInfo()];
    else st.info();
    st.structuresDirty = false;
    if (people) {
      people.jettyDirty = false;
      people.bridges.dirty = false;
    }
  }
  if (st.liningDirty || people?.quayDirty) {
    const lining = new Uint8Array(w.size);
    st.packLining(lining, people?.quay, people?.liningWorn());
    if (people) people.quayDirty = false;
    st.liningDirty = false;
  }
  if (sim.fog && sim.revealDirty) {
    w.revealed.slice();
    sim.revealDirty = false;
  }
  if (sim.planDirty || structs) {
    const fixed = new Uint8Array(w.size);
    sim.packFixed(fixed);
  }
  if (sim.planDirty) {
    w.plan.slice();
    sim.planDirty = false;
  }
  if (sim.achievements.dirty) sim.achievements.take();
  if (sim.ideas.dirty) sim.ideas.take();
  t.add('snap: other', clock() - t0);
}

async function prof(file: string): Promise<void> {
  const days = Number(opt('days', '4'));
  const speed = Number(opt('speed', '1'));
  const b = readFileSync(file);
  const { sim } = await loadGame(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const t = new Timers();
  const p = sim.people;
  // Subsystems (exclusive times; the rest of advance() is "kernels").
  if (p) {
    t.wrap(p, 'tick', 'people.tick');
    const names = ['daily', 'rebuildReserved', 'rebuildDitchCells', 'updateMoisture', 'updateFloodMemory', 'growCrops', 'updateFishCapacity', 'growFish', 'tendWells', 'tendMill', 'updateSafety', 'syncPopulation', 'syncChildren', 'planHouses', 'planWell', 'planMill', 'planWorks', 'planDitch', 'planWoods', 'assignJobs', 'manageLand', 'judgeGrowth', 'tendCamp', 'surveyLand', 'considerFounding', 'tendWear', 'updateQuays', 'tendRuins', 'trimSnowBanks', 'meltFloodedBanks', 'floodHouses', 'updateMills', 'updateAgent', 'moveCarts'];
    for (const k of names) t.wrap(p, k, `people.${k}`);
    t.wrap(p.herds, 'tick', 'herds.tick');
    t.wrap(p.herds, 'daily', 'herds.daily');
    t.wrap(p.bridges, 'flood', 'bridges.flood');
  }
  t.wrap(sim.power, 'step', 'power.step');
  t.wrap(sim.power, 'planGrid', 'power.planGrid');
  t.wrap(sim.power, 'daily', 'power.daily');
  t.wrap(sim.power, 'groundCheck', 'power.groundCheck');
  t.wrap(sim.power, 'floods', 'power.floods');
  t.wrap(sim.gatekeeper, 'tick', 'gatekeeper.tick');
  t.wrap(sim.structures, 'stepWheels', 'structures.stepWheels');
  t.wrap(sim.structures, 'followSills', 'structures.followSills');
  t.wrap(sim.vegetation, 'daily', 'vegetation.daily');
  t.wrap(sim.achievements, 'daily', 'achievements.daily');
  t.wrap(sim.achievements, 'update', 'achievements.update');
  t.wrap(sim.ideas, 'daily', 'ideas.daily');
  t.wrap(sim.history, 'record', 'history.record');
  t.wrap(sim, 'clearTakenGround', 'sim.clearTakenGround');
  t.wrap(sim, 'updateActive', 'sim.updateActive');
  t.wrap(sim.weather, 'advance', 'weather.advance');
  t.wrap(sim.crew, 'work', 'crew.work');
  const steps = days * STEPS_PER_DAY;
  const snapEvery = Math.max(1, Math.round((STEPS_PER_SECOND_1X * speed) / 10));
  const bufs = { depth: new Float32Array(sim.world.size), vel: new Int8Array(sim.world.size * 2) };
  const stepMs: number[] = [];
  const snapMs: number[] = [];
  const T0 = clock();
  let adv = 0;
  for (let s = 0; s < steps; s++) {
    const a = clock();
    t.depth.push(0);
    sim.advance();
    const inner = t.depth.pop()!;
    const dt = clock() - a;
    adv += dt;
    t.add('kernels (advance rest)', dt - inner);
    stepMs.push(dt);
    if (s % snapEvery === snapEvery - 1) {
      const c = clock();
      packSnapshot(sim, speed, bufs, t);
      snapMs.push(clock() - c);
    }
  }
  const total = clock() - T0;
  const gameSeconds = steps / (STEPS_PER_SECOND_1X * speed);
  const perGs = (x: number) => x / gameSeconds;
  console.log(`${file}: ${sim.world.width}² year ${sim.time.year} day ${sim.time.day} pop ${p?.population} (${sim.active.stats()}), ${days} days at ${speed}×`);
  console.log(`total ${perGs(total).toFixed(1)} ms per game second (advance ${perGs(adv).toFixed(1)}, snapshots ${perGs(total - adv).toFixed(1)}); mean step ${(adv / steps).toFixed(2)} ms`);
  const sorted = [...stepMs].sort((x, y) => y - x);
  console.log(`worst steps: ${sorted.slice(0, 6).map((x) => x.toFixed(1)).join(', ')} ms; p99 ${sorted[Math.floor(steps / 100)]!.toFixed(1)}; worst snapshot ${Math.max(...snapMs).toFixed(1)} ms`);
  const rowsOut = [...t.ms.entries()].sort((x, y) => y[1] - x[1]);
  for (const [k, v] of rowsOut) console.log(`  ${k.padEnd(28)} ${perGs(v).toFixed(2).padStart(7)} ms/gs  worst ${t.worst.get(k)!.toFixed(1).padStart(6)} ms  calls ${t.calls.get(k)}`);
  const json = opt('json', '');
  if (json) writeFileSync(json, JSON.stringify({ file, speed, perGs: perGs(total), adv: perGs(adv), worst: sorted.slice(0, 10), phases: Object.fromEntries(rowsOut.map(([k, v]) => [k, { perGs: perGs(v), worst: t.worst.get(k) }])) }, null, 1));
  console.log(`final hash ${sim.stateHash()}`);
}

if (args[0] === 'make') await make();
else if (args[0] === 'prof') await prof(args[1]!);
else console.log('usage: perfgame.ts make|prof …');
