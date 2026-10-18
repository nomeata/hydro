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
 * Deterministic (no RNG), saved as PowerState.
 */
import type { PowerInfo, PowerStats, Pt, SimTime } from '../../shared/protocol';
import { CELL_AREA, DT, STEPS_PER_DAY } from '../constants';
import { LandUse, type World } from '../world';
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

  /** Remove power structures (finished or not) within a radius (the Remove tool). */
  cancel(x: number, y: number, radius: number): boolean {
    const r2 = radius * radius;
    const near = (px: number, py: number) => (px - x) ** 2 + (py - y) ** 2 <= r2;
    const gone = new Set<number>();
    const t = this.turbines.filter((o) => !near(o.x, o.y) || (gone.add(o.id), false));
    const p = this.poles.filter((o) => !near(o.x, o.y) || (gone.add(o.id), false));
    const n = this.pumps.length;
    this.pumps = this.pumps.filter((o) => !near(o.hx, o.hy) && !near(o.x, o.y));
    if (!gone.size && n === this.pumps.length) return false;
    this.turbines = t;
    this.poles = p;
    const wires: number[] = [];
    for (let k = 0; k + 1 < this.wires.length; k += 2)
      if (!gone.has(this.wires[k]!) && !gone.has(this.wires[k + 1]!)) wires.push(this.wires[k]!, this.wires[k + 1]!);
    this.wires = wires;
    this.changed();
    return true;
  }

  private changed(): void {
    this.dirty = true;
  }

  // ---------------------------------------------------------------------------
  // Building (the spirit crew, as for the stone work)

  get pending(): boolean {
    return this.turbines.some((t) => t.progress < 1) || this.poles.some((p) => p.progress < 1) || this.pumps.some((p) => p.progress < 1);
  }

  crewWork(amount: number): void {
    for (const o of [...this.turbines, ...this.poles, ...this.pumps]) {
      if (o.progress >= 1) continue;
      const k = 'a' in o ? TURBINE_WORK : 'ox' in o ? PUMP_WORK : POLE_WORK;
      o.progress = Math.min(1, o.progress + amount * k);
      this.dirty = true;
    }
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
      for (const t of net.turbines) {
        const sa = w.surface(t.a);
        const sb = w.surface(t.b);
        const up = sa >= sb ? t.a : t.b;
        const down = up === t.a ? t.b : t.a;
        const head = Math.abs(sa - sb);
        const q = water[up]! > POWER.keep + 0.01 ? turbineFlow(head) : 0;
        const su = w.surface(up);
        t.mark = Math.max(su, (t.mark ?? su) - POWER.markDecay / STEPS_PER_DAY);
        const level = Math.min(t.crest, t.mark);
        // Pumped storage: a pump on this network fills the pool.
        const ux = up % w.width;
        const uy = (up / w.width) | 0;
        // (It lifts into this pool: its outlet at the pool's level, its inlet well below it.)
        const paired = net.pumps.some(
          (p) =>
            Math.hypot(p.ox - ux, p.oy - uy) <= POWER.pairReach &&
            Math.abs(w.surface(w.idx(p.ox, p.oy)) - su) < 1 &&
            w.surface(w.idx(p.x, p.y)) < su - 0.5,
        );
        const f = paired ? 0 : smooth(level - POWER.storageBand, level - POWER.spillBand, su);
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
    const wires: number[] = [];
    for (let k = 0; k + 1 < this.wires.length; k += 2) {
      const a = this.nodePos(this.wires[k]!);
      const b = this.nodePos(this.wires[k + 1]!);
      if (a && b) wires.push(a[0], a[1], b[0], b[1]);
    }
    // Pumps hang on the nearest pole with a short wire.
    for (const p of this.pumps) {
      const n = this.nearestNode(p.hx, p.hy, SUPPLY_RADIUS);
      const q = n >= 0 ? this.nodePos(n) : null;
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
      poles: this.poles.map((p) => ({ id: p.id, x: p.x, y: p.y, progress: p.progress })),
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
    this.lit.clear();
    this.changed();
  }
}
