/**
 * The people system (docs/PEOPLE.md, phase M3-α "first village"):
 * founding, houses, job quotas, fields and crops, builders that realise the
 * player's plans, and the agents doing all of it. Land grows crops, agents
 * collect them, the settlement only decides (see §2 of the design).
 */
import { CarryKind, EntityAnim, type SimTime } from '../../shared/protocol';
import { Rng } from '../../shared/rng';
import { DAYS_PER_SEASON, STEPS_PER_DAY } from '../constants';
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
const DIG_PER_VISIT = 0.35;
/** House construction progress per builder visit. */
const BUILD_PER_VISIT = 0.12;
/** Water drawn by a growing field per day (m). */
const FIELD_DRAW = 0.004;

export interface Building {
  id: number;
  kind: 'house' | 'store';
  settlement: number;
  x: number;
  y: number;
  rot: number;
  /** 0..1 construction progress. */
  progress: number;
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
  private rng: Rng;
  private nextId = 1;
  private founded = false;
  private blocked = new Map<number, number>();
  /** Cells currently targeted by someone. */
  private reserved = new Set<number>();
  private lastDay = -1;

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
    this.updateMoisture();
  }

  get population(): number {
    return this.settlements.reduce((n, s) => n + s.state.population, 0);
  }

  /** Builders available near cell i (for deciding whether the spirit crew helps). */
  settlementNear(i: number): Settlement | null {
    const W = this.world.width;
    const x = i % W;
    const y = (i / W) | 0;
    for (const s of this.settlements) {
      if (Math.hypot(s.state.x - x, s.state.y - y) <= REACH) return s;
    }
    return null;
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
    const W = this.world.width;
    const sx = site % W;
    const sy = (site / W) | 0;
    // The founders bring enough food to last until the first harvest.
    const s = new Settlement(this.settlements.length, sx, sy, 0, 400);
    this.settlements.push(s);
    this.addBuilding('store', s.state.id, sx, sy);
    this.buildings[this.buildings.length - 1]!.progress = 1;
    s.state.population = 4;
    this.syncPopulation(s);
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
    const i = this.world.idx(x, y);
    this.world.landuse[i] = LandUse.Building;
    this.world.vegetation[i] = Math.min(this.world.vegetation[i]!, 0.1);
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
    for (const s of this.settlements) {
      this.updateSafety(s);
      s.day(doy, this.rng);
      this.syncPopulation(s);
      this.planHouses(s);
      this.assignJobs(s, host);
      this.manageFields(s);
    }
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

  private updateFloodMemory(): void {
    const w = this.world;
    for (let i = 0; i < w.size; i++) {
      if (w.water[i]! > 0.3 && w.landuse[i] !== LandUse.None) w.floodMemory[i] = 255;
      else if (w.floodMemory[i]! > 0) w.floodMemory[i]!--;
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

  private spawnAt(s: Settlement, dist: number): Agent | null {
    const w = this.world;
    const edge = this.edgePoint(s, dist, null);
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
    const path = this.pf.find(edge, centre, { window: 40 });
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
    const building = this.buildings.some((b) => b.settlement === s.state.id && b.progress < 1);
    if (building || !s.wantsHouse()) return;
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
    const houseWork = this.buildings.some((b) => b.settlement === s.state.id && b.progress < 1);
    const planWork = host.planCells().some((i) => !Number.isNaN(this.world.plan[i]!) && this.settlementNear(i) === s);
    const builders = houseWork || planWork ? Math.max(1, Math.round(n * (planWork ? 0.45 : 0.25))) : 0;
    let b = mine.filter((a) => a.job === Job.Builder).length;
    // Move at most two people per day, lowest ids first (deterministic, no flip-flop).
    let moves = 2;
    for (const a of mine) {
      if (moves === 0) break;
      if (b < builders && a.job !== Job.Builder) {
        a.job = Job.Builder;
        b++;
        moves--;
      } else if (b > builders && a.job === Job.Builder) {
        a.job = Job.Farmer;
        b--;
        moves--;
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
        const m = this.fieldMoisture[i]!;
        const wet = m < 0.15 ? 0 : m < 0.35 ? (m - 0.15) / 0.2 : m < 0.9 ? 1 : 0.4;
        const forest = Math.max(0, w.vegetation[i]! - 0.45);
        const suit = w.fertility[i]! * wet - r / (FIELD_RADIUS * 4) - forest;
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
        if (w.landuse[i] === LandUse.Field) out.push(i);
      }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Agents

  private cellOf(a: Agent): number {
    return this.world.idx(Math.round(a.x), Math.round(a.y));
  }

  private updateAgent(a: Agent, time: SimTime, host: PeopleHost): void {
    switch (a.task) {
      case Task.Leave:
      case Task.Walk: {
        const arrived = walk(this.world, a, PEOPLE_TICK);
        a.anim = a.carry !== CarryKind.None ? EntityAnim.Carry : EntityAnim.Walk;
        if (arrived && a.task === Task.Walk) this.arrive(a);
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
        const i = a.site;
        const target = w.plan[i]!;
        if (!Number.isNaN(target)) {
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
    if (a.carry === CarryKind.Sack && a.load > 0) {
      const store = this.buildings.find((b) => b.settlement === s.state.id && b.kind === 'store');
      if (store && this.goTo(a, w.idx(store.x, store.y), SiteKind.Deliver, time)) return;
    }
    if (a.job === Job.Builder) {
      const house = this.buildings.find((b) => b.settlement === s.state.id && b.progress < 1);
      if (house && this.goTo(a, w.idx(house.x, house.y), SiteKind.House, time, house.id)) return;
      const cell = this.nearestPlanCell(a, s, host);
      if (cell >= 0 && this.goTo(a, cell, SiteKind.Earthwork, time)) {
        this.reserved.add(cell);
        a.carry = w.plan[cell]! > w.terrain(cell) ? CarryKind.Earth : CarryKind.None;
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
      const claims = k === SiteKind.Earthwork || k === SiteKind.Sow || k === SiteKind.Tend || k === SiteKind.Harvest;
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
    this.buildingsDirty = true;
    this.updateMoisture();
  }
}
