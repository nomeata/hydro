/**
 * Simulation orchestrator: owns the world and runs all subsystems at their
 * rates. Independent of workers and DOM, so it runs the same in Node tests.
 */
import type { Command, SimTime } from '../shared/protocol';
import { Rng } from '../shared/rng';
import { timeAt, seaLevelTemperature } from './climate/calendar';
import { Weather, type WeatherState } from './climate/weather';
import { CELL_AREA, DT, STEPS_PER_DAY } from './constants';
import { DEFAULT_FLOW_PARAMS, FlowScratch, flowStep, stableDt, type FlowStats } from './hydro/inertial';
import { newLedger, soilWaterStep, type Ledger } from './hydro/soilwater';
import { PARAMS } from './params';
import { SpiritCrew, cancelPlans, planDike, planLevel, planTrench } from './plans/plans';
import { PEOPLE_TICK, PeopleSystem, type PeopleHost, type PeopleState } from './people/village';
import { SOIL_PROPS, type World } from './world';

export interface SimOptions {
  /** Enable villages; founding happens near the start point. */
  people?: { startX: number; startY: number };
}

export interface SimState {
  step: number;
  rng: number[];
  weather: WeatherState;
  ledger: Ledger;
  flowStats: FlowStats;
  outflowToday: number;
  outflowLastDay: number;
  crewQueue: number[];
  tileElevation: number[];
  people?: PeopleState;
}

/** Steps between soil-water/weather updates. */
const SOILWATER_EVERY = 4;
/** Steps between builder updates. */
const BUILD_EVERY = 10;

export class Simulation {
  readonly world: World;
  readonly rng: Rng;
  readonly weather: Weather;
  readonly ledger: Ledger = newLedger();
  readonly crew = new SpiritCrew();
  step = 0;

  private readonly scratch: FlowScratch;
  private readonly flowStats: FlowStats = { outflow: 0, maxDepth: 1, maxSpeed: 0 };

  // Dirty tracking for snapshots.
  private dirtyY0 = Infinity;
  private dirtyY1 = -Infinity;
  lookDirty = true;
  planDirty = true;

  /** Outflow accumulated over the current day, and the last full day's total. */
  private outflowToday = 0;
  outflowLastDay = 0;

  /** Villages and their people (absent in pure-physics tests). */
  people: PeopleSystem | null = null;
  private fieldsDirty = true;

  constructor(world: World, seed: number, opts: SimOptions = {}) {
    this.world = world;
    this.seed = seed;
    this.rng = new Rng(seed ^ 0x5eed);
    this.scratch = new FlowScratch(world.size);
    this.weather = new Weather(world, this.rng);
    if (opts.people) this.people = new PeopleSystem(world, seed, opts.people.startX, opts.people.startY);
  }

  readonly seed: number;

  private readonly peopleHost: PeopleHost = {
    terrainChanged: (i) => this.markTerrainDirty(i),
    planChanged: () => {
      this.planDirty = true;
    },
    planCells: () => this.crew.cells,
    waterUsed: (m3) => {
      this.ledger.evaporation += m3;
    },
  };

  get time(): SimTime {
    return timeAt(this.step);
  }

  /** Advance one hydro step (DT hydraulic seconds). */
  advance(): void {
    const w = this.world;
    if (this.step % SOILWATER_EVERY === 0) {
      const t = this.time;
      this.weather.advance(SOILWATER_EVERY, t, this.rng);
      soilWaterStep(
        w,
        {
          tileRain: this.weather.tileRain,
          tileElevation: this.weather.tileElevation,
          tilesWide: this.weather.tw,
          seaLevelTemp: seaLevelTemperature(t),
          steps: SOILWATER_EVERY,
        },
        this.ledger,
      );
    }

    // Surface flow, sub-stepped for stability in deep or fast water.
    const fs = this.flowStats;
    const n = Math.max(1, Math.ceil(DT / stableDt(fs.maxDepth, fs.maxSpeed)));
    let out = 0;
    for (let k = 0; k < n; k++) {
      flowStep(w, this.scratch, DEFAULT_FLOW_PARAMS, DT / n, fs);
      out += fs.outflow;
    }
    this.ledger.outflow += out;
    this.outflowToday += out;

    const people = this.people;
    if (people && this.step % PEOPLE_TICK === 0) {
      people.tick(this.step, this.time, this.peopleHost);
      if (this.step % 60 === 0) this.fieldsDirty = true;
    }

    if (this.step % BUILD_EVERY === 0 && this.crew.pending > 0) {
      const rate = (PARAMS.builderRatePerDay * BUILD_EVERY) / STEPS_PER_DAY;
      // The spirit crew leaves plans to a village once it has enough builders.
      const skip = people ? (i: number) => people.handledByVillage(i) : undefined;
      this.crew.work(
        w,
        rate,
        PARAMS.builderCells,
        (i) => {
          this.markTerrainDirty(i);
          this.planDirty = true;
        },
        skip,
      );
    }

    this.step++;
    if (this.step % STEPS_PER_DAY === 0) {
      this.outflowLastDay = this.outflowToday;
      this.outflowToday = 0;
    }
    if (this.step % 30 === 0) this.lookDirty = true;
  }

  run(steps: number): void {
    for (let s = 0; s < steps; s++) this.advance();
  }

  command(cmd: Command): void {
    const w = this.world;
    switch (cmd.type) {
      case 'planTrench': {
        const changed = planTrench(w, cmd.points, cmd.width, cmd.depth);
        this.crew.enqueue(changed);
        if (changed.length) this.planDirty = true;
        break;
      }
      case 'planDike': {
        const changed = planDike(w, cmd.points, cmd.width, cmd.height);
        this.crew.enqueue(changed);
        if (changed.length) this.planDirty = true;
        break;
      }
      case 'planLevel': {
        const changed = planLevel(w, cmd.points, cmd.width);
        this.crew.enqueue(changed);
        if (changed.length) this.planDirty = true;
        break;
      }
      case 'cancelPlan': {
        if (cancelPlans(w, cmd.x, cmd.y, cmd.radius).length) this.planDirty = true;
        break;
      }
      case 'debugWater': {
        const r = cmd.radius;
        for (let y = Math.max(0, Math.floor(cmd.y - r)); y <= Math.min(w.height - 1, Math.ceil(cmd.y + r)); y++)
          for (let x = Math.max(0, Math.floor(cmd.x - r)); x <= Math.min(w.width - 1, Math.ceil(cmd.x + r)); x++)
            if ((x - cmd.x) ** 2 + (y - cmd.y) ** 2 <= r * r) w.water[w.idx(x, y)]! += cmd.depth;
        break;
      }
    }
  }

  markTerrainDirty(i: number): void {
    const y = (i / this.world.width) | 0;
    if (y < this.dirtyY0) this.dirtyY0 = y;
    if (y > this.dirtyY1) this.dirtyY1 = y;
  }

  /** Returns and clears the dirty terrain row range [y0, y1), or null. */
  takeDirtyRows(): { y0: number; y1: number } | null {
    if (this.dirtyY1 < this.dirtyY0) return null;
    const r = { y0: this.dirtyY0, y1: this.dirtyY1 + 1 };
    this.dirtyY0 = Infinity;
    this.dirtyY1 = -Infinity;
    return r;
  }

  /** Fill terrain heights for rows [y0, y1) into `out`. */
  terrainRows(y0: number, y1: number, out: Float32Array): void {
    const { width: W, bedrock, soil } = this.world;
    for (let i = y0 * W, k = 0; i < y1 * W; i++, k++) out[k] = bedrock[i]! + soil[i]!;
  }

  /** Pack the per-cell ground look (see protocol.ts). */
  computeLook(out: Uint8Array): void {
    const { size, soilType, soil, ground, vegetation, snow } = this.world;
    for (let i = 0; i < size; i++) {
      const st = soilType[i]!;
      const cap = soil[i]! * SOIL_PROPS[st]!.porosity;
      const o = i * 4;
      out[o] = st;
      out[o + 1] = cap > 0 ? Math.min(255, (ground[i]! / cap) * 255) : 0;
      out[o + 2] = Math.min(255, vegetation[i]! * 255);
      out[o + 3] = Math.min(255, snow[i]! * 2550); // full white at 10 cm SWE
    }
  }

  surfaceVolume(): number {
    let s = 0;
    const { water, size } = this.world;
    for (let i = 0; i < size; i++) s += water[i]!;
    return s * CELL_AREA;
  }

  /** Non-field state needed to resume exactly (see persist.ts). */
  getState(): SimState {
    return {
      step: this.step,
      rng: this.rng.getState(),
      weather: structuredClone(this.weather.state),
      ledger: { ...this.ledger },
      flowStats: { ...this.flowStats },
      outflowToday: this.outflowToday,
      outflowLastDay: this.outflowLastDay,
      crewQueue: this.crew.getQueue(),
      people: this.people?.getState(),
      tileElevation: Array.from(this.weather.tileElevation),
    };
  }

  setState(st: SimState): void {
    this.step = st.step;
    this.rng.setState(st.rng);
    this.weather.state = structuredClone(st.weather);
    this.weather.tileElevation.set(st.tileElevation);
    Object.assign(this.ledger, st.ledger);
    Object.assign(this.flowStats, st.flowStats);
    this.outflowToday = st.outflowToday;
    this.outflowLastDay = st.outflowLastDay;
    this.crew.setQueue(st.crewQueue);
    if (st.people) {
      this.people ??= new PeopleSystem(this.world, this.seed, st.people.startX, st.people.startY);
      this.people.setState(st.people);
    }
    this.fieldsDirty = true;
    this.lookDirty = true;
    this.planDirty = true;
  }

  /** Returns and clears whether land use/crops changed. */
  takeFieldsDirty(): boolean {
    const d = this.fieldsDirty;
    this.fieldsDirty = false;
    return d;
  }

  /** Pack land use and crop stage (2 bytes per cell). */
  packFields(out: Uint8Array): void {
    const { landuse, crop, size } = this.world;
    for (let i = 0; i < size; i++) {
      out[2 * i] = landuse[i]!;
      out[2 * i + 1] = crop[i]!;
    }
  }

  /** Hash of the persistent state, for determinism tests. */
  stateHash(): string {
    let h = 0x811c9dc5;
    const mix = (arr: ArrayLike<number> & { buffer: ArrayBufferLike; byteOffset: number; byteLength: number }) => {
      const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
      for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193);
    };
    const w = this.world;
    mix(w.bedrock);
    mix(w.soil);
    mix(w.water);
    mix(w.ground);
    mix(w.snow);
    mix(w.sediment);
    mix(w.landuse);
    mix(w.crop);
    if (this.people) {
      const json = JSON.stringify(this.people.getState());
      for (let i = 0; i < json.length; i++) h = Math.imul(h ^ json.charCodeAt(i), 0x01000193);
    }
    return `${this.step}:${(h >>> 0).toString(16)}`;
  }
}
