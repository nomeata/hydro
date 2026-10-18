/**
 * Footbridges (docs/PEOPLE.md §5.2): wooden plank bridges the villagers
 * build themselves where a narrow stretch of water stands between the
 * village and land it farms (or would like to farm), so they need not walk
 * the long way round. Built by a builder like the jetty, used by everyone's
 * A* (the deck cells become `LandUse.Bridge`), swept away when a flood
 * overtops the deck and rebuilt (a little higher) once the water is down.
 *
 * Planning works on the daily walking map (reach.ts): the "demand" is the
 * village's fields that are too far to walk to and the good land it turned
 * down for that reason. A crossing from a reachable dry bank straight over
 * at most `maxSpan` wet cells to a dry bank opposite is scored by how much
 * walking it would save on the way to that land, measured with all existing
 * bridges (of any village, finished or not) already in the path network and
 * checked with a real walk on the far bank, so a second bridge beside one
 * that already joins the same shores saves next to nothing; well-trodden
 * banks (desire paths, traffic) rank a little higher. A village's bridges
 * are capped by its size and spaced in time. Deterministic; state saved
 * with the people (optional field, older saves have none).
 */
import type { StructureInfo } from '../../shared/protocol';
import { LandUse, CellFlag, type World } from '../world';
import { MAX_WADE } from './path';
import { octile, WalkMap } from './reach';

export const BRIDGE = {
  /** Most deck cells (water to span), 20 m. */
  maxSpan: 4,
  /** Bridges per village at most: one per `perPeople` people (started), at most `perVillage`. */
  perVillage: 3,
  perPeople: 25,
  /** Days after choosing a bridge before the village considers another. */
  cooldown: 24,
  /** Best estimated crossings checked with a real walk on the far bank. */
  verify: 4,
  /** Villages this small don't build bridges. */
  minPeople: 4,
  /** Walking saved (cost units, ≈ cells, summed over the land it serves) to be worth a bridge. */
  minSaving: 120,
  /** Score penalty per deck cell. */
  spanCost: 6,
  /** Progress per builder visit. */
  perVisit: 0.1,
  /** Deck clearance above the water when built (m). */
  clearance: 0.35,
  /** A flood breaks the bridge when the water surface rises this far above the deck (m). */
  overtop: 0.05,
  /** What is left after a flood (progress): the piles. */
  wreck: 0.4,
  /** Days after a flood before the villagers start on it again (and the water must be below the deck). */
  rebuildAfter: 4,
  /** Rebuilt decks clear the flood that broke them by this much (m), but rise at most `maxRaise` above the banks. */
  floodMargin: 0.15,
  maxRaise: 1.2,
  /** An unfinished bridge whose crossing can't be worked for this long is given up. */
  giveUpDays: 60,
  /** Demand cells considered at most. */
  maxDemand: 64,
};

export interface Footbridge {
  id: number;
  settlement: number;
  /** Dry bank cells at either end: `a` on the village side (builders work from it), `b` opposite. */
  a: number;
  b: number;
  /** Deck cells over the water, from a to b. */
  cells: number[];
  /** 0..1 construction progress. */
  progress: number;
  /** Deck height (m), set when (re)built. */
  top: number;
  /** Day it was chosen, or last swept away (for rebuilding and giving up). */
  since: number;
  /** Swept away by a flood and not yet rebuilt. */
  broken?: boolean;
  /** Highest water surface seen at the deck while broken (m): rebuilt above it. */
  flood?: number;
}

const DIRS8: readonly [number, number][] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
  [1, 1],
  [-1, 1],
  [-1, -1],
  [1, -1],
];

function surface(w: World, i: number): number {
  return w.terrain(i) + w.water[i]!;
}

/** A dry cell a bridge may land on. */
function landing(w: World, i: number): boolean {
  const lu = w.landuse[i]!;
  return w.water[i]! < 0.05 && lu !== LandUse.Building && lu !== LandUse.Bridge && (w.flags[i]! & CellFlag.Structure) === 0;
}

/** A wet cell a deck may span. */
function spannable(w: World, i: number): boolean {
  const lu = w.landuse[i]!;
  return (
    w.water[i]! >= 0.05 &&
    (lu === LandUse.None || lu === LandUse.Path) &&
    (w.flags[i]! & (CellFlag.Structure | CellFlag.Outlet)) === 0 &&
    Number.isNaN(w.plan[i]!)
  );
}

export interface Crossing {
  a: number;
  b: number;
  cells: number[];
  saving: number;
  score: number;
}

/**
 * The best new crossing for a village, or null: from a dry bank reachable
 * on `map` over 1..maxSpan wet cells (at least one too deep or slow to
 * wade comfortably) to a dry bank, scored by the walking it saves on the
 * way to the `demand` cells. `map` should already walk over the existing
 * bridges (`bridge`, also used for the walk on the far bank), so only what
 * a new bridge adds counts. `taken(i)` marks cells of other bridges.
 * Candidates are ranked by an optimistic estimate (straight on from the far
 * bank); the best few are then checked with a walking map from the far
 * bank, and the best that still saves `minSaving` wins.
 */
export function chooseCrossing(
  w: World,
  map: WalkMap,
  demand: readonly number[],
  taken: (i: number) => boolean,
  bridge?: (i: number) => boolean,
): Crossing | null {
  if (!demand.length) return null;
  const W = w.width;
  // Unreachable demand counts as a long way round.
  const far = (d: number) => {
    const c = map.at(d);
    return Number.isFinite(c) ? c : 2.5 * map.straight(d) + 30;
  };
  const old = demand.map(far);
  const dx0 = demand.map((d) => d % W);
  const dy0 = demand.map((d) => (d / W) | 0);
  const cands: (Crossing & { viaB: number; dir: number })[] = [];
  for (let ly = 0; ly < map.h; ly++)
    for (let lx = 0; lx < map.w; lx++) {
      const ca = map.cost[ly * map.w + lx]!;
      if (!Number.isFinite(ca)) continue;
      const ax = map.x0 + lx;
      const ay = map.y0 + ly;
      const a = ay * W + ax;
      if (!landing(w, a)) continue;
      for (const [dx, dy] of DIRS8) {
        const cells: number[] = [];
        let b = -1;
        let deep = 0;
        for (let k = 1; k <= BRIDGE.maxSpan + 1; k++) {
          const x = ax + dx * k;
          const y = ay + dy * k;
          if (!w.inBounds(x, y)) break;
          const c = w.idx(x, y);
          if (taken(c)) break;
          if (landing(w, c)) {
            if (cells.length) b = c;
            break;
          }
          if (k > BRIDGE.maxSpan || !spannable(w, c)) break;
          cells.push(c);
          deep = Math.max(deep, w.water[c]!);
        }
        if (b < 0 || deep < MAX_WADE * 0.6 || taken(b)) continue;
        // The banks shouldn't be cliffs apart.
        if (Math.abs(w.terrain(a) - w.terrain(b)) > 1.5) continue;
        const span = cells.length * Math.hypot(dx, dy);
        const viaB = ca + span + 1;
        const cb = map.at(b);
        if (Number.isFinite(cb) && cb <= viaB + 4) continue; // the far bank is no farther the long way
        const bx = b % W;
        const by = (b / W) | 0;
        let saving = 0;
        for (let k = 0; k < demand.length; k++) {
          const nw = viaB + 1.15 * octile(Math.abs(dx0[k]! - bx), Math.abs(dy0[k]! - by));
          if (nw < old[k]!) saving += old[k]! - nw;
        }
        if (saving < BRIDGE.minSaving) continue;
        const bonus = -BRIDGE.spanCost * cells.length + (w.traffic[a]! + w.traffic[b]!) / 40 - ca * 0.1;
        cands.push({ a, b, cells, saving, score: saving + bonus, viaB, dir: bonus });
      }
    }
  cands.sort((p, q) => q.score - p.score || p.a - q.a || p.b - q.b);
  // Check the best estimates with a real walk from the far bank.
  let best: Crossing | null = null;
  const seen = new Set<number>();
  for (const c of cands) {
    if (seen.size >= BRIDGE.verify) break;
    if (best && c.score <= best.score) break; // estimates are optimistic: nothing below can win
    if (seen.has(c.b)) continue;
    seen.add(c.b);
    const far = new WalkMap(w, c.b % W, (c.b / W) | 0, undefined, bridge);
    let saving = 0;
    for (let k = 0; k < demand.length; k++) {
      const nw = c.viaB + far.at(demand[k]!);
      if (nw < old[k]!) saving += old[k]! - nw;
    }
    if (saving < BRIDGE.minSaving) continue;
    const score = saving + c.dir;
    if (!best || score > best.score) best = { a: c.a, b: c.b, cells: c.cells, saving, score };
  }
  return best;
}

/** The footbridges of all villages (owned by PeopleSystem; saved with it). */
export class Bridges {
  list: Footbridge[] = [];
  /** Set when a bridge appeared, changed stage or broke (for snapshots). */
  dirty = true;

  constructor(
    private readonly world: World,
    private readonly nextId: () => number,
  ) {}

  of(settlement: number): Footbridge[] {
    return this.list.filter((b) => b.settlement === settlement);
  }

  /** Cells of any bridge (ends and deck). */
  private taken(): Set<number> {
    const s = new Set<number>();
    for (const b of this.list) {
      s.add(b.a);
      s.add(b.b);
      for (const c of b.cells) s.add(c);
    }
    return s;
  }

  /** A village has a bridge on the way (being built or waiting to be rebuilt). */
  pending(settlement: number): boolean {
    return this.list.some((b) => b.settlement === settlement && b.progress < 1);
  }

  /** Whether the water lets the builders work on bridge b today. */
  workable(b: Footbridge, day: number): boolean {
    const w = this.world;
    if (w.water[b.a]! > MAX_WADE * 0.5) return false;
    if (!b.broken) return true;
    if (day < b.since + BRIDGE.rebuildAfter) return false;
    for (const c of b.cells) if (surface(w, c) > b.top - 0.2) return false;
    return true;
  }

  /** The bridge a builder of the village should work on now, or null. */
  site(settlement: number, day: number, blocked: (i: number) => boolean): Footbridge | null {
    for (const b of this.list) if (b.settlement === settlement && b.progress < 1 && !blocked(b.a) && this.workable(b, day)) return b;
    return null;
  }

  /**
   * Daily per village: give up crossings that can't be worked any more,
   * and maybe choose a new one for the `demand` cells (fields too far to
   * walk to, good land turned down for it).
   */
  plan(settlement: number, population: number, map: WalkMap, demand: readonly number[], day: number): void {
    const w = this.world;
    // Give up on what the water won't allow (the river moved, the banks are gone).
    const before = this.list.length;
    this.list = this.list.filter((b) => {
      if (b.settlement !== settlement || b.progress >= 1 || this.workable(b, day)) return true;
      return day - b.since < BRIDGE.giveUpDays;
    });
    if (this.list.length !== before) this.dirty = true;
    if (population < BRIDGE.minPeople || this.pending(settlement) || !demand.length) return;
    const mine = this.of(settlement);
    if (mine.length >= Math.min(BRIDGE.perVillage, Math.ceil(population / BRIDGE.perPeople))) return;
    if (mine.some((b) => day - b.since < BRIDGE.cooldown)) return;
    let dem = demand;
    if (dem.length > BRIDGE.maxDemand) {
      const step = dem.length / BRIDGE.maxDemand;
      dem = Array.from({ length: BRIDGE.maxDemand }, (_, k) => demand[Math.floor(k * step)]!);
    }
    const taken = this.taken();
    // Every bridge (finished, being built or waiting to be rebuilt) counts as
    // part of the path network: only what a new one adds is worth building.
    const deck = new Set<number>();
    for (const b of this.list) for (const c of b.cells) deck.add(c);
    const onBridge = (i: number) => w.landuse[i] === LandUse.Bridge || deck.has(i);
    const net = this.list.some((b) => b.progress < 1) ? new WalkMap(w, map.cx, map.cy, undefined, onBridge) : map;
    const c = chooseCrossing(w, net, dem, (i) => taken.has(i), onBridge);
    if (!c) return;
    this.list.push({ id: this.nextId(), settlement, a: c.a, b: c.b, cells: c.cells, progress: 0, top: 0, since: day });
    this.dirty = true;
  }

  /** A builder's visit to bridge `id`: returns true when it was just finished. */
  work(id: number): boolean {
    const b = this.list.find((x) => x.id === id);
    if (!b || b.progress >= 1) return false;
    b.progress = Math.min(1, b.progress + BRIDGE.perVisit);
    this.dirty = true;
    if (b.progress < 1) return false;
    const w = this.world;
    const banks = Math.max(w.terrain(b.a), w.terrain(b.b));
    let top = banks;
    for (const c of b.cells) top = Math.max(top, surface(w, c) + BRIDGE.clearance);
    if (b.broken) {
      // Rebuilt higher: clear the flood that took it (within reason).
      top = Math.max(top, b.top);
      if (b.flood !== undefined) top = Math.max(top, Math.min(banks + BRIDGE.maxRaise, b.flood + BRIDGE.floodMargin));
    }
    b.top = top;
    for (const c of b.cells) if (w.landuse[c] === LandUse.None || w.landuse[c] === LandUse.Path) w.landuse[c] = LandUse.Bridge;
    delete b.broken;
    delete b.flood;
    return true;
  }

  /**
   * Floods (checked with the houses, every 30 steps): water over a deck
   * sweeps the planks away; the piles stay. Returns whether any broke.
   */
  flood(day: number): boolean {
    const w = this.world;
    let broke = false;
    for (const b of this.list) {
      if (b.broken) {
        let hi = b.flood ?? 0;
        for (const c of b.cells) hi = Math.max(hi, surface(w, c));
        b.flood = hi;
        continue;
      }
      if (b.progress < 1) continue;
      let hi = -Infinity;
      for (const c of b.cells) hi = Math.max(hi, surface(w, c));
      if (hi <= b.top + BRIDGE.overtop) continue;
      b.broken = true;
      b.flood = hi;
      b.progress = BRIDGE.wreck;
      b.since = day;
      for (const c of b.cells) if (w.landuse[c] === LandUse.Bridge) w.landuse[c] = LandUse.None;
      broke = true;
    }
    if (broke) this.dirty = true;
    return broke;
  }
}

/** Footbridges for the structure list (rendering). */
export function bridgeInfo(w: World, list: readonly Footbridge[]): StructureInfo[] {
  const W = w.width;
  const out: StructureInfo[] = [];
  for (const b of list) {
    if (b.progress <= 0) continue;
    const ax = b.a % W;
    const ay = (b.a / W) | 0;
    const bx = b.b % W;
    const by = (b.b / W) | 0;
    const o: StructureInfo = {
      id: 200000 + b.id,
      kind: 'bridge',
      x: ax,
      y: ay,
      x2: bx,
      y2: by,
      rot: Math.atan2(by - ay, bx - ax),
      width: b.cells.length,
      top: b.top > 0 ? b.top : Math.max(w.terrain(b.a), w.terrain(b.b)),
      sill: Math.min(w.terrain(b.a), w.terrain(b.b)),
      open: false,
      progress: b.progress,
    };
    if (b.broken) o.broken = true;
    out.push(o);
  }
  return out;
}
