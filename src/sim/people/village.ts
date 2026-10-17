/**
 * The people system (docs/PEOPLE.md, phase M3-α "first village"):
 * founding, houses, job quotas, fields and crops, builders that realise the
 * player's plans, and the agents doing all of it. Land grows crops, agents
 * collect them, the settlement only decides (see §2 of the design).
 */
import { CarryKind, EntityAnim, FISH_BLOCK, STRESS_WET, type SimTime, type StructureInfo } from '../../shared/protocol';
import { Rng } from '../../shared/rng';
import { DAYS_PER_SEASON, DAYS_PER_YEAR, STEPS_PER_DAY } from '../constants';
import { REVEALED } from '../fog';
import { PARAMS } from '../params';
import { applyEarthwork } from '../plans/plans';
import { CellFlag, LandUse, SOIL_PROPS, type World } from '../world';
import { Job, SiteKind, Task, packEntities, walk, type Agent, type Animal } from './agents';
import { updateDesirePaths } from './desire';
import { Herds, type HerdHome } from './herds';
import { PathFinder } from './path';
import { ECONOMY, Settlement, type SettlementState } from './settlement';
import { WORKS, chooseJetty, markQuays, standCell, surveyLining } from './works';

/** Hydro steps between agent updates. */
export const PEOPLE_TICK = 2;
/** Founding happens this many steps into a new game. */
const FOUND_AFTER = STEPS_PER_DAY / 3;
/** How far (cells) a settlement works: fields, houses, plans. */
export const REACH = 40;
const FIELD_RADIUS = 18;
const FIELDS_PER_FARMER = 6;
const CROP_RIPE = 230;
/** Food (person-days) per harvested cell at fertility 1 and good moisture. */
const YIELD = 34;
/** Earth moved per builder visit (m). */
const DIG_PER_VISIT = 0.5;
/** House construction progress per builder visit. */
const BUILD_PER_VISIT = 0.12;
/** Jetty construction progress per builder visit. */
const JETTY_PER_VISIT = 0.2;
export { FISH_BLOCK };
/** Fish stock (person-days of food) per calm, deep water cell at capacity. */
const FISH_PER_CELL = 8;
/** Logistic growth rate of fish per day. */
const FISH_GROWTH = 0.06;
/** Food landed by one fishing session at full stock (person-days). */
const CATCH = 5;
/** Water drawn by a growing field per day (m). */
const FIELD_DRAW = 0.004;
/** Children playing per prosperous village at most (PEOPLE.md §7). */
export const MAX_CHILDREN = 4;
/**
 * Woodcutters (M3-δ): a small share of bigger villages fells trees at the
 * forest edge near home (never by the water) and carries the logs to the
 * woodpile by the store.
 */
export const WOOD = {
  /** Villages smaller than this have no woodcutter. */
  minPeople: 10,
  /** Share of the people, and most woodcutters per village. */
  share: 0.05,
  max: 3,
  /** Woodcutters stop when the pile holds this many logs. */
  enough: 8,
  /** Vegetation a felled tree leaves (stump and grass), and the least a cell must have to be felled. */
  felled: 0.18,
  minForest: 0.6,
  /** Forest within this many cells of water (rivers, lakes) is never cut. */
  waterMargin: 5,
  /** Forest edge cells kept on the list per village. */
  sites: 12,
};
/** Herders (M3-δ): an outing at pasture lasts this many steps; they rest this long at home between outings. */
export const HERDING = {
  outing: 420,
  rest: 180,
  /** Milk per cow per outing (person-days); sheep count half. Winter: the herd stays in and gives less. */
  dairy: 0.5,
  winterDairy: 0.5,
  /** The herder leads at the herd's pace. */
  leadSpeed: 0.6,
};

/** Children run this much faster than adults walk; struggling villagers dawdle. */
const CHILD_SPEED = 1.7;
const TIRED_SPEED = 0.6;


/**
 * How crops respond to field moisture (docs/PEOPLE.md §3.1): nothing grows
 * below `dry`, growth ramps up to full at `moist`, and waterlogged soil
 * (≥ `soggy`) gives `soggyGrowth`. Exported so tools can tune it.
 */
/** Capillary wetting from nearby water: max · exp(−d / reach), d in cells. */
export const CAPILLARY = { max: 0.8, reach: 2.5 };

export const CROP_MOISTURE = { dry: 0.15, moist: 0.35, soggy: 0.9, soggyGrowth: 0.4 };

/** Crop growth factor 0..1 for a field moisture. */
export function cropGrowth(m: number): number {
  const c = CROP_MOISTURE;
  return m < c.dry ? 0 : m < c.moist ? (m - c.dry) / (c.moist - c.dry) : m < c.soggy ? 1 : c.soggyGrowth;
}

/**
 * Visible stress of a field cell (docs/PEOPLE.md §7), mirroring the growth
 * factor in `growCrops`: 0 healthy (or nothing growing), 1..127 how dry
 * (127 = too dry to grow), 128..255 how waterlogged (255 = under water).
 */
export function cropStress(crop: number, moisture: number, water: number, growing: boolean): number {
  if (crop <= 0) return 0;
  if (water > 0.05) return 255;
  if (!growing || crop >= 255) return 0;
  const c = CROP_MOISTURE;
  if (moisture < c.moist) return Math.max(1, Math.round(127 * Math.min(1, (c.moist - moisture) / (c.moist - c.dry))));
  if (moisture >= c.soggy) return STRESS_WET + Math.round(127 * Math.min(1, 0.5 + (moisture - c.soggy) * 5));
  return 0;
}

/**
 * Founding of further villages (docs/PEOPLE.md §4). Attractiveness is
 * computed per ATTRACT_BLOCK² block every `everyDays`; when the best block
 * is attractive enough and the existing villages are big (or one is
 * crowded), a migrant family walks in from the fog edge and founds a
 * village there. Exported so tests can tweak it.
 */
export const FOUNDING = {
  everyDays: 4,
  /** Minimum days between two foundings. */
  interval: DAYS_PER_YEAR,
  /** Total population of all villages that makes people look for new land. */
  minPopulation: 25,
  /** A single village this big without free houses also sends people out. */
  crowdedPopulation: 18,
  /** Minimum distance (cells) to every other settlement. */
  minSpacing: 26,
  /**
   * Block attractiveness (0..~1.15) needed, both now and at the end of last
   * summer (migrants judge land at its worst; docs/GAMEPLAY.md §4.3 P6).
   */
  minScore: 0.6,
  /** Day of the year of the end-of-summer survey. */
  summerDay: 22,
  /** Food (person-days) the founders bring. */
  food: 300,
};
export const ATTRACT_BLOCK = 8;
/** Flood memory forgotten after a dry spring (of 255; docs/GAMEPLAY.md §4.3 P3). */
export const FLOOD_FORGET = 120;

export interface Building {
  id: number;
  kind: 'house' | 'store' | 'ruin';
  settlement: number;
  x: number;
  y: number;
  rot: number;
  /** 0..1 construction progress. */
  progress: number;
}

/** A ready-made village (PeopleSystem.stage). Coordinates are cells. */
export interface StagedVillage {
  /** The store, at the village centre. */
  x: number;
  y: number;
  food: number;
  /** Houses; progress < 1 is still being built (default 1). */
  houses: { x: number; y: number; progress?: number; rot?: number }[];
  /** Rectangles of field cells (inclusive) with their crop stage 0..255. */
  fields: { x0: number; y0: number; x1: number; y1: number; crop: number }[];
  /** People; `fishing` ones sit at their (shore) cell with a rod for that many steps first. */
  people: { x: number; y: number; job: 'farmer' | 'fisher' | 'builder'; variant?: number; fishing?: number }[];
}

export interface PeopleState {
  nextId: number;
  agents: Agent[];
  settlements: SettlementState[];
  buildings: Building[];
  blocked: [number, number][];
  rng: number[];
  founded: boolean;
  startX: number;
  startY: number;
  lastDay: number;
  fish: number[];
  /** Fish capacity per block as of the latest daily update (absent in older saves). */
  fishCap?: number[];
  /** Day of the latest founding (absent in older saves). */
  lastFounding?: number;
  /** Highest total population so far (tool unlocks). */
  peak?: number;
  /** Cumulative flood counters (history; absent in older saves). */
  floods?: { cells: number; ruined: number };
  /** Village animals (M3-δ; absent in older saves). */
  animals?: Animal[];
  /** No animals are kept (staged welcome scenes draw their own). */
  noAnimals?: boolean;
  /** Block attractiveness at the end of last summer (absent before the first, and in older saves). */
  summerSurvey?: number[];
}

/** Small happenings reported to `PeopleSystem.onEvent` (achievements). */
export type PeopleEvent = 'harvest' | 'catch' | 'rebuilt';

export interface PeopleHost {
  /** Called when a cell's terrain changed. */
  terrainChanged(i: number): void;
  /** Called when the plan of a cell changed. */
  planChanged(): void;
  /** Plan cells in placement order (may include finished ones). */
  planCells(): readonly number[];
  /** Water removed from the world by fields (m³), for the ledger. */
  waterUsed(m3: number): void;
  /** Villagers lined cell i (CellFlag.Lined is already set). */
  lined(i: number): void;
}

export class PeopleSystem {
  agents: Agent[] = [];
  settlements: Settlement[] = [];
  buildings: Building[] = [];
  /** Set when buildings changed (for snapshots). */
  buildingsDirty = true;
  /** Field moisture proxy 0..1 (own soil or nearby water), recomputed daily. */
  readonly fieldMoisture: Float32Array;
  /** Nearest water cell for each cell (or -1), recomputed daily. */
  private readonly nearestWater: Int32Array;
  private readonly waterDist: Float32Array;
  private readonly pf: PathFinder;
  /** Fish stock per block (person-days of food), and the block's capacity. */
  readonly fish: Float32Array;
  readonly fishCap: Float32Array;
  readonly fbw: number;
  private rng: Rng;
  private nextId = 1;
  private founded = false;
  private blocked = new Map<number, number>();
  /** Cells currently targeted by someone. */
  private reserved = new Set<number>();
  private lastDay = -1;
  private lastFounding = 0;
  /** Highest total population so far: tools unlocked by it stay unlocked. */
  peakPopulation = 0;
  /**
   * Cumulative flood counters for the history chart: land cells newly
   * flooded (flood memory set from nothing) and houses ruined by floods.
   */
  floods = { cells: 0, ruined: 0 };
  /** Block attractiveness from the latest survey (debugging/tests; recomputed before use). */
  attractiveness: Float32Array | null = null;
  /** Block attractiveness at the end of last summer (FOUNDING.summerDay), or null before the first. */
  summerSurvey: Float32Array | null = null;
  /** Quay cells (lined lake fronts by the houses), derived daily; rendering only. */
  readonly quay: Uint8Array;
  /** Set when `quay` changed, and when a jetty changed (for snapshots). */
  quayDirty = true;
  jettyDirty = true;
  /** Cows, sheep, pigs and chicks (herds.ts). */
  readonly herds: Herds;
  /** Staged scenes keep no animals (their ambient animals are drawn by the renderer). */
  noAnimals = false;
  /** Told of harvests, catches (at the water cell) and rebuilt ruins; an observer only (not saved). */
  onEvent: ((e: PeopleEvent, cell: number) => void) | null = null;
  private readonly onBridge = (i: number): boolean => this.world.landuse[i] === LandUse.Bridge;

  constructor(
    private readonly world: World,
    seed: number,
    private startX: number,
    private startY: number,
  ) {
    this.rng = new Rng(seed ^ 0x9e0b1e);
    this.pf = new PathFinder(world);
    this.herds = new Herds(world, this.pf, this.rng, () => this.nextId++, this.onBridge);
    this.fieldMoisture = new Float32Array(world.size);
    this.nearestWater = new Int32Array(world.size).fill(-1);
    this.waterDist = new Float32Array(world.size);
    this.quay = new Uint8Array(world.size);
    this.fbw = Math.ceil(world.width / FISH_BLOCK);
    const blocks = this.fbw * Math.ceil(world.height / FISH_BLOCK);
    this.fish = new Float32Array(blocks);
    this.fishCap = new Float32Array(blocks);
    this.updateMoisture();
    this.updateFishCapacity();
    // Waters start fully stocked.
    this.fish.set(this.fishCap);
  }

  get population(): number {
    return this.settlements.reduce((n, s) => n + s.state.population, 0);
  }

  /** Stress byte of cell i for the renderer (see cropStress). */
  stressAt(i: number, season: number): number {
    const w = this.world;
    if (w.landuse[i] !== LandUse.Field) return 0;
    return cropStress(w.crop[i]!, this.fieldMoisture[i]!, w.water[i]!, season === 0 || season === 1);
  }

  /** Fishers of a settlement (the store shows a fish-drying rack). */
  fishersOf(id: number): number {
    let n = 0;
    for (const a of this.agents) if (a.settlement === id && a.job === Job.Fisher && a.task !== Task.Leave) n++;
    return n;
  }

  /**
   * Debugging and screenshots (Command 'debugVillage'): force a village's
   * wellbeing (and with it its mood) or food, or dry out the soil around it.
   */
  debugVillage(index: number, opts: { wellbeing?: number; food?: number; dry?: boolean }): void {
    const s = this.settlements[index];
    if (!s) return;
    const st = s.state;
    if (opts.wellbeing !== undefined) {
      st.wellbeing = opts.wellbeing;
      st.mood = opts.wellbeing > 0.62 ? 1 : opts.wellbeing < 0.28 ? -1 : 0;
    }
    if (opts.food !== undefined) st.food = opts.food;
    if (opts.dry) {
      const w = this.world;
      for (let y = Math.max(0, Math.round(st.y - REACH)); y <= Math.min(w.height - 1, Math.round(st.y + REACH)); y++)
        for (let x = Math.max(0, Math.round(st.x - REACH)); x <= Math.min(w.width - 1, Math.round(st.x + REACH)); x++) {
          const i = w.idx(x, y);
          if (w.landuse[i] === LandUse.Field) w.ground[i] = 0;
        }
      this.updateMoisture();
    }
  }

  /**
   * Whether village builders take care of plan cell i: a settlement is in
   * reach and has at least 3 builders (until then the spirit crew helps).
   */
  handledByVillage(i: number): boolean {
    const s = this.settlementNear(i);
    if (!s) return false;
    let n = 0;
    for (const a of this.agents) if (a.settlement === s.state.id && a.job === Job.Builder) n++;
    return n >= 3;
  }

  /** The nearest settlement whose reach covers cell i, if any. */
  settlementNear(i: number): Settlement | null {
    const W = this.world.width;
    const x = i % W;
    const y = (i / W) | 0;
    const s = this.ownerOf(x, y);
    return s && Math.hypot(s.state.x - x, s.state.y - y) <= REACH ? s : null;
  }

  /** The settlement nearest to a cell: it owns the land there (ties go to the older one). */
  ownerOf(x: number, y: number): Settlement | null {
    let best: Settlement | null = null;
    let bestD = Infinity;
    for (const s of this.settlements) {
      const d = (s.state.x - x) ** 2 + (s.state.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // Main update

  tick(step: number, time: SimTime, host: PeopleHost): void {
    this.rebuildReserved();
    if (!this.founded && step >= FOUND_AFTER) this.found();
    if (time.day !== this.lastDay) {
      this.lastDay = time.day;
      this.daily(time, host);
    }
    if (step % 30 === 0) this.floodHouses();
    for (const a of this.agents) this.updateAgent(a, time, host);
    // Remove agents who have left.
    this.agents = this.agents.filter((a) => !(a.task === Task.Leave && a.pathPos >= a.path.length));
    this.herds.tick(PEOPLE_TICK, this.settlements, (s) => this.herdHome(s));
  }

  entities(speed: number) {
    return packEntities(this.agents, speed, this.herds.animals);
  }

  /** Where a village's animals live. */
  private herdHome(s: Settlement): HerdHome {
    const id = s.state.id;
    const store = this.buildings.find((b) => b.settlement === id && b.kind === 'store') ?? null;
    const houses = this.buildings.filter((b) => b.settlement === id && b.kind === 'house' && b.progress >= 1);
    return { store, houses, owns: (x, y) => this.settlements.length < 2 || this.ownerOf(x, y) === s };
  }

  /** Woodcutters, herders and the like of a village. */
  workersOf(id: number, job: Job): number {
    let n = 0;
    for (const a of this.agents) if (a.settlement === id && a.job === job && a.task !== Task.Leave) n++;
    return n;
  }

  // ---------------------------------------------------------------------------
  // Founding

  private found(): void {
    this.founded = true;
    // The start point is chosen with care (worldgen chooseStart: a dry terrace); stay close.
    const site = this.bestSite(this.startX, this.startY, 4);
    if (site < 0) return;
    // The founders bring enough food to last until the first harvest.
    this.foundAt(site, 400, 4, false);
  }

  /**
   * Skip the founding and set up a ready-made village instead (or none):
   * used by the welcome scenes (sim/scenes.ts), which show a living village
   * without fast-forwarding a game. Buildings, fields and people are placed
   * as given; from then on everything runs as usual.
   */
  stage(spec: StagedVillage | null): void {
    this.founded = true;
    this.noAnimals = true;
    if (!spec) return;
    const w = this.world;
    const s = new Settlement(this.settlements.length, spec.x, spec.y, 0, spec.food);
    this.settlements.push(s);
    this.addBuilding('store', s.state.id, spec.x, spec.y).progress = 1;
    for (const h of spec.houses) {
      const b = this.addBuilding('house', s.state.id, h.x, h.y);
      b.progress = h.progress ?? 1;
      if (h.rot !== undefined) b.rot = h.rot;
      if (b.progress >= 1) s.state.houses++;
    }
    for (const f of spec.fields) {
      for (let y = f.y0; y <= f.y1; y++)
        for (let x = f.x0; x <= f.x1; x++) {
          if (!w.inBounds(x, y)) continue;
          const i = w.idx(x, y);
          if (w.landuse[i] !== LandUse.None && w.landuse[i] !== LandUse.Yard) continue;
          w.landuse[i] = LandUse.Field;
          w.crop[i] = f.crop;
          w.vegetation[i] = Math.min(w.vegetation[i]!, 0.15);
        }
    }
    const jobs = { farmer: Job.Farmer, fisher: Job.Fisher, builder: Job.Builder } as const;
    for (const p of spec.people) {
      const cell = w.idx(Math.round(p.x), Math.round(p.y));
      const a: Agent = {
        id: this.nextId++,
        settlement: s.state.id,
        variant: p.variant ?? this.rng.int(0, 10),
        x: p.x,
        y: p.y,
        heading: 0,
        job: jobs[p.job],
        task: Task.None,
        siteKind: SiteKind.None,
        site: -1,
        path: [],
        pathPos: 0,
        timer: 0,
        carry: CarryKind.None,
        load: 0,
        anim: EntityAnim.Idle,
        vx: 0,
        vy: 0,
      };
      if (p.fishing) {
        // Already at the shore: start the session as if just arrived.
        a.siteKind = SiteKind.Fish;
        a.site = cell;
        this.arrive(a);
        a.timer = p.fishing;
      }
      this.agents.push(a);
    }
    s.state.population = spec.people.length;
    this.peakPopulation = s.state.population;
    this.buildingsDirty = true;
    this.updateMoisture();
  }

  /** Best place for a village centre near (cx, cy): flat, dry, fertile, near water. */
  private bestSite(cx: number, cy: number, radius: number): number {
    const w = this.world;
    let best = -1;
    let bestScore = -Infinity;
    for (let y = Math.max(2, Math.round(cy - radius)); y <= Math.min(w.height - 3, Math.round(cy + radius)); y += 2) {
      for (let x = Math.max(2, Math.round(cx - radius)); x <= Math.min(w.width - 3, Math.round(cx + radius)); x += 2) {
        const i = w.idx(x, y);
        if (!this.buildable(i)) continue;
        const d = this.waterDist[i]!;
        const nearWater = d >= 3 && d <= 14 ? 1 : d < 3 ? 0.2 : Math.max(0, 1 - (d - 14) / 20);
        // Open meadow is far more attractive than forest that must be cleared.
        const forest = Math.max(0, w.vegetation[i]! - 0.45) * 4;
        const score = nearWater * 2 + w.fertility[i]! - this.slope(i) * 3 - forest - Math.hypot(x - cx, y - cy) / radius;
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      }
    }
    return best;
  }

  private slope(i: number): number {
    const w = this.world;
    const W = w.width;
    const x = i % W;
    const y = (i / W) | 0;
    let m = 0;
    const h = w.terrain(i);
    if (x > 0) m = Math.max(m, Math.abs(w.terrain(i - 1) - h));
    if (x < W - 1) m = Math.max(m, Math.abs(w.terrain(i + 1) - h));
    if (y > 0) m = Math.max(m, Math.abs(w.terrain(i - W) - h));
    if (y < w.height - 1) m = Math.max(m, Math.abs(w.terrain(i + W) - h));
    return m / 5;
  }

  private buildable(i: number): boolean {
    const w = this.world;
    return (
      w.water[i]! < 0.01 &&
      w.landuse[i] === LandUse.None &&
      w.floodMemory[i]! < 60 &&
      Number.isNaN(w.plan[i]!) &&
      this.slope(i) < 0.25
    );
  }

  private addBuilding(kind: Building['kind'], settlement: number, x: number, y: number): Building {
    const b: Building = { id: this.nextId++, kind, settlement, x, y, rot: this.rng.int(0, 4) * (Math.PI / 2), progress: 0 };
    this.buildings.push(b);
    const w = this.world;
    const i = w.idx(x, y);
    w.landuse[i] = LandUse.Building;
    w.vegetation[i] = Math.min(w.vegetation[i]!, 0.1);
    // A small yard around it: trodden, kept free of fields and trees.
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if ((dx || dy) && w.inBounds(x + dx, y + dy)) {
          const j = w.idx(x + dx, y + dy);
          if (w.landuse[j] === LandUse.None && w.water[j]! < 0.05) {
            w.landuse[j] = LandUse.Yard;
            w.vegetation[j] = Math.min(w.vegetation[j]!, 0.25);
          }
        }
      }
    this.buildingsDirty = true;
    return b;
  }

  // ---------------------------------------------------------------------------
  // Daily decisions

  private daily(time: SimTime, host: PeopleHost): void {
    this.updateMoisture();
    this.updateFloodMemory(time);
    for (const [site, until] of this.blocked) if (until <= time.day) this.blocked.delete(site);
    const doy = time.season * DAYS_PER_SEASON + time.dayOfSeason;
    this.growCrops(time, host);
    this.updateFishCapacity();
    this.growFish(time);
    updateDesirePaths(this.world);
    for (const s of this.settlements) {
      this.updateSafety(s);
      s.day(doy, this.rng);
      this.syncPopulation(s);
      this.syncChildren(s);
      this.planHouses(s);
      this.planWorks(s);
      this.planWoods(s);
      this.herds.daily(s, this.herdHome(s), time.season === 3, !this.noAnimals);
      this.assignJobs(s, host);
      this.manageFields(s);
    }
    this.peakPopulation = Math.max(this.peakPopulation, this.population);
    // Migrants remember how the land looked at the end of summer.
    if (doy === FOUNDING.summerDay) this.summerSurvey = this.surveyLand();
    if (time.day % FOUNDING.everyDays === 0) this.considerFounding(time);
    this.updateQuays();
  }

  // ---------------------------------------------------------------------------
  // The villagers' own works: lining, quays, the jetty (works.ts)

  /** Daily: what to line next, how much stone work the village can afford, and its jetty. */
  private planWorks(s: Settlement): void {
    const st = s.state;
    const houses = this.buildings.filter((b) => b.settlement === st.id && (b.kind === 'house' || b.kind === 'store'));
    st.lineSites = surveyLining(this.world, st.x, st.y, (x, y) => this.settlements.length < 2 || this.ownerOf(x, y) === s, houses);
    // The jetty's landing comes first: its shore and the banks beside it.
    const jt = st.jetty;
    if (jt && jt.progress >= 1) {
      const w = this.world;
      const W = w.width;
      const landing: number[] = [];
      for (const [ox, oy] of [[0, 0], [-jt.dy, jt.dx], [jt.dy, -jt.dx]] as const) {
        const x = (jt.shore % W) + ox;
        const y = ((jt.shore / W) | 0) + oy;
        if (!w.inBounds(x, y)) continue;
        const i = w.idx(x, y);
        if ((w.flags[i]! & CellFlag.Lined) === 0 && w.water[i]! < 0.3 && w.landuse[i] !== LandUse.Building) landing.push(i);
      }
      st.lineSites = [...landing, ...st.lineSites.filter((i) => !landing.includes(i))];
    }
    const w = Math.max(0, Math.min(1, st.wellbeing));
    st.lineBudget = Math.min(WORKS.maxBudget, (st.lineBudget ?? 0) + WORKS.ratePerDay * (0.2 + 0.8 * w));
    if (!st.lineSites.length) st.lineBudget = Math.min(st.lineBudget, 1);
    if (!st.jetty && this.agents.some((a) => a.settlement === st.id && a.job === Job.Fisher)) {
      const W = this.world.width;
      const j = chooseJetty(this.world, st.x, st.y, (c) => {
        const b = Math.floor(c / W / FISH_BLOCK) * this.fbw + Math.floor((c % W) / FISH_BLOCK);
        const K = this.fishCap[b]!;
        return K > 0 ? this.fish[b]! / K : 0;
      });
      if (j) {
        st.jetty = j;
        this.jettyDirty = true;
      }
    }
  }

  /**
   * Daily: the forest edge cells the woodcutters may fell, nearest first:
   * dense forest (not a lone tree) next to open ground, away from the water.
   */
  private planWoods(s: Settlement): void {
    const st = s.state;
    if (st.population < WOOD.minPeople) {
      st.chopSites = [];
      return;
    }
    const w = this.world;
    const W = w.width;
    const v = w.vegetation;
    const cx = Math.round(st.x);
    const cy = Math.round(st.y);
    const R = REACH - 6;
    const cands: [number, number][] = [];
    for (let y = Math.max(2, cy - R); y <= Math.min(w.height - 3, cy + R); y++)
      for (let x = Math.max(2, cx - R); x <= Math.min(W - 3, cx + R); x++) {
        const i = y * W + x;
        if (v[i]! < WOOD.minForest || w.landuse[i] !== LandUse.None || this.waterDist[i]! < WOOD.waterMargin) continue;
        const r = Math.hypot(x - cx, y - cy);
        if (r > R || (this.settlements.length > 1 && this.ownerOf(x, y) !== s)) continue;
        // At the edge: an open, dry neighbour to stand on.
        let edge = false;
        for (const j of [i - 1, i + 1, i - W, i + W]) if (v[j]! < 0.5 && w.water[j]! < 0.02 && w.landuse[j] !== LandUse.Building) edge = true;
        if (!edge) continue;
        // Dense: most of the 3×3 block is forest.
        let dense = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (v[i + dy * W + dx]! >= 0.5) dense++;
        if (dense < 6) continue;
        cands.push([r, i]);
      }
    cands.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    st.chopSites = cands.slice(0, WOOD.sites).map((c) => c[1]);
    st.wood ??= 0;
  }

  /** The next tree a woodcutter can fell (and where to stand), or null. */
  private chopSite(a: Agent, s: Settlement): [number, number] | null {
    const w = this.world;
    const W = w.width;
    for (const i of s.state.chopSites ?? []) {
      if (this.reserved.has(i) || this.blocked.has(i) || w.vegetation[i]! < WOOD.minForest) continue;
      let stand = -1;
      let bestD = Infinity;
      for (const j of [i - 1, i + 1, i - W, i + W]) {
        if (w.vegetation[j]! >= 0.5 || w.water[j]! >= 0.02 || w.landuse[j] === LandUse.Building) continue;
        const d = Math.hypot((j % W) - a.x, ((j / W) | 0) - a.y);
        if (d < bestD) {
          bestD = d;
          stand = j;
        }
      }
      if (stand >= 0) return [i, stand];
    }
    return null;
  }

  /** Lined banks by the houses that face open water read as quays. */
  private updateQuays(): void {
    const W = this.world.width;
    const near: { x: number; y: number; r?: number }[] = this.buildings.filter((b) => b.kind === 'house' || b.kind === 'store');
    for (const s of this.settlements) {
      const j = s.state.jetty;
      if (j && j.progress >= 1) near.push({ x: j.shore % W, y: (j.shore / W) | 0, r: 2 });
    }
    if (markQuays(this.world, near, this.quay)) this.quayDirty = true;
  }

  /** A finished jetty's end cell (where a fisher sits), or -1. */
  private jettyEnd(s: Settlement): number {
    const j = s.state.jetty;
    return j && j.progress >= 1 ? j.cells[j.cells.length - 1]! : -1;
  }

  /** Jetties for the structure list (rendering). */
  jettyInfo(): StructureInfo[] {
    const W = this.world.width;
    const out: StructureInfo[] = [];
    for (const s of this.settlements) {
      const j = s.state.jetty;
      if (!j || j.progress <= 0) continue;
      const end = j.cells[j.cells.length - 1]!;
      out.push({
        id: 100000 + s.state.id,
        kind: 'jetty',
        x: j.shore % W,
        y: (j.shore / W) | 0,
        x2: end % W,
        y2: (end / W) | 0,
        rot: Math.atan2(j.dy, j.dx),
        width: j.cells.length,
        top: j.top,
        sill: j.top,
        open: false,
        progress: j.progress,
      });
    }
    return out;
  }

  /** Stone work a mason can start now: the next free site, or -1. */
  private nextLineSite(s: Settlement): number {
    const st = s.state;
    const sites = st.lineSites;
    if (!sites || !sites.length) return -1;
    // Masons at work (or carrying a stone) count against the budget.
    let busy = 0;
    for (const a of this.agents)
      if (a.settlement === st.id && (a.carry === CarryKind.Stone || a.siteKind === SiteKind.Quarry || a.siteKind === SiteKind.Line) && a.task !== Task.None)
        busy++;
    if ((st.lineBudget ?? 0) < busy + 1) return -1;
    const w = this.world;
    for (const i of sites) {
      if (this.reserved.has(i) || this.blocked.has(i) || (w.flags[i]! & CellFlag.Lined) !== 0) continue;
      return i;
    }
    return -1;
  }

  // ---------------------------------------------------------------------------
  // New villages

  /** Whether the existing villages are big or crowded enough to send people out. */
  private wantsNewVillage(day: number): boolean {
    if (!this.settlements.length || day - this.lastFounding < FOUNDING.interval) return false;
    if (this.population >= FOUNDING.minPopulation) return true;
    return this.settlements.some((s) => s.state.population >= FOUNDING.crowdedPopulation && s.freeHouses <= 0);
  }

  /**
   * Attractiveness of every ATTRACT_BLOCK² block for a new village: flat,
   * fertile, moist but not flooded land near water, on or at the edge of
   * known land, away from other settlements. 0 = unsuitable.
   */
  surveyLand(): Float32Array {
    const w = this.world;
    const W = w.width;
    const B = ATTRACT_BLOCK;
    const bw = Math.ceil(W / B);
    const bh = Math.ceil(w.height / B);
    const out = new Float32Array(bw * bh);
    for (let by = 0; by < bh; by++)
      for (let bx = 0; bx < bw; bx++) {
        const cx = bx * B + B / 2;
        const cy = by * B + B / 2;
        if (cx < 6 || cy < 6 || cx > W - 7 || cy > w.height - 7) continue;
        const c = cy * W + cx;
        // Known land, or right at its soft edge.
        if (w.revealed[c]! < REVEALED / 2) continue;
        if (this.settlements.some((s) => Math.hypot(s.state.x - cx, s.state.y - cy) < FOUNDING.minSpacing)) continue;
        let sum = 0;
        let land = 0;
        let n = 0;
        for (let y = by * B; y < Math.min(w.height, by * B + B); y += 2)
          for (let x = bx * B; x < Math.min(W, bx * B + B); x += 2) {
            n++;
            const i = y * W + x;
            if (w.water[i]! > 0.05) continue;
            land++;
            if (w.floodMemory[i]! > 40 || w.landuse[i] !== LandUse.None) continue;
            const sl = this.slope(i);
            if (sl > 0.25) continue;
            const m = this.fieldMoisture[i]!;
            const wet = cropGrowth(m);
            const forest = w.vegetation[i]! > 0.6 ? 0.6 : 1;
            sum += w.fertility[i]! * wet * forest * (1 - sl * 2);
          }
        if (land < n * 0.6) continue;
        const d = this.waterDist[c]!;
        const nearWater = d >= 2 && d <= 14 ? 0.15 : d < 2 ? 0 : Math.max(0, 0.15 * (1 - (d - 14) / 16));
        out[by * bw + bx] = sum / n + nearWater;
      }
    return out;
  }

  private considerFounding(time: SimTime): void {
    if (!this.wantsNewVillage(time.day)) return;
    const summer = this.summerSurvey;
    if (!summer) return;
    const a = this.surveyLand();
    for (let b = 0; b < a.length; b++) a[b] = Math.min(a[b]!, summer[b] ?? 0);
    this.attractiveness = a;
    const B = ATTRACT_BLOCK;
    const bw = Math.ceil(this.world.width / B);
    let best = -1;
    for (let b = 0; b < a.length; b++) if (a[b]! >= FOUNDING.minScore && (best < 0 || a[b]! > a[best]!)) best = b;
    if (best < 0) return;
    const site = this.bestSite((best % bw) * B + B / 2, Math.floor(best / bw) * B + B / 2, 6);
    if (site < 0) return;
    this.foundAt(site, FOUNDING.food, this.rng.int(3, 6), true);
    this.lastFounding = time.day;
  }

  /**
   * A new village at cell `site`: a store and a family. Migrants (`fromFog`)
   * walk in with their bundles from the nearest edge of the known land.
   */
  private foundAt(site: number, food: number, people: number, fromFog: boolean): Settlement {
    const W = this.world.width;
    const sx = site % W;
    const sy = (site / W) | 0;
    const s = new Settlement(this.settlements.length, sx, sy, 0, food);
    this.settlements.push(s);
    this.addBuilding('store', s.state.id, sx, sy);
    this.buildings[this.buildings.length - 1]!.progress = 1;
    s.state.population = people;
    const from = fromFog ? this.fogEdge(sx, sy) : -1;
    if (from >= 0) for (let k = 0; k < people; k++) this.spawnAt(s, 0, from);
    this.syncPopulation(s);
    return s;
  }

  /** A dry cell just inside the known land, on the way from (x, y) to the nearest fog. */
  private fogEdge(x: number, y: number): number {
    const w = this.world;
    let best = -1;
    let bestR = Infinity;
    for (let k = 0; k < 16; k++) {
      const ang = (k / 16) * Math.PI * 2;
      let lastDry = -1;
      for (let r = 4; r <= 56 && r < bestR; r += 2) {
        const cx = Math.round(x + Math.cos(ang) * r);
        const cy = Math.round(y + Math.sin(ang) * r);
        if (!w.inBounds(cx, cy)) break;
        const i = w.idx(cx, cy);
        if (w.revealed[i]! < REVEALED) {
          if (lastDry >= 0) {
            best = lastDry;
            bestR = r;
          }
          break;
        }
        if (w.water[i]! < 0.05 && this.slope(i) < 0.6) lastDry = i;
      }
    }
    return best;
  }

  /** Field moisture: own soil saturation, or capillary wetting from nearby water. */
  private updateMoisture(): void {
    const w = this.world;
    const W = w.width;
    const H = w.height;
    const d = this.waterDist;
    const near = this.nearestWater;
    for (let i = 0; i < w.size; i++) {
      if (w.water[i]! > 0.05) {
        d[i] = 0;
        near[i] = i;
      } else {
        d[i] = 1e9;
        near[i] = -1;
      }
    }
    // Two-pass chamfer distance transform with nearest-source propagation.
    const relax = (i: number, j: number, c: number) => {
      if (d[j]! + c < d[i]!) {
        d[i] = d[j]! + c;
        near[i] = near[j]!;
      }
    };
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (x > 0) relax(i, i - 1, 1);
        if (y > 0) {
          relax(i, i - W, 1);
          if (x > 0) relax(i, i - W - 1, 1.414);
          if (x < W - 1) relax(i, i - W + 1, 1.414);
        }
      }
    for (let y = H - 1; y >= 0; y--)
      for (let x = W - 1; x >= 0; x--) {
        const i = y * W + x;
        if (x < W - 1) relax(i, i + 1, 1);
        if (y < H - 1) {
          relax(i, i + W, 1);
          if (x < W - 1) relax(i, i + W + 1, 1.414);
          if (x > 0) relax(i, i + W - 1, 1.414);
        }
      }
    const { soil, ground, soilType } = w;
    for (let i = 0; i < w.size; i++) {
      const cap = soil[i]! * SOIL_PROPS[soilType[i]!]!.porosity;
      const own = cap > 0 ? ground[i]! / cap : 0;
      this.fieldMoisture[i] = Math.max(own, CAPILLARY.max * Math.exp(-d[i]! / CAPILLARY.reach));
    }
  }

  /**
   * Memories of floods fade over about four years, and fast once the cause
   * is gone: on the last day of spring, land that stayed dry all spring
   * (no flood since its first day) forgets FLOOD_FORGET at once. So one dry
   * spring behind a new dike frees the land for the next year.
   */
  private updateFloodMemory(time: SimTime): void {
    const w = this.world;
    const m = w.floodMemory;
    for (let i = 0; i < w.size; i++) if (m[i]! > 0 && w.water[i]! <= 0.3) m[i]!--;
    if (time.season === 0 && time.dayOfSeason === DAYS_PER_SEASON - 1) {
      // Flooded this spring: set to 255 and decremented at most once a day since.
      const wetThisSpring = 255 - DAYS_PER_SEASON;
      for (let i = 0; i < w.size; i++) if (m[i]! > 0 && m[i]! <= wetThisSpring) m[i] = Math.max(0, m[i]! - FLOOD_FORGET);
    }
  }

  /** Floods are noticed as they happen: houses in deep water are ruined, flooded land remembered. */
  private floodHouses(): void {
    const w = this.world;
    for (let i = 0; i < w.size; i++) {
      if (w.water[i]! > 0.3 && w.landuse[i] !== LandUse.None) {
        if (w.floodMemory[i] === 0) this.floods.cells++;
        w.floodMemory[i] = 255;
      }
    }
    for (const b of this.buildings) {
      if (b.kind !== 'house') continue;
      if (w.water[w.idx(b.x, b.y)]! > 0.4) {
        if (b.progress >= 1) {
          const s = this.settlements[b.settlement];
          if (s) s.state.houses = Math.max(0, s.state.houses - 1);
        }
        b.kind = 'ruin';
        b.progress = 0;
        this.floods.ruined++;
        this.buildingsDirty = true;
      }
    }
  }

  private updateSafety(s: Settlement): void {
    const w = this.world;
    let houses = 0;
    let wet = 0;
    for (const b of this.buildings) {
      if (b.settlement !== s.state.id) continue;
      houses++;
      if (w.water[w.idx(b.x, b.y)]! > 0.1) wet++;
    }
    s.state.safety = houses ? 1 - wet / houses : 1;
    const c = w.idx(Math.round(s.state.x), Math.round(s.state.y));
    s.state.waterAccess = this.waterDist[c]! < 25 ? 1 : 0.5;
  }

  /** Crops grow from moisture and season (land grows it). */
  private growCrops(time: SimTime, host: PeopleHost): void {
    const w = this.world;
    const growing = time.season === 0 || time.season === 1;
    let used = 0;
    for (let i = 0; i < w.size; i++) {
      if (w.landuse[i] !== LandUse.Field) continue;
      let c = w.crop[i]!;
      if (time.season === 3) {
        c = 0; // whatever is left rots in winter
      } else if (w.water[i]! > 0.05) {
        c = Math.max(0, c - 60); // drowning
      } else if (growing && c > 0 && c < 255) {
        const m = this.fieldMoisture[i]!;
        const f = cropGrowth(m);
        c = Math.min(255, c + Math.round(16 * f));
        // Growing crops draw water from the nearest water body, or the soil.
        const src = this.nearestWater[i]!;
        if (src >= 0 && this.waterDist[i]! < 8 && w.water[src]! > FIELD_DRAW) {
          w.water[src]! -= FIELD_DRAW;
          used += FIELD_DRAW;
        } else if (w.ground[i]! > FIELD_DRAW) {
          w.ground[i]! -= FIELD_DRAW;
          used += FIELD_DRAW;
        }
      }
      w.crop[i] = c;
    }
    host.waterUsed(used * 25);
  }

  /** Fish need calm (< 0.4 m/s), not too shallow (> 0.5 m) water. */
  /** Pack fish stocks for the renderer (see Snapshot.fish). */
  packFish(): Uint8Array {
    const out = new Uint8Array(this.fish.length);
    for (let b = 0; b < out.length; b++) {
      const K = this.fishCap[b]!;
      out[b] = K > 0 ? 1 + Math.round(254 * Math.min(1, this.fish[b]! / K)) : 0;
    }
    return out;
  }

  private updateFishCapacity(): void {
    const w = this.world;
    const { width: W, water, velX, velY } = w;
    this.fishCap.fill(0);
    for (let i = 0; i < w.size; i++) {
      const d = water[i]!;
      if (d < 0.5) continue;
      const v = Math.hypot(velX[i]!, velY[i]!);
      if (v > 0.4) continue;
      const b = Math.floor((i / W) / FISH_BLOCK) * this.fbw + Math.floor((i % W) / FISH_BLOCK);
      this.fishCap[b]! += FISH_PER_CELL * Math.min(1, d / 1.5);
    }
  }

  private growFish(time: SimTime): void {
    const winter = time.season === 3;
    for (let b = 0; b < this.fish.length; b++) {
      const K = this.fishCap[b]!;
      let f = Math.min(this.fish[b]!, K);
      if (K > 0) {
        // A few fish always find their way into new water (natural stocking).
        f = Math.max(f, 0.02 * K);
        if (!winter) f += FISH_GROWTH * f * (1 - f / K);
      }
      this.fish[b] = f;
    }
  }

  /** A dry shore cell next to stocked, calm water, near the agent and within reach. */
  private fishingSpot(a: Agent, s: Settlement): number {
    const w = this.world;
    const W = w.width;
    const cx = Math.round(s.state.x);
    const cy = Math.round(s.state.y);
    let best = -1;
    let bestScore = -Infinity;
    // The village jetty's end is the favourite spot.
    const end = this.jettyEnd(s);
    if (end >= 0 && !this.reserved.has(end) && !this.blocked.has(end)) {
      const b = Math.floor(end / W / FISH_BLOCK) * this.fbw + Math.floor((end % W) / FISH_BLOCK);
      const K = this.fishCap[b]!;
      if (K > 0 && this.fish[b]! / K > 0.2) return end;
    }
    for (let k = 0; k < 120; k++) {
      // Deterministic sampling of candidate cells around the village.
      const r = 3 + this.rng.next() * (REACH - 3);
      const ang = this.rng.range(0, Math.PI * 2);
      const x = Math.round(cx + Math.cos(ang) * r);
      const y = Math.round(cy + Math.sin(ang) * r);
      if (x < 1 || y < 1 || x >= W - 1 || y >= w.height - 1) continue;
      const i = y * W + x;
      if (w.water[i]! > 0.05 || this.reserved.has(i) || this.blocked.has(i) || w.landuse[i] === LandUse.Building) continue;
      for (const j of [i - 1, i + 1, i - W, i + W]) {
        if (w.water[j]! < 0.5) continue;
        const b = Math.floor((j / W) / FISH_BLOCK) * this.fbw + Math.floor((j % W) / FISH_BLOCK);
        const K = this.fishCap[b]!;
        if (K <= 0) continue;
        const score = (this.fish[b]! / K) * 10 - Math.hypot(x - a.x, y - a.y) / 4;
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      }
    }
    return best;
  }

  /** How much fishing the waters within reach can sustain (person-days per day). */
  private fishSupply(s: Settlement): number {
    let total = 0;
    for (let b = 0; b < this.fish.length; b++) {
      if (this.fishCap[b]! <= 0) continue;
      const bx = (b % this.fbw) * FISH_BLOCK + FISH_BLOCK / 2;
      const by = Math.floor(b / this.fbw) * FISH_BLOCK + FISH_BLOCK / 2;
      if (Math.hypot(bx - s.state.x, by - s.state.y) > REACH) continue;
      total += this.fish[b]!;
    }
    return total * FISH_GROWTH * 0.25; // a sustainable share of the growth at mid stock
  }

  /**
   * Children playing between the houses while the village prospers: they
   * come out of a house, and go back in (vanish) when times get harder.
   */
  private syncChildren(s: Settlement): void {
    const st = s.state;
    const houses = this.buildings.filter((b) => b.settlement === st.id && b.kind === 'house' && b.progress >= 1);
    const want = st.mood === 1 ? Math.min(MAX_CHILDREN, Math.floor(st.population / 4), houses.length) : 0;
    const kids = this.agents.filter((a) => a.settlement === st.id && a.child && a.task !== Task.Leave);
    const w = this.world;
    for (let n = kids.length; n < want; n++) {
      const h = houses[this.rng.int(0, houses.length)]!;
      this.agents.push({
        id: this.nextId++,
        settlement: st.id,
        variant: this.rng.int(0, 10),
        x: h.x,
        y: h.y,
        heading: this.rng.range(0, Math.PI * 2),
        job: Job.Idle,
        task: Task.None,
        siteKind: SiteKind.None,
        site: -1,
        path: [],
        pathPos: 0,
        timer: 0,
        carry: CarryKind.None,
        load: 0,
        anim: EntityAnim.Idle,
        vx: 0,
        vy: 0,
        child: true,
      });
    }
    for (let k = kids.length - 1; k >= want; k--) {
      const a = kids[k]!;
      // Home: the nearest house (or gone at once if there is none to walk to).
      let best: Building | null = null;
      let bestD = Infinity;
      for (const h of houses) {
        const d = Math.hypot(h.x - a.x, h.y - a.y);
        if (d < bestD) {
          bestD = d;
          best = h;
        }
      }
      const path = best ? this.pf.find(this.cellOf(a), w.idx(best.x, best.y), { window: 24, maxExpand: 2000 }) : null;
      a.task = Task.Leave;
      a.path = path ?? [];
      a.pathPos = 0;
    }
  }

  /** Spawn arrivals / send away leavers so agents match the settlement's population. */
  private syncPopulation(s: Settlement): void {
    const mine = this.agents.filter((a) => a.settlement === s.state.id && a.task !== Task.Leave && !a.child);
    let diff = s.state.population - mine.length;
    while (diff > 0) {
      const a = this.spawnAt(s, 12);
      if (!a) break;
      diff--;
    }
    for (let k = mine.length - 1; k >= 0 && diff < 0; k--, diff++) {
      const a = mine[k]!;
      const out = this.edgePoint(s, 16, a);
      const path = out >= 0 ? this.pf.find(this.cellOf(a), out, { window: 40 }) : null;
      a.task = Task.Leave;
      a.carry = CarryKind.Bundle;
      a.path = path ?? [];
      a.pathPos = 0;
    }
  }

  /** A newcomer walking to the village centre from `dist` cells away (or from cell `from`). */
  private spawnAt(s: Settlement, dist: number, from = -1): Agent | null {
    const w = this.world;
    const edge = from >= 0 ? from : this.edgePoint(s, dist, null);
    if (edge < 0) return null;
    const a: Agent = {
      id: this.nextId++,
      settlement: s.state.id,
      variant: this.rng.int(0, 10),
      x: edge % w.width,
      y: (edge / w.width) | 0,
      heading: 0,
      job: Job.Idle,
      task: Task.None,
      siteKind: SiteKind.None,
      site: -1,
      path: [],
      pathPos: 0,
      timer: 0,
      carry: CarryKind.Bundle,
      load: 0,
      anim: EntityAnim.Idle,
      vx: 0,
      vy: 0,
    };
    const centre = w.idx(Math.round(s.state.x), Math.round(s.state.y));
    const path = this.pf.find(edge, centre, { window: from >= 0 ? 48 : 40 });
    if (path) {
      a.path = path;
      a.task = Task.Walk;
      a.siteKind = SiteKind.Wander;
      a.site = centre;
    }
    this.agents.push(a);
    return a;
  }

  /** A dry, reachable-looking cell about `dist` from the settlement centre. */
  private edgePoint(s: Settlement, dist: number, a: Agent | null): number {
    const w = this.world;
    const base = a ? Math.atan2(a.y - s.state.y, a.x - s.state.x) : this.rng.range(0, Math.PI * 2);
    for (let k = 0; k < 16; k++) {
      const ang = base + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.4;
      const x = Math.round(s.state.x + Math.cos(ang) * dist);
      const y = Math.round(s.state.y + Math.sin(ang) * dist);
      if (!w.inBounds(x, y)) continue;
      const i = w.idx(x, y);
      if (w.water[i]! < 0.05 && this.slope(i) < 0.6) return i;
    }
    return -1;
  }

  private planHouses(s: Settlement): void {
    const building = this.buildings.some((b) => b.settlement === s.state.id && b.kind === 'house' && b.progress < 1);
    if (building || !s.wantsHouse()) return;
    // Rebuild a ruin once its site has long been dry (people forget floods).
    const w0 = this.world;
    const ruin = this.buildings.find(
      (b) => b.settlement === s.state.id && b.kind === 'ruin' && w0.floodMemory[w0.idx(b.x, b.y)]! === 0 && w0.water[w0.idx(b.x, b.y)]! < 0.01,
    );
    if (ruin) {
      ruin.kind = 'house';
      ruin.progress = 0.3; // the walls still stand
      this.onEvent?.('rebuilt', w0.idx(ruin.x, ruin.y));
      this.buildingsDirty = true;
      return;
    }
    // Look for a free, safe spot near the centre, not hugging other buildings.
    const w = this.world;
    let best = -1;
    let bestScore = -Infinity;
    for (let r = 2; r <= 12; r++) {
      for (let k = 0; k < 8 * r; k++) {
        const ang = (k / (8 * r)) * Math.PI * 2;
        const x = Math.round(s.state.x + Math.cos(ang) * r);
        const y = Math.round(s.state.y + Math.sin(ang) * r);
        if (!w.inBounds(x, y)) continue;
        const i = w.idx(x, y);
        if (!this.buildable(i) || !this.spacious(x, y)) continue;
        const score = -r - this.slope(i) * 4 - w.floodMemory[i]! / 50 - w.vegetation[i]! * 3 + this.rng.next() * 0.5;
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      }
      if (best >= 0 && r >= 4) break;
    }
    if (best < 0) return;
    this.addBuilding('house', s.state.id, best % w.width, (best / w.width) | 0);
  }

  private spacious(x: number, y: number): boolean {
    for (const b of this.buildings) if (Math.abs(b.x - x) < 2 && Math.abs(b.y - y) < 2) return false;
    return true;
  }

  private assignJobs(s: Settlement, host: PeopleHost): void {
    const mine = this.agents.filter((a) => a.settlement === s.state.id && a.task !== Task.Leave && !a.child);
    const n = mine.length;
    const houseWork = this.buildings.some((b) => b.settlement === s.state.id && b.kind === 'house' && b.progress < 1);
    const planWork =
      PARAMS.villagersBuildPlans && host.planCells().some((i) => !Number.isNaN(this.world.plan[i]!) && this.settlementNear(i) === s);
    const want = new Map<Job, number>();
    // Stone work and the jetty need a builder or two (a small mason share, more when prosperous).
    const st = s.state;
    const stoneWork = n >= 4 && (st.lineSites?.length ?? 0) > 0 && (st.lineBudget ?? 0) >= 1;
    const jettyWork = st.jetty !== undefined && st.jetty.progress < 1;
    const masons = stoneWork || jettyWork ? Math.max(1, Math.round(n * (0.04 + 0.08 * Math.max(0, st.wellbeing)))) : 0;
    want.set(Job.Builder, Math.max(masons, houseWork || planWork ? Math.max(1, Math.round(n * (planWork ? 0.45 : 0.25))) : 0));
    // Fishers: as many as the waters sustain (one landing ≈ CATCH a day), up to a quarter.
    want.set(Job.Fisher, n >= 3 ? Math.min(Math.round(n * 0.25), Math.round(this.fishSupply(s) / CATCH)) : 0);
    // Herders: one for a herd, two for a big one.
    const grazers = this.herds.grazers(st.id);
    want.set(Job.Herder, grazers >= 2 ? (grazers >= 8 ? 2 : 1) : 0);
    // Woodcutters: a small share of bigger villages, while the woodpile needs logs.
    const wood = n >= WOOD.minPeople && (st.chopSites?.length ?? 0) > 0 && (st.wood ?? 0) < WOOD.enough;
    want.set(Job.Woodcutter, wood ? Math.min(WOOD.max, Math.max(1, Math.round(n * WOOD.share))) : 0);
    // Move at most two people per day, lowest ids first (deterministic, no flip-flop).
    let moves = 2;
    for (const [job, target] of want) {
      let have = mine.filter((a) => a.job === job).length;
      for (const a of mine) {
        if (moves === 0) break;
        if (have < target && (a.job === Job.Farmer || a.job === Job.Idle)) {
          a.job = job;
          have++;
          moves--;
        } else if (have > target && a.job === job) {
          a.job = Job.Farmer;
          have--;
          moves--;
        }
      }
    }
    for (const a of mine) if (a.job === Job.Idle) a.job = Job.Farmer;
  }

  private manageFields(s: Settlement): void {
    const w = this.world;
    const farmers = this.agents.filter((a) => a.settlement === s.state.id && a.job === Job.Farmer).length;
    const want = farmers * FIELDS_PER_FARMER;
    const fields = this.fieldsOf(s);
    if (fields.length >= want) return;
    // Claim the best unclaimed cells nearby (at most 10 per day).
    const cands: [number, number][] = [];
    const cx = Math.round(s.state.x);
    const cy = Math.round(s.state.y);
    for (let y = Math.max(0, cy - FIELD_RADIUS); y <= Math.min(w.height - 1, cy + FIELD_RADIUS); y++)
      for (let x = Math.max(0, cx - FIELD_RADIUS); x <= Math.min(w.width - 1, cx + FIELD_RADIUS); x++) {
        const r = Math.hypot(x - cx, y - cy);
        if (r > FIELD_RADIUS || r < 3) continue;
        const i = w.idx(x, y);
        if (!this.buildable(i) || !this.spacious(x, y)) continue;
        if (this.settlements.length > 1 && this.ownerOf(x, y) !== s) continue;
        const m = this.fieldMoisture[i]!;
        const wet = cropGrowth(m);
        const forest = Math.max(0, w.vegetation[i]! - 0.45);
        // Grow fields in solid patches next to existing ones.
        const W = w.width;
        let adj = 0;
        if (x > 0 && w.landuse[i - 1] === LandUse.Field) adj++;
        if (x < W - 1 && w.landuse[i + 1] === LandUse.Field) adj++;
        if (y > 0 && w.landuse[i - W] === LandUse.Field) adj++;
        if (y < w.height - 1 && w.landuse[i + W] === LandUse.Field) adj++;
        const suit = w.fertility[i]! * wet - r / (FIELD_RADIUS * 4) - forest + (wet > 0 ? 0.12 * adj : 0);
        if (suit > 0.12) cands.push([suit, i]);
      }
    cands.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    for (let k = 0; k < Math.min(10, want - fields.length, cands.length); k++) {
      const i = cands[k]![1];
      w.landuse[i] = LandUse.Field;
      w.crop[i] = 0;
      w.vegetation[i] = Math.min(w.vegetation[i]!, 0.15); // cleared
    }
  }

  private fieldsOf(s: Settlement): number[] {
    const w = this.world;
    const out: number[] = [];
    const cx = Math.round(s.state.x);
    const cy = Math.round(s.state.y);
    for (let y = Math.max(0, cy - FIELD_RADIUS); y <= Math.min(w.height - 1, cy + FIELD_RADIUS); y++)
      for (let x = Math.max(0, cx - FIELD_RADIUS); x <= Math.min(w.width - 1, cx + FIELD_RADIUS); x++) {
        const i = w.idx(x, y);
        if (w.landuse[i] === LandUse.Field && (this.settlements.length < 2 || this.ownerOf(x, y) === s)) out.push(i);
      }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Agents

  private cellOf(a: Agent): number {
    return this.world.idx(Math.round(a.x), Math.round(a.y));
  }

  private updateAgent(a: Agent, time: SimTime, host: PeopleHost): void {
    // Check for rising water every 10 ticks per person (staggered by id).
    if (!a.flee && a.task !== Task.Leave && (time.step / PEOPLE_TICK + a.id) % 10 === 0 && this.world.water[this.cellOf(a)]! > 0.3) {
      this.flee(a, time);
    }
    switch (a.task) {
      case Task.Leave:
      case Task.Walk: {
        // Children run; in a struggling village people dawdle when idle (never on the way to work: PEOPLE.md §7).
        const tired = !a.flee && a.siteKind === SiteKind.Wander && a.task === Task.Walk && this.settlements[a.settlement]?.state.mood === -1;
        const leading = a.siteKind === SiteKind.Herd && a.task === Task.Walk;
        const arrived = walk(this.world, a, PEOPLE_TICK, a.child ? CHILD_SPEED : tired ? TIRED_SPEED : leading ? HERDING.leadSpeed : 1);
        a.anim = a.flee || a.child ? EntityAnim.Run : a.carry !== CarryKind.None ? EntityAnim.Carry : EntityAnim.Walk;
        if (arrived && a.task === Task.Walk) {
          a.flee = false;
          this.arrive(a);
        }
        break;
      }
      case Task.Work:
      case Task.Rest:
        a.vx = 0;
        a.vy = 0;
        a.timer -= PEOPLE_TICK;
        if (a.timer <= 0) {
          if (a.task === Task.Work) this.complete(a, time, host);
          a.task = Task.None;
        }
        break;
      case Task.None:
        this.chooseTask(a, time, host);
        break;
    }
  }

  private arrive(a: Agent): void {
    a.task = Task.Work;
    switch (a.siteKind) {
      case SiteKind.House:
        a.timer = 60;
        a.anim = EntityAnim.Build;
        break;
      case SiteKind.Earthwork:
        a.timer = 50;
        a.anim = EntityAnim.Work;
        break;
      case SiteKind.Sow:
      case SiteKind.Tend:
        a.timer = 40;
        a.anim = EntityAnim.Work;
        break;
      case SiteKind.Harvest:
        a.timer = 40;
        a.anim = EntityAnim.Work;
        break;
      case SiteKind.Deliver:
        a.timer = 10;
        a.anim = EntityAnim.Idle;
        break;
      case SiteKind.Quarry:
        a.timer = 16;
        a.anim = EntityAnim.Work;
        break;
      case SiteKind.Line: {
        a.timer = 70;
        a.anim = EntityAnim.Build;
        const W = this.world.width;
        const here = this.cellOf(a);
        if (here !== a.site) a.heading = Math.atan2(((a.site / W) | 0) - ((here / W) | 0), (a.site % W) - (here % W));
        break;
      }
      case SiteKind.Jetty:
        a.timer = 60;
        a.anim = EntityAnim.Build;
        break;
      case SiteKind.Chop: {
        a.timer = 90;
        a.anim = EntityAnim.Chop;
        const W = this.world.width;
        const here = this.cellOf(a);
        if (here !== a.site) a.heading = Math.atan2(((a.site / W) | 0) - ((here / W) | 0), (a.site % W) - (here % W));
        break;
      }
      case SiteKind.Herd:
        // Watch the herd graze: mostly sitting in the grass.
        a.timer = HERDING.outing;
        a.anim = this.rng.next() < 0.6 ? EntityAnim.Sit : EntityAnim.Idle;
        break;
      case SiteKind.Fish: {
        a.timer = 160;
        a.anim = EntityAnim.Fish;
        // Face the water.
        const w = this.world;
        const W = w.width;
        const i = a.site;
        let best = -1;
        for (const j of [i - 1, i + 1, i - W, i + W]) if (j >= 0 && j < w.size && (best < 0 || w.water[j]! > w.water[best]!)) best = j;
        if (best >= 0) a.heading = Math.atan2(((best / W) | 0) - ((i / W) | 0), (best % W) - (i % W));
        // On a jetty: look out along it.
        const jt = this.settlements[a.settlement]?.state.jetty;
        if (jt && jt.cells[jt.cells.length - 1] === i) a.heading = Math.atan2(jt.dy, jt.dx);
        break;
      }
      default:
        a.task = Task.Rest;
        if (a.child) {
          // A short pause in the game, then off again.
          a.timer = 6 + this.rng.int(0, 30);
          a.anim = this.rng.next() < 0.2 ? EntityAnim.Sit : EntityAnim.Idle;
          break;
        }
        if (this.settlements[a.settlement]?.state.mood === -1) {
          // Hanging about the store, listless.
          a.timer = 80 + this.rng.int(0, 160);
          a.anim = this.rng.next() < 0.25 ? EntityAnim.Sit : EntityAnim.Idle;
          if (a.carry === CarryKind.Bundle) a.carry = CarryKind.None;
          break;
        }
        a.timer = 30 + this.rng.int(0, 80);
        a.anim = this.rng.next() < 0.4 ? EntityAnim.Sit : EntityAnim.Idle;
        if (a.carry === CarryKind.Bundle) a.carry = CarryKind.None;
    }
  }

  /** The work is done: apply its effect. */
  private complete(a: Agent, time: SimTime, host: PeopleHost): void {
    const w = this.world;
    const s = this.settlements[a.settlement];
    switch (a.siteKind) {
      case SiteKind.House: {
        const b = this.buildings.find((b) => b.id === a.site);
        if (b && b.progress < 1) {
          b.progress = Math.min(1, b.progress + BUILD_PER_VISIT);
          if (b.progress >= 1 && s) s.state.houses++;
          this.buildingsDirty = true;
        }
        break;
      }
      case SiteKind.Earthwork: {
        // Work the cell and its planned neighbours (a small patch per visit).
        const W = w.width;
        const c = a.site;
        for (const i of [c, c - 1, c + 1, c - W, c + W]) {
          if (i < 0 || i >= w.size || (i !== c && Math.abs((i % W) - (c % W)) > 1)) continue;
          const target = w.plan[i]!;
          if (Number.isNaN(target)) continue;
          const diff = target - w.terrain(i);
          const step = Math.max(-DIG_PER_VISIT, Math.min(DIG_PER_VISIT, diff));
          applyEarthwork(w, i, step);
          if (Math.abs(diff - step) < 0.01) w.plan[i] = NaN;
          host.terrainChanged(i);
          host.planChanged();
        }
        a.carry = CarryKind.None;
        break;
      }
      case SiteKind.Sow:
        if (w.landuse[a.site] === LandUse.Field && w.crop[a.site] === 0) w.crop[a.site] = 8;
        break;
      case SiteKind.Tend:
        // Tending helps a little (weeding); growth itself comes from the land.
        if (w.landuse[a.site] === LandUse.Field && w.crop[a.site]! > 0) w.crop[a.site] = Math.min(255, w.crop[a.site]! + 1);
        break;
      case SiteKind.Harvest: {
        const i = a.site;
        if (w.landuse[i] === LandUse.Field && w.crop[i]! >= CROP_RIPE) {
          a.load = YIELD * Math.max(0.2, w.fertility[i]!) * (w.crop[i]! / 255);
          a.carry = CarryKind.Sack;
          w.crop[i] = 0;
          w.fertility[i] = Math.max(0.1, w.fertility[i]! * 0.985);
          this.onEvent?.('harvest', i);
        }
        break;
      }
      case SiteKind.Fish: {
        const W = w.width;
        const i = a.site;
        let caught = 0;
        for (const j of [i - 1, i + 1, i - W, i + W]) {
          if (j < 0 || j >= w.size || w.water[j]! < 0.5) continue;
          const b = Math.floor((j / W) / FISH_BLOCK) * this.fbw + Math.floor((j % W) / FISH_BLOCK);
          const K = this.fishCap[b]!;
          if (K <= 0) continue;
          caught = Math.min(this.fish[b]!, CATCH * (this.fish[b]! / K));
          this.fish[b]! -= caught;
          if (caught > 0.3) this.onEvent?.('catch', j);
          break;
        }
        if (caught > 0.3) {
          a.load = caught;
          a.carry = CarryKind.Fish;
        }
        break;
      }
      case SiteKind.Deliver:
        if (s && a.carry === CarryKind.Log) s.state.wood = Math.min(ECONOMY.woodMax, (s.state.wood ?? 0) + 1);
        else if (s && a.load > 0) s.bookFood(a.load);
        a.load = 0;
        a.carry = CarryKind.None;
        break;
      case SiteKind.Chop: {
        const i = a.site;
        if (w.vegetation[i]! >= WOOD.minForest) {
          w.vegetation[i] = WOOD.felled;
          a.carry = CarryKind.Log;
          a.load = 1;
          if (s) s.state.chopSites = s.state.chopSites?.filter((c) => c !== i);
        }
        break;
      }
      case SiteKind.Herd: {
        // Home time: the herd heads back to the fold, the herder brings the milk.
        const h = s?.state.herd;
        if (s && h) {
          const winter = time.season === 3 || !h.out;
          const milk = HERDING.dairy * this.herds.near(s.state.id, a.site, 8) * (winter ? HERDING.winterDairy : 1);
          this.herds.setOut(s, false);
          h.restUntil = time.step + HERDING.rest;
          if (milk > 0) {
            a.carry = CarryKind.Bucket;
            a.load = milk;
          }
        }
        break;
      }
      case SiteKind.Quarry:
        a.carry = CarryKind.Stone;
        break;
      case SiteKind.Line: {
        const i = a.site;
        if (a.carry === CarryKind.Stone && (w.flags[i]! & CellFlag.Lined) === 0) {
          w.flags[i]! |= CellFlag.Lined;
          w.vegetation[i] = Math.min(w.vegetation[i]!, 0.05);
          if (s) {
            s.state.lineBudget = Math.max(0, (s.state.lineBudget ?? 0) - 1);
            s.state.lineSites = s.state.lineSites?.filter((c) => c !== i);
          }
          host.lined(i);
        }
        a.carry = CarryKind.None;
        break;
      }
      case SiteKind.Jetty: {
        const j = s?.state.jetty;
        if (j && j.progress < 1) {
          j.progress = Math.min(1, j.progress + JETTY_PER_VISIT);
          if (j.progress >= 1) {
            let top = w.terrain(j.shore);
            for (const c of j.cells) top = Math.max(top, w.surface(c) + 0.25);
            j.top = top;
            for (const c of j.cells) w.landuse[c] = LandUse.Bridge;
          }
          this.jettyDirty = true;
        }
        a.carry = CarryKind.None;
        break;
      }
    }
    void time;
  }

  private chooseTask(a: Agent, time: SimTime, host: PeopleHost): void {
    const s = this.settlements[a.settlement];
    if (!s) return;
    const w = this.world;
    if (a.child) {
      this.play(a, s, time);
      return;
    }
    // Deliver what you carry first.
    const delivering =
      ((a.carry === CarryKind.Sack || a.carry === CarryKind.Fish || a.carry === CarryKind.Bucket) && a.load > 0) ||
      (a.carry === CarryKind.Log && a.job === Job.Woodcutter);
    if (delivering) {
      const store = this.buildings.find((b) => b.settlement === s.state.id && b.kind === 'store');
      if (store && this.goTo(a, w.idx(store.x, store.y), SiteKind.Deliver, time)) return;
    }
    if (a.job === Job.Builder) {
      const house = this.buildings.find((b) => b.settlement === s.state.id && b.kind === 'house' && b.progress < 1);
      if (house && this.goTo(a, w.idx(house.x, house.y), SiteKind.House, time, house.id)) return;
      const jt = s.state.jetty;
      if (jt && jt.progress < 1 && !this.blocked.has(jt.shore) && this.goTo(a, jt.shore, SiteKind.Jetty, time)) {
        a.carry = CarryKind.Log;
        return;
      }
      // Stone work: fetch a stone from the store, then lay it.
      if (a.carry === CarryKind.Stone) {
        const site = this.nextLineSite(s);
        const stand = site >= 0 ? standCell(w, site, a.x, a.y) : -1;
        if (stand >= 0 && this.goTo(a, stand, SiteKind.Line, time, site)) {
          this.reserved.add(site);
          return;
        }
        if (site >= 0) this.blocked.set(site, time.day + 3);
        a.carry = CarryKind.None;
      } else if (this.nextLineSite(s) >= 0) {
        const store = this.buildings.find((b) => b.settlement === s.state.id && b.kind === 'store');
        if (store && this.goTo(a, w.idx(store.x, store.y), SiteKind.Quarry, time)) return;
      }
      const cell = PARAMS.villagersBuildPlans ? this.nearestPlanCell(a, s, host) : -1;
      if (cell >= 0 && this.goTo(a, cell, SiteKind.Earthwork, time)) {
        this.reserved.add(cell);
        a.carry = w.plan[cell]! > w.terrain(cell) ? CarryKind.Earth : CarryKind.None;
        return;
      }
    }
    if (a.job === Job.Woodcutter) {
      const site = this.chopSite(a, s);
      if (site && this.goTo(a, site[1], SiteKind.Chop, time, site[0])) {
        this.reserved.add(site[0]);
        return;
      }
    }
    if (a.job === Job.Herder && this.herd(a, s, time)) return;
    if (a.job === Job.Fisher && time.season !== 3) {
      const spot = this.fishingSpot(a, s);
      if (spot >= 0 && this.goTo(a, spot, SiteKind.Fish, time)) {
        this.reserved.add(spot);
        return;
      }
    }
    if (a.job === Job.Farmer && time.season !== 3) {
      const job = this.fieldTask(a, s, time);
      if (job && this.goTo(a, job[0], job[1], time)) {
        this.reserved.add(job[0]);
        return;
      }
    }
    // Nothing to do: wander near home and rest (in hard times: by the store).
    const tired = s.state.mood === -1;
    const store = tired ? this.buildings.find((b) => b.settlement === s.state.id && b.kind === 'store') : undefined;
    const r = store ? 1 + this.rng.int(0, 2) : 2 + this.rng.int(0, 6);
    const ang = this.rng.range(0, Math.PI * 2);
    const x = Math.round((store?.x ?? s.state.x) + Math.cos(ang) * r);
    const y = Math.round((store?.y ?? s.state.y) + Math.sin(ang) * r);
    if (w.inBounds(x, y) && w.water[w.idx(x, y)]! < 0.05 && this.goTo(a, w.idx(x, y), SiteKind.Wander, time)) return;
    a.task = Task.Rest;
    a.timer = 40;
    a.anim = EntityAnim.Idle;
  }

  /**
   * Herders: the first herder of a village leads the herd out to pasture
   * (cows and sheep follow), watches it graze, and brings the milk home
   * when they all head back; a second one goes along. In winter the herd
   * stays in the fold. Returns whether a task was set.
   */
  private herd(a: Agent, s: Settlement, time: SimTime): boolean {
    const st = s.state;
    const h = st.herd;
    if (!h || h.fold < 0 || this.herds.grazers(st.id) <= 0) return false;
    const lead = this.agents.find((b) => b.settlement === st.id && b.job === Job.Herder && b.task !== Task.Leave);
    if (lead !== a) {
      // Along with the herd: to the pasture while it is out, else by the fold.
      if (h.out && h.pasture >= 0 && this.goTo(a, this.near(h.pasture, 2), SiteKind.Wander, time)) return true;
      return false;
    }
    if (h.out) {
      // Interrupted while out (flood flight…): bring them home.
      this.herds.setOut(s, false);
      h.restUntil = time.step + HERDING.rest;
      return false;
    }
    if (time.step < h.restUntil) return false;
    const winter = time.season === 3 || h.pasture < 0;
    const to = winter ? h.fold : h.pasture;
    if (!this.goTo(a, this.near(to, 1), SiteKind.Herd, time, to)) return false;
    this.herds.setOut(s, !winter);
    return true;
  }

  /** A dry cell near cell c (within r), or c itself. */
  private near(c: number, r: number): number {
    const w = this.world;
    const W = w.width;
    for (let k = 0; k < 6; k++) {
      const x = (c % W) + this.rng.int(-r, r + 1);
      const y = ((c / W) | 0) + this.rng.int(-r, r + 1);
      if (!w.inBounds(x, y)) continue;
      const i = w.idx(x, y);
      if (w.water[i]! < 0.02 && w.landuse[i] !== LandUse.Building) return i;
    }
    return c;
  }

  /** Children: run to a spot between the houses, pause, run on. */
  private play(a: Agent, s: Settlement, time: SimTime): void {
    const w = this.world;
    const homes = this.buildings.filter((b) => b.settlement === s.state.id && b.kind !== 'ruin' && b.progress >= 1);
    const h = homes.length ? homes[this.rng.int(0, homes.length)]! : { x: s.state.x, y: s.state.y };
    const r = 1.5 + this.rng.range(0, 2.5);
    const ang = this.rng.range(0, Math.PI * 2);
    const x = Math.round(h.x + Math.cos(ang) * r);
    const y = Math.round(h.y + Math.sin(ang) * r);
    if (w.inBounds(x, y)) {
      const i = w.idx(x, y);
      if (w.water[i]! < 0.02 && w.landuse[i] !== LandUse.Building && this.goTo(a, i, SiteKind.Wander, time)) return;
    }
    a.task = Task.Rest;
    a.timer = 20;
    a.anim = EntityAnim.Idle;
  }

  /** Run uphill to the nearest dry, higher place. */
  private flee(a: Agent, time: SimTime): void {
    const w = this.world;
    const here = this.cellOf(a);
    const h0 = w.terrain(here);
    let best = -1;
    let bestScore = -Infinity;
    for (let r = 2; r <= 14; r += 2) {
      for (let k = 0; k < 12; k++) {
        const ang = (k / 12) * Math.PI * 2;
        const x = Math.round(a.x + Math.cos(ang) * r);
        const y = Math.round(a.y + Math.sin(ang) * r);
        if (!w.inBounds(x, y)) continue;
        const i = w.idx(x, y);
        if (w.water[i]! > 0.02) continue;
        const score = w.terrain(i) - h0 - r * 0.2;
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      }
      if (best >= 0 && bestScore > 1) break;
    }
    if (best < 0) return;
    // Drop whatever was in hand; the work is abandoned.
    if (this.goTo(a, best, SiteKind.Wander, time)) {
      a.flee = true;
      if (a.carry === CarryKind.Earth) a.carry = CarryKind.None;
    }
  }

  private nearestPlanCell(a: Agent, s: Settlement, host: PeopleHost): number {
    const w = this.world;
    const W = w.width;
    let best = -1;
    let bestD = Infinity;
    let scanned = 0;
    for (const i of host.planCells()) {
      if (Number.isNaN(w.plan[i]!) || this.reserved.has(i) || this.blocked.has(i)) continue;
      const x = i % W;
      const y = (i / W) | 0;
      if (Math.hypot(x - s.state.x, y - s.state.y) > REACH) continue;
      const d = Math.hypot(x - a.x, y - a.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
      if (++scanned > 600) break;
    }
    return best;
  }

  private fieldTask(a: Agent, s: Settlement, time: SimTime): [number, SiteKind] | null {
    const w = this.world;
    const W = w.width;
    let best: [number, SiteKind] | null = null;
    let bestScore = -Infinity;
    const canSow = time.season === 0 || (time.season === 1 && time.dayOfSeason < 6);
    for (const i of this.fieldsOf(s)) {
      if (this.reserved.has(i) || this.blocked.has(i) || w.water[i]! > 0.05) continue;
      const c = w.crop[i]!;
      let kind: SiteKind;
      let prio: number;
      if (c >= CROP_RIPE) {
        kind = SiteKind.Harvest;
        prio = 3;
      } else if (c === 0 && canSow) {
        kind = SiteKind.Sow;
        prio = 2;
      } else if (c > 0) {
        kind = SiteKind.Tend;
        prio = 0.5;
      } else continue;
      const d = Math.hypot((i % W) - a.x, ((i / W) | 0) - a.y);
      const score = prio * 10 - d + this.rng.next();
      if (score > bestScore) {
        bestScore = score;
        best = [i, kind];
      }
    }
    return best;
  }

  /** Plan a walk to `cell`; returns false (and blocks the site) if unreachable. */
  private goTo(a: Agent, cell: number, kind: SiteKind, time: SimTime, site = cell): boolean {
    const path = this.pf.find(this.cellOf(a), cell, { window: REACH + 8, maxExpand: 4000, bridge: this.onBridge });
    if (!path) {
      this.blocked.set(cell, time.day + 3);
      return false;
    }
    a.path = path;
    a.pathPos = 0;
    a.task = Task.Walk;
    a.siteKind = kind;
    a.site = site;
    return true;
  }

  private rebuildReserved(): void {
    this.reserved.clear();
    for (const a of this.agents) {
      const k = a.siteKind;
      const claims =
        k === SiteKind.Earthwork ||
        k === SiteKind.Sow ||
        k === SiteKind.Tend ||
        k === SiteKind.Harvest ||
        k === SiteKind.Fish ||
        k === SiteKind.Chop ||
        k === SiteKind.Line;
      if ((a.task === Task.Walk || a.task === Task.Work) && claims) {
        this.reserved.add(a.site);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Persistence

  getState(): PeopleState {
    return structuredClone({
      nextId: this.nextId,
      agents: this.agents,
      settlements: this.settlements.map((s) => s.state),
      buildings: this.buildings,
      blocked: [...this.blocked],
      rng: this.rng.getState(),
      founded: this.founded,
      startX: this.startX,
      startY: this.startY,
      lastDay: this.lastDay,
      fish: Array.from(this.fish),
      fishCap: Array.from(this.fishCap),
      lastFounding: this.lastFounding,
      peak: this.peakPopulation,
      floods: this.floods,
      animals: this.herds.animals,
      noAnimals: this.noAnimals,
      summerSurvey: this.summerSurvey ? Array.from(this.summerSurvey, (v) => Math.round(v * 1000) / 1000) : undefined,
    });
  }

  setState(st: PeopleState): void {
    const c = structuredClone(st);
    this.nextId = c.nextId;
    this.agents = c.agents;
    this.settlements = c.settlements.map((ss) => {
      const s = new Settlement(ss.id, ss.x, ss.y, 0, 0);
      s.state = ss;
      return s;
    });
    this.buildings = c.buildings;
    this.blocked = new Map(c.blocked);
    this.rng.setState(c.rng);
    this.founded = c.founded;
    this.startX = c.startX;
    this.startY = c.startY;
    this.lastDay = c.lastDay;
    this.lastFounding = c.lastFounding ?? 0;
    this.peakPopulation = c.peak ?? 0;
    this.floods = c.floods ?? { cells: 0, ruined: 0 };
    this.herds.animals = c.animals ?? [];
    this.noAnimals = c.noAnimals ?? false;
    this.summerSurvey = c.summerSurvey ? Float32Array.from(c.summerSurvey) : null;
    if (c.fish && c.fish.length === this.fish.length) this.fish.set(c.fish);
    // Capacity is recomputed daily; restore the day's value so a load mid-day continues exactly.
    if (c.fishCap && c.fishCap.length === this.fishCap.length) this.fishCap.set(c.fishCap);
    this.buildingsDirty = true;
    this.updateMoisture();
    this.updateQuays();
    this.quayDirty = true;
    this.jettyDirty = true;
  }
}
