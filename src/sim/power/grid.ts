/**
 * The power grid (M6, docs/GAMEPLAY.md §1.5): turbines, poles, wires and
 * electric pumps, and every step the dispatch of each connected network.
 *
 * Networks: finished turbines and poles are nodes, wires join them (drawn
 * pole lines); a finished house belongs to the nearest node within
 * SUPPLY_RADIUS, a pump to the node nearest its pump house.
 *
 * Dispatch per network and step (power/power.ts has the physics):
 *  1. Every turbine measures its head and full flow. The share `f` of it
 *     whose pool stands at its spill level (water that would leave anyway)
 *     runs always; the rest is storage and runs only to cover the houses'
 *     demand that the free share does not. A pool filled by a pump on the
 *     network is all storage (pumped storage).
 *  2. The houses take what they need of the production (share < 1: the
 *     lights dim); a surplus runs the pumps (houses first); what is left is
 *     dumped (the turbines then simply run, as a water wheel would).
 * Water moves from cell to cell (turbine: high side → low side; pump:
 * inlet → outlet), so it is conserved; the energy is booked in `ledger`
 * (J): produced = houses + pumps + dumped.
 *
 * Lines: the player places turbines and pumps; the villagers plan the
 * poles and wires themselves once a turbine has made power (planGrid,
 * lines.ts): from the grid to every village and pump, to the houses no
 * pole reaches, and between separate grids, so the colony has one grid.
 * The village builders put the poles up (poleSite, workPole; the spirit
 * crew those out of reach); floods and ground moved under a pole knock it
 * down (floods, groundCheck) and they put it up again; poles in the way of
 * new houses, fields, plans or the water move aside.
 *
 * Deterministic (no RNG), saved as PowerState.
 */
import type { PowerInfo, PowerStats, Pt, SimTime } from '../../shared/protocol';
import { CELL_AREA, DT, STEPS_PER_DAY } from '../constants';
import { LandUse, type World } from '../world';
import { LINES, placeAlong, poleCost, routeLine } from './lines';
import {
  LINK_SPAN,
  POLE_SNAP,
  POLE_SPACING,
  POWER,
  SUPPLY_RADIUS,
  houseDemand,
  polePositions,
  pumpFlow,
  pumpPower,
  pumpSite,
  turbineFlow,
  turbinePower,
  turbineSite,
  type PowerGrid2D,
} from './power';

export interface Turbine {
  id: number;
  /** Crest cell and the wall's direction. */
  x: number;
  y: number;
  rot: number;
  /** Penstock ends either side of the wall, the wall's crest (m), and the pool's high-water mark (absent before the first step). */
  a: number;
  b: number;
  crest: number;
  mark?: number;
  progress: number;
  /** Last step: flow (m³/s, > 0 from a to b, < 0 from b to a), head (m), power (W). */
  flow: number;
  head: number;
  power: number;
  /** Energy produced in all (J) and water turbined (m³). */
  produced: number;
  water: number;
}

export interface Pole {
  id: number;
  x: number;
  y: number;
  progress: number;
  /** The village whose builders put it up (-1 or absent: the spirit crew; player poles of older saves). */
  settlement?: number;
  /** Day it was planned, moved or knocked down (absent: long ago). */
  since?: number;
  /** Knocked down (by a flood, or ground moved under it) on this day, until rebuilt. */
  down?: number;
  /** Ground height (m) when it was put up: moved much, the pole falls. */
  ground?: number;
  /** A standing pole (id) this one replaces once it stands (moved out of a new field without the lights going out). */
  replaces?: number;
}

export interface Pump {
  id: number;
  /** Inlet (in the water), pump house, outlet (cell coordinates). */
  x: number;
  y: number;
  hx: number;
  hy: number;
  ox: number;
  oy: number;
  progress: number;
  /** Last step: lifted flow (m³/s) and power drawn (W). */
  flow: number;
  power: number;
  /** Water lifted in all (m³). */
  pumped: number;
}

/** Energy book (J) and water moved (m³), since the world began. */
export interface PowerLedger {
  produced: number;
  /** Delivered to houses, to pumps, and left unused. */
  houses: number;
  pumps: number;
  dumped: number;
  /** Of `produced`, the part from storage (turbines running below their crest on demand). */
  storage: number;
  /** Houses' demand (J); `houses` ≤ `demand`. */
  demand: number;
  turbined: number;
  pumpedWater: number;
}

export interface PowerState {
  nextId: number;
  turbines: Turbine[];
  poles: Pole[];
  /** Pairs [nodeId, nodeId] of wires between turbines and poles. */
  wires: number[];
  pumps: Pump[];
  ledger: PowerLedger;
  /** The ledger at the start of the current day, and the last full day's totals. */
  dayStart: PowerLedger;
  lastDay: PowerLedger;
  /** Light per house today: pairs [houseId, sum of light shares over the day's steps]. */
  light: number[];
  lightSteps: number;
  /** Lines that found no way: pairs [target key, day to try again] (absent in older saves). */
  failed?: number[];
}

/** A village as the grid's planner sees it: its id and centre (the store). */
export interface GridVillage {
  id: number;
  x: number;
  y: number;
}

/** A house as the grid sees it (people/village.ts buildings). */
export interface GridHouse {
  id: number;
  x: number;
  y: number;
  settlement: number;
}

/** Turbine progress per unit of lining work (a turbine is ~3 lined cells' work), poles and pumps. */
const TURBINE_WORK = 0.33;
const POLE_WORK = 2;
/** The spirit crew's poles (out of the villages' reach) go up more slowly, one at a time. */
const CREW_POLE_WORK = 0.6;
const PUMP_WORK = 0.5;

function newLedger(): PowerLedger {
  return { produced: 0, houses: 0, pumps: 0, dumped: 0, storage: 0, demand: 0, turbined: 0, pumpedWater: 0 };
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

interface Net {
  turbines: Turbine[];
  pumps: Pump[];
  houses: GridHouse[];
  /** Supply share of the houses' demand last step (1 when there is no demand). */
  share: number;
}

export class PowerGrid {
  turbines: Turbine[] = [];
  poles: Pole[] = [];
  wires: number[] = [];
  pumps: Pump[] = [];
  ledger: PowerLedger = newLedger();
  private dayStart: PowerLedger = newLedger();
  lastDay: PowerLedger = newLedger();
  private nextId = 1;
  /** Where things may be placed (fog of war), or null for anywhere. */
  allow: ((i: number) => boolean) | null = null;
  /** The village houses (set by the simulation; none without villages). */
  houses: () => readonly GridHouse[] = () => [];
  /** The villages (set by the simulation): the grid's lines run to them. */
  villages: () => readonly GridVillage[] = () => [];
  /** The villagers plan and build the lines (off in the staged tool-card scenes). */
  autoGrid = true;
  /** Lines that found no way: target key → day to try again. */
  private failed = new Map<number, number>();
  /** Told each day of every village's mean light share (0..1) of that day. */
  onVillageLight: ((settlement: number, share: number) => void) | null = null;
  /** Set when what the renderer shows changed. */
  dirty = true;
  private nets: Net[] = [];
  /** House id → light level shown (0..1, in tenths), and the light summed over today's steps. */
  private lit = new Map<number, number>();
  private light = new Map<number, number>();
  private lightSteps = 0;
  /** Last step's totals (W) for the stats. */
  private now = { produced: 0, demand: 0, supplied: 0, pumping: 0 };

  constructor(private readonly world: World) {}

  get empty(): boolean {
    return this.turbines.length === 0 && this.poles.length === 0 && this.pumps.length === 0;
  }

  private grid(): PowerGrid2D {
    const w = this.world;
    return { width: w.width, height: w.height, terrain: (i) => w.terrain(i), depth: (i) => w.water[i]!, allowed: this.allow ?? undefined };
  }

  // ---------------------------------------------------------------------------
  // Placement

  placeTurbine(p: Pt): Turbine | null {
    const site = turbineSite(this.grid(), p);
    if (!site?.ok) return null;
    if (this.turbines.some((t) => Math.hypot(t.x - site.x, t.y - site.y) < 2)) return null;
    const t: Turbine = {
      id: this.nextId++,
      x: site.x,
      y: site.y,
      rot: site.rot,
      a: site.a,
      b: site.b,
      crest: site.crest,
      progress: 0,
      flow: 0,
      head: 0,
      power: 0,
      produced: 0,
      water: 0,
    };
    this.turbines.push(t);
    this.changed();
    return t;
  }

  /** Nodes (turbines and poles, finished or not) as [id, x, y]. */
  private nodes(): [number, number, number][] {
    return [...this.turbines.map((t): [number, number, number] => [t.id, t.x, t.y]), ...this.poles.map((p): [number, number, number] => [p.id, p.x, p.y])];
  }

  private nearestNode(x: number, y: number, maxD: number, except = -1): number {
    let best = -1;
    let bd = maxD;
    for (const [id, nx, ny] of this.nodes()) {
      if (id === except) continue;
      const d = Math.hypot(nx - x, ny - y);
      if (d <= bd) {
        bd = d;
        best = id;
      }
    }
    return best;
  }

  private nodePos(id: number): [number, number] | null {
    const t = this.turbines.find((o) => o.id === id);
    if (t) return [t.x, t.y];
    const p = this.poles.find((o) => o.id === id);
    return p ? [p.x, p.y] : null;
  }

  private link(a: number, b: number): void {
    if (a === b || a < 0 || b < 0) return;
    for (let k = 0; k + 1 < this.wires.length; k += 2) {
      const u = this.wires[k]!;
      const v = this.wires[k + 1]!;
      if ((u === a && v === b) || (u === b && v === a)) return;
    }
    this.wires.push(a, b);
  }

  /**
   * A line of poles along a stroke (see polePositions): a stroke starting or
   * ending at a turbine or pole joins it; a new first pole is wired to the
   * nearest node within LINK_SPAN. Poles never stand in water. Returns the
   * number of new poles.
   */
  placePoles(points: readonly Pt[]): number {
    const w = this.world;
    let prev = -1;
    let added = 0;
    const pos = polePositions(points);
    // A pole stands on open dry ground: here, or right beside (not in a house or on a bridge).
    const spot = (x: number, y: number): [number, number] | null => {
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (!w.inBounds(nx, ny)) continue;
        const i = w.idx(nx, ny);
        const lu = w.landuse[i]!;
        if (w.water[i]! >= 0.1 || lu === LandUse.Building || lu === LandUse.Bridge || (this.allow && !this.allow(i))) continue;
        return [nx, ny];
      }
      return null;
    };
    pos.forEach(([x0, y0], k) => {
      if (!w.inBounds(x0, y0)) return;
      let x = x0;
      let y = y0;
      let id = this.nearestNode(x, y, POLE_SNAP);
      if (id < 0) {
        const s = spot(x0, y0);
        if (!s) return;
        [x, y] = s;
        id = this.nextId++;
        this.poles.push({ id, x, y, progress: 0 });
        added++;
        // The line's first pole hooks onto the grid nearby.
        if (prev < 0 && k === 0) this.link(id, this.nearestNode(x, y, LINK_SPAN, id));
      }
      if (prev >= 0) {
        const a = this.nodePos(prev)!;
        // (A pole skipped in the water leaves a longer span.)
        if (Math.hypot(a[0] - x, a[1] - y) <= 2 * POLE_SPACING + 1) this.link(prev, id);
      }
      prev = id;
    });
    // The last pole too (a line drawn towards the grid).
    if (prev >= 0 && added > 0) {
      const p = this.nodePos(prev)!;
      const near = this.nearestNode(p[0], p[1], LINK_SPAN, prev);
      if (near >= 0 && !this.linked(prev)) this.link(prev, near);
    }
    if (added > 0 || pos.length > 1) this.changed();
    return added;
  }

  private linked(id: number): boolean {
    return this.wires.includes(id);
  }

  placePump(points: readonly Pt[]): Pump | null {
    const site = pumpSite(this.grid(), points);
    if (!site?.ok) return null;
    if (this.pumps.some((o) => o.x === site.x && o.y === site.y)) return null;
    const p: Pump = { id: this.nextId++, x: site.x, y: site.y, hx: site.hx, hy: site.hy, ox: site.ox, oy: site.oy, progress: 0, flow: 0, power: 0, pumped: 0 };
    this.pumps.push(p);
    this.changed();
    return p;
  }

  /** Remove turbines and pumps (finished or not) within a radius (the Remove tool; the poles are the villagers'). */
  cancel(x: number, y: number, radius: number): boolean {
    const r2 = radius * radius;
    const near = (px: number, py: number) => (px - x) ** 2 + (py - y) ** 2 <= r2;
    const gone = new Set<number>();
    const t = this.turbines.filter((o) => !near(o.x, o.y) || (gone.add(o.id), false));
    const n = this.pumps.length;
    this.pumps = this.pumps.filter((o) => !near(o.hx, o.hy) && !near(o.x, o.y));
    if (!gone.size && n === this.pumps.length) return false;
    this.turbines = t;
    this.dropWires(gone);
    this.changed();
    return true;
  }

  /** Remove one turbine or pump by id (the selection's Remove; the poles are the villagers'). */
  remove(id: number): boolean {
    const n = this.turbines.length + this.pumps.length;
    this.turbines = this.turbines.filter((o) => o.id !== id);
    this.pumps = this.pumps.filter((o) => o.id !== id);
    if (n === this.turbines.length + this.pumps.length) return false;
    this.dropWires(new Set([id]));
    this.changed();
    return true;
  }

  /** Earthworks planned over turbines and pumps take them down (see Structures.dismantle); poles move out of the way (planGrid). */
  dismantle(cells: ReadonlySet<number>): boolean {
    if (cells.size === 0) return false;
    const W = this.world.width;
    const at = (x: number, y: number) => cells.has(y * W + x);
    const gone = new Set<number>();
    for (const t of this.turbines) if (at(t.x, t.y) || cells.has(t.a) || cells.has(t.b)) gone.add(t.id);
    for (const p of this.pumps) if (at(p.x, p.y) || at(p.hx, p.hy) || at(p.ox, p.oy)) gone.add(p.id);
    if (!gone.size) return false;
    this.turbines = this.turbines.filter((o) => !gone.has(o.id));
    this.pumps = this.pumps.filter((o) => !gone.has(o.id));
    this.dropWires(gone);
    this.changed();
    return true;
  }

  private dropWires(gone: ReadonlySet<number>): void {
    const wires: number[] = [];
    for (let k = 0; k + 1 < this.wires.length; k += 2)
      if (!gone.has(this.wires[k]!) && !gone.has(this.wires[k + 1]!)) wires.push(this.wires[k]!, this.wires[k + 1]!);
    this.wires = wires;
  }

  private changed(): void {
    this.dirty = true;
  }

  // ---------------------------------------------------------------------------
  // Building: turbines and pumps by the spirit crew (as the stone work), poles by the village builders

  get pending(): boolean {
    return this.turbines.some((t) => t.progress < 1) || this.poles.some((p) => p.progress < 1) || this.pumps.some((p) => p.progress < 1);
  }

  /**
   * The spirit crew's work: turbines and pumps, and the poles no village
   * builds (out of every village's reach, waiting too long, or the
   * player's own of older saves), one at a time. Without `day` (staging)
   * every pole goes up at once.
   */
  crewWork(amount: number, day?: number): void {
    for (const o of [...this.turbines, ...this.pumps]) {
      if (o.progress >= 1) continue;
      o.progress = Math.min(1, o.progress + amount * ('a' in o ? TURBINE_WORK : PUMP_WORK));
      this.dirty = true;
    }
    const w = this.world;
    let n = day === undefined ? Infinity : 1;
    for (const p of [...this.poles]) {
      if (p.progress >= 1 || n <= 0) continue;
      if (day !== undefined && (!this.crewPole(p, day) || w.water[w.idx(p.x, p.y)]! >= LINES.dry)) continue;
      p.progress = Math.min(1, p.progress + amount * (day === undefined ? POLE_WORK : CREW_POLE_WORK));
      if (p.progress >= 1) this.raised(p);
      n--;
      this.dirty = true;
    }
  }

  /** Whether the spirit crew puts pole p up (no village's builders do). */
  private crewPole(p: Pole, day: number): boolean {
    return (p.settlement ?? -1) < 0 || day - (p.since ?? -Infinity) > LINES.crewAfter;
  }

  private raised(p: Pole): void {
    p.progress = 1;
    p.ground = this.world.terrain(this.world.idx(p.x, p.y));
    delete p.down;
    this.dirty = true;
    // The pole it replaces comes down.
    if (p.replaces !== undefined) {
      const old = p.replaces;
      delete p.replaces;
      if (this.poles.some((o) => o.id === old)) {
        this.poles = this.poles.filter((o) => o.id !== old);
        this.dropWires(new Set([old]));
      }
    }
  }

  /** The pole a builder of village `settlement` should put up next (lowest id first), or null. */
  poleSite(settlement: number, day: number, blocked: (i: number) => boolean): { id: number; cell: number } | null {
    const w = this.world;
    for (const p of this.poles) {
      if (p.progress >= 1 || (p.settlement ?? -1) !== settlement || this.crewPole(p, day)) continue;
      const i = w.idx(p.x, p.y);
      if (w.water[i]! >= LINES.dry || blocked(i)) continue;
      return { id: p.id, cell: i };
    }
    return null;
  }

  /** A builder's visit to pole `id`: returns true when it was just put up. */
  workPole(id: number): boolean {
    const p = this.poles.find((o) => o.id === id);
    if (!p || p.progress >= 1) return false;
    p.progress = Math.min(1, p.progress + LINES.perVisit);
    this.dirty = true;
    if (p.progress < 1) return false;
    this.raised(p);
    return true;
  }

  /** Floods (every 30 steps): deep or quick water knocks standing poles down. Returns whether any fell. */
  floods(day: number): boolean {
    const w = this.world;
    let any = false;
    for (const p of this.poles) {
      if (p.progress < 1) continue;
      const i = w.idx(p.x, p.y);
      const d = w.water[i]!;
      if (d < LINES.floodWade) continue;
      if (d >= LINES.floodDeep || Math.hypot(w.velX[i]!, w.velY[i]!) >= LINES.floodSpeed) {
        this.knock(p, day);
        any = true;
      }
    }
    return any;
  }

  /** After the brushes (and daily): a standing pole whose ground moved more than LINES.ground falls. */
  groundCheck(day: number): boolean {
    const w = this.world;
    let any = false;
    for (const p of this.poles) {
      if (p.progress < 1) continue;
      const h = w.terrain(w.idx(p.x, p.y));
      if (p.ground === undefined) p.ground = h;
      else if (Math.abs(h - p.ground) > LINES.ground) {
        this.knock(p, day);
        any = true;
      }
    }
    return any;
  }

  /** Down it goes: a stump is left, and the builders come back for it. */
  private knock(p: Pole, day: number): void {
    p.progress = LINES.stump;
    p.down = day;
    p.since = day;
    delete p.ground;
    this.dirty = true;
  }

  // ---------------------------------------------------------------------------
  // The villagers' grid (lines.ts): planned daily, once a turbine has made power

  /**
   * Daily: move poles out of the way of new houses, fields, plans and the
   * water (or give them up), then, once any turbine has made power, plan
   * the next lines: from the grid to each village (its store) and pump
   * not on it yet, to stray stretches of line, to the houses no pole
   * reaches, and between separate grids, nearest first; at most
   * LINES.routesPerDay a day, and none while many poles wait to be built.
   */
  planGrid(day: number): void {
    if (!this.autoGrid) return;
    for (const [k, until] of this.failed) if (until <= day) this.failed.delete(k);
    this.repair(day);
    if (!this.turbines.some((t) => t.progress >= 1 && t.produced > 0)) return;
    for (let r = 0; r < LINES.routesPerDay; r++) {
      if (this.poles.filter((p) => p.progress < 1).length >= LINES.maxPending) break;
      if (!this.nextLine(day)) break;
    }
  }

  private repair(day: number): void {
    const w = this.world;
    const gone = new Set<number>();
    for (const p of this.poles) {
      const i = w.idx(p.x, p.y);
      const lu = w.landuse[i]!;
      const field = lu === LandUse.Field || lu === LandUse.Garden;
      let move: boolean;
      if (w.water[i]! >= LINES.dry) {
        // Knocked down, or not yet built, and the water stays: dry ground nearby.
        const since = p.down ?? (p.progress < 1 ? (p.since ?? -Infinity) : Infinity);
        move = day - since > LINES.wetDays;
      } else move = field || !Number.isFinite(poleCost(w, i, null, true));
      if (!move || this.poles.some((o) => o.replaces === p.id)) continue;
      const to = this.moveSpot(p);
      if (to && field && p.progress >= 1) {
        // Out of a new field: a new pole beside it first, then this one comes down (raised).
        const id = this.nextId++;
        this.poles.push({ id, x: to[0], y: to[1], progress: 0, settlement: this.ownerAt(to[0], to[1]), since: day, replaces: p.id });
        for (const o of this.wiredTo(p.id)) this.link(id, o);
        this.dirty = true;
      } else if (to) {
        p.x = to[0];
        p.y = to[1];
        p.progress = 0;
        p.since = day;
        delete p.down;
        delete p.ground;
        this.dirty = true;
      } else if (!field) gone.add(p.id);
    }
    // Poles left without a wire carry nothing.
    for (const p of this.poles) if (!gone.has(p.id) && !this.wires.includes(p.id)) gone.add(p.id);
    if (!gone.size) return;
    this.poles = this.poles.filter((p) => !gone.has(p.id));
    this.dropWires(gone);
    this.changed();
  }

  /** The nodes wired to node `id`. */
  private wiredTo(id: number): number[] {
    const out: number[] = [];
    for (let k = 0; k + 1 < this.wires.length; k += 2) {
      if (this.wires[k] === id) out.push(this.wires[k + 1]!);
      else if (this.wires[k + 1] === id) out.push(this.wires[k]!);
    }
    return out;
  }

  /** The village whose builders put up a pole at (x, y): the nearest within LINES.reach, else -1 (the spirit crew). */
  private ownerAt(x: number, y: number): number {
    let owner = -1;
    let od: number = LINES.reach;
    for (const v of this.villages()) {
      const d = Math.hypot(v.x - x, v.y - y);
      if (d <= od) {
        od = d;
        owner = v.id;
      }
    }
    return owner;
  }

  /** The best dry cell within LINES.moveReach for pole p, its spans still reaching its neighbours. */
  private moveSpot(p: Pole): [number, number] | null {
    const w = this.world;
    const nb: [number, number][] = [];
    for (const o of this.wiredTo(p.id)) {
      const q = this.nodePos(o);
      if (q) nb.push(q);
    }
    const others = this.nodes().filter(([id]) => id !== p.id);
    const R = LINES.moveReach;
    let best: [number, number] | null = null;
    let bc = Infinity;
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        const d = Math.hypot(dx, dy);
        if (d === 0 || d > R) continue;
        const x = p.x + dx;
        const y = p.y + dy;
        if (!w.inBounds(x, y)) continue;
        const c = poleCost(w, w.idx(x, y), this.allow);
        if (!Number.isFinite(c)) continue;
        if (others.some(([, ox, oy]) => Math.hypot(ox - x, oy - y) < LINES.minGap)) continue;
        if (nb.some(([ox, oy]) => Math.hypot(ox - x, oy - y) > LINK_SPAN)) continue;
        const v = c + 0.5 * d;
        if (v < bc) {
          bc = v;
          best = [x, y];
        }
      }
    return best;
  }

  /** Plan the most wanted line; false when nothing is wanted. */
  private nextLine(day: number): boolean {
    const w = this.world;
    const W = w.width;
    const parent = new Map<number, number>();
    const find = (a: number): number => {
      let r = a;
      while (parent.get(r) !== r) r = parent.get(r)!;
      parent.set(a, r);
      return r;
    };
    for (const t of this.turbines) if (t.progress >= 1) parent.set(t.id, t.id);
    for (const p of this.poles) parent.set(p.id, p.id);
    for (let k = 0; k + 1 < this.wires.length; k += 2) {
      const a = this.wires[k]!;
      const b = this.wires[k + 1]!;
      if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b));
    }
    interface Node {
      id: number;
      x: number;
      y: number;
      root: number;
    }
    const nodes: Node[] = [];
    for (const t of this.turbines) if (t.progress >= 1) nodes.push({ id: t.id, x: t.x, y: t.y, root: find(t.id) });
    for (const p of this.poles) nodes.push({ id: p.id, x: p.x, y: p.y, root: find(p.id) });
    const powered = new Set<number>();
    for (const t of this.turbines) if (t.progress >= 1 && t.produced > 0) powered.add(find(t.id));
    const live = nodes.filter((n) => powered.has(n.root));
    if (!live.length) return false;
    const R = SUPPLY_RADIUS;
    const nearest = (x: number, y: number, among: readonly Node[] = live): { n: Node; d: number } => {
      let n = among[0]!;
      let d = Infinity;
      for (const o of among) {
        const e = Math.hypot(o.x - x, o.y - y);
        if (e < d) {
          d = e;
          n = o;
        }
      }
      return { n, d };
    };
    const covered = (x: number, y: number) => live.some((o) => Math.hypot(o.x - x, o.y - y) <= R);
    const houses = this.houses();
    interface Target {
      key: number;
      from: Node;
      d: number;
      to: [number, number];
      node: Node | null;
      score?: (x: number, y: number) => number;
      trim?: (x: number, y: number) => boolean;
    }
    let best: Target | null = null;
    const offer = (t: Target) => {
      if (this.failed.has(t.key)) return;
      if (!best || t.d < best.d) best = t;
    };
    // Villages and pumps not on the grid, and stray lines that reach houses.
    for (const v of this.villages()) {
      const vh = houses.filter((h) => h.settlement === v.id);
      if (!vh.length || covered(v.x, v.y) || vh.some((h) => covered(h.x, h.y))) continue;
      const { n, d } = nearest(v.x, v.y);
      const reach = (x: number, y: number) => -0.4 * vh.filter((h) => Math.hypot(h.x - x, h.y - y) <= R - 1).length;
      // The line ends at the village's edge, where a pole reaches all its houses (not in among them).
      const trim = (x: number, y: number) => vh.every((h) => Math.hypot(h.x - x, h.y - y) <= R - 2);
      offer({ key: v.y * W + v.x, from: n, d, to: [v.x, v.y], node: null, score: reach, trim });
    }
    for (const p of this.pumps) {
      if (covered(p.hx, p.hy)) continue;
      const { n, d } = nearest(p.hx, p.hy);
      offer({ key: p.hy * W + p.hx, from: n, d, to: [p.hx, p.hy], node: null });
    }
    const stray = new Map<number, Node[]>();
    for (const n of nodes) if (!powered.has(n.root)) stray.set(n.root, [...(stray.get(n.root) ?? []), n]);
    for (const [root, list] of stray) {
      if (!houses.some((h) => list.some((o) => Math.hypot(o.x - h.x, o.y - h.y) <= R))) continue;
      let pick: Target | null = null;
      for (const o of list) {
        const { n, d } = nearest(o.x, o.y);
        if (!pick || d < pick.d) pick = { key: -1 - root, from: n, d, to: [o.x, o.y], node: o };
      }
      if (pick) offer(pick);
    }
    // Then the houses no pole reaches yet.
    if (!best) {
      const open = houses.filter((h) => !covered(h.x, h.y));
      const reach = (x: number, y: number) => -0.4 * open.filter((h) => Math.hypot(h.x - x, h.y - y) <= R - 1).length;
      for (const h of open) {
        const { n, d } = nearest(h.x, h.y);
        offer({ key: h.y * W + h.x, from: n, d, to: [h.x, h.y], node: null, score: reach });
      }
    }
    // Then one grid of all.
    if (!best && powered.size > 1) {
      const roots = [...powered];
      for (let a = 0; a < roots.length; a++)
        for (let b = a + 1; b < roots.length; b++) {
          const A = live.filter((n) => n.root === roots[a]);
          const B = live.filter((n) => n.root === roots[b]);
          for (const o of B) {
            const { n, d } = nearest(o.x, o.y, A);
            offer({ key: -1 - Math.min(roots[a]!, roots[b]!), from: n, d, to: [o.x, o.y], node: o });
          }
        }
    }
    const t = best as Target | null;
    if (!t) return false;
    if (t.d > LINES.maxLine || !this.buildLine(t.from, t.to, t.node, nodes, day, t.score, t.trim)) this.failed.set(t.key, day + LINES.retryDays);
    return true;
  }

  /** Plan a line of poles from node `from` to `to` (node `node`, or a spot beside it). Returns whether it could. */
  private buildLine(
    from: { id: number; x: number; y: number },
    to: [number, number],
    node: { id: number } | null,
    nodes: readonly { x: number; y: number }[],
    day: number,
    score?: (x: number, y: number) => number,
    trim?: (x: number, y: number) => boolean,
  ): boolean {
    const w = this.world;
    let path: number[] | null = null;
    for (const m of LINES.margins) if ((path = routeLine(w, w.idx(from.x, from.y), w.idx(to[0], to[1]), this.allow, m))) break;
    if (!path) return false;
    if (trim && !node) {
      const k = path.findIndex((i) => trim(i % w.width, (i / w.width) | 0));
      if (k > 0) path = path.slice(0, k + 1);
    }
    const others = nodes.map((n): [number, number] => [n.x, n.y]);
    const opts = { allow: this.allow, toNode: node !== null, others, endScore: score };
    const poles = placeAlong(w, path, opts) ?? placeAlong(w, path, { ...opts, fields: true });
    if (!poles || (!poles.length && !node)) return false;
    let prev = from.id;
    for (const [x, y] of poles) {
      // Built by the nearest village's builders, if it is near enough.
      const id = this.nextId++;
      this.poles.push({ id, x, y, progress: 0, settlement: this.ownerAt(x, y), since: day });
      this.link(prev, id);
      prev = id;
    }
    if (node) this.link(prev, node.id);
    this.changed();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Networks

  /** Rebuild the connected networks and who hangs on them. */
  private rebuild(): void {
    const parent = new Map<number, number>();
    const find = (a: number): number => {
      let r = a;
      while (parent.get(r) !== r) r = parent.get(r)!;
      parent.set(a, r);
      return r;
    };
    const live: [number, number, number][] = [];
    for (const t of this.turbines) if (t.progress >= 1) live.push([t.id, t.x, t.y]);
    for (const p of this.poles) if (p.progress >= 1) live.push([p.id, p.x, p.y]);
    for (const [id] of live) parent.set(id, id);
    for (let k = 0; k + 1 < this.wires.length; k += 2) {
      const a = this.wires[k]!;
      const b = this.wires[k + 1]!;
      if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b));
    }
    const nets = new Map<number, Net>();
    const net = (root: number): Net => {
      let n = nets.get(root);
      if (!n) {
        n = { turbines: [], pumps: [], houses: [], share: 1 };
        nets.set(root, n);
      }
      return n;
    };
    for (const t of this.turbines) if (t.progress >= 1) net(find(t.id)).turbines.push(t);
    const nearest = (x: number, y: number): number => {
      let best = -1;
      let bd = SUPPLY_RADIUS;
      for (const [id, nx, ny] of live) {
        const d = Math.hypot(nx - x, ny - y);
        if (d <= bd) {
          bd = d;
          best = id;
        }
      }
      return best;
    };
    for (const p of this.pumps) {
      if (p.progress < 1) continue;
      const n = nearest(p.hx, p.hy);
      if (n >= 0) net(find(n)).pumps.push(p);
    }
    for (const h of this.houses()) {
      const n = nearest(h.x, h.y);
      if (n >= 0) net(find(n)).houses.push(h);
    }
    // Keep only networks with something that makes power.
    this.nets = [...nets.values()].filter((n) => n.turbines.length > 0);
  }

  // ---------------------------------------------------------------------------
  // Every step

  /** Run the turbines and pumps for one step (after the flow). */
  step(time: SimTime): void {
    if (this.empty) return;
    // Every step (cheap: a few dozen nodes and houses), so a resumed game runs exactly as an uninterrupted one.
    this.rebuild();
    const w = this.world;
    const water = w.water;
    const L = this.ledger;
    const demandPerHouse = houseDemand(time.timeOfDay, time.yearFrac);
    const now = { produced: 0, demand: 0, supplied: 0, pumping: 0 };
    const supplied = new Set<number>();
    for (const net of this.nets) {
      // 1. What every turbine could give, and how much of it is free.
      const full: { t: Turbine; up: number; down: number; head: number; q: number; f: number; p: number }[] = [];
      let pFree = 0;
      let pStore = 0;
      const sides = net.turbines.map((t) => {
        const sa = w.surface(t.a);
        const sb = w.surface(t.b);
        const up = sa >= sb ? t.a : t.b;
        return { t, up, down: up === t.a ? t.b : t.a, head: Math.abs(sa - sb), su: w.surface(up) };
      });
      // Pumped storage: a pump on this network fills the pool. (It lifts into this pool: its outlet
      // at the pool's level on ground the pool covers or would cover, not up on the wall or a bank
      // above it, and its inlet well below.)
      const paired = sides.map(({ up, su }) => {
        const ux = up % w.width;
        const uy = (up / w.width) | 0;
        return net.pumps.some((p) => {
          const o = w.idx(p.ox, p.oy);
          return Math.hypot(p.ox - ux, p.oy - uy) <= POWER.pairReach && Math.abs(w.surface(o) - su) < 1 && w.terrain(o) <= su + 0.05 && w.surface(w.idx(p.x, p.y)) < su - 0.5;
        });
      });
      // Storage needs something else to fill it: a network of nothing but paired turbines runs them free
      // (else a pump beside a lone turbine would stop it, and itself).
      const allPaired = paired.every(Boolean);
      for (let n = 0; n < sides.length; n++) {
        const { t, up, down, head, su } = sides[n]!;
        const q = water[up]! > POWER.keep + 0.01 ? turbineFlow(head) : 0;
        t.mark = Math.max(su, (t.mark ?? su) - POWER.markDecay / STEPS_PER_DAY);
        const level = Math.min(t.crest, t.mark);
        const f = paired[n] && !allPaired ? 0 : smooth(level - POWER.storageBand, level - POWER.spillBand, su);
        const p = turbinePower(q, head);
        pFree += f * p;
        pStore += (1 - f) * p;
        full.push({ t, up, down, head, q, f, p });
      }
      const demand = net.houses.length * demandPerHouse;
      const need = Math.min(pStore, Math.max(0, demand - pFree));
      const k = pStore > 0 ? need / pStore : 0;
      // 2. Run them: the free share always, the storage share as needed.
      let produced = 0;
      let fromStore = 0;
      for (const e of full) {
        const share = e.f + (1 - e.f) * k;
        const want = e.q * share;
        const vol = Math.min(want * DT, Math.max(0, water[e.up]! - POWER.keep) * CELL_AREA);
        const q = vol > 0 ? vol / DT : 0;
        if (vol > 0) {
          water[e.up]! -= vol / CELL_AREA;
          water[e.down]! += vol / CELL_AREA;
        }
        const p = turbinePower(q, e.head);
        produced += p;
        if (share > 0) fromStore += (p * (1 - e.f) * k) / share;
        const t = e.t;
        const flow = e.up === t.a ? q : -q;
        if (Math.round(flow * 5) !== Math.round(t.flow * 5) || (t.power > 0) !== (p > 0)) this.dirty = true;
        t.flow = flow;
        t.head = e.head;
        t.power = p;
        t.produced += p * DT;
        t.water += vol;
        L.turbined += vol;
      }
      // 3. Houses first, then the pumps; the rest is left unused.
      const toHouses = Math.min(demand, produced);
      net.share = demand > 0 ? toHouses / demand : 1;
      let spare = produced - toHouses;
      const rating = net.pumps.length * POWER.pumpRating;
      let toPumps = 0;
      for (const p of net.pumps) {
        const give = rating > 0 ? Math.min(POWER.pumpRating, (spare * POWER.pumpRating) / rating) : 0;
        const inlet = w.idx(p.x, p.y);
        const outlet = w.idx(p.ox, p.oy);
        const head = w.surface(outlet) - w.surface(inlet);
        const vol = Math.min(pumpFlow(give, head) * DT, Math.max(0, water[inlet]! - POWER.keep) * CELL_AREA);
        const q = vol > 0 ? vol / DT : 0;
        const used = vol > 0 ? Math.min(give, pumpPower(q, head)) : 0;
        if (vol > 0) {
          water[inlet]! -= vol / CELL_AREA;
          water[outlet]! += vol / CELL_AREA;
        }
        if ((q > 0.01) !== (p.flow > 0.01)) this.dirty = true;
        p.flow = q;
        p.power = used;
        p.pumped += vol;
        L.pumpedWater += vol;
        toPumps += used;
      }
      spare -= toPumps;
      L.produced += produced * DT;
      L.storage += fromStore * DT;
      L.houses += toHouses * DT;
      L.demand += demand * DT;
      L.pumps += toPumps * DT;
      L.dumped += Math.max(0, spare) * DT;
      now.produced += produced;
      now.demand += demand;
      now.supplied += toHouses;
      now.pumping += toPumps;
      // Lights: each house on this network shows its share (in tenths).
      const level = Math.round(net.share * 10) / 10;
      for (const h of net.houses) {
        supplied.add(h.id);
        this.light.set(h.id, (this.light.get(h.id) ?? 0) + net.share);
        if (this.lit.get(h.id) !== level) {
          this.lit.set(h.id, level);
          this.dirty = true;
        }
      }
    }
    // Pumps and turbines off the grid stand still.
    for (const t of this.turbines) if (!this.nets.some((n) => n.turbines.includes(t)) && t.power !== 0) Object.assign(t, { flow: 0, power: 0 });
    for (const p of this.pumps) if (!this.nets.some((n) => n.pumps.includes(p)) && p.flow !== 0) Object.assign(p, { flow: 0, power: 0 });
    for (const id of [...this.lit.keys()])
      if (!supplied.has(id)) {
        this.lit.delete(id);
        this.dirty = true;
      }
    this.lightSteps++;
    this.now = now;
  }

  /** At a day boundary: the day's totals, and each village's light for its wellbeing. */
  daily(): void {
    const L = this.ledger;
    const S = this.dayStart;
    const d = newLedger();
    for (const k of Object.keys(d) as (keyof PowerLedger)[]) d[k] = L[k] - S[k];
    this.lastDay = d;
    this.dayStart = { ...L };
    if (this.onVillageLight) {
      const sum = new Map<number, { n: number; light: number }>();
      for (const h of this.houses()) {
        const e = sum.get(h.settlement) ?? { n: 0, light: 0 };
        e.n++;
        e.light += this.lightSteps > 0 ? Math.min(1, (this.light.get(h.id) ?? 0) / this.lightSteps) : 0;
        sum.set(h.settlement, e);
      }
      for (const [s, e] of sum) this.onVillageLight(s, e.n > 0 ? e.light / e.n : 0);
    }
    this.light.clear();
    this.lightSteps = 0;
  }

  // ---------------------------------------------------------------------------
  // Snapshots and persistence

  stats(): PowerStats {
    let houses = 0;
    for (const n of this.nets) houses += n.houses.length;
    return {
      produced: this.now.produced,
      demand: this.now.demand,
      supplied: this.now.supplied,
      pumping: this.now.pumping,
      houses,
      dayMean: this.lastDay.produced / (STEPS_PER_DAY * DT) / 1000,
    };
  }

  info(): PowerInfo {
    // Wires hang between standing poles (and turbines) only: a line goes up pole by pole.
    const up = new Map<number, [number, number]>();
    for (const t of this.turbines) up.set(t.id, [t.x, t.y]);
    for (const p of this.poles) if (p.progress >= 1) up.set(p.id, [p.x, p.y]);
    const wires: number[] = [];
    for (let k = 0; k + 1 < this.wires.length; k += 2) {
      const a = up.get(this.wires[k]!);
      const b = up.get(this.wires[k + 1]!);
      if (a && b) wires.push(a[0], a[1], b[0], b[1]);
    }
    // Pumps hang on the nearest standing pole with a short wire.
    for (const p of this.pumps) {
      let q: [number, number] | null = null;
      let bd = SUPPLY_RADIUS;
      for (const o of up.values()) {
        const d = Math.hypot(o[0] - p.hx, o[1] - p.hy);
        if (d <= bd) {
          bd = d;
          q = o;
        }
      }
      if (q) wires.push(q[0], q[1], p.hx, p.hy);
    }
    const W = this.world.width;
    return {
      turbines: this.turbines.map((t) => ({
        id: t.id,
        x: t.x,
        y: t.y,
        rot: t.rot,
        ax: t.a % W,
        ay: (t.a / W) | 0,
        bx: t.b % W,
        by: (t.b / W) | 0,
        progress: t.progress,
        flow: Math.round(t.flow * 10) / 10,
        power: t.power,
      })),
      // (Planned poles show once the builders start on them.)
      poles: this.poles.filter((p) => p.progress > 0).map((p) => ({ id: p.id, x: p.x, y: p.y, progress: p.progress })),
      wires,
      pumps: this.pumps.map((p) => ({ id: p.id, x: p.x, y: p.y, hx: p.hx, hy: p.hy, ox: p.ox, oy: p.oy, progress: p.progress, flow: p.flow, power: p.power })),
      lit: [...this.lit].flat(),
    };
  }

  getState(): PowerState {
    return structuredClone({
      nextId: this.nextId,
      turbines: this.turbines,
      poles: this.poles,
      wires: this.wires,
      pumps: this.pumps,
      ledger: this.ledger,
      dayStart: this.dayStart,
      lastDay: this.lastDay,
      light: [...this.light].flat(),
      lightSteps: this.lightSteps,
      failed: this.failed.size ? [...this.failed].flat() : undefined,
    });
  }

  setState(st: PowerState): void {
    const s = structuredClone(st);
    this.nextId = s.nextId;
    this.turbines = s.turbines;
    this.poles = s.poles;
    this.wires = s.wires;
    this.pumps = s.pumps;
    this.ledger = { ...newLedger(), ...s.ledger };
    this.dayStart = { ...newLedger(), ...s.dayStart };
    this.lastDay = { ...newLedger(), ...s.lastDay };
    this.light.clear();
    for (let k = 0; k + 1 < s.light.length; k += 2) this.light.set(s.light[k]!, s.light[k + 1]!);
    this.lightSteps = s.lightSteps;
    this.failed.clear();
    const f = s.failed ?? [];
    for (let k = 0; k + 1 < f.length; k += 2) this.failed.set(f[k]!, f[k + 1]!);
    this.lit.clear();
    this.changed();
  }
}
