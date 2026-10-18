/**
 * Achievements (DESIGN §4a, docs/ACHIEVEMENTS.md): cheap checks of the
 * world against a compact snapshot taken when the world was created
 * (where the water was, which land was too dry to farm) and against what
 * the player has touched. Some are noticed as they happen (a harvest, a
 * catch, a gate worked), the rest by checks a few times a game day.
 * Purely an observer: it never changes the world and uses no randomness,
 * so it cannot affect the simulation; its state is saved with the world.
 */
import type { AchievementEarned, AchievementsUpdate } from '../shared/protocol';
import { ACH, POPULATION_ACHIEVEMENTS } from '../shared/achievements';
import { CELL_AREA, DAYS_PER_SEASON, DAYS_PER_YEAR } from './constants';
import { CellFlag, LandUse, SOIL_PROPS, type World } from './world';
import type { PeopleEvent, PeopleSystem } from './people/village';
import { longestPath } from './people/desire';
import { VEG } from './vegetation';
import type { Structures } from './structures/structures';
import type { GateEvent } from './structures/gatekeeper';
import type { PowerGrid } from './power/grid';

/** What the checks look at (the Simulation). */
export interface AchievementHost {
  readonly world: World;
  readonly people: PeopleSystem | null;
  readonly structures: Structures;
  /** The power grid (M6; absent in hosts that have none). */
  readonly power?: PowerGrid;
}

/** Side (cells) of the blocks that track where the player has worked. */
const BLOCK = 8;
/** Water this deep at the start counts as the world's own water (m). */
const WET0 = 0.1;
/** Field moisture below this at the start: too dry to farm (the farmers' own threshold). */
const DRY0 = 0.15;
/** Field moisture at which land counts as watered (fully farmable). */
const MOIST = 0.35;
/** Standing water is slower than this (m/s). */
const STANDING = 0.3;
/** Daily checks of slowly built conditions must hold this many days in a row. */
const STREAK = 2;
/** Steps between the quick checks (plans, villages, population) and the waterfall check. */
export const QUICK_EVERY = 60;
const FALL_EVERY = 150;
/** Minimum flow (m/s) for falling water. */
const FALL_SPEED = 0.2;
/** Water at least this deep belongs to a water body (m). */
const BODY_DEPTH = 0.1;
/** A lake is held back by a work cell if its surface stands this far above that cell's original ground (m). */
const HELD = 0.2;
/** A cell dug at least this deep below its original ground counts as dug (m). */
const DUG = 0.3;

/** An earthwork stroke by the player, followed until it is built. */
interface Stroke {
  k: 'trench' | 'dike' | 'level';
  /** Path length (cells). */
  len: number;
  /** Cells still planned. */
  c: number[];
  /** Cells built and cancelled. */
  b: number;
  x: number;
}

interface Counters {
  /** Harvests in `year`. */
  harvests: number;
  year: number;
  /** This spring: village land flooded, and the ruin count when it began (−1: unknown). */
  springFlood: boolean;
  springRuined: number;
  lakeStreak: number;
  greenStreak: number;
  /** Days in a row with enough new forest near the works (absent in older saves). */
  forestStreak?: number;
}

export interface AchievementsState {
  earned: AchievementEarned[];
  /** Run-length encoded bitsets: [start, length, …]. */
  wet0: number[];
  dry0: number[];
  /** Forest at the start (absent in older saves: the forest when loaded). */
  forest0?: number[];
  touched: number[];
  /** Original ground under the player's plans: [cell, terrain, …] (absent in older saves). */
  ground0?: number[];
  strokes: Stroke[];
  counters: Counters;
}

/** Run-length encode a 0/1 array as [start, length, …]. */
export function rle(a: Uint8Array): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < a.length) {
    if (!a[i]) {
      i++;
      continue;
    }
    const s = i;
    while (i < a.length && a[i]) i++;
    out.push(s, i - s);
  }
  return out;
}

export function unrle(a: Uint8Array, runs: readonly number[]): void {
  a.fill(0);
  for (let k = 0; k + 1 < runs.length; k += 2) a.fill(1, runs[k]!, Math.min(a.length, runs[k]! + runs[k + 1]!));
}

const freshCounters = (): Counters => ({ harvests: 0, year: 0, springFlood: false, springRuined: -1, lakeStreak: 0, greenStreak: 0, forestStreak: 0 });

export class Achievements {
  earned: AchievementEarned[] = [];
  /** Earned since the last update was taken. */
  fresh: string[] = [];
  /** Set when `earned` changed (or after a load), for snapshots. */
  dirty = true;
  /** The world's own water and its too-dry land at the start. */
  readonly wet0: Uint8Array;
  readonly dry0: Uint8Array;
  /** Forest (vegetation ≥ VEG.forestLevel) at the start. */
  readonly forest0: Uint8Array;
  /** Cells the player's works have changed, and per block whether any did. */
  readonly touched: Uint8Array;
  private readonly blocks: Uint8Array;
  /** Terrain of each cell before the player's first plan on it. */
  private ground0 = new Map<number, number>();
  private readonly bw: number;
  private readonly bh: number;
  private strokes: Stroke[] = [];
  private c: Counters = freshCounters();
  private readonly has = new Set<string>();

  constructor(private readonly width: number, private readonly height: number) {
    const n = width * height;
    this.wet0 = new Uint8Array(n);
    this.dry0 = new Uint8Array(n);
    this.forest0 = new Uint8Array(n);
    this.touched = new Uint8Array(n);
    this.bw = Math.ceil(width / BLOCK);
    this.bh = Math.ceil(height / BLOCK);
    this.blocks = new Uint8Array(this.bw * this.bh);
  }

  /** Start afresh, taking the world as it is now as its original state. */
  baseline(h: AchievementHost): void {
    const w = h.world;
    this.earned = [];
    this.has.clear();
    this.fresh = [];
    this.dirty = true;
    this.strokes = [];
    this.c = freshCounters();
    this.touched.fill(0);
    this.blocks.fill(0);
    this.ground0.clear();
    for (let i = 0; i < w.size; i++) {
      this.wet0[i] = w.water[i]! >= WET0 ? 1 : 0;
      this.dry0[i] = !this.wet0[i] && moisture(h, i) < DRY0 ? 1 : 0;
    }
    this.forestBaseline(w);
  }

  /** Take the forest as it is now as the forest at the start. */
  private forestBaseline(w: World): void {
    for (let i = 0; i < w.size; i++) this.forest0[i] = w.vegetation[i]! >= VEG.forestLevel ? 1 : 0;
  }

  /**
   * An old save without achievements: take it as the start, and quietly
   * record what is already true (no fanfare on loading).
   */
  catchUp(h: AchievementHost, day: number): void {
    this.baseline(h);
    this.quick(h, day);
    this.daily(h, day);
    this.fresh = [];
  }

  hasEarned(id: string): boolean {
    return this.has.has(id);
  }

  earn(id: string, day: number): void {
    if (this.has.has(id)) return;
    this.has.add(id);
    this.earned.push({ id, day });
    this.fresh.push(id);
    this.dirty = true;
  }

  /** The update for the next snapshot (clears `fresh` and `dirty`). */
  take(): AchievementsUpdate {
    const u = { earned: this.earned.map((e) => ({ ...e })), fresh: this.fresh };
    this.fresh = [];
    this.dirty = false;
    return u;
  }

  // ---------------------------------------------------------------------------
  // What the player does

  /** A player's work changed cell i. */
  touch(i: number): void {
    if (this.touched[i]) return;
    this.touched[i] = 1;
    const x = i % this.width;
    const y = (i / this.width) | 0;
    this.blocks[((y / BLOCK) | 0) * this.bw + ((x / BLOCK) | 0)] = 1;
  }

  /** Whether cell i is near the player's works (in or next to a block they touched). */
  near(i: number): boolean {
    const bx = ((i % this.width) / BLOCK) | 0;
    const by = ((i / this.width / BLOCK) | 0);
    for (let y = Math.max(0, by - 1); y <= Math.min(this.bh - 1, by + 1); y++)
      for (let x = Math.max(0, bx - 1); x <= Math.min(this.bw - 1, bx + 1); x++) if (this.blocks[y * this.bw + x]) return true;
    return false;
  }

  /** The player planned works on these cells: remember the ground under them as it was. */
  planned(w: World, cells: readonly number[]): void {
    for (const c of cells) if (!this.ground0.has(c)) this.ground0.set(c, w.terrain(c));
  }

  /** Whether the player ever planned works on cell i. */
  isPlanned(i: number): boolean {
    return this.ground0.has(i);
  }

  /** An earthwork stroke was planned (its changed cells, path length in cells). */
  stroke(kind: Stroke['k'], cells: readonly number[], len: number): void {
    if (cells.length) this.strokes.push({ k: kind, len, c: [...cells], b: 0, x: 0 });
  }

  /** Plans on these cells were removed. */
  cancelled(cells: readonly number[]): void {
    if (!cells.length || !this.strokes.length) return;
    const gone = new Set(cells);
    for (const s of this.strokes) {
      const keep = s.c.filter((c) => !gone.has(c));
      s.x += s.c.length - keep.length;
      s.c = keep;
    }
  }

  /** Villagers lined bank cell i with stone (their own works near home). */
  lined(day: number): void {
    this.earn('stoneByStone', day);
  }

  /** Villagers opened a gate to water their fields, or flood relief saved a dike (structures/gatekeeper.ts). */
  gateEvent(e: GateEvent, day: number): void {
    this.earn(e === 'irrigated' ? 'gatekeeper' : 'safetyValve', day);
  }

  /** Something happened in a village (`h`: the world, to judge a catch's water). */
  peopleEvent(e: PeopleEvent, cell: number, day: number, h?: AchievementHost): void {
    switch (e) {
      case 'harvest': {
        this.earn('firstHarvest', day);
        const year = Math.floor(day / DAYS_PER_YEAR);
        if (year !== this.c.year) {
          this.c.year = year;
          this.c.harvests = 0;
        }
        if (++this.c.harvests >= ACH.harvests) this.earn('goldenYear', day);
        break;
      }
      case 'catch':
        if (!this.has.has('goneFishing') && h && this.newWater(h, cell)) this.earn('goneFishing', day);
        break;
      case 'rebuilt':
        this.earn('rebuilt', day);
        break;
      case 'well':
        if (this.touchedWithin(cell, ACH.wellNear)) this.earn('wellspring', day);
        break;
      case 'mill':
        if (this.touchedWithin(cell, ACH.millNear)) this.earn('millersHead', day);
        break;
    }
  }

  /** Whether the player's works changed a cell within r cells of cell i. */
  private touchedWithin(i: number, r: number): boolean {
    const W = this.width;
    const x0 = i % W;
    const y0 = (i / W) | 0;
    for (let y = Math.max(0, y0 - r); y <= Math.min(this.height - 1, y0 + r); y++)
      for (let x = Math.max(0, x0 - r); x <= Math.min(W - 1, x0 + r); x++)
        if (this.touched[y * W + x] && Math.hypot(x - x0, y - y0) <= r + 0.5) return true;
    return false;
  }

  /**
   * Water by cell i that the player made: not near the world's own water,
   * and either in a cell they dug or in a lake their works hold back.
   */
  private newWater(h: AchievementHost, i: number): boolean {
    const W = this.width;
    const x0 = i % W;
    const y0 = (i / W) | 0;
    const made: number[] = [];
    for (let y = Math.max(0, y0 - 2); y <= Math.min(this.height - 1, y0 + 2); y++)
      for (let x = Math.max(0, x0 - 2); x <= Math.min(W - 1, x0 + 2); x++) {
        const j = y * W + x;
        if (this.wet0[j]) return false;
        if (h.world.water[j]! >= BODY_DEPTH) made.push(j);
      }
    const w = h.world;
    for (const j of made) {
      const g0 = this.ground0.get(j);
      if (g0 !== undefined && w.terrain(j) < g0 - DUG) return true;
    }
    const seen = new Uint8Array(w.size);
    for (const j of made) if (!seen[j] && this.waterBody(h, j, seen).held) return true;
    return false;
  }

  /**
   * The connected body of standing water (≥ BODY_DEPTH, 4-neighbours) at
   * cell s, marking its cells in `seen`: its new water (cells that were dry
   * at the start, counted by how deep the water stands above their original
   * ground), and whether the player's works hold it back (it touches a cell
   * they raised, with its surface above that cell's original ground: without
   * the work the water would spill there).
   */
  waterBody(h: AchievementHost, s: number, seen: Uint8Array): { cells: number; volume: number; held: boolean } {
    const w = h.world;
    const W = w.width;
    const { water, velX, velY } = w;
    const wet = (i: number) => water[i]! >= BODY_DEPTH && velX[i]! ** 2 + velY[i]! ** 2 < STANDING * STANDING;
    let cells = 0;
    let volume = 0;
    let held = false;
    if (seen[s] || !wet(s)) return { cells, volume, held };
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      const surf = w.surface(i);
      if (!this.wet0[i]) {
        const g0 = this.ground0.get(i);
        const d = surf - Math.max(w.terrain(i), g0 ?? -Infinity);
        if (d > 0.05) {
          cells++;
          volume += d * CELL_AREA;
        }
      }
      const x = i % W;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) {
        if (j < 0 || j >= w.size) continue;
        if (!held) {
          const g0 = this.ground0.get(j);
          if (g0 !== undefined && w.terrain(j) > g0 + 0.05 && surf > g0 + HELD) held = true;
        }
        if (!seen[j] && wet(j)) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    return { cells, volume, held };
  }

  /** Whether some water body is a lake the player made (Lake Maker, today). */
  private lakeToday(h: AchievementHost): boolean {
    const w = h.world;
    const seen = new Uint8Array(w.size);
    for (const c of this.ground0.keys()) {
      // Every held-back lake touches a work cell: start from their neighbours.
      const x = c % w.width;
      for (const j of [x > 0 ? c - 1 : -1, x < w.width - 1 ? c + 1 : -1, c - w.width, c + w.width, c]) {
        if (j < 0 || j >= w.size || seen[j]) continue;
        const b = this.waterBody(h, j, seen);
        if (b.held && b.cells >= ACH.lakeCells && b.volume >= ACH.lakeM3 && b.volume / CELL_AREA / b.cells >= ACH.lakeDepth) return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Checks

  /** Run the checks due at `step` (the quick ones and the waterfall). */
  update(h: AchievementHost, step: number, day: number): void {
    if (step % QUICK_EVERY === 0) this.quick(h, day);
    if (step % FALL_EVERY === 0 && !this.has.has('waterfall') && this.waterfall(h)) this.earn('waterfall', day);
  }

  /** Cheap checks, several times a day: finished plans, villages, population. */
  quick(h: AchievementHost, day: number): void {
    const plan = h.world.plan;
    if (this.strokes.length) {
      const left: Stroke[] = [];
      for (const s of this.strokes) {
        const keep = s.c.filter((c) => !Number.isNaN(plan[c]!));
        s.b += s.c.length - keep.length;
        s.c = keep;
        if (keep.length) {
          left.push(s);
          continue;
        }
        const built = s.b - s.x;
        if (built <= 0) continue;
        this.earn('firstSpade', day);
        if (s.k === 'trench' && s.len >= ACH.canalCells && built >= 0.7 * s.b) this.earn('longCanal', day);
      }
      this.strokes = left;
    }
    if (!this.has.has('uphill') && h.structures.wheels?.some((wh) => wh.lifted >= ACH.liftedM3)) this.earn('uphill', day);
    const pw = h.power;
    if (pw && !pw.empty) {
      const st = pw.stats();
      if (st.houses > 0 && st.supplied > 0) this.earn('brightWindows', day);
      if (st.houses >= ACH.gridHouses) this.earn('villageLights', day);
      const d = pw.lastDay;
      if (d.storage >= ACH.storageKWh * 3.6e6 && d.pumps >= ACH.storageKWh * 3.6e6) this.earn('nightAndDay', day);
    }
    const p = h.people;
    if (p) {
      const n = p.settlements.length;
      if (n >= 1) this.earn('founders', day);
      if (n >= 2) this.earn('newHome', day);
      if (n >= 3) this.earn('threeVillages', day);
      const peak = Math.max(p.peakPopulation, p.population);
      for (const [id, pop] of POPULATION_ACHIEVEMENTS) if (peak >= pop) this.earn(id, day);
      if (!this.has.has('cattleCountry') && p.settlements.some((s) => p.herds.cows(s.state.id) >= ACH.herdCows)) this.earn('cattleCountry', day);
    }
  }

  /** Once a day, for the day that just ended: the land, the water, the seasons. */
  daily(h: AchievementHost, day: number): void {
    const w = h.world;
    const p = h.people;
    if (day + 1 >= DAYS_PER_YEAR) this.earn('year1', day);
    if (day + 1 >= 10 * DAYS_PER_YEAR) this.earn('decade', day);

    // One pass over the grid for the cell-based checks.
    const needGreen = !this.has.has('greenDesert') && p !== null;
    const needField = !this.has.has('newGround') && p !== null;
    const needForest = !this.has.has('forestKeeper');
    let green = 0;
    let forest = 0;
    let flooded = 0;
    const { water, landuse } = w;
    const fm = p ? w.floodMemory : null;
    for (let i = 0; i < w.size; i++) {
      const d = water[i]!;
      if (fm && fm[i]! >= 254 && landuse[i] !== LandUse.None) flooded++;
      if (needForest && w.vegetation[i]! >= VEG.forestLevel && !this.forest0[i] && this.near(i)) forest++;
      if (!this.dry0[i]) continue;
      if (needField && landuse[i] === LandUse.Field && this.near(i)) this.earn('newGround', day);
      if (needGreen && d < 0.05 && moisture(h, i) >= MOIST && this.near(i)) green++;
    }
    if (!this.has.has('lakeMaker')) {
      this.c.lakeStreak = this.lakeToday(h) ? this.c.lakeStreak + 1 : 0;
      if (this.c.lakeStreak >= ACH.lakeDays) this.earn('lakeMaker', day);
    }
    this.c.greenStreak = green >= ACH.greenCells ? this.c.greenStreak + 1 : 0;
    if (this.c.greenStreak >= STREAK) this.earn('greenDesert', day);
    this.c.forestStreak = forest >= ACH.forestCells ? (this.c.forestStreak ?? 0) + 1 : 0;
    if (this.c.forestStreak >= STREAK) this.earn('forestKeeper', day);

    // Structures.
    if (!this.has.has('weirBuilder')) {
      const flags = w.flags;
      if (h.structures.weirs.some((wr) => wr.cells.length > 0 && wr.cells.every((c) => (flags[c]! & CellFlag.Lined) !== 0))) this.earn('weirBuilder', day);
    }

    if (p) {
      if (!this.has.has('wellTrodden') && longestPath(w) >= ACH.pathCells) this.earn('wellTrodden', day);
      if (!this.has.has('quayside') && p.quay.some((q) => q > 0)) this.earn('quayside', day);
      if (!this.has.has('jetty') && p.settlements.some((s) => (s.state.jetty?.progress ?? 0) >= 1)) this.earn('jetty', day);
      // A spring flood that every house weathers.
      const doy = day % DAYS_PER_YEAR;
      if (doy === 0) {
        this.c.springFlood = false;
        this.c.springRuined = p.floods.ruined;
      }
      if (doy < DAYS_PER_SEASON && flooded >= ACH.floodCells && p.settlements.length > 0) this.c.springFlood = true;
      if (doy === DAYS_PER_SEASON - 1) {
        const houses = p.buildings.some((b) => b.kind === 'house' && b.progress >= 1);
        if (this.c.springFlood && this.c.springRuined >= 0 && p.floods.ruined === this.c.springRuined && houses) this.earn('weathered', day);
        this.c.springFlood = false;
        this.c.springRuined = -1;
      }
    }
  }

  /** Water falling at least ACH.fallDrop within two cells, at the player's works. */
  waterfall(h: AchievementHost): boolean {
    const w = h.world;
    const W = w.width;
    const H = w.height;
    const { water, velX, velY } = w;
    const fast = (i: number) => velX[i]! ** 2 + velY[i]! ** 2 >= FALL_SPEED * FALL_SPEED;
    for (let i = 0; i < w.size; i++) {
      if (!this.touched[i] || water[i]! < 0.01) continue;
      const sa = w.surface(i);
      const x0 = i % W;
      const y0 = (i / W) | 0;
      for (let y = Math.max(0, y0 - 2); y <= Math.min(H - 1, y0 + 2); y++)
        for (let x = Math.max(0, x0 - 2); x <= Math.min(W - 1, x0 + 2); x++) {
          const j = y * W + x;
          if (j === i || water[j]! < 0.01) continue;
          if (Math.abs(sa - w.surface(j)) >= ACH.fallDrop && (fast(i) || fast(j))) return true;
        }
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Persistence

  getState(): AchievementsState {
    return {
      earned: this.earned.map((e) => ({ ...e })),
      wet0: rle(this.wet0),
      dry0: rle(this.dry0),
      forest0: rle(this.forest0),
      touched: rle(this.touched),
      ground0: [...this.ground0].flat(),
      strokes: this.strokes.map((s) => ({ ...s, c: [...s.c] })),
      counters: { ...this.c },
    };
  }

  setState(st: AchievementsState, w?: World): void {
    this.earned = st.earned.map((e) => ({ ...e }));
    this.has.clear();
    for (const e of this.earned) this.has.add(e.id);
    unrle(this.wet0, st.wet0);
    unrle(this.dry0, st.dry0);
    if (st.forest0) unrle(this.forest0, st.forest0);
    else if (w) this.forestBaseline(w);
    unrle(this.touched, st.touched);
    this.ground0.clear();
    const g = st.ground0 ?? [];
    for (let k = 0; k + 1 < g.length; k += 2) this.ground0.set(g[k]!, g[k + 1]!);
    this.blocks.fill(0);
    for (let i = 0; i < this.touched.length; i++) {
      if (!this.touched[i]) continue;
      const x = i % this.width;
      const y = (i / this.width) | 0;
      this.blocks[((y / BLOCK) | 0) * this.bw + ((x / BLOCK) | 0)] = 1;
    }
    this.strokes = st.strokes.map((s) => ({ ...s, c: [...s.c] }));
    this.c = { ...freshCounters(), ...st.counters };
    // A loaded game: send the list, but no fanfare.
    this.fresh = [];
    this.dirty = true;
  }
}

/** Field moisture of cell i (the farmers' measure; soil saturation without villages). */
function moisture(h: AchievementHost, i: number): number {
  if (h.people) return h.people.fieldMoisture[i]!;
  const w = h.world;
  const cap = w.soil[i]! * SOIL_PROPS[w.soilType[i]!]!.porosity;
  return cap > 0 ? w.ground[i]! / cap : 0;
}
