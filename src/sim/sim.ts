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
import { ErosionScratch, defaultGeoParams, erosionStep, newSedimentLedger, weatherStep, type GeoParams, type RowRange, type SedimentLedger } from './hydro/erosion';
import { TalusScratch, talusStep } from './hydro/talus';
import { PARAMS } from './params';
import { SpiritCrew, cancelPlans, planDike, planLevel, planTrench } from './plans/plans';
import { SOIL_PROPS, type World } from './world';

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
  /** Geomorphology (absent in saves from before M1b). */
  geo?: GeoState;
}

/** Erosion state that must survive save/load: the ledger and sparse per-cell accumulators. */
export interface GeoState {
  sedLedger: SedimentLedger;
  time: number;
  /** Pairs [cell, value] of non-zero entries. */
  bedAcc: number[];
  inflowConc: number[];
  loose: number[];
}

function sparse(a: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== 0) out.push(i, a[i]!);
  return out;
}

function unsparse(a: Float32Array, pairs: number[]): void {
  a.fill(0);
  for (let k = 0; k + 1 < pairs.length; k += 2) a[pairs[k]!] = pairs[k + 1]!;
}

/** Steps between soil-water/weather updates. */
const SOILWATER_EVERY = 4;
/** Steps between builder updates. */
const BUILD_EVERY = 10;
/** Steps between erosion/deposition passes (offset from soil-water). */
const EROSION_EVERY = 4;
/** Steps between talus passes. */
const TALUS_EVERY = 16;
/** Steps between weathering passes (four times a day). */
const WEATHER_EVERY = STEPS_PER_DAY / 4;
/** Steps between publishing slow terrain changes to the renderer. */
const TERRAIN_PUBLISH_EVERY = 30;

export class Simulation {
  readonly world: World;
  readonly rng: Rng;
  readonly weather: Weather;
  readonly ledger: Ledger = newLedger();
  readonly crew = new SpiritCrew();
  /** Sediment budget (m³). */
  readonly sedLedger: SedimentLedger = newSedimentLedger();
  /** Geomorphology tunables (a copy of PARAMS; tools and tests may change it). */
  readonly geo: GeoParams = defaultGeoParams();
  step = 0;

  private readonly scratch: FlowScratch;
  private readonly flowStats: FlowStats = { outflow: 0, maxDepth: 1, maxSpeed: 0, sedimentOut: 0 };
  private readonly erosionScratch: ErosionScratch;
  private readonly talusScratch: TalusScratch;
  /** Rows changed by erosion/talus since they were last published. */
  private readonly geoDirty: RowRange = { y0: Infinity, y1: -Infinity };

  // Dirty tracking for snapshots.
  private dirtyY0 = Infinity;
  private dirtyY1 = -Infinity;
  lookDirty = true;
  planDirty = true;

  /** Outflow accumulated over the current day, and the last full day's total. */
  private outflowToday = 0;
  outflowLastDay = 0;

  constructor(world: World, seed: number) {
    this.world = world;
    this.rng = new Rng(seed ^ 0x5eed);
    this.scratch = new FlowScratch(world.size);
    this.erosionScratch = new ErosionScratch(world.size);
    this.talusScratch = new TalusScratch(world.size);
    this.weather = new Weather(world, this.rng);
  }

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
    let sedOut = 0;
    for (let k = 0; k < n; k++) {
      flowStep(w, this.scratch, DEFAULT_FLOW_PARAMS, DT / n, fs);
      out += fs.outflow;
      sedOut += fs.sedimentOut ?? 0;
    }
    this.ledger.outflow += out;
    this.outflowToday += out;
    this.sedLedger.outflow += sedOut;

    // Geomorphology.
    const geo = this.geo;
    if (this.step % EROSION_EVERY === EROSION_EVERY / 2) {
      erosionStep(w, this.erosionScratch, EROSION_EVERY * DT, geo, this.sedLedger, this.geoDirty);
    }
    if (this.step % TALUS_EVERY === TALUS_EVERY - 1) {
      const frac = (geo.talusPerDay * geo.morfac * TALUS_EVERY) / STEPS_PER_DAY / PARAMS.morfac;
      talusStep(w, this.talusScratch, frac, geo, this.sedLedger, this.geoDirty, this.erosionScratch.loose);
    }
    if (this.step % WEATHER_EVERY === 1) {
      weatherStep(w, WEATHER_EVERY / STEPS_PER_DAY, geo, this.sedLedger, this.erosionScratch.loose);
    }
    if (this.step % TERRAIN_PUBLISH_EVERY === 0 && this.geoDirty.y1 >= this.geoDirty.y0) {
      if (this.geoDirty.y0 < this.dirtyY0) this.dirtyY0 = this.geoDirty.y0;
      if (this.geoDirty.y1 > this.dirtyY1) this.dirtyY1 = this.geoDirty.y1;
      this.geoDirty.y0 = Infinity;
      this.geoDirty.y1 = -Infinity;
    }

    if (this.step % BUILD_EVERY === 0 && this.crew.pending > 0) {
      const rate = (PARAMS.builderRatePerDay * BUILD_EVERY) / STEPS_PER_DAY;
      const loose = this.erosionScratch.loose;
      this.crew.work(w, rate, PARAMS.builderCells, (i) => {
        loose[i] = 1;
        this.markTerrainDirty(i);
        this.planDirty = true;
      });
    }

    this.step++;
    if (this.step % STEPS_PER_DAY === 0) {
      this.outflowLastDay = this.outflowToday;
      this.outflowToday = 0;
      this.weather.updateElevation();
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
      tileElevation: Array.from(this.weather.tileElevation),
      geo: {
        sedLedger: { ...this.sedLedger },
        time: this.erosionScratch.time,
        bedAcc: sparse(this.erosionScratch.bedAcc),
        inflowConc: sparse(this.erosionScratch.inflowConc),
        loose: sparse(this.erosionScratch.loose),
      },
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
    if (st.geo) {
      Object.assign(this.sedLedger, st.geo.sedLedger);
      this.erosionScratch.time = st.geo.time;
      unsparse(this.erosionScratch.bedAcc, st.geo.bedAcc);
      unsparse(this.erosionScratch.inflowConc, st.geo.inflowConc);
      unsparse(this.erosionScratch.loose, st.geo.loose);
    }
    this.lookDirty = true;
    this.planDirty = true;
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
    return `${this.step}:${(h >>> 0).toString(16)}`;
  }
}
