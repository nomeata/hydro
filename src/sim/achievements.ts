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
import { DAYS_PER_SEASON, DAYS_PER_YEAR } from './constants';
import { CellFlag, LandUse, SOIL_PROPS, type World } from './world';
import type { PeopleEvent, PeopleSystem } from './people/village';
import { longestPath } from './people/desire';
import { VEG } from './vegetation';
import type { Structures } from './structures/structures';
import type { GateEvent } from './structures/gatekeeper';

/** What the checks look at (the Simulation). */
export interface AchievementHost {
  readonly world: World;
  readonly people: PeopleSystem | null;
  readonly structures: Structures;
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

  /** Something happened in a village. */
  peopleEvent(e: PeopleEvent, cell: number, day: number): void {
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
        if (!this.has.has('goneFishing') && this.newWater(cell)) this.earn('goneFishing', day);
        break;
      case 'rebuilt':
        this.earn('rebuilt', day);
        break;
    }
  }

  /** Water at cell i that the player made: not near the world's own water, and near their works. */
  private newWater(i: number): boolean {
    const W = this.width;
    const x0 = i % W;
    const y0 = (i / W) | 0;
    for (let y = Math.max(0, y0 - 2); y <= Math.min(this.height - 1, y0 + 2); y++)
      for (let x = Math.max(0, x0 - 2); x <= Math.min(W - 1, x0 + 2); x++) if (this.wet0[y * W + x]) return false;
    return this.near(i);
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
    if (!this.has.has('uphill') && h.structures.wheels.some((wh) => wh.lifted >= ACH.liftedM3)) this.earn('uphill', day);
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
    const needLake = !this.has.has('lakeMaker');
    const needGreen = !this.has.has('greenDesert') && p !== null;
    const needField = !this.has.has('newGround') && p !== null;
    const needForest = !this.has.has('forestKeeper');
    let lake = 0;
    let green = 0;
    let forest = 0;
    let flooded = 0;
    const { water, velX, velY, landuse } = w;
    const fm = p ? w.floodMemory : null;
    for (let i = 0; i < w.size; i++) {
      const d = water[i]!;
      if (fm && fm[i]! >= 254 && landuse[i] !== LandUse.None) flooded++;
      if (needForest && w.vegetation[i]! >= VEG.forestLevel && !this.forest0[i] && this.near(i)) forest++;
      if (needLake && d >= ACH.lakeDepth && !this.wet0[i] && velX[i]! ** 2 + velY[i]! ** 2 < STANDING * STANDING && this.near(i)) lake++;
      if (!this.dry0[i]) continue;
      if (needField && landuse[i] === LandUse.Field && this.near(i)) this.earn('newGround', day);
      if (needGreen && d < 0.05 && moisture(h, i) >= MOIST && this.near(i)) green++;
    }
    this.c.lakeStreak = lake >= ACH.lakeCells ? this.c.lakeStreak + 1 : 0;
    if (this.c.lakeStreak >= STREAK) this.earn('lakeMaker', day);
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
