/**
 * Simulation orchestrator: owns the world and runs all subsystems at their
 * rates. Independent of workers and DOM, so it runs the same in Node tests.
 */
import { FIELD_BYTES, FIXED_BRUSH, FIXED_CANAL, FIXED_WALL, type Command, type SimTime } from '../shared/protocol';
import { Rng } from '../shared/rng';
import { timeAt, seaLevelTemperature } from './climate/calendar';
import { Weather, type WeatherState } from './climate/weather';
import { Climate, tileRainMap, type ClimateRunState } from './climate/climate';
import { CELL_AREA, DT, STEPS_PER_DAY, TILE } from './constants';
import { GroundwaterScratch, groundwaterStep } from './hydro/groundwater';
import { DEFAULT_FLOW_PARAMS, FlowScratch, flowStep, stableDt, type FlowStats } from './hydro/inertial';
import { FrozenSnow, newLedger, snowCoverByte, soilWaterStep, type Ledger } from './hydro/soilwater';
import { ErosionScratch, defaultGeoParams, erosionStep, overtopStep, newSedimentLedger, weatherStep, type GeoParams, type RowRange, type SedimentLedger } from './hydro/erosion';
import { TalusScratch, talusStep } from './hydro/talus';
import { PARAMS } from './params';
import { SpiritCrew, applyEarthwork, cancelPlans, keepsPlan, takenGround } from './plans/plans';
import { Brushwork } from './plans/brushwork';
import { Structures, type StructuresState } from './structures/structures';
import { Gatekeeper } from './structures/gatekeeper';
import { PEOPLE_TICK, PeopleSystem, type PeopleHost, type PeopleState } from './people/village';
import { CellFlag, LandUse, SOIL_PROPS, type World } from './world';
import { History, type HistoryState } from './history';
import { START_REVEAL, isRevealed, revealDisc, revealRadius } from './fog';
import { Achievements, type AchievementsState } from './achievements';
import { Ideas, type IdeasState } from './ideas';
import { Vegetation } from './vegetation';
import { ActiveSet } from './active';
import { PowerGrid, type PowerState } from './power/grid';

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
  /** Ideas for this valley (absent in older saves). */
  ideas?: IdeasState;
  /** River seasons and wet/dry years (absent in older saves). */
  climate?: ClimateRunState;
  /** The power grid (M6; absent in older saves). */
  power?: PowerState;
  /** Earth moved by the brushes and by scripted lines (m³; absent in older saves). */
  earthMoved?: { brush: number; script: number };
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
  /** Lining, weirs, sluice gates and water wheels. */
  readonly structures: Structures;
  /** Who opens and closes the gates (villagers, or the gates themselves as flood relief). */
  readonly gatekeeper: Gatekeeper;
  /** Turbines, poles and electric pumps (M6; power/grid.ts). */
  readonly power: PowerGrid;
  /** The sculpting brushes (plans/brushwork.ts): applied at once. */
  readonly brush: Brushwork;
  /** Ids of scripted strokes (shapeLine): negative, apart from the client's. */
  private scriptStroke = 0;
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
  /** Ideas for this valley (sim/ideas.ts): another observer, saved with the world. */
  readonly ideas = new Ideas();
  /** Living vegetation (daily growth and decline; sim/vegetation.ts). */
  readonly vegetation: Vegetation;
  /** Whether vegetation grows and declines (pure-physics tests may switch it off). */
  vegetationOn = true;
  /**
   * The tiles that are simulated (docs/ENDLESS.md §2): with the fog, the
   * revealed land plus a margin; otherwise all. Derived from `revealed` and
   * `fog` (recomputed at day boundaries and on load), so it is not saved.
   */
  readonly active: ActiveSet;
  /** Scratch for the snowpack on frozen land (soilwater.ts). */
  private readonly frozenSnow = new FrozenSnow();
  /** The fog setting the active set was last derived for. */
  private maskFog: boolean | null = null;
  /** Simulate every tile regardless of the fog (the worker's spin-up). */
  private unmasked = false;

  constructor(world: World, seed: number, opts: SimOptions = {}) {
    this.world = world;
    this.seed = seed;
    this.rng = new Rng(seed ^ 0x5eed);
    this.scratch = new FlowScratch(world.size);
    this.gwScratch = new GroundwaterScratch(world.size);
    this.erosionScratch = new ErosionScratch(world.size);
    this.talusScratch = new TalusScratch(world.size);
    this.active = new ActiveSet(world.width, world.height);
    this.weather = new Weather(world, this.rng);
    this.climate = new Climate(seed);
    if (opts.rain) this.setRainMap(tileRainMap(opts.rain, world.width, world.height, TILE));
    this.vegetation = new Vegetation(world);
    this.structures = new Structures(world);
    this.structures.allow = (i) => !this.fog || isRevealed(this.world, i);
    this.gatekeeper = new Gatekeeper(world, this.structures, () => this.time);
    this.power = new PowerGrid(world);
    this.power.allow = this.structures.allow;
    this.power.houses = () => this.people?.houses() ?? [];
    this.power.onVillageLight = (id, share) => this.people?.setLight(id, share);
    this.power.villages = () => this.people?.settlements.map((s) => ({ id: s.state.id, x: Math.round(s.state.x), y: Math.round(s.state.y) })) ?? [];
    if (opts.people) {
      this.people = new PeopleSystem(world, seed, opts.people.startX, opts.people.startY);
      this.fog = true;
      revealDisc(world, opts.people.startX, opts.people.startY, START_REVEAL);
    }
    this.updateActive();
    this.resetHistory();
    this.achievements = new Achievements(world.width, world.height);
    this.watchPeople();
    this.structures.onLined = (i) => this.achievements.touch(i);
    this.gatekeeper.onEvent = (e) => this.achievements.gateEvent(e, this.time.day);
    this.achievements.baseline(this);
    this.brush = new Brushwork(world, {
      fixed: (i) => this.isFixed(i),
      original: (i) => this.achievements.original(i),
      willChange: (i) => this.achievements.planned(this.world, [i]),
      changed: (i) => {
        // Sculpted earth is loose: it slumps and erodes readily.
        this.erosionScratch.loose[i] = 1;
        this.achievements.touch(i);
        this.markTerrainDirty(i);
      },
      cleared: (_i, lining) => {
        this.fieldsDirty = true;
        if (lining) this.structures.liningDirty = true;
      },
    });
  }

  /** Derive the active tiles from the revealed land (all tiles without fog). */
  updateActive(): void {
    this.maskFog = this.fog;
    if (this.fog && !this.unmasked) this.active.setFromRevealed(this.world.revealed);
    else this.active.setAll();
  }

  /**
   * Run `steps` steps on the whole map, ignoring the fog: the worker's
   * spin-up, so the frozen land outside the active set holds flowing rivers
   * and settled water when it becomes the boundary (and later, when it is
   * activated).
   */
  spinUp(steps: number): void {
    this.unmasked = true;
    this.updateActive();
    this.run(steps);
    this.unmasked = false;
    this.updateActive();
  }

  /** Use a per-tile rain factor for the live weather (saved with the climate). */
  setRainMap(map: readonly number[]): void {
    if (map.length !== this.weather.rainMap.length) return;
    this.weather.rainMap.set(map);
    this.climate.state.rainMap = map.slice();
  }

  /** Let the achievements hear of the villagers' harvests, catches and rebuilt houses. */
  private watchPeople(): void {
    if (!this.people) return;
    this.people.onEvent = (e, cell) => this.achievements.peopleEvent(e, cell, this.time.day, this);
    this.people.onGate = (gate, agent) => this.gatekeeper.arrived(gate, agent);
    this.people.poles = { site: (s, day, blocked) => this.power.poleSite(s, day, blocked), work: (id) => this.power.workPole(id) };
  }

  /** Clear the history and count from now (after the worker's spin-up, or for old saves). */
  resetHistory(): void {
    const f = this.people?.floods;
    this.history.reset(this.ledger.rain + this.ledger.snowfall, f?.cells ?? 0, f?.ruined ?? 0);
  }

  /** Record the calendar day that just ended. */
  private recordHistory(day: number): void {
    const p = this.people;
    const t = timeAt(this.step - STEPS_PER_DAY / 2);
    this.history.record({
      day,
      villages: p ? p.settlements.map((s) => s.state) : [],
      peak: p ? Math.max(p.peakPopulation, p.population) : 0,
      precipTotal: this.ledger.rain + this.ledger.snowfall,
      area: this.active.cells() * CELL_AREA,
      // The daily mean: the diurnal term vanishes at this time of day.
      temperature: seaLevelTemperature({ ...t, timeOfDay: 0.375 }),
      floodCells: p?.floods.cells ?? 0,
      ruined: p?.floods.ruined ?? 0,
      power: this.power.empty ? undefined : { kw: this.power.lastDay.produced / (STEPS_PER_DAY * DT) / 1000, lit: this.power.stats().houses },
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

  /** After the brushes moved ground (`before`: the bridges' footings): footbridges whose piles or banks it disturbed break. */
  private groundMoved(before: number[][] | undefined): void {
    const p = this.people;
    if (p && before && p.bridges.disturbed(before, this.time.day)) this.fieldsDirty = true;
    // Poles whose ground the brush moved fall; the villagers put them up again.
    this.power.groundCheck(this.time.day);
  }

  /**
   * Whether the brushes must leave cell i alone: houses (and mills, wells,
   * stores, ruins), jetties, structures and their works in progress (the
   * crew's plans), and land not yet revealed. Footbridges and power poles
   * do not stop the brush: ground moved under one breaks it
   * (Bridges.disturbed, PowerGrid.groundCheck), and the villagers rebuild
   * it if they still need it.
   */
  isFixed(i: number): boolean {
    const w = this.world;
    if (this.fixedGround(i, w.landuse[i]!) || (w.flags[i]! & CellFlag.Structure) !== 0 || !Number.isNaN(w.plan[i]!)) return true;
    return this.fog && !isRevealed(w, i);
  }

  /** Land use the brushes go round: buildings, and decks that are not footbridges (jetties). */
  private fixedGround(i: number, lu: number): boolean {
    if (keepsPlan(lu)) return false;
    return lu !== LandUse.Bridge || !(this.people?.bridges.onDeck(i) ?? false);
  }

  /**
   * The brushes' fixed cells for the client (Snapshot.fixed: FIXED_BRUSH;
   * fog is the client's own), and the cells the gate tool sees as a bank or
   * weir (FIXED_WALL) or a canal (FIXED_CANAL).
   */
  packFixed(out: Uint8Array): void {
    const w = this.world;
    const { landuse, flags, plan } = w;
    const wall = this.structures.gateGrid().wall;
    for (let i = 0; i < out.length; i++) {
      const f = flags[i]!;
      let v = this.fixedGround(i, landuse[i]!) || (f & CellFlag.Structure) !== 0 || !Number.isNaN(plan[i]!) ? FIXED_BRUSH : 0;
      if ((f & CellFlag.Fill) !== 0 && wall(i)) v |= FIXED_WALL;
      if ((f & CellFlag.Canal) !== 0) v |= FIXED_CANAL;
      out[i] = v;
    }
  }

  /**
   * Mark the cells structures stand on (CellFlag.Structure): weirs, gates'
   * passages, wheels and their heads, turbines and their penstock ends,
   * pumps (inlet, house, outlet); not the villagers' poles. Derived from the structure
   * lists, so it is redone after every command and on load.
   */
  syncStructureFlags(): void {
    const w = this.world;
    const f = w.flags;
    for (let i = 0; i < f.length; i++) f[i] = f[i]! & ~CellFlag.Structure;
    const mark = (i: number) => {
      if (i >= 0 && i < f.length) f[i] = f[i]! | CellFlag.Structure;
    };
    const at = (x: number, y: number) => {
      if (w.inBounds(x, y)) mark(w.idx(x, y));
    };
    const st = this.structures;
    for (const wr of st.weirs) wr.cells.forEach(mark);
    for (const g of st.gates) g.passage.forEach(mark);
    for (const wh of st.wheels) {
      mark(wh.cell);
      mark(wh.head);
    }
    const pw = this.power;
    for (const t of pw.turbines) {
      at(t.x, t.y);
      mark(t.a);
      mark(t.b);
    }
    for (const p of pw.pumps) {
      at(p.x, p.y);
      at(p.hx, p.hy);
      at(p.ox, p.oy);
    }
  }

  /** Fields, gardens and pastures on ground that is taken (plans.ts takenGround) go back to plain land (daily). */
  private clearTakenGround(): void {
    const w = this.world;
    const lu = w.landuse;
    for (let i = 0; i < lu.length; i++) {
      const u = lu[i]!;
      // (Yards stay: villagers line the banks by their own houses.)
      if (u !== LandUse.Field && u !== LandUse.Garden && u !== LandUse.Pasture) continue;
      if (!takenGround(w, i)) continue;
      lu[i] = LandUse.None;
      w.crop[i] = 0;
      this.fieldsDirty = true;
    }
  }

  /** The selection's Remove (ui/selection.ts). */
  private removeStructure(kind: string, id: number): void {
    const st = this.structures;
    let changed: number[] | null = null;
    if (kind === 'weir') {
      const wr = st.weirs.find((o) => o.id === id);
      if (!wr) return;
      const cells = new Set(wr.cells);
      changed = st.removeWeir(id);
      // Gates and turbines in the weir go with it.
      st.dismantle(cells);
      this.power.dismantle(cells);
    } else if (kind === 'gate') changed = st.removeGate(id);
    else if (kind === 'wheel') st.removeWheel(id);
    // (Poles are the villagers': they stay.)
    else if (kind !== 'pole') this.power.remove(id);
    if (changed?.length) {
      this.crew.enqueue(changed);
      this.planDirty = true;
    }
    this.lookDirty = true;
  }

  readonly seed: number;

  private readonly peopleHost: PeopleHost = {
    terrainChanged: (i) => {
      // Freshly dug or heaped soil is loose (slumps and erodes more easily).
      this.erosionScratch.loose[i] = 1;
      // Villagers building the player's plans: still the player's works.
      if (this.achievements.isPlanned(i)) this.achievements.touch(i);
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
    const act = this.active;
    if (this.maskFog !== this.fog) this.updateActive();
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
          active: act,
          frozen: this.frozenSnow,
        },
        this.ledger,
      );
    }

    // Surface flow, sub-stepped for stability in deep or fast water.
    const fs = this.flowStats;
    const n = Math.max(1, Math.ceil(DT / stableDt(fs.maxDepth, fs.maxSpeed)));
    let out = 0;
    let sedOut = 0;
    let edgeIn = 0;
    let sedIn = 0;
    for (let k = 0; k < n; k++) {
      flowStep(w, this.scratch, DEFAULT_FLOW_PARAMS, DT / n, fs, this.structures.walls, act);
      out += fs.outflow + fs.edgeOut!;
      sedOut += fs.sedimentOut! + fs.edgeSedOut!;
      edgeIn += fs.edgeIn!;
      sedIn += fs.edgeSedIn!;
    }
    // Water crossing the active edge counts as in- and outflow (ENDLESS.md §4.1).
    this.ledger.outflow += out;
    this.ledger.inflow += edgeIn;
    this.outflowToday += out;
    // Water wheels lift river water onto the bank (conserved: an internal transfer).
    if (this.structures.wheels.length) this.ledger.lifted = (this.ledger.lifted ?? 0) + this.structures.stepWheels();
    // Turbines and pumps move water across their walls and up their pipes (conserved too).
    this.power.step(this.time);
    this.sedLedger.outflow += sedOut;
    this.sedLedger.inflow += sedIn;

    // Geomorphology.
    const geo = this.geo;
    if (this.step % GROUNDWATER_EVERY === 2) {
      const gw = this.gwScratch;
      groundwaterStep(w, gw, undefined, act);
      this.ledger.inflow += gw.edgeIn * CELL_AREA;
      this.ledger.outflow += gw.edgeOut * CELL_AREA;
    }

    if (this.step % EROSION_EVERY === EROSION_EVERY / 2) {
      erosionStep(w, this.erosionScratch, EROSION_EVERY * DT, geo, this.sedLedger, this.geoDirty, act);
      overtopStep(w, this.erosionScratch, EROSION_EVERY * DT, geo, this.sedLedger, this.geoDirty, act);
    }
    if (this.step % TALUS_EVERY === TALUS_EVERY - 1) {
      const frac = (geo.talusPerDay * geo.morfac * TALUS_EVERY) / STEPS_PER_DAY / PARAMS.morfac;
      talusStep(w, this.talusScratch, frac, geo, this.sedLedger, this.geoDirty, this.erosionScratch.loose, act);
    }
    if (this.step % WEATHER_EVERY === 1) {
      weatherStep(w, WEATHER_EVERY / STEPS_PER_DAY, geo, this.sedLedger, this.erosionScratch.loose, act);
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
    // Sluice gates: the leaves move, and villagers (or the gates themselves) decide.
    this.gatekeeper.tick(this.step, people);
    // Stone work (lining, gates) is always done by the spirit crew.
    if (this.step % BUILD_EVERY === 0 && this.structures.pending) {
      this.structures.crewWork((PARAMS.liningPerDay * BUILD_EVERY) / STEPS_PER_DAY, PARAMS.builderCells);
    }
    if (this.step % BUILD_EVERY === 0 && this.power.pending) this.power.crewWork((PARAMS.liningPerDay * BUILD_EVERY) / STEPS_PER_DAY, this.time.day);
    // Floods knock power poles down (checked with the houses and bridges).
    if (this.step % 30 === 0 && this.power.poles.length) this.power.floods(this.time.day);

    this.step++;
    const today = timeAt(this.step).day;
    if (today !== timeAt(this.step - 1).day) {
      if (this.vegetationOn) {
        const t = timeAt(this.step - STEPS_PER_DAY / 2);
        this.vegetation.daily(seaLevelTemperature({ ...t, timeOfDay: 0.375 }), today - 1, act);
        this.lookDirty = true;
      }
      this.power.daily();
      // Sluice gates' sills follow a bed dug or scoured deeper beside them.
      const sills = this.structures.followSills();
      if (sills.length) {
        this.crew.enqueue(sills);
        this.planDirty = true;
        this.syncStructureFlags();
      }
      // The villagers' grid: fallen poles, poles in the way, and the next lines.
      this.power.groundCheck(today);
      this.power.planGrid(today);
      this.clearTakenGround();
      this.recordHistory(today - 1);
      this.achievements.daily(this, today - 1);
      this.ideas.daily(this, today - 1);
    }
    this.achievements.update(this, this.step, today);
    if (this.step % STEPS_PER_DAY === 0) {
      this.outflowLastDay = this.outflowToday;
      this.outflowToday = 0;
      this.weather.updateElevation();
      this.updateReveal();
      // The active land follows the revealed land (activation is a cheap tile scan).
      this.updateActive();
    }
    if (this.step % 30 === 0) this.lookDirty = true;
  }

  run(steps: number): void {
    for (let s = 0; s < steps; s++) this.advance();
  }

  command(cmd: Command): void {
    this.applyCommand(cmd);
    this.syncStructureFlags();
  }

  private applyCommand(cmd: Command): void {
    const w = this.world;
    // Footbridges the brushes may disturb (their footings' heights before the stroke).
    const footings = cmd.type === 'sculpt' || cmd.type === 'shapeLine' ? this.people?.bridges.footings() : undefined;
    switch (cmd.type) {
      case 'sculpt': {
        const r = this.brush.sculpt(cmd.tool, cmd.radius, cmd.stroke, cmd.samples);
        if (cmd.seq !== undefined && cmd.seq > this.brush.seq) this.brush.seq = cmd.seq;
        if (r) {
          // The whole brush's rows: the client predicted them, the sim's word is final.
          if (r.y0 < this.dirtyY0) this.dirtyY0 = r.y0;
          if (r.y1 > this.dirtyY1) this.dirtyY1 = r.y1;
          this.lookDirty = true;
          this.achievements.sculpted(w, this.time.day);
          this.groundMoved(footings);
        }
        break;
      }
      case 'shapeLine':
        if (this.brush.shapeLine(cmd.tool, cmd.points, cmd.width, cmd.amount ?? 1, --this.scriptStroke, cmd.floor).length) {
          this.lookDirty = true;
          this.achievements.sculpted(w, this.time.day);
          this.groundMoved(footings);
        }
        break;
      case 'planLining':
        if (this.structures.planLining(cmd.points, cmd.width).length) this.lookDirty = true;
        break;
      case 'planWeir': {
        const changed = this.structures.planWeir(cmd.points, cmd.width, cmd.height);
        this.achievements.planned(w, changed);
        this.crew.enqueue(changed);
        this.lookDirty = true;
        if (changed.length) this.planDirty = true;
        break;
      }
      case 'editWeir': {
        if (cmd.points.length < 2) break;
        const changed = this.structures.editWeir(cmd.id, cmd.points[0]!, cmd.points[cmd.points.length - 1]!, cmd.top);
        if (!changed) break;
        this.crew.enqueue(changed);
        this.lookDirty = true;
        this.planDirty = true;
        break;
      }
      case 'removeStructure':
        this.removeStructure(cmd.kind, cmd.id);
        break;
      case 'placeGate': {
        const r = this.structures.placeGate(cmd.points);
        if (r) {
          this.achievements.planned(w, r.cells);
          this.crew.enqueue(r.cells);
          this.lookDirty = true;
          this.planDirty = true;
        }
        break;
      }
      case 'placeWheel':
        if (this.structures.placeWheel(cmd.points)) this.lookDirty = true;
        break;
      case 'placeTurbine':
        if (cmd.points.length) this.power.placeTurbine(cmd.points[0]!);
        break;
      case 'placePoles':
        this.power.placePoles(cmd.points);
        break;
      case 'placePump':
        this.power.placePump(cmd.points);
        break;
      case 'toggleGate':
        this.structures.toggleGate(cmd.id, cmd.open);
        break;
      case 'cancelPlan': {
        // The Remove brush: plans go; weirs, gates and wheels in reach, built or not, are taken
        // down as the selection's Remove does (the crew lowers a weir, plugs a gate's opening);
        // turbines and pumps too (not the villagers' poles).
        const hit = this.structures.near(cmd.x, cmd.y, cmd.radius);
        // The crew's plans to take something down stay (the brush may still be moving over it).
        const keep = [...this.structures.restoringNow()].map((c) => [c, w.plan[c]!] as const);
        const gone = cancelPlans(w, cmd.x, cmd.y, cmd.radius).filter((c) => !this.structures.restoring.has(c));
        for (const [c, v] of keep) w.plan[c] = v;
        this.achievements.cancelled(gone);
        if (gone.length) this.planDirty = true;
        for (const h of hit) this.removeStructure(h.kind, h.id);
        if (this.structures.cancel(cmd.x, cmd.y, cmd.radius)) this.lookDirty = true;
        this.power.cancel(cmd.x, cmd.y, cmd.radius);
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
      out[o + 3] = snowCoverByte(snow[i]!);
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
      ideas: this.ideas.getState(),
      climate: this.climate.getState(),
      power: this.power.empty ? undefined : this.power.getState(),
      earthMoved: { ...this.brush.moved },
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
    if (st.power) this.power.setState(st.power);
    this.finishOldPlans();
    this.brush.reset();
    Object.assign(this.brush.moved, st.earthMoved ?? { brush: 0, script: 0 });
    this.syncStructureFlags();
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
    this.updateActive();
    if (st.history) this.history.setState(st.history);
    else this.resetHistory();
    if (st.achievements) this.achievements.setState(st.achievements, this.world);
    else this.achievements.catchUp(this, Math.max(0, this.time.day - 1));
    this.ideas.setState(st.ideas, (id) => this.achievements.hasEarned(id));
    this.lookDirty = true;
    this.planDirty = true;
  }

  /**
   * Saves from before the brushes may hold the player's trench, dike and
   * level plans: there is no crew for earthworks any more, so they are done
   * at once (the player asked for them). The crew's structure work (weirs,
   * gates, taking them down) stays planned.
   */
  private finishOldPlans(): void {
    const w = this.world;
    const st = this.structures;
    const owned = new Set<number>(st.restoring);
    for (const wr of st.weirs) for (const c of wr.cells) owned.add(c);
    for (const g of st.gates) {
      for (const c of g.passage) owned.add(c);
      for (const c of g.cells) owned.add(c);
    }
    const loose = this.erosionScratch.loose;
    for (let i = 0; i < w.size; i++) {
      const p = w.plan[i]!;
      if (Number.isNaN(p) || owned.has(i)) continue;
      applyEarthwork(w, i, p - w.terrain(i));
      w.plan[i] = NaN;
      loose[i] = 1;
      this.achievements.touch(i);
      this.markTerrainDirty(i);
    }
  }

  /** Returns and clears whether land use/crops changed. */
  takeFieldsDirty(): boolean {
    const d = this.fieldsDirty;
    this.fieldsDirty = false;
    return d;
  }

  /**
   * Pack land use, crop stage, crop stress and field crop (FIELD_BYTES per
   * cell, see Snapshot.fields). On desire paths the crop byte carries the
   * footfall (traffic) instead, for the width and wear the terrain shader draws.
   */
  packFields(out: Uint8Array): void {
    const { landuse, crop, traffic, size } = this.world;
    const p = this.people;
    const season = this.time.season;
    for (let i = 0; i < size; i++) {
      out[FIELD_BYTES * i] = landuse[i]!;
      out[FIELD_BYTES * i + 1] = landuse[i] === LandUse.Path ? traffic[i]! : crop[i]!;
      out[FIELD_BYTES * i + 2] = p ? p.stressAt(i, season) : 0;
      out[FIELD_BYTES * i + 3] = p ? p.fieldCropAt(i) : 0;
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
    if (!this.power.empty) {
      const json = JSON.stringify(this.power.getState());
      for (let i = 0; i < json.length; i++) h = Math.imul(h ^ json.charCodeAt(i), 0x01000193);
    }
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
