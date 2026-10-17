/**
 * Village animals (docs/PEOPLE.md §5, M3-δ): a village with grassy meadow
 * around it keeps a small herd. Cows and sheep spend their time at the fold
 * by the village and go out to pasture when the herder leads them there
 * (village.ts drives the herder and flips `HerdState.out`); they graze
 * (Eat), which crops the grass a little. Pigs root about the store and
 * chicks peck around the houses. The herd grows with prosperity and
 * pasture, one animal at a time.
 *
 * Animals are deterministic sim entities: updated in array order with the
 * people's RNG, saved with the people and sent in the entity frame.
 */
import { EntityAnim, EntityKind } from '../../shared/protocol';
import type { Rng } from '../../shared/rng';
import { CELL } from '../constants';
import { LandUse, type World } from '../world';
import { Task, walk, type Animal } from './agents';
import type { PathFinder } from './path';
import type { HerdState, Settlement } from './settlement';

export const HERD = {
  /** Pasture is looked for this far from the village centre (cells). */
  pastureMin: 7,
  pastureMax: 24,
  /** Grass counts as pasture between these vegetation levels (forest above). */
  grassMin: 0.12,
  grassMax: 0.62,
  /** Grass eaten per mouthful (vegetation), and the floor it leaves. */
  graze: 0.012,
  grazeFloor: 0.08,
  /** Pasture cells (estimated) per cow; most cows per village. */
  cellsPerCow: 60,
  maxCows: 10,
  /** People per cow at most. */
  peoplePerCow: 4,
  /** Villages smaller than this keep no herd. */
  minPeople: 6,
  /** Chance per day that a missing animal is born / a surplus one is sold. */
  birth: 0.35,
  sell: 0.25,
  /** Walking speeds relative to people. */
  speed: { [EntityKind.Cow]: 0.6, [EntityKind.Sheep]: 0.65, [EntityKind.Pig]: 0.55, [EntityKind.Chick]: 0.5 } as Record<number, number>,
};

/** Whether an animal kind goes out to pasture with the herder. */
export function grazes(kind: number): boolean {
  return kind === EntityKind.Cow || kind === EntityKind.Sheep;
}

export interface HerdTargets {
  [EntityKind.Cow]: number;
  [EntityKind.Sheep]: number;
  [EntityKind.Pig]: number;
  [EntityKind.Chick]: number;
}

/** Where a village's animals live: its houses and store. */
export interface HerdHome {
  store: { x: number; y: number } | null;
  houses: readonly { x: number; y: number }[];
  /** Whether the village owns cell (x, y). */
  owns: (x: number, y: number) => boolean;
}

export class Herds {
  animals: Animal[] = [];
  /** Estimated pasture cells around each village (from the latest daily survey; not saved, recomputed daily). */
  readonly pasture = new Map<number, number>();

  constructor(
    private readonly world: World,
    private readonly pf: PathFinder,
    private readonly rng: Rng,
    private readonly newId: () => number,
    private readonly bridge: (i: number) => boolean,
  ) {}

  of(settlement: number, kind?: number): Animal[] {
    return this.animals.filter((a) => a.settlement === settlement && a.task !== Task.Leave && (kind === undefined || a.kind === kind));
  }

  /** Cows of a village (Cattle Country). */
  cows(settlement: number): number {
    let n = 0;
    for (const a of this.animals) if (a.settlement === settlement && a.kind === EntityKind.Cow && a.task !== Task.Leave) n++;
    return n;
  }

  /** Whether cell i is grass a herd can graze. */
  grassy(i: number): boolean {
    const w = this.world;
    const v = w.vegetation[i]!;
    const lu = w.landuse[i]!;
    return v >= HERD.grassMin && v < HERD.grassMax && w.water[i]! < 0.02 && (lu === LandUse.None || lu === LandUse.Pasture || lu === LandUse.Path);
  }

  /**
   * Daily: survey the pasture, pick the next outing's meadow and the fold,
   * and let the herd grow or shrink by one towards what the village can keep.
   */
  daily(s: Settlement, home: HerdHome, winter: boolean, enabled: boolean): void {
    const st = s.state;
    const w = this.world;
    const W = w.width;
    const cx = st.x;
    const cy = st.y;
    // Survey: deterministic samples in the ring around the village.
    let best = -1;
    let bestScore = -Infinity;
    let grassy = 0;
    const samples = 80;
    for (let k = 0; k < samples; k++) {
      const r = HERD.pastureMin + this.rng.next() * (HERD.pastureMax - HERD.pastureMin);
      const ang = this.rng.range(0, Math.PI * 2);
      const x = Math.round(cx + Math.cos(ang) * r);
      const y = Math.round(cy + Math.sin(ang) * r);
      if (x < 2 || y < 2 || x >= W - 2 || y >= w.height - 2 || !home.owns(x, y)) continue;
      const i = y * W + x;
      if (!this.grassy(i)) continue;
      grassy++;
      let score = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const j = i + dy * W + dx;
          if (this.grassy(j)) score += w.vegetation[j]!;
        }
      score -= r * 0.05 + this.slope(i) * 8;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    const ring = Math.PI * (HERD.pastureMax ** 2 - HERD.pastureMin ** 2);
    const cells = (grassy / samples) * ring;
    this.pasture.set(st.id, cells);

    const herd = (st.herd ??= { out: false, pasture: -1, fold: -1, restUntil: 0 });
    if (!herd.out && best >= 0) herd.pasture = best;
    if (!herd.out || herd.fold < 0) herd.fold = this.foldCell(s, home, herd);

    const want = enabled ? this.targets(s, home, cells) : { [EntityKind.Cow]: 0, [EntityKind.Sheep]: 0, [EntityKind.Pig]: 0, [EntityKind.Chick]: 0 };
    for (const kind of [EntityKind.Cow, EntityKind.Sheep, EntityKind.Pig, EntityKind.Chick] as const) {
      const have = this.of(st.id, kind);
      const target = want[kind];
      if (have.length < target) {
        // A new village gets its first pair at once; then one at a time.
        const n = have.length === 0 ? Math.min(2, target) : this.rng.next() < HERD.birth ? 1 : 0;
        for (let k = 0; k < n; k++) this.spawn(s, kind, home, herd);
      } else if (have.length > target && this.rng.next() < HERD.sell) {
        // Sold to the neighbours: it walks off to the store and is gone.
        const a = have[have.length - 1]!;
        const to = home.store ? w.idx(Math.round(home.store.x), Math.round(home.store.y)) : -1;
        const path = to >= 0 ? this.pf.find(this.cellOf(a), to, { window: 40, maxExpand: 3000, bridge: this.bridge }) : null;
        a.task = Task.Leave;
        a.path = path ?? [];
        a.pathPos = 0;
      }
    }
    void winter;
  }

  /** How many animals of each kind the village keeps: grows with people, pasture and wellbeing. */
  targets(s: Settlement, home: HerdHome, pastureCells: number): HerdTargets {
    const st = s.state;
    const pop = st.population;
    const w = Math.max(0, Math.min(1, st.wellbeing));
    let cows = 0;
    if (pop >= HERD.minPeople && pastureCells >= HERD.cellsPerCow) {
      const room = Math.min(HERD.maxCows, pastureCells / HERD.cellsPerCow, pop / HERD.peoplePerCow);
      cows = Math.max(2, Math.floor(room * (0.4 + 0.6 * w)));
    }
    return {
      [EntityKind.Cow]: cows,
      [EntityKind.Sheep]: cows >= 3 ? Math.min(4, Math.floor(cows / 2)) : 0,
      [EntityKind.Pig]: pop >= 10 && home.store ? (pop >= 25 ? 2 : 1) : 0,
      [EntityKind.Chick]: home.houses.length >= 2 ? Math.min(6, 2 + Math.floor(home.houses.length / 2)) : 0,
    };
  }

  /** The fold: open dry ground a few cells from the store, towards the pasture. */
  private foldCell(s: Settlement, home: HerdHome, herd: HerdState): number {
    const w = this.world;
    const W = w.width;
    const st = s.state;
    const ox = home.store?.x ?? st.x;
    const oy = home.store?.y ?? st.y;
    const px = herd.pasture >= 0 ? herd.pasture % W : ox + 1;
    const py = herd.pasture >= 0 ? (herd.pasture / W) | 0 : oy;
    const base = Math.atan2(py - oy, px - ox);
    for (const r of [5, 6, 4, 7, 3]) {
      for (let k = 0; k < 12; k++) {
        const ang = base + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.35;
        const x = Math.round(ox + Math.cos(ang) * r);
        const y = Math.round(oy + Math.sin(ang) * r);
        if (!w.inBounds(x, y)) continue;
        const i = w.idx(x, y);
        const lu = w.landuse[i]!;
        if (w.water[i]! < 0.02 && (lu === LandUse.None || lu === LandUse.Path || lu === LandUse.Pasture) && this.slope(i) < 0.3) return i;
      }
    }
    return w.idx(Math.round(ox), Math.round(oy));
  }

  private spawn(s: Settlement, kind: EntityKind, home: HerdHome, herd: HerdState): void {
    const w = this.world;
    let at: { x: number; y: number };
    if (grazes(kind)) at = { x: herd.fold % w.width, y: (herd.fold / w.width) | 0 };
    else if (kind === EntityKind.Chick && home.houses.length) at = home.houses[this.rng.int(0, home.houses.length)]!;
    else at = home.store ?? { x: s.state.x, y: s.state.y };
    this.animals.push({
      id: this.newId(),
      settlement: s.state.id,
      kind,
      x: at.x,
      y: at.y,
      heading: this.rng.range(0, Math.PI * 2),
      path: [],
      pathPos: 0,
      vx: 0,
      vy: 0,
      task: Task.None,
      timer: 0,
      anim: EntityAnim.Idle,
    });
  }

  /** The herd sets out to pasture (or heads home): cows and sheep pick their way at once. */
  setOut(s: Settlement, out: boolean): void {
    const herd = s.state.herd;
    if (!herd) return;
    herd.out = out;
    for (const a of this.animals) if (a.settlement === s.state.id && grazes(a.kind) && a.task !== Task.Leave) a.task = Task.None;
  }

  /** Grazing animals of a village (cows count 1, sheep ½). */
  grazers(settlement: number): number {
    let n = 0;
    for (const a of this.animals) if (a.settlement === settlement && grazes(a.kind) && a.task !== Task.Leave) n += a.kind === EntityKind.Cow ? 1 : 0.5;
    return n;
  }

  /** Grazing animals of a village within `r` cells of a cell (cows count 1, sheep ½). */
  near(settlement: number, cell: number, r: number): number {
    const W = this.world.width;
    const x = cell % W;
    const y = (cell / W) | 0;
    let n = 0;
    for (const a of this.animals)
      if (a.settlement === settlement && grazes(a.kind) && a.task !== Task.Leave && Math.hypot(a.x - x, a.y - y) <= r) n += a.kind === EntityKind.Cow ? 1 : 0.5;
    return n;
  }

  /** Advance all animals by `steps` hydro steps. */
  tick(steps: number, settlements: readonly Settlement[], homes: (s: Settlement) => HerdHome): void {
    const w = this.world;
    const cache = new Map<number, HerdHome>();
    for (const a of this.animals) {
      switch (a.task) {
        case Task.Walk:
        case Task.Leave: {
          const arrived = walk(w, a, steps, HERD.speed[a.kind] ?? 0.6);
          a.anim = EntityAnim.Walk;
          if (arrived) {
            if (a.task === Task.Walk) a.task = Task.None;
            a.vx = 0;
            a.vy = 0;
          }
          break;
        }
        case Task.Rest:
          a.vx = 0;
          a.vy = 0;
          a.timer -= steps;
          if (a.timer <= 0) {
            if (a.anim === EntityAnim.Eat) this.graze(a);
            a.task = Task.None;
          }
          break;
        case Task.None: {
          const s = settlements[a.settlement];
          if (!s) break;
          let h = cache.get(s.state.id);
          if (!h) cache.set(s.state.id, (h = homes(s)));
          this.choose(a, s, h);
          break;
        }
      }
    }
    // Sold animals leave at the store.
    this.animals = this.animals.filter((a) => !(a.task === Task.Leave && a.pathPos >= a.path.length));
  }

  private choose(a: Animal, s: Settlement, home: HerdHome): void {
    const w = this.world;
    const W = w.width;
    const herd = s.state.herd;
    let ax: number;
    let ay: number;
    let radius: number;
    if (grazes(a.kind) && herd && herd.fold >= 0) {
      const c = herd.out && herd.pasture >= 0 ? herd.pasture : herd.fold;
      ax = c % W;
      ay = (c / W) | 0;
      radius = herd.out ? 3.5 : 2.5;
    } else if (a.kind === EntityKind.Chick && home.houses.length) {
      const h = home.houses[a.id % home.houses.length]!;
      ax = h.x;
      ay = h.y;
      radius = 2.2;
    } else {
      const c = home.store ?? { x: s.state.x, y: s.state.y };
      ax = c.x + 1.5;
      ay = c.y + 1.5;
      radius = 2;
    }
    const here = this.cellOf(a);
    const far = Math.hypot(a.x - ax, a.y - ay) > radius + 1.5;
    const wet = w.water[here]! > 0.2;
    const r = this.rng.next();
    if (far || wet || r >= 0.6) {
      // Walk: back to the anchor, or a few steps about it.
      for (let k = 0; k < 4; k++) {
        const ang = this.rng.range(0, Math.PI * 2);
        const d = this.rng.next() * radius;
        const x = Math.round(ax + Math.cos(ang) * d);
        const y = Math.round(ay + Math.sin(ang) * d);
        if (!w.inBounds(x, y)) continue;
        const i = y * W + x;
        if (i === here || w.water[i]! > 0.02 || w.landuse[i] === LandUse.Building) continue;
        const path = this.pf.find(here, i, far ? { window: 40, maxExpand: 3000, bridge: this.bridge } : { window: 8, maxExpand: 300, bridge: this.bridge });
        if (path && path.length > 1) {
          a.path = path;
          a.pathPos = 0;
          a.task = Task.Walk;
          return;
        }
      }
    }
    // Graze (or peck) a while, or just stand.
    a.task = Task.Rest;
    if (r < 0.75 || far) {
      a.anim = EntityAnim.Eat;
      a.timer = 50 + this.rng.int(0, 100);
      a.heading += this.rng.range(-0.8, 0.8);
    } else {
      a.anim = EntityAnim.Idle;
      a.timer = 30 + this.rng.int(0, 50);
    }
  }

  /** A mouthful of grass where a grazing animal stands. */
  private graze(a: Animal): void {
    if (!grazes(a.kind)) return;
    const w = this.world;
    const i = this.cellOf(a);
    const v = w.vegetation[i]!;
    if (v > HERD.grazeFloor && v < HERD.grassMax && w.landuse[i] !== LandUse.Field) w.vegetation[i] = Math.max(HERD.grazeFloor, v - HERD.graze);
  }

  private cellOf(a: Animal): number {
    return this.world.idx(Math.round(a.x), Math.round(a.y));
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
    return m / CELL;
  }
}
