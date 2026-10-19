/**
 * Scripted "player bots" for the playtest harness (tools/playtest.ts). Each
 * bot looks at the world like a player would (where are the dry fields, the
 * river, the floodplain), and issues ordinary player commands through
 * `Simulation.command`, respecting the tool unlocks. Bots are checked on a
 * schedule (`check`), may act several times (e.g. for each new village) and
 * report what they did and which cells they expect to change ("targets"),
 * so the harness can measure how quickly a visible response follows.
 *
 * Earthworks are `shapeLine` commands (the brushes' rules, applied at once)
 * and every bot has the same earth budget (`BotOptions.budget`, m³ moved,
 * dug plus raised, over the run; `earthOf` estimates a plan's share before
 * it is issued). Stone works (weirs) and wheels are built by the crew and
 * do not count against it.
 */
import type { Command, Pt } from '../../src/shared/protocol';
import { isUnlocked } from '../../src/shared/unlocks';
import type { Settlement } from '../../src/sim/people/settlement';
import type { Simulation } from '../../src/sim/sim';
import { CELL, CELL_AREA, DT, STEPS_PER_DAY } from '../../src/sim/constants';
import { CROP_MOISTURE } from '../../src/sim/people/village';
import { rasterisePath, type PlanGrid } from '../../src/sim/plans/plans';
import { WEIR_MAX_HEIGHT } from '../../src/sim/structures/structures';
import { wheelSite, wheelSites, type WheelGrid } from '../../src/sim/structures/wheel';
import { LandUse } from '../../src/sim/world';
import { canalCommand, earthOf, footprintOf, planCanal, worthOf, type CanalPlan, type CanalStart } from './canal';
import {
  cellsAround,
  cellX,
  cellY,
  crossLine,
  dist,
  fieldsOf,
  flowDir,
  homesOf,
  isRiver,
  isShore,
  isWater,
  lineClear,
  polyLength,
  routeAround,
  lineRevealed,
  lowestOn,
  pt,
  saturation,
  speed,
  villages,
} from './geo';

export interface BotAction {
  /** Game day the action was taken. */
  day: number;
  /** Village it was meant for (settlement id). */
  village: number;
  /** What the bot did, in words. */
  note: string;
  /** Player commands issued. */
  commands: Command[];
  /** Cells the action should visibly change (for the response latency). */
  targets: number[];
  /** Diagnostic numbers (e.g. the target's moisture before, the earth it moves). */
  info?: Record<string, number>;
}

export interface Bot {
  readonly name: string;
  readonly description: string;
  /** Look at the world and return the actions to take now (commands not yet issued). */
  check(sim: Simulation, day: number): BotAction[];
}

export interface BotOptions {
  /** Let bots use tools before their population unlock (experiments). */
  ignoreUnlocks?: boolean;
  /** Earth each bot may move over the run (m³). */
  budget?: number;
}

/** Default earth budget per bot over a run (m³ dug plus raised): about two good canals' worth. */
export const EARTH_BUDGET = 6000;

/** Whether a tool is usable now (unlocks by the highest population so far). */
export function unlocked(sim: Simulation, tool: string): boolean {
  const p = sim.people;
  const peak = p ? Math.max(p.peakPopulation, p.population) : 0;
  return isUnlocked(tool, peak);
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** Point `back` cells before b on the way from a to b. */
function shortOf(a: Pt, b: Pt, back: number): Pt {
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (l <= back + 1) return b;
  const t = (l - back) / l;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * Shape the ground along a line to a target profile at once (the sim's
 * shapeLine: the brushes' rules for conservation, loose earth and what is in
 * the way; the earth moved is counted in Simulation.brush.moved).
 */
function shape(tool: 'dig' | 'raise', points: Pt[], width: number, amount: number, floor?: [number, number]): Command[] {
  return [{ type: 'shapeLine', tool, points, width, amount, ...(floor ? { floor } : {}) }];
}

/** A bot's earth account. */
class Earth {
  spent = 0;
  constructor(readonly budget: number) {}
  get left(): number {
    return Math.max(0, this.budget - this.spent);
  }
  /** Book `m3` if it fits (true), else nothing. */
  take(m3: number): boolean {
    if (m3 > this.left) return false;
    this.spent += m3;
    return true;
  }
}

/** Houses are built within 12 cells of a village's centre: canals keep out of most of that ring. */
const HOME_RING = 10;

/** Field radius of a village (people/village.ts FIELD_RADIUS). */
const FIELD_RADIUS = 18;

/**
 * Dry land a player would want green near village s: fields and fertile open
 * land within the field radius that natural water does not keep moist
 * (no water within 2 cells and field moisture below what crops need
 * in summer: own saturation alone).
 */
export function dryLand(sim: Simulation, s: Settlement, r = FIELD_RADIUS): Set<number> {
  const w = sim.world;
  const m = sim.people!.fieldMoisture;
  const out = new Set<number>();
  const near = (i: number, d: number) => {
    const x = cellX(w, i);
    const y = cellY(w, i);
    for (let dy = -d; dy <= d; dy++)
      for (let dx = -d; dx <= d; dx++) if (w.inBounds(x + dx, y + dy) && w.water[w.idx(x + dx, y + dy)]! > 0.05) return true;
    return false;
  };
  for (const i of cellsAround(sim, s.state.x, s.state.y, r)) {
    const lu = w.landuse[i];
    if (lu !== LandUse.Field && lu !== LandUse.None) continue;
    if (w.water[i]! > 0.01 || dist(w, i, s.state.x, s.state.y) < 3) continue;
    if (lu === LandUse.None && (w.fertility[i]! < 0.35 || w.vegetation[i]! > 0.7)) continue;
    if (near(i, 2)) continue;
    if (m[i]! >= 0.7) continue;
    out.add(i);
  }
  return out;
}

/** Bots that act once per village (and look again on later checks for new villages). */
abstract class PerVillageBot implements Bot {
  abstract readonly name: string;
  abstract readonly description: string;
  protected done = new Set<number>();
  check(sim: Simulation, day: number): BotAction[] {
    const out: BotAction[] = [];
    for (const s of villages(sim)) {
      if (this.done.has(s.state.id)) continue;
      const a = this.forVillage(sim, s, day);
      if (a) {
        this.done.add(s.state.id);
        out.push(a);
      }
    }
    return out;
  }
  protected abstract forVillage(sim: Simulation, s: Settlement, day: number): BotAction | null;
}

/**
 * Round 2's irrigation bot (kept for comparison): a trench from the nearest
 * river or lake that can feed it by gravity to the village's driest land.
 */
export class IrrigateBot extends PerVillageBot {
  readonly name = 'irrigate';
  readonly description = 'trench from the nearest river/lake that can feed it by gravity into the driest land by the village (round 2)';
  constructor(private readonly earth = new Earth(EARTH_BUDGET)) {
    super();
  }
  protected forVillage(sim: Simulation, s: Settlement, day: number): BotAction | null {
    const w = sim.world;
    const m = sim.people!.fieldMoisture;
    const fields = fieldsOf(sim, s);
    if (fields.length < 6) return null;
    const land = cellsAround(sim, s.state.x, s.state.y, 17).filter((i) => {
      const lu = w.landuse[i];
      if ((lu !== LandUse.Field && lu !== LandUse.None) || isWater(w, i) || dist(w, i, s.state.x, s.state.y) < 4) return false;
      return m[i]! < CROP_MOISTURE.moist && (lu === LandUse.Field || w.fertility[i]! >= 0.4);
    });
    let best: { src: number; depth: number; route: Pt[]; T: Pt } | null = null;
    let pool = fields;
    let dry: number[] = [];
    for (const p of land.length >= 12 ? [land, fields] : [fields]) {
      if (best) break;
      pool = p;
      pool.sort((a, b) => m[a]! - m[b]! || a - b);
      dry = pool.slice(0, Math.max(4, Math.ceil(pool.length / 4)));
      const cx = mean(dry.map((i) => cellX(w, i)));
      const cy = mean(dry.map((i) => cellY(w, i)));
      const aims = [...dry].sort((a, b) => dist(w, a, cx, cy) - dist(w, b, cx, cy) || a - b);
      for (const strict of [true, false]) {
        if (best) break;
        for (const target of aims.filter((_, k) => k % 3 === 0).slice(0, 8)) {
          const T = pt(w, target);
          const cands: { src: number; depth: number; score: number; end: Pt }[] = [];
          for (const j of cellsAround(sim, T[0], T[1], strict ? 70 : 50)) {
            if (!isShore(w, j)) continue;
            const S = pt(w, j);
            const end = shortOf(S, T, 1);
            const zEnd = w.terrain(w.idx(Math.round(end[0]), Math.round(end[1])));
            if (strict && zEnd < w.surface(j) + 0.3) continue;
            const depth = Math.max(1, zEnd - w.surface(j) + 0.4);
            if (depth > (strict ? 1.3 : 3)) continue;
            cands.push({ src: j, depth, score: Math.hypot(S[0] - T[0], S[1] - T[1]) + 8 * depth, end });
          }
          cands.sort((a, b) => a.score - b.score || a.src - b.src);
          for (const c of cands.filter((_, k) => k % 2 === 0).slice(0, 20)) {
            const route = routeAround(sim, pt(w, c.src), c.end);
            if (route) {
              best = { src: c.src, depth: c.depth, route, T };
              break;
            }
          }
          if (best) break;
        }
      }
    }
    if (!best) return null;
    const commands = shape('dig', best.route, 2, best.depth);
    const earth = earthOf(sim, commands);
    if (!this.earth.take(earth)) return null;
    const T = best.T;
    const targets = dry.filter((i) => dist(w, i, T[0], T[1]) < 8);
    return {
      day,
      village: s.state.id,
      note: `canal ${Math.round(polyLength(best.route))} cells${best.route.length > 2 ? ' (dogleg)' : ''}, depth ${best.depth.toFixed(1)} m, to ${dry.length} driest ${pool === land ? 'cells' : 'fields'}`,
      commands,
      targets,
      info: { moistureBefore: mean(targets.map((i) => m[i]!)), fields: fields.length, earth },
    };
  }
}

// ---------------------------------------------------------------------------
// (a) Weir + canal

/** A weir site and the pool behind it. */
interface WeirSite {
  line: [Pt, Pt];
  /** Crest height above the lowest ground on the line (the planWeir height), and its absolute level. */
  height: number;
  crest: number;
  /** Cells the pool will cover (dry now, below the crest, upstream). */
  pool: Set<number>;
  /** Fields under the pool, and the cell of the river where the weir stands. */
  poolFields: number;
  cell: number;
  /** Days the river takes to fill the pool. */
  fillDays: number;
}

/** Weir pools a stream fills within this many days are worth it. */
const WEIR_FILL_DAYS = 12;

/** The pool behind a weir across the river at cell i with crest `crest`, or null if it would flood houses or leak round the ends. */
function weirPool(sim: Simulation, i: number, line: [Pt, Pt], crest: number): { pool: Set<number>; fields: number; volume: number } | null {
  const w = sim.world;
  const d = flowDir(w, i);
  if (!d) return null;
  const grid: PlanGrid = { width: w.width, height: w.height, plan: new Float32Array(0), idx: (x, y) => w.idx(x, y), terrain: (j) => w.terrain(j) };
  const wall = new Set(rasterisePath(grid, line, 1).keys());
  const [x0, y0] = pt(w, i);
  const up = w.idx(Math.round(x0 - d[0] * 2), Math.round(y0 - d[1] * 2));
  const down = w.idx(Math.round(x0 + d[0] * 2), Math.round(y0 + d[1] * 2));
  const R = 45;
  const seen = new Set<number>([up]);
  const stack = [up];
  const pool = new Set<number>();
  let fields = 0;
  let volume = 0;
  while (stack.length) {
    const c = stack.pop()!;
    if (c === down) return null; // round the ends
    volume += Math.max(0, crest - w.surface(c)) * CELL_AREA;
    if (w.water[c]! < 0.05) {
      pool.add(c);
      const lu = w.landuse[c];
      if (lu === LandUse.Building || (lu === LandUse.Yard && w.terrain(c) < crest + 0.2)) return null;
      if (lu === LandUse.Field && w.terrain(c) < crest - 0.1) fields++;
    }
    const cx = cellX(w, c);
    const cy = cellY(w, c);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!w.inBounds(nx, ny) || Math.hypot(nx - x0, ny - y0) > R) continue;
      const j = w.idx(nx, ny);
      if (seen.has(j) || wall.has(j)) continue;
      seen.add(j);
      if (w.terrain(j) + 0 < crest + 0.05 || w.water[j]! > 0.05) {
        // Houses near the pool's edge: their ground must stay above it.
        if (w.landuse[j] === LandUse.Building && w.terrain(j) < crest + 0.3) return null;
        if (w.terrain(j) < crest + 0.05) stack.push(j);
      }
    }
  }
  return { pool, fields, volume };
}

/** Weir sites across the river upstream of village s, best first (a few crest heights each). */
function weirSites(sim: Simulation, s: Settlement): WeirSite[] {
  const w = sim.world;
  const { x, y } = s.state;
  // Flowing water, brooks too (a weir across a brook makes a pond for a canal).
  const cand = cellsAround(sim, x, y, 45).filter((i) => w.water[i]! > 0.1 && speed(w, i) > 0.08 && dist(w, i, x, y) >= 8);
  // Spread the candidates out: at most one per 3×3 cells, nearest the middle of the stream.
  cand.sort((a, b) => w.water[b]! - w.water[a]! || a - b);
  const picked: number[] = [];
  for (const i of cand) {
    if (picked.some((j) => Math.max(Math.abs(cellX(w, i) - cellX(w, j)), Math.abs(cellY(w, i) - cellY(w, j))) < 3)) continue;
    picked.push(i);
  }
  const out: WeirSite[] = [];
  for (const i of picked.slice(0, 60)) {
    const pre = crossLine(w, i, w.surface(i), 0.3);
    if (!pre) continue;
    const bed = lowestOn(w, pre[0], pre[1]);
    // The stream's flow through the line (m³ a day).
    let q = 0;
    const n = Math.ceil(Math.hypot(pre[1][0] - pre[0][0], pre[1][1] - pre[0][1]));
    for (let k = 0; k <= n; k++) {
      const j = w.idx(Math.round(pre[0][0] + ((pre[1][0] - pre[0][0]) * k) / n), Math.round(pre[0][1] + ((pre[1][1] - pre[0][1]) * k) / n));
      q += w.water[j]! * speed(w, j) * CELL;
    }
    const perDay = (q * DT * STEPS_PER_DAY * Math.hypot(pre[1][0] - pre[0][0], pre[1][1] - pre[0][1])) / Math.max(1, n + 1);
    for (const H of [1.5, 2, 3, WEIR_MAX_HEIGHT]) {
      const crest = bed + H;
      if (crest < w.surface(i) + 0.5) continue;
      const line = crossLine(w, i, crest, 0.2, 20);
      if (!line || !lineRevealed(sim, line[0], line[1]) || !lineClear(w, line[0], line[1], 1)) continue;
      const bed2 = lowestOn(w, line[0], line[1]);
      const c2 = bed2 + H;
      const p = weirPool(sim, i, line, c2);
      if (!p) continue;
      const fillDays = p.volume / Math.max(1, perDay);
      if (fillDays > WEIR_FILL_DAYS) continue;
      out.push({ line, height: H, crest: c2, pool: p.pool, poolFields: p.fields, cell: i, fillDays });
    }
  }
  return out;
}

/** Canal starts along a pool's shore (land just above the crest, near the weir). */
function poolStarts(sim: Simulation, site: WeirSite): CanalStart[] {
  const w = sim.world;
  const [x0, y0] = pt(w, site.cell);
  const out: CanalStart[] = [];
  const level = site.crest + 0.05;
  for (const c of cellsAround(sim, x0, y0, 14)) {
    if (site.pool.has(c) || w.water[c]! > 0.05 || w.terrain(c) < level) continue;
    let shore = false;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cellX(w, c) + dx;
      const ny = cellY(w, c) + dy;
      if (!w.inBounds(nx, ny)) continue;
      const j = w.idx(nx, ny);
      if (site.pool.has(j) || (w.water[j]! > 0.05 && w.surface(j) < level + 0.5)) shore = true;
    }
    if (shore) out.push({ cell: c, level });
  }
  return out;
}

/** The best weir and canal for village s within `earth` m³, or null. */
/** Why the last weir + canal search found nothing (diagnostics). */
export const weirWhy = { targets: 0, sites: 0, starts: 0, canals: 0 };

function planWeirCanal(sim: Simulation, s: Settlement, earth: number): { site: WeirSite; canal: CanalPlan; score: number } | null {
  const targets = dryLand(sim, s);
  weirWhy.targets = targets.size;
  weirWhy.sites = weirWhy.starts = weirWhy.canals = 0;
  if (targets.size < 12) return null;
  let best: { site: WeirSite; canal: CanalPlan; score: number } | null = null;
  const sites = weirSites(sim, s);
  weirWhy.sites = sites.length;
  for (const site of sites) {
    const starts = poolStarts(sim, site);
    if (!starts.length) continue;
    weirWhy.starts++;
    // Keep clear of the weir's wall and apron (its cells are the crew's, then fixed).
    const w = sim.world;
    const grid: PlanGrid = { width: w.width, height: w.height, plan: new Float32Array(0), idx: (a, b) => w.idx(a, b), terrain: (j) => w.terrain(j) };
    const wallCells = new Set(rasterisePath(grid, site.line, 3.5).keys());
    const canal = planCanal(sim, starts, targets, { village: { x: s.state.x, y: s.state.y, r: HOME_RING }, blocked: (i) => site.pool.has(i) || wallCells.has(i), maxEarth: earth });
    if (!canal) continue;
    weirWhy.canals++;
    const score = worthOf(sim.world, canal.covered) - 1.5 * site.poolFields - canal.earth / 200;
    if (!best || score > best.score) best = { site, canal, score };
  }
  // Only works that water clearly more than the pool drowns.
  return best && best.score >= 10 ? best : null;
}

/**
 * (a) Weir + canal: once the weir is unlocked, a stone weir across the
 * river upstream of the village (crest up to 4 m above the bed; the pool may
 * not reach the houses) and a graded canal from its pool along the slope
 * onto the dry terrace fields.
 */
export class WeirCanalBot implements Bot {
  readonly name: string = 'weircanal';
  readonly description: string = 'stone weir across the river upstream, graded canal from its pool onto the dry terrace land';
  protected done = new Set<number>();
  constructor(
    protected readonly earth: Earth,
    protected readonly ignoreUnlock = false,
  ) {}
  check(sim: Simulation, day: number): BotAction[] {
    if (!this.ignoreUnlock && !unlocked(sim, 'weir')) return [];
    const out: BotAction[] = [];
    for (const s of villages(sim)) {
      if (this.done.has(s.state.id) || this.earth.left < 300) continue;
      const a = this.forVillage(sim, s, day);
      if (a) {
        this.done.add(s.state.id);
        out.push(a);
      }
    }
    return out;
  }
  protected forVillage(sim: Simulation, s: Settlement, day: number): BotAction | null {
    const w = sim.world;
    const plan = planWeirCanal(sim, s, this.earth.left);
    if (!plan || !this.earth.take(plan.canal.earth)) return null;
    const { site, canal } = plan;
    return {
      day,
      village: s.state.id,
      note: `weir ${Math.round(Math.hypot(site.line[1][0] - site.line[0][0], site.line[1][1] - site.line[0][1]))} cells, ${site.height} m (crest ${(site.crest - w.surface(site.cell)).toFixed(1)} m above the water, pool ${site.pool.size} cells, ${site.poolFields} fields, fills in ${site.fillDays.toFixed(0)} d), ${Math.round(dist(w, site.cell, s.state.x, s.state.y))} cells from the village; canal ${canal.path.length} cells waters ${canal.covered.length} dry cells, ${Math.round(canal.earth)} m³`,
      commands: [{ type: 'planWeir', points: site.line, width: 2, height: site.height }, canalCommand(canal)],
      targets: canal.covered,
      info: { earth: canal.earth, covered: canal.covered.length, crest: site.height, poolFields: site.poolFields },
    };
  }
}

/**
 * A plain contour canal for village s from flowing water upstream (no weir):
 * the river's own level, graded along the slope onto the dry land.
 */
function planRiverCanal(sim: Simulation, s: Settlement, earth: number): CanalPlan | null {
  const w = sim.world;
  const targets = dryLand(sim, s);
  if (targets.size < 12) return null;
  const starts: CanalStart[] = [];
  const seen = new Set<number>();
  for (const i of cellsAround(sim, s.state.x, s.state.y, 50)) {
    if (w.water[i]! < 0.1 || speed(w, i) < 0.08) continue;
    const x = cellX(w, i);
    const y = cellY(w, i);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      if (!w.inBounds(x + dx, y + dy)) continue;
      const c = w.idx(x + dx, y + dy);
      if (seen.has(c) || w.water[c]! > 0.05) continue;
      seen.add(c);
      starts.push({ cell: c, level: w.surface(i) - 0.05 });
    }
  }
  const canal = planCanal(sim, starts, targets, { village: { x: s.state.x, y: s.state.y, r: HOME_RING }, maxEarth: earth }, 20);
  return canal && worthOf(w, canal.covered) >= 15 ? canal : null;
}

/** A contour canal from the river (no weir) for each village, where one waters enough dry land. */
export class CanalBot extends PerVillageBot {
  readonly name = 'canal';
  readonly description = 'contour canal from flowing water upstream onto the dry land (no weir)';
  constructor(private readonly earth: Earth) {
    super();
  }
  protected forVillage(sim: Simulation, s: Settlement, day: number): BotAction | null {
    const canal = planRiverCanal(sim, s, this.earth.left);
    if (!canal || !this.earth.take(canal.earth)) return null;
    return {
      day,
      village: s.state.id,
      note: `contour canal ${canal.path.length} cells waters ${canal.covered.length} dry cells, ${Math.round(canal.earth)} m³`,
      commands: [canalCommand(canal)],
      targets: canal.covered,
      info: { earth: canal.earth, covered: canal.covered.length },
    };
  }
}

// ---------------------------------------------------------------------------
// (b) Wheel + canal

function wheelGrid(sim: Simulation): WheelGrid {
  const w = sim.world;
  return {
    width: w.width,
    height: w.height,
    terrain: (i) => w.terrain(i),
    depth: (i) => w.water[i]!,
    speed: (i) => Math.hypot(w.velX[i]!, w.velY[i]!),
    allowed: sim.fog ? (i) => w.revealed[i]! >= 128 : undefined,
  };
}

/**
 * (b) Wheel + canal: a water wheel where the current turns it well
 * (`wheelSites`), its trough onto the bank towards the terrace, and a canal
 * from its head along the slope onto the dry land. The wheel unlocks at 50
 * villagers, which few valleys reach in the bot runs' four years, so this bot
 * builds it from the start (it measures the mechanic, not the progression).
 */
export class WheelCanalBot implements Bot {
  readonly name = 'wheel';
  readonly description = 'water wheel at a good site (wheelSites), trough up the bank, canal from its head onto the dry land (before its unlock)';
  private done = new Set<number>();
  constructor(
    private readonly earth: Earth,
    private readonly ignoreUnlock = true,
  ) {}
  check(sim: Simulation, day: number): BotAction[] {
    if (!this.ignoreUnlock && !unlocked(sim, 'wheel')) return [];
    const out: BotAction[] = [];
    const w = sim.world;
    const g = wheelGrid(sim);
    const sites = wheelSites(g, 3, 400);
    for (const s of villages(sim)) {
      if (this.done.has(s.state.id) || this.earth.left < 300) continue;
      const targets = dryLand(sim, s);
      if (targets.size < 12) continue;
      let best: { pts: [Pt, Pt]; canal: CanalPlan; perDay: number; lift: number; score: number } | null = null;
      for (const site of sites) {
        if (Math.hypot(site.x - s.state.x, site.y - s.state.y) > 30) continue;
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * 2 * Math.PI;
          const end: Pt = [site.x + Math.cos(a) * 6, site.y + Math.sin(a) * 6];
          const ws = wheelSite(g, [[site.x, site.y], end]);
          if (!ws?.ok || ws.perDay < 10) continue;
          const head = w.idx(ws.hx, ws.hy);
          const starts: CanalStart[] = [];
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              if ((!dx && !dy) || !w.inBounds(ws.hx + dx, ws.hy + dy)) continue;
              const c = w.idx(ws.hx + dx, ws.hy + dy);
              if (w.water[c]! < 0.05) starts.push({ cell: c, level: w.terrain(head) });
            }
          // A wheel's water keeps only a short canal wet (it soaks into the bed and evaporates).
          const maxLen = Math.max(8, Math.min(30, ws.perDay / 2.5));
          const canal = planCanal(sim, starts, targets, { village: { x: s.state.x, y: s.state.y, r: HOME_RING }, maxEarth: this.earth.left, maxLen, blocked: (i) => i === head || i === w.idx(ws.x, ws.y) }, 10);
          if (!canal) continue;
          // The wheel's water spreads over a short canal only: favour what it can keep wet.
          const score = Math.min(canal.covered.length, ws.perDay * 1.5) - canal.earth / 200 - canal.path.length * 0.2;
          if (!best || score > best.score) best = { pts: [[site.x, site.y], end], canal, perDay: ws.perDay, lift: ws.lift, score };
        }
      }
      if (!best || !this.earth.take(best.canal.earth)) continue;
      this.done.add(s.state.id);
      out.push({
        day,
        village: s.state.id,
        note: `wheel lifting ${best.lift.toFixed(1)} m (${Math.round(best.perDay)} m³/day), canal ${best.canal.path.length} cells waters ${best.canal.covered.length} dry cells, ${Math.round(best.canal.earth)} m³`,
        commands: [{ type: 'placeWheel', points: best.pts }, canalCommand(best.canal)],
        targets: best.canal.covered,
        info: { earth: best.canal.earth, covered: best.canal.covered.length, lift: best.lift, perDay: best.perDay },
      });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// (c) Dike along the floodplain edge

/**
 * (c) Flood protection: a dike along the river side of the village's
 * floodplain, a few cells back from the water, its crest above the flood
 * the land remembers (or 1.5 m above the river), its ends tied into higher
 * ground. Looks again when new flood memory appears by a village.
 */
export class DikeBot implements Bot {
  readonly name: string = 'dike';
  readonly description: string = 'dike along the river side of the floodplain fields, crest above the remembered flood, ends tied into high ground';
  private readonly diked = new Map<number, number>();
  constructor(private readonly earth: Earth) {}
  check(sim: Simulation, day: number): BotAction[] {
    const out: BotAction[] = [];
    for (const s of villages(sim)) {
      if (this.earth.left < 300) break;
      const a = planDikes(sim, s, this.earth.left, this.diked.get(s.state.id) ?? 0);
      if (!a) continue;
      if (!this.earth.take(a.earth)) continue;
      this.diked.set(s.state.id, a.memory);
      out.push({ day, village: s.state.id, note: a.note, commands: a.commands, targets: a.targets, info: { earth: a.earth, protected: a.targets.length } });
    }
    return out;
  }
}

/** The floodplain dike(s) for village s, or null if it needs none (no new flood memory over `seen` cells). */
function planDikes(sim: Simulation, s: Settlement, earth: number, seen: number): { commands: Command[]; targets: number[]; earth: number; note: string; memory: number } | null {
  const w = sim.world;
  const { x, y } = s.state;
  const R = FIELD_RADIUS + 6;
  const around = cellsAround(sim, x, y, R);
  const river = around.filter((i) => isRiver(w, i));
  if (river.length < 4) return null;
  const surface = mean(river.map((i) => w.surface(i)));
  // The floodplain: village land (fields, open land, homes) the river flooded or that lies low.
  const remembered = around.filter((i) => !isWater(w, i) && w.floodMemory[i]! > 30);
  if (remembered.length <= seen + 8) return null;
  const top = remembered.length ? Math.max(...remembered.map((i) => w.terrain(i))) : surface;
  const crest = Math.min(surface + 2.5, Math.max(surface + 1.5, top + 0.4));
  const fields = new Set(fieldsOf(sim, s));
  const protect = around.filter((i) => !isWater(w, i) && w.terrain(i) < crest && (fields.has(i) || w.landuse[i] === LandUse.Building || w.landuse[i] === LandUse.Yard));
  if (protect.length < 10) return null;
  // The line: a band of land cells some distance back from the river. Of a few bands, the one
  // whose footprint takes the fewest fields for the low land it protects (round 4: the banks
  // took the best fields by the river).
  let best: { commands: Command[]; pieces: number; runs: number; score: number; band: number; lost: number } | null = null;
  const toWater = waterDistances(sim, around, 8);
  for (const [lo, hi] of DIKE_BANDS) {
    const plan = dikeLine(sim, around, toWater, protect, crest, lo, hi);
    if (!plan) continue;
    const foot = new Set(footprintOf(sim, plan.commands));
    const lost = [...foot].filter((i) => fields.has(i)).length;
    // Protected: the low land behind the line (farther from the water), not under the banks.
    const kept = protect.filter((i) => !foot.has(i) && (toWater.get(i) ?? Infinity) >= hi).length;
    const score = kept - 3 * lost;
    if (!best || score > best.score) best = { ...plan, score, band: lo, lost };
  }
  if (!best || best.score < 10) return null;
  const { commands, pieces } = best;
  if (!commands.length) return null;
  let cmds = commands;
  let e = earthOf(sim, cmds);
  // Over budget: keep the pieces nearest the village.
  if (e > earth) {
    const d = (c: Command) => (c.type === 'shapeLine' ? Math.min(...c.points.map((p) => Math.hypot(p[0] - x, p[1] - y))) : 0);
    cmds = [...commands].sort((p, q) => d(p) - d(q));
    while (cmds.length && e > earth) {
      cmds.pop();
      e = earthOf(sim, cmds);
    }
    if (!cmds.length) return null;
  }
  return {
    commands: cmds,
    targets: protect,
    earth: e,
    note: `${cmds.length} dike piece(s) of ${pieces} (${best.runs} run(s)) ${best.band}–${best.band + 1} cells from the river, crest ${(crest - surface).toFixed(1)} m above it, ${protect.length} low cells behind, ${best.lost} fields under the banks, ${Math.round(e)} m³`,
    memory: remembered.length,
  };
}

/** Distance (cells) from each of `cells` to the nearest open water within `r` (absent: farther). */
function waterDistances(sim: Simulation, cells: number[], r: number): Map<number, number> {
  const w = sim.world;
  const out = new Map<number, number>();
  for (const i of cells) {
    if (isWater(w, i)) {
      out.set(i, 0);
      continue;
    }
    let d = Infinity;
    const cx = cellX(w, i);
    const cy = cellY(w, i);
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (!w.inBounds(cx + dx, cy + dy)) continue;
        if (isWater(w, w.idx(cx + dx, cy + dy))) d = Math.min(d, Math.hypot(dx, dy));
      }
    if (d <= r) out.set(i, d);
  }
  return out;
}

/** Distance bands (cells from the river water) tried for a dike line, and the crest width (cells). */
const DIKE_BANDS: [number, number][] = [
  [2.5, 3.5],
  [3.5, 4.5],
  [4.5, 5.5],
  [5.5, 6.5],
];
const DIKE_WIDTH = 1;

/** The dike pieces along the band `lo`–`hi` cells from the river in front of `protect` (planDikes). */
function dikeLine(sim: Simulation, around: number[], toWater: Map<number, number>, protect: number[], crest: number, lo: number, hi: number): { commands: Command[]; pieces: number; runs: number } | null {
  const w = sim.world;
  const W = w.width;
  const near = new Map<number, number>();
  for (const i of around) {
    if (isWater(w, i) || w.terrain(i) >= crest) continue;
    const d = toWater.get(i) ?? Infinity;
    if (d >= lo && d < hi) near.set(i, d);
  }
  // Only the stretch in front of the protected land: within 6 cells of it.
  const prot = new Set(protect);
  const line = [...near.keys()].filter((i) => {
    if (w.landuse[i] === LandUse.Building || w.landuse[i] === LandUse.Yard) return false;
    const cx = cellX(w, i);
    const cy = cellY(w, i);
    for (let dy = -6; dy <= 6; dy++)
      for (let dx = -6; dx <= 6; dx++) if (w.inBounds(cx + dx, cy + dy) && prot.has(w.idx(cx + dx, cy + dy))) return true;
    return false;
  });
  if (line.length < 4) return null;
  // Chain the line cells into polylines (nearest neighbour walk), split into runs of ≤ 8 cells.
  const left = new Set(line);
  const runs: Pt[][] = [];
  while (left.size) {
    let cur = left.values().next().value as number;
    // Start at an end: walk away from the first cell as far as the chain goes.
    for (let guard = 0; guard < 2; guard++) {
      const chain: number[] = [cur];
      const used = new Set(chain);
      for (;;) {
        let nxt = -1;
        let nd = Infinity;
        const c = chain[chain.length - 1]!;
        for (const j of left) {
          if (used.has(j)) continue;
          const d = Math.hypot(cellX(w, j) - cellX(w, c), cellY(w, j) - cellY(w, c));
          if (d < 2.3 && d < nd) {
            nd = d;
            nxt = j;
          }
        }
        if (nxt < 0) break;
        chain.push(nxt);
        used.add(nxt);
      }
      if (guard === 0) cur = chain[chain.length - 1]!;
      else {
        for (const j of chain) left.delete(j);
        // Thin the chain to every other cell: a line, not a band.
        const pts = chain.filter((_, k) => k % 2 === 0 || k === chain.length - 1).map((i): Pt => [i % W, (i / W) | 0]);
        if (pts.length >= 2) runs.push(pts);
      }
    }
  }
  // Tie the ends of each run into high ground (≥ crest) within 6 cells, away from the river.
  const tie = (p: Pt, q: Pt): Pt | null => {
    const dx = p[0] - q[0];
    const dy = p[1] - q[1];
    const l = Math.hypot(dx, dy) || 1;
    for (let r = 1; r <= 6; r++) {
      const xx = Math.round(p[0] + (dx / l) * r);
      const yy = Math.round(p[1] + (dy / l) * r);
      if (!w.inBounds(xx, yy)) return null;
      const j = w.idx(xx, yy);
      if (isWater(w, j)) return null;
      if (w.terrain(j) >= crest) return [xx, yy];
    }
    return null;
  };
  const commands: Command[] = [];
  let pieces = 0;
  for (const run of runs) {
    if (run.length < 2 && polyLength(run) < 3) continue;
    const a = tie(run[0]!, run[1] ?? run[0]!);
    const b = tie(run[run.length - 1]!, run[run.length - 2] ?? run[run.length - 1]!);
    const full = [...(a ? [a] : []), ...run, ...(b ? [b] : [])];
    // Segments of ≤ 6 points, each raised to the absolute crest.
    for (let k = 0; k + 1 < full.length; k += 5) {
      const seg = full.slice(k, k + 6);
      if (seg.length < 2) continue;
      const lo = lowestOn(w, seg[0]!, seg[seg.length - 1]!);
      const lowest = Math.min(lo, ...seg.map((p) => w.terrain(w.idx(Math.round(p[0]), Math.round(p[1])))));
      if (crest - lowest < 0.2) continue;
      commands.push(...shape('raise', seg, DIKE_WIDTH, crest - lowest));
      pieces++;
    }
  }
  if (!commands.length) return null;
  return { commands, pieces, runs: runs.length };
}

// ---------------------------------------------------------------------------
// (d) Drainage

/** Shallow standing water still counts as marsh for the drainage bot (m). */
const WATER_SHALLOW = 0.3;

/**
 * A drain from the wettest patch near village s (soil saturation or field
 * moisture ≥ 0.9, or puddles) down to lower water: its floor 0.8 m below the
 * patch, graded to just under the outlet's water. `skip`: patch cores
 * already drained.
 */
function planDrain(sim: Simulation, s: Settlement, earth: number, skip: number[]): { commands: Command[]; targets: number[]; earth: number; note: string; core: number; info: Record<string, number> } | null {
  const w = sim.world;
  const m = sim.people!.fieldMoisture;
  const { x, y } = s.state;
  const wet = cellsAround(sim, x, y, 25).filter((i) => {
    const lu = w.landuse[i];
    if (lu === LandUse.Building || lu === LandUse.Yard || w.water[i]! > WATER_SHALLOW || isRiver(w, i)) return false;
    if (skip.some((c) => dist(w, i, cellX(w, c), cellY(w, c)) < 8)) return false;
    return saturation(w, i) >= 0.9 || m[i]! >= 0.9 || w.water[i]! > 0.05;
  });
  if (wet.length < 8) return null;
  const wetSet = new Set(wet);
  let core = -1;
  let coreN = -1;
  for (const i of wet) {
    let n = 0;
    for (const j of cellsAround(sim, cellX(w, i), cellY(w, i), 4, false)) if (wetSet.has(j)) n++;
    if (n > coreN) {
      coreN = n;
      core = i;
    }
  }
  if (coreN < 6) return null;
  const C = pt(w, core);
  const zC = w.terrain(core);
  const outs = cellsAround(sim, C[0], C[1], 45)
    .filter((j) => isShore(w, j) && w.surface(j) <= zC - 0.6)
    .map((j) => ({ j, d: dist(w, j, C[0], C[1]) }))
    .sort((a, b) => a.d - b.d || a.j - b.j);
  for (const o of outs.slice(0, 40)) {
    const route = routeAround(sim, C, pt(w, o.j));
    if (!route) continue;
    const f0 = zC - 0.8;
    const f1 = Math.min(f0 - 0.05, w.surface(o.j) - 0.1);
    const commands = shape('dig', route, 2, 0.8, [f0, f1]);
    const e = earthOf(sim, commands);
    if (e > earth) continue;
    const targets = wet.filter((i) => dist(w, i, C[0], C[1]) <= 6);
    return {
      commands,
      targets,
      earth: e,
      core,
      note: `drain ${Math.round(polyLength(route))} cells from a wet patch of ${coreN} cells, ${Math.round(e)} m³`,
      info: { wetCells: wet.length, saturationBefore: mean(targets.map((i) => saturation(w, i))), earth: e },
    };
  }
  return null;
}

/** (d) Drainage: drains from the wet patches near each village (up to three) down to lower water. */
export class DrainBot implements Bot {
  readonly name = 'drain';
  readonly description = 'drains from the wettest patches near the village down to lower water (up to three per village)';
  private readonly cores = new Map<number, number[]>();
  constructor(private readonly earth: Earth) {}
  check(sim: Simulation, day: number): BotAction[] {
    const out: BotAction[] = [];
    for (const s of villages(sim)) {
      const done = this.cores.get(s.state.id) ?? [];
      if (done.length >= 3 || this.earth.left < 200) continue;
      const a = planDrain(sim, s, this.earth.left, done);
      if (!a || !this.earth.take(a.earth)) continue;
      this.cores.set(s.state.id, [...done, a.core]);
      out.push({ day, village: s.state.id, note: a.note, commands: a.commands, targets: a.targets, info: a.info });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// (e) Vandal, and undoing it

/** A line the bots brushed: a canal (dig) or a bank (raise). */
interface Line {
  tool: 'dig' | 'raise';
  points: Pt[];
  width: number;
  amount: number;
}

/**
 * (e) Vandal: diverts the river into the first village: a canal from the
 * water upstream straight to the store, and a dam across the river just
 * below its intake.
 */
export class VandalBot implements Bot {
  readonly name: string = 'vandal';
  readonly description: string = 'canal from the river upstream into the village, and a dam across the river below the intake';
  private done = false;
  /** The canal and the dam, as lines (the undo bot cuts through them). */
  lines: Line[] = [];
  /** The ground under the works before they were dug (cell → height). */
  ground = new Map<number, number>();
  constructor(protected readonly earth = new Earth(Infinity)) {}
  check(sim: Simulation, day: number): BotAction[] {
    if (this.done) return [];
    const w = sim.world;
    const s = villages(sim)[0];
    if (!s) return [];
    const { x, y } = s.state;
    const V: Pt = [x, y];
    const zv = w.terrain(w.idx(Math.round(x), Math.round(y)));
    let best: { j: number; score: number } | null = null;
    for (const j of cellsAround(sim, x, y, 45)) {
      if (!isShore(w, j)) continue;
      const head = w.surface(j) - zv;
      const d = dist(w, j, x, y);
      if (d < 5) continue;
      const score = head - 0.03 * d + (isRiver(w, j) ? 0.5 : 0);
      if (!best || score > best.score) best = { j, score };
    }
    if (!best) return [];
    this.done = true;
    const S = pt(w, best.j);
    const head = w.surface(best.j) - zv;
    const canal: Line = { tool: 'dig', points: [S, V], width: 3, amount: Math.max(1.5, 1 - head + 0.5) };
    this.lines = [canal];
    const commands: Command[] = shape(canal.tool, canal.points, canal.width, canal.amount);
    // Dam the river a few cells downstream of the intake.
    const d = flowDir(w, best.j);
    if (d) {
      for (let r = 3; r <= 8; r++) {
        const xx = Math.round(S[0] + d[0] * r);
        const yy = Math.round(S[1] + d[1] * r);
        if (!w.inBounds(xx, yy)) break;
        const i = w.idx(xx, yy);
        if (!isWater(w, i)) continue;
        const line = crossLine(w, i, w.surface(i), 1.5);
        if (line && lineRevealed(sim, line[0], line[1])) {
          const dam: Line = { tool: 'raise', points: line, width: 3, amount: 3 };
          this.lines.push(dam);
          commands.push(...shape(dam.tool, dam.points, dam.width, dam.amount));
          break;
        }
      }
    }
    // Remember the ground the canal was dug into (for undoing it).
    const grid: PlanGrid = { width: w.width, height: w.height, plan: new Float32Array(0), idx: (a, b) => w.idx(a, b), terrain: (i) => w.terrain(i) };
    for (const i of rasterisePath(grid, canal.points, canal.width / 2 + 2).keys()) this.ground.set(i, w.terrain(i));
    const earth = earthOf(sim, commands);
    this.earth.take(earth);
    return [
      {
        day,
        village: s.state.id,
        note: `diversion canal from ${Math.round(dist(w, best.j, x, y))} cells away (head ${head.toFixed(1)} m)${this.lines.length > 1 ? ' + dam' : ''}, ${Math.round(earth)} m³`,
        commands,
        targets: homesOf(sim, s),
        info: { head, earth },
      },
    ];
  }
}

/** Days after the vandal's works that `undo` takes them out again. */
export const UNDO_AFTER = 48;

/**
 * (f) Vandal, then remorse: the vandal's canal and dam, and a year later the
 * dam is trenched down to the river bed and the canal filled back to the
 * ground it was dug into (in short pieces, each raised to that ground), so
 * the pond over the village has nowhere to stand; a drain from what is
 * still wet by the village follows on the next look. Measures recovery.
 */
export class UndoBot extends VandalBot {
  override readonly name = 'undo';
  override readonly description = "the vandal's works, undone a year later (dam trenched, canal filled back to the old ground, then the wet patch drained)";
  private works: Line[] | null = null;
  private at = 0;
  private stage = 0;
  private drains: number[] = [];
  override check(sim: Simulation, day: number): BotAction[] {
    if (!this.works) {
      const acts = super.check(sim, day);
      if (acts.length) {
        this.works = this.lines;
        this.at = day;
      }
      return acts;
    }
    if (day < this.at + UNDO_AFTER) return [];
    const w = sim.world;
    const s = villages(sim)[0];
    if (this.stage >= 1) {
      // Then drain what is still wet by the village (up to two drains).
      if (!s || this.stage > 2) return [];
      this.stage++;
      const a = planDrain(sim, s, Infinity, this.drains);
      if (!a) return [];
      this.drains.push(a.core);
      this.earth.take(a.earth);
      return [{ day, village: s.state.id, note: `undo: ${a.note}`, commands: a.commands, targets: a.targets, info: a.info }];
    }
    this.stage = 1;
    const commands: Command[] = [];
    for (const c of this.works) {
      if (c.tool === 'raise') {
        // Trench through the dam along the river, its floor at the bed just up- and downstream.
        const [a, b] = c.points as [Pt, Pt];
        const m: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const nx = -(b[1] - a[1]) / len;
        const ny = (b[0] - a[0]) / len;
        const u: Pt = [m[0] + nx * 4, m[1] + ny * 4];
        const d: Pt = [m[0] - nx * 4, m[1] - ny * 4];
        commands.push(...shape('dig', [u, d], Math.max(3, len - 3), 0.1));
      } else {
        // Fill the canal back to the ground it was dug into: pieces of 3 cells, each raised to that ground.
        const [S, V] = c.points as [Pt, Pt];
        const len = Math.hypot(V[0] - S[0], V[1] - S[1]);
        const ux = (V[0] - S[0]) / len;
        const uy = (V[1] - S[1]) / len;
        const grid: PlanGrid = { width: w.width, height: w.height, plan: new Float32Array(0), idx: (a, b) => w.idx(a, b), terrain: (i) => w.terrain(i) };
        for (let t = 0; t < len; t += 3) {
          const p: Pt = [S[0] + ux * t, S[1] + uy * t];
          const q: Pt = [S[0] + ux * Math.min(len, t + 3), S[1] + uy * Math.min(len, t + 3)];
          const core = [...rasterisePath(grid, [p, q], (c.width + 2) / 2).keys()];
          const lowest = Math.min(...core.map((i) => w.terrain(i)));
          const orig = core.map((i) => this.ground.get(i)).filter((v): v is number => v !== undefined);
          if (!orig.length) continue;
          // The old ground, a little below the lowest of it on this piece (no bank left standing).
          const target = Math.min(...orig) - 0.05;
          if (target - lowest < 0.1) continue;
          commands.push(...shape('raise', [p, q], c.width + 2, target - lowest));
        }
      }
    }
    const earth = earthOf(sim, commands);
    this.earth.take(earth);
    return [{ day, village: s?.state.id ?? 0, note: `undo: dam trenched, canal filled in ${commands.length - 1} pieces, ${Math.round(earth)} m³`, commands, targets: s ? homesOf(sim, s) : [], info: { earth } }];
  }
}

// ---------------------------------------------------------------------------
// The good player

/**
 * A sensible player: drains the marsh by the village and diks the
 * floodplain where the land remembers floods (each with at most a quarter of
 * the budget, from the first look), and once the weir is unlocked builds
 * the weir + canal with the rest; when every village has its canal and
 * earth is left, a second canal for the biggest village.
 */
export class GoodBot implements Bot {
  readonly name = 'good';
  readonly description = 'a contour canal from the river before the weir (35 % of the budget), drain the marsh and dike the floodplain (20 %, 25 %), weir + canal once unlocked with the rest';
  private readonly drain: DrainBot;
  private readonly dike: DikeBot;
  private readonly weir: WeirCanalBot;
  private readonly drainEarth: Earth;
  private readonly dikeEarth: Earth;
  private readonly canal: CanalBot;
  private readonly canalEarth: Earth;
  constructor(
    private readonly earth: Earth,
    ignoreUnlocks = false,
  ) {
    this.canalEarth = new Earth(earth.budget * 0.35);
    this.canal = new CanalBot(this.canalEarth);
    this.drainEarth = new Earth(earth.budget * 0.2);
    this.dikeEarth = new Earth(earth.budget * 0.25);
    this.drain = new DrainBot(this.drainEarth);
    this.dike = new DikeBot(this.dikeEarth);
    this.weir = new WeirCanalBot(earth, ignoreUnlocks);
  }
  check(sim: Simulation, day: number): BotAction[] {
    const out: BotAction[] = [];
    // The weir + canal first when it is there to be had (it gets the main budget).
    out.push(...this.weir.check(sim, day));
    const sub = (b: Bot, e: Earth) => {
      const before = e.spent;
      const acts = b.check(sim, day);
      // Booked against the shared budget too (and only if it fits there).
      const used = e.spent - before;
      if (used > 0 && !this.earth.take(used)) {
        e.spent = before;
        return;
      }
      out.push(...acts.map((a) => ({ ...a, note: `${b.name}: ${a.note}` })));
    };
    // Keep what the weir + canal needs: the side works only take what it leaves beyond ~60 %.
    // Before the weir: a contour canal from the river where one waters enough dry land.
    if (!unlocked(sim, 'weir')) sub(this.canal, this.canalEarth);
    if (this.earth.left > this.earth.budget * 0.3 || unlocked(sim, 'weir')) {
      sub(this.drain, this.drainEarth);
      sub(this.dike, this.dikeEarth);
    }
    return out;
  }
}

export const BOT_NAMES = ['weircanal', 'wheel', 'dike', 'drain', 'vandal', 'undo', 'good', 'canal', 'irrigate'] as const;
export type BotName = (typeof BOT_NAMES)[number];

export function makeBot(name: string, opts: BotOptions = {}): Bot {
  const earth = new Earth(opts.budget ?? EARTH_BUDGET);
  switch (name) {
    case 'irrigate':
      return new IrrigateBot(earth);
    case 'weircanal':
      return new WeirCanalBot(earth, opts.ignoreUnlocks);
    case 'canal':
      return new CanalBot(earth);
    case 'wheel':
      return new WheelCanalBot(earth);
    case 'dike':
      return new DikeBot(earth);
    case 'drain':
      return new DrainBot(earth);
    case 'vandal':
      return new VandalBot();
    case 'undo':
      return new UndoBot();
    case 'good':
      return new GoodBot(earth, opts.ignoreUnlocks);
    default:
      throw new Error(`unknown bot ${name} (known: ${BOT_NAMES.join(', ')})`);
  }
}
