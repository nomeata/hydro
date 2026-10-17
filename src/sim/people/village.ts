/**
 * The people system (docs/PEOPLE.md, phase M3-α "first village"):
 * founding, houses, job quotas, fields and crops, builders that realise the
 * player's plans, and the agents doing all of it. Land grows crops, agents
 * collect them, the settlement only decides (see §2 of the design).
 */
import { CarryKind, EntityAnim, FISH_BLOCK, type SimTime } from '../../shared/protocol';
import { Rng } from '../../shared/rng';
import { DAYS_PER_SEASON, DAYS_PER_YEAR, STEPS_PER_DAY } from '../constants';
import { REVEALED } from '../fog';
import { PARAMS } from '../params';
import { applyEarthwork } from '../plans/plans';
import { LandUse, SOIL_PROPS, type World } from '../world';
import { Job, SiteKind, Task, packEntities, walk, type Agent } from './agents';
import { PathFinder } from './path';
import { Settlement, type SettlementState } from './settlement';

/** Hydro steps between agent updates. */
export const PEOPLE_TICK = 2;
/** Founding happens this many steps into a new game. */
const FOUND_AFTER = STEPS_PER_DAY / 3;
/** How far (cells) a settlement works: fields, houses, plans. */
export const REACH = 40;
const FIELD_RADIUS = 22;
const FIELDS_PER_FARMER = 6;
const CROP_RIPE = 230;
/** Food (person-days) per harvested cell at fertility 1 and good moisture. */
const YIELD = 34;
/** Earth moved per builder visit (m). */
const DIG_PER_VISIT = 0.5;
/** House construction progress per builder visit. */
const BUILD_PER_VISIT = 0.12;
export { FISH_BLOCK };
/** Fish stock (person-days of food) per calm, deep water cell at capacity. */
const FISH_PER_CELL = 8;
/** Logistic growth rate of fish per day. */
const FISH_GROWTH = 0.06;
/** Food landed by one fishing session at full stock (person-days). */
const CATCH = 5;
/** Water drawn by a growing field per day (m). */
const FIELD_DRAW = 0.004;

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
  /** Block attractiveness (0..~1.15) needed. */
  minScore: 0.55,
  /** Food (person-days) the founders bring. */
  food: 300,
};
export const ATTRACT_BLOCK = 8;

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
  /** People; `fishing` ones start with a rod at their (shore) cell. */
  people: { x: number; y: number; job: 'farmer' | 'fisher' | 'builder'; variant?: number; fishing?: boolean }[];
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
  /** Day of the latest founding (absent in older saves). */
  lastFounding?: number;
  /** Highest total population so far (tool unlocks). */
  peak?: number;
}

export interface PeopleHost {
  /** Called when a cell's terrain changed. */
  terrainChanged(i: number): void;
  /** Called when the plan of a cell changed. */
  planChanged(): void;
  /** Plan cells in placement order (may include finished ones). */
  planCells(): readonly number[];
  /** Water removed from the world by fields (m³), for the ledger. */
  waterUsed(m3: number): void;
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
  /** Block attractiveness from the latest survey (debugging/tests; recomputed before use). */
  attractiveness: Float32Array | null = null;

  constructor(
    private readonly world: World,
    seed: number,
    private startX: number,
    private startY: number,
  ) {
    this.rng = new Rng(seed ^ 0x9e0b1e);
    this.pf = new PathFinder(world);
    this.fieldMoisture = new Float32Array(world.size);
    this.nearestWater = new Int32Array(world.size).fill(-1);
    this.waterDist = new Float32Array(world.size);
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
  }

  entities(speed: number) {
    return packEntities(this.agents, speed);
  }

  // ---------------------------------------------------------------------------
  // Founding

  private found(): void {
    this.founded = true;
    const site = this.bestSite(this.startX, this.startY, 30);
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
      this.agents.push({
        id: this.nextId++,
        settlement: s.state.id,
        variant: p.variant ?? this.rng.int(0, 10),
        x: p.x,
        y: p.y,
        heading: 0,
        job: jobs[p.job],
        // Fishing: a zero-length walk to the spot; arriving starts the session.
        task: p.fishing ? Task.Walk : Task.None,
        siteKind: p.fishing ? SiteKind.Fish : SiteKind.None,
        site: p.fishing ? cell : -1,
        path: p.fishing ? [cell] : [],
        pathPos: 0,
        timer: 0,
        carry: CarryKind.None,
        load: 0,
        anim: EntityAnim.Idle,
        vx: 0,
        vy: 0,
      });
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
    this.updateFloodMemory();
    for (const [site, until] of this.blocked) if (until <= time.day) this.blocked.delete(site);
    const doy = time.season * DAYS_PER_SEASON + time.dayOfSeason;
    this.growCrops(time, host);
    this.updateFishCapacity();
    this.growFish(time);
    for (const s of this.settlements) {
      this.updateSafety(s);
      s.day(doy, this.rng);
      this.syncPopulation(s);
      this.planHouses(s);
      this.assignJobs(s, host);
      this.manageFields(s);
    }
    this.peakPopulation = Math.max(this.peakPopulation, this.population);
    if (time.day % FOUNDING.everyDays === 0) this.considerFounding(time);
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
            const wet = m < 0.15 ? 0 : m < 0.35 ? (m - 0.15) / 0.2 : m < 0.9 ? 1 : 0.4;
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
    const a = this.surveyLand();
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
      this.fieldMoisture[i] = Math.max(own, 0.8 * Math.exp(-d[i]! / 2.5));
    }
  }

  /** Memories of floods fade over about five years. */
  private updateFloodMemory(): void {
    const w = this.world;
    for (let i = 0; i < w.size; i++) if (w.floodMemory[i]! > 0 && w.water[i]! <= 0.3) w.floodMemory[i]!--;
  }

  /** Floods are noticed as they happen: houses in deep water are ruined, flooded land remembered. */
  private floodHouses(): void {
    const w = this.world;
    for (let i = 0; i < w.size; i++) {
      if (w.water[i]! > 0.3 && w.landuse[i] !== LandUse.None) w.floodMemory[i] = 255;
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
        const f = m < 0.15 ? 0 : m < 0.35 ? (m - 0.15) / 0.2 : m < 0.9 ? 1 : 0.4;
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

  /** Spawn arrivals / send away leavers so agents match the settlement's population. */
  private syncPopulation(s: Settlement): void {
    const mine = this.agents.filter((a) => a.settlement === s.state.id && a.task !== Task.Leave);
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
    const mine = this.agents.filter((a) => a.settlement === s.state.id && a.task !== Task.Leave);
    const n = mine.length;
    const houseWork = this.buildings.some((b) => b.settlement === s.state.id && b.kind === 'house' && b.progress < 1);
    const planWork =
      PARAMS.villagersBuildPlans && host.planCells().some((i) => !Number.isNaN(this.world.plan[i]!) && this.settlementNear(i) === s);
    const want = new Map<Job, number>();
    want.set(Job.Builder, houseWork || planWork ? Math.max(1, Math.round(n * (planWork ? 0.45 : 0.25))) : 0);
    // Fishers: as many as the waters sustain (one landing ≈ CATCH a day), up to a quarter.
    want.set(Job.Fisher, n >= 3 ? Math.min(Math.round(n * 0.25), Math.round(this.fishSupply(s) / CATCH)) : 0);
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
        const wet = m < 0.15 ? 0 : m < 0.35 ? (m - 0.15) / 0.2 : m < 0.9 ? 1 : 0.4;
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
        const arrived = walk(this.world, a, PEOPLE_TICK);
        a.anim = a.flee ? EntityAnim.Run : a.carry !== CarryKind.None ? EntityAnim.Carry : EntityAnim.Walk;
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
        break;
      }
      default:
        a.task = Task.Rest;
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
          break;
        }
        if (caught > 0.3) {
          a.load = caught;
          a.carry = CarryKind.Fish;
        }
        break;
      }
      case SiteKind.Deliver:
        if (s && a.load > 0) s.bookFood(a.load);
        a.load = 0;
        a.carry = CarryKind.None;
        break;
    }
    void time;
  }

  private chooseTask(a: Agent, time: SimTime, host: PeopleHost): void {
    const s = this.settlements[a.settlement];
    if (!s) return;
    const w = this.world;
    // Deliver what you carry first.
    if ((a.carry === CarryKind.Sack || a.carry === CarryKind.Fish) && a.load > 0) {
      const store = this.buildings.find((b) => b.settlement === s.state.id && b.kind === 'store');
      if (store && this.goTo(a, w.idx(store.x, store.y), SiteKind.Deliver, time)) return;
    }
    if (a.job === Job.Builder) {
      const house = this.buildings.find((b) => b.settlement === s.state.id && b.kind === 'house' && b.progress < 1);
      if (house && this.goTo(a, w.idx(house.x, house.y), SiteKind.House, time, house.id)) return;
      const cell = PARAMS.villagersBuildPlans ? this.nearestPlanCell(a, s, host) : -1;
      if (cell >= 0 && this.goTo(a, cell, SiteKind.Earthwork, time)) {
        this.reserved.add(cell);
        a.carry = w.plan[cell]! > w.terrain(cell) ? CarryKind.Earth : CarryKind.None;
        return;
      }
    }
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
    // Nothing to do: wander near home and rest.
    const r = 2 + this.rng.int(0, 6);
    const ang = this.rng.range(0, Math.PI * 2);
    const x = Math.round(s.state.x + Math.cos(ang) * r);
    const y = Math.round(s.state.y + Math.sin(ang) * r);
    if (w.inBounds(x, y) && w.water[w.idx(x, y)]! < 0.05 && this.goTo(a, w.idx(x, y), SiteKind.Wander, time)) return;
    a.task = Task.Rest;
    a.timer = 40;
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
    const path = this.pf.find(this.cellOf(a), cell, { window: REACH + 8, maxExpand: 4000 });
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
        k === SiteKind.Earthwork || k === SiteKind.Sow || k === SiteKind.Tend || k === SiteKind.Harvest || k === SiteKind.Fish;
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
      lastFounding: this.lastFounding,
      peak: this.peakPopulation,
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
    if (c.fish && c.fish.length === this.fish.length) this.fish.set(c.fish);
    this.buildingsDirty = true;
    this.updateMoisture();
  }
}
