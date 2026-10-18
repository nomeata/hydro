/**
 * Simulation orchestrator: owns the world and runs all subsystems at their
 * rates. Independent of workers and DOM, so it runs the same in Node tests.
 */
import type { Command, SimTime } from '../shared/protocol';
import { Rng } from '../shared/rng';
import { timeAt, seaLevelTemperature } from './climate/calendar';
import { Weather, type WeatherState } from './climate/weather';
import { Climate, tileRainMap, type ClimateRunState } from './climate/climate';
import { CELL_AREA, DT, STEPS_PER_DAY, TILE } from './constants';
import { GroundwaterScratch, groundwaterStep } from './hydro/groundwater';
import { DEFAULT_FLOW_PARAMS, FlowScratch, flowStep, stableDt, type FlowStats } from './hydro/inertial';
import { newLedger, soilWaterStep, type Ledger } from './hydro/soilwater';
import { ErosionScratch, defaultGeoParams, erosionStep, newSedimentLedger, weatherStep, type GeoParams, type RowRange, type SedimentLedger } from './hydro/erosion';
import { TalusScratch, talusStep } from './hydro/talus';
import { PARAMS } from './params';
import { SpiritCrew, cancelPlans, planDike, planLevel, planTrench } from './plans/plans';
import { Structures, type StructuresState } from './structures/structures';
import { PEOPLE_TICK, PeopleSystem, type PeopleHost, type PeopleState } from './people/village';
import { CellFlag, SOIL_PROPS, type World } from './world';
import { History, type HistoryState } from './history';
import { START_REVEAL, isRevealed, revealDisc, revealRadius } from './fog';
import { Achievements, type AchievementsState } from './achievements';
import { Vegetation } from './vegetation';

export interface SimOptions {
  /** Enable villages; founding happens near the start point. */
  people?: { startX: number; startY: number };
  /** The generation climate's rain factor per cell (GenResult.rain): the live weather follows it. */
  rain?: Float32Array;
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
  /** Water structures (absent in saves from before M4a). */
  structures?: StructuresState;
  /** Geomorphology (absent in saves from before M1b). */
  geo?: GeoState;
  /** Daily history for the stats chart (absent in older saves). */
  history?: HistoryState;
  /** Achievements (absent in older saves). */
  achievements?: AchievementsState;
  /** River seasons and wet/dry years (absent in older saves). */
  climate?: ClimateRunState;
}

/** Erosion state that must survive save/load: the ledger and sparse per-cell accumulators. */
export interface GeoState {
  sedLedger: SedimentLedger;
  time: number;
  /** Pairs [cell, value] of non-zero entries. */
  bedAcc: number[];
  inflowConc: number[];
  loose: number[];
  /** Last pass's transport rates (read again by the next pass's fast path). */
  transport?: number[];
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

function pathLength(points: readonly (readonly [number, number])[]): number {
  let l = 0;
  for (let k = 0; k + 1 < points.length; k++) l += Math.hypot(points[k + 1]![0] - points[k]![0], points[k + 1]![1] - points[k]![1]);
  return l;
}
/** Steps between builder updates. */
const BUILD_EVERY = 10;
/** Steps between erosion/deposition passes (offset from soil-water). */
const EROSION_EVERY = 8;
/** Steps between lateral groundwater updates (one game hour). */
const GROUNDWATER_EVERY = STEPS_PER_DAY / 24;
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
  /** River seasons and wet/dry years (climate/climate.ts). */
  readonly climate: Climate;
  readonly ledger: Ledger = newLedger();
  readonly crew = new SpiritCrew();
  /** Lining, weirs and sluice gates. */
  readonly structures: Structures;
  /** Sediment budget (m³). */
  readonly sedLedger: SedimentLedger = newSedimentLedger();
  /** Geomorphology tunables (a copy of PARAMS; tools and tests may change it). */
  readonly geo: GeoParams = defaultGeoParams();
  step = 0;

  private readonly scratch: FlowScratch;
  private readonly gwScratch: GroundwaterScratch;
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

  /** Villages and their people (absent in pure-physics tests). */
  people: PeopleSystem | null = null;
  private fieldsDirty = true;
  /**
   * Fog of war (docs/PEOPLE.md §6): on with villages. Plans are only placed
   * on revealed land; `revealDirty` asks the worker to send `revealed`.
   */
  fog = false;
  revealDirty = true;
  /** Daily history (stats bar chart), recorded at each calendar day boundary. */
  readonly history = new History();
  /** Achievements: an observer of the world, saved with it. */
  readonly achievements: Achievements;
  /** Living vegetation (daily growth and decline; sim/vegetation.ts). */
  readonly vegetation: Vegetation;
  /** Whether vegetation grows and declines (pure-physics tests may switch it off). */
  vegetationOn = true;

  constructor(world: World, seed: number, opts: SimOptions = {}) {
    this.world = world;
    this.seed = seed;
    this.rng = new Rng(seed ^ 0x5eed);
    this.scratch = new FlowScratch(world.size);
    this.gwScratch = new GroundwaterScratch(world.size);
    this.erosionScratch = new ErosionScratch(world.size);
    this.talusScratch = new TalusScratch(world.size);
    this.weather = new Weather(world, this.rng);
    this.climate = new Climate(seed);
    if (opts.rain) this.setRainMap(tileRainMap(opts.rain, world.width, world.height, TILE));
    this.vegetation = new Vegetation(world);
    this.structures = new Structures(world);
    this.structures.allow = (i) => !this.fog || isRevealed(this.world, i);
    if (opts.people) {
      this.people = new PeopleSystem(world, seed, opts.people.startX, opts.people.startY);
      this.fog = true;
      revealDisc(world, opts.people.startX, opts.people.startY, START_REVEAL);
    }
    this.resetHistory();
    this.achievements = new Achievements(world.width, world.height);
    this.watchPeople();
    this.structures.onLined = (i) => this.achievements.touch(i);
    this.achievements.baseline(this);
  }

  /** Use a per-tile rain factor for the live weather (saved with the climate). */
  setRainMap(map: readonly number[]): void {
    if (map.length !== this.weather.rainMap.length) return;
    this.weather.rainMap.set(map);
    this.climate.state.rainMap = map.slice();
  }

  /** Let the achievements hear of the villagers' harvests, catches and rebuilt houses. */
  private watchPeople(): void {
    if (this.people) this.people.onEvent = (e, cell) => this.achievements.peopleEvent(e, cell, this.time.day);
  }

  /** Clear the history and count from now (after the worker's spin-up, or for old saves). */
  resetHistory(): void {
    const f = this.people?.floods;
    this.history.reset(this.ledger.rain + this.ledger.snowfall, f?.cells ?? 0, f?.ruined ?? 0);
  }

  /** Record the calendar day that just ended. */
  private recordHistory(day: number): void {
    const p = this.people;
    const w = this.world;
    const t = timeAt(this.step - STEPS_PER_DAY / 2);
    this.history.record({
      day,
      villages: p ? p.settlements.map((s) => s.state) : [],
      peak: p ? Math.max(p.peakPopulation, p.population) : 0,
      precipTotal: this.ledger.rain + this.ledger.snowfall,
      area: w.size * CELL_AREA,
      // The daily mean: the diurnal term vanishes at this time of day.
      temperature: seaLevelTemperature({ ...t, timeOfDay: 0.375 }),
      floodCells: p?.floods.cells ?? 0,
      ruined: p?.floods.ruined ?? 0,
    });
  }

  /** Grow the known land around every settlement (daily). */
  private updateReveal(): void {
    const p = this.people;
    if (!p) return;
    for (const s of p.settlements) {
      if (revealDisc(this.world, s.state.x, s.state.y, revealRadius(s.state.population))) this.revealDirty = true;
    }
  }

  /** Drop plan cells on unrevealed land (fog of war); returns the cells kept. */
  private onlyRevealed(changed: number[]): number[] {
    if (!this.fog) return changed;
    const w = this.world;
    const kept: number[] = [];
    for (const i of changed) {
      if (isRevealed(w, i)) kept.push(i);
      else w.plan[i] = NaN;
    }
    return kept;
  }

  readonly seed: number;

  private readonly peopleHost: PeopleHost = {
    terrainChanged: (i) => {
      // Freshly dug or heaped soil is loose (slumps and erodes more easily).
      this.erosionScratch.loose[i] = 1;
      this.markTerrainDirty(i);
    },
    planChanged: () => {
      this.planDirty = true;
    },
    planCells: () => this.crew.cells,
    lined: (i) => {
      // Villagers' own stone work; a planned lining there is done too.
      this.achievements.lined(this.time.day);
      this.structures.lining.delete(i);
      this.structures.liningDirty = true;
    },
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
      this.climate.update(t, this.ledger.rain + this.ledger.snowfall);
      this.weather.frontFactor = this.climate.frontFactor(t);
      this.weather.advance(SOILWATER_EVERY, t, this.rng);
      soilWaterStep(
        w,
        {
          tileRain: this.weather.tileRain,
          tileElevation: this.weather.tileElevation,
          tilesWide: this.weather.tw,
          seaLevelTemp: seaLevelTemperature(t),
          steps: SOILWATER_EVERY,
          inflowScale: this.climate.inflowFactor(t),
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
      flowStep(w, this.scratch, DEFAULT_FLOW_PARAMS, DT / n, fs, this.structures.walls);
      out += fs.outflow;
      sedOut += fs.sedimentOut ?? 0;
    }
    this.ledger.outflow += out;
    this.outflowToday += out;
    this.sedLedger.outflow += sedOut;

    // Geomorphology.
    const geo = this.geo;
    if (this.step % GROUNDWATER_EVERY === 2) groundwaterStep(w, this.gwScratch);

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

    const people = this.people;
    if (people && this.step % PEOPLE_TICK === 0) {
      people.tick(this.step, this.time, this.peopleHost);
      if (this.step % 60 === 0) this.fieldsDirty = true;
    }

    if (this.step % BUILD_EVERY === 0 && this.crew.pending > 0) {
      const rate = (PARAMS.builderRatePerDay * BUILD_EVERY) / STEPS_PER_DAY;
      // The spirit crew leaves plans to a village once it has enough builders.
      const skip = people && PARAMS.villagersBuildPlans ? (i: number) => people.handledByVillage(i) : undefined;
      const loose = this.erosionScratch.loose;
      this.crew.work(
        w,
        rate,
        PARAMS.builderCells,
        (i) => {
          loose[i] = 1;
          this.achievements.touch(i);
          this.markTerrainDirty(i);
          this.planDirty = true;
        },
        skip,
      );
    }
    // Stone work (lining, gates) is always done by the spirit crew.
    if (this.step % BUILD_EVERY === 0 && this.structures.pending) {
      this.structures.crewWork((PARAMS.liningPerDay * BUILD_EVERY) / STEPS_PER_DAY, PARAMS.builderCells);
    }

    this.step++;
    const today = timeAt(this.step).day;
    if (today !== timeAt(this.step - 1).day) {
      if (this.vegetationOn) {
        const t = timeAt(this.step - STEPS_PER_DAY / 2);
        this.vegetation.daily(seaLevelTemperature({ ...t, timeOfDay: 0.375 }), today - 1);
        this.lookDirty = true;
      }
      this.recordHistory(today - 1);
      this.achievements.daily(this, today - 1);
    }
    this.achievements.update(this, this.step, today);
    if (this.step % STEPS_PER_DAY === 0) {
      this.outflowLastDay = this.outflowToday;
      this.outflowToday = 0;
      this.weather.updateElevation();
      this.updateReveal();
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
        const changed = this.onlyRevealed(planTrench(w, cmd.points, cmd.width, cmd.depth));
        this.achievements.stroke('trench', changed, pathLength(cmd.points));
        // Remember the player's canals (villagers line those near home).
        for (const i of changed) if (w.plan[i]! < w.terrain(i)) w.flags[i]! |= CellFlag.Canal;
        this.crew.enqueue(changed);
        if (changed.length) this.planDirty = true;
        break;
      }
      case 'planDike': {
        const changed = this.onlyRevealed(planDike(w, cmd.points, cmd.width, cmd.height));
        this.achievements.stroke('dike', changed, pathLength(cmd.points));
        this.crew.enqueue(changed);
        if (changed.length) this.planDirty = true;
        break;
      }
      case 'planLevel': {
        const changed = this.onlyRevealed(planLevel(w, cmd.points, cmd.width));
        this.achievements.stroke('level', changed, pathLength(cmd.points));
        this.crew.enqueue(changed);
        if (changed.length) this.planDirty = true;
        break;
      }
      case 'planLining':
        if (this.structures.planLining(cmd.points, cmd.width).length) this.lookDirty = true;
        break;
      case 'planWeir': {
        const changed = this.structures.planWeir(cmd.points, cmd.width, cmd.height);
        this.crew.enqueue(changed);
        this.lookDirty = true;
        if (changed.length) this.planDirty = true;
        break;
      }
      case 'placeGate': {
        const r = this.structures.placeGate(cmd.points, Math.max(1, Math.min(3, cmd.width)), cmd.height);
        if (r) {
          this.crew.enqueue(r.cells);
          this.lookDirty = true;
          this.planDirty = true;
        }
        break;
      }
      case 'toggleGate': {
        const g = this.structures.gates.find((g) => g.id === cmd.id);
        if (this.structures.toggleGate(cmd.id, cmd.open) && g?.open && g.progress >= 1) this.achievements.gateOpened(this.time.day);
        break;
      }
      case 'cancelPlan': {
        const gone = cancelPlans(w, cmd.x, cmd.y, cmd.radius);
        this.achievements.cancelled(gone);
        if (gone.length) this.planDirty = true;
        this.structures.cancel(cmd.x, cmd.y, cmd.radius);
        break;
      }
      case 'debugVillage':
        this.people?.debugVillage(cmd.index, cmd);
        this.fieldsDirty = true;
        break;
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
      structures: this.structures.getState(),
      geo: {
        sedLedger: { ...this.sedLedger },
        time: this.erosionScratch.time,
        bedAcc: sparse(this.erosionScratch.bedAcc),
        transport: sparse(this.erosionScratch.transport),
        inflowConc: sparse(this.erosionScratch.inflowConc),
        loose: sparse(this.erosionScratch.loose),
      },
      history: this.history.getState(),
      achievements: this.achievements.getState(),
      climate: this.climate.getState(),
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
      this.watchPeople();
      this.fog = true;
      // Saves from before the fog of war: reveal the start and every village.
      if (!this.world.revealed.some((v) => v > 0)) {
        revealDisc(this.world, st.people.startX, st.people.startY, START_REVEAL);
        this.updateReveal();
      }
      this.revealDirty = true;
    }
    this.fieldsDirty = true;
    if (st.structures) this.structures.setState(st.structures);
    if (st.geo) {
      Object.assign(this.sedLedger, st.geo.sedLedger);
      this.erosionScratch.time = st.geo.time;
      unsparse(this.erosionScratch.bedAcc, st.geo.bedAcc);
      unsparse(this.erosionScratch.inflowConc, st.geo.inflowConc);
      unsparse(this.erosionScratch.loose, st.geo.loose);
      if (st.geo.transport) unsparse(this.erosionScratch.transport, st.geo.transport);
    }
    if (st.climate) {
      this.climate.setState(st.climate);
      if (st.climate.rainMap && st.climate.rainMap.length === this.weather.rainMap.length) this.weather.rainMap.set(st.climate.rainMap);
      else this.weather.rainMap.fill(1);
    } else {
      // Older saves: an ordinary year from now on, uniform rain.
      this.climate.state.year = this.time.year;
    }
    if (st.history) this.history.setState(st.history);
    else this.resetHistory();
    if (st.achievements) this.achievements.setState(st.achievements, this.world);
    else this.achievements.catchUp(this, Math.max(0, this.time.day - 1));
    this.lookDirty = true;
    this.planDirty = true;
  }

  /** Returns and clears whether land use/crops changed. */
  takeFieldsDirty(): boolean {
    const d = this.fieldsDirty;
    this.fieldsDirty = false;
    return d;
  }

  /** Pack land use, crop stage and crop stress (FIELD_BYTES per cell, see Snapshot.fields). */
  packFields(out: Uint8Array): void {
    const { landuse, crop, size } = this.world;
    const p = this.people;
    const season = this.time.season;
    for (let i = 0; i < size; i++) {
      out[3 * i] = landuse[i]!;
      out[3 * i + 1] = crop[i]!;
      out[3 * i + 2] = p ? p.stressAt(i, season) : 0;
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
    mix(w.flags);
    mix(w.vegetation);
    mix(w.traffic);
    {
      const json = JSON.stringify(this.structures.getState());
      for (let i = 0; i < json.length; i++) h = Math.imul(h ^ json.charCodeAt(i), 0x01000193);
    }
    mix(w.revealed);
    {
      const json = JSON.stringify(this.climate.state);
      for (let i = 0; i < json.length; i++) h = Math.imul(h ^ json.charCodeAt(i), 0x01000193);
    }
    if (this.people) {
      const json = JSON.stringify(this.people.getState());
      for (let i = 0; i < json.length; i++) h = Math.imul(h ^ json.charCodeAt(i), 0x01000193);
    }
    return `${this.step}:${(h >>> 0).toString(16)}`;
  }
}
