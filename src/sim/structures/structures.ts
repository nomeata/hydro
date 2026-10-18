/**
 * Water structures (M4a): stone lining, weirs and sluice gates.
 *
 * - **Lining** is planned per cell and built after any earthworks there;
 *   built cells get CellFlag.Lined (no erosion, no slumping).
 * - A **weir** is a dike plan along a straight line plus lining on it: a
 *   fixed overflow crest made of terrain, so the flow model spills water
 *   over it naturally. The record is kept for rendering.
 * - A **sluice gate** is the one structure that is not just terrain: the
 *   builders dig a passage through the dike down to the gate's sill and line
 *   it; the gate itself is a thin wall on the passage's middle row of cells
 *   (see `Walls` in hydro/inertial.ts). Closed, water passes only above its
 *   top; open, the passage is free down to the sill. While being built, a
 *   closed gate's wall rises from the ground it was placed on to its top, so
 *   a gate put into a full reservoir's dam never lets the water out.
 *   Who opens and closes a gate is decided in gatekeeper.ts (the villagers,
 *   or the gate itself as flood relief); here the leaf only moves: `lift`
 *   follows `open` over a few game hours, lowering the wall's crest
 *   smoothly towards the sill (no flood wave).
 *
 * Everything here is deterministic and part of SimState.
 */
import type { Pt, StructureInfo } from '../../shared/protocol';
import { LINING_DONE, LINING_QUAY } from '../../shared/protocol';
import type { Walls } from '../hydro/inertial';
import { planDike, rasterisePath } from '../plans/plans';
import { CELL_AREA, DT } from '../constants';
import { CellFlag, type World } from '../world';
import { WHEEL_MIN_SPEED, wheelLift, wheelSite } from './wheel';

export interface Gate {
  id: number;
  /** Wall cells (the middle row of the passage, along the gate line). */
  cells: number[];
  /** All cells of the passage through the dike (dug to the sill, lined). */
  passage: number[];
  /** Centre (cell coordinates) and direction of the gate line (0 or π/2). */
  x: number;
  y: number;
  rot: number;
  /** Gate width in cells. */
  width: number;
  /** Crest of the closed gate, ground height when placed, and the sill (m). */
  top: number;
  top0: number;
  sill: number;
  /** Where the leaf is going: open (up, water passes to the sill) or closed. */
  open: boolean;
  progress: number;
  /** How far the leaf is up, 0 (closed) .. 1 (open); follows `open` (absent in old saves: = open). */
  lift?: number;
  /** Gatekeeping (gatekeeper.ts; absent in old saves). Why the gate is open (GateMode). */
  mode?: number;
  /** Step of the last switch (−1e9: never). */
  lastSwitch?: number;
  /** Id of the villager who last worked the gate (−1: it moved by itself, or never). */
  operator?: number;
  /** A switch waiting for a villager: −1 none, 0 close, 1 open; its mode, and the step it was asked for. */
  want?: number;
  wantMode?: number;
  wantStep?: number;
  /** Day the gate last opened as flood relief (−1: none pending), and whether its dike was overtopped since. */
  reliefDay?: number;
  overtopped?: boolean;
  /** Day a house below the gate was last seen in water (−1e9: never). */
  wetDay?: number;
  /** Held by the toggleGate command (tests, debugging): the gatekeeping leaves it alone. */
  manual?: boolean;
}

/** Steps for the leaf to travel fully up or down (four game hours). */
export const LIFT_STEPS = 100;

export interface Weir {
  id: number;
  x: number;
  y: number;
  x2: number;
  y2: number;
  top: number;
  width: number;
  /** Cells lined for this weir. */
  cells: number[];
}

/** A water wheel (structures/wheel.ts): in the river at `cell`, lifting into `head`. */
export interface Wheel {
  id: number;
  cell: number;
  head: number;
  /** Wheel and head cell coordinates. */
  x: number;
  y: number;
  hx: number;
  hy: number;
  progress: number;
  /**
   * Current speed of the water at the wheel (m/s, 0 when it stands still;
   * negative when it passes the other way across the axle) and the lifted
   * flow (m³/s), as last reported.
   */
  speed: number;
  flow: number;
  /** Total water lifted (m³). */
  lifted: number;
}

export interface StructuresState {
  nextId: number;
  /** Pairs [cell, progress] of planned lining, in placement order. */
  lining: number[];
  gates: Gate[];
  weirs: Weir[];
  /** Water wheels (absent in older saves). */
  wheels?: Wheel[];
}

/** How far across the gate line the passage may cut through a dike (cells). */
const PASSAGE_REACH = 4;
/** Minimum head a gate must hold (m). */
const MIN_GATE_HEAD = 0.3;
/** Gate progress per unit of lining work (a gate is ~4× the work of a lined cell). */
const GATE_WORK = 0.25;
/** Wheel progress per unit of lining work (about three lined cells' worth of carpentry). */
const WHEEL_WORK = 0.33;
/** The wheel leaves this much water in its cell (m). */
const WHEEL_KEEP = 0.05;
/** The trough stops when the water at its outlet stands this deep (m): nowhere to go. */
const HEAD_FULL = 0.5;

function current(w: World, i: number): number {
  const p = w.plan[i]!;
  return Number.isNaN(p) ? w.terrain(i) : p;
}

export class Structures {
  /** Planned lining: cell → progress 0..1 (Map keeps placement order). */
  readonly lining = new Map<number, number>();
  gates: Gate[] = [];
  weirs: Weir[] = [];
  wheels: Wheel[] = [];
  private nextId = 1;
  /** Gate walls for the flow kernel. */
  readonly walls: Walls = { count: 0, cell: new Int32Array(16), top: new Float32Array(16) };
  /** Set when the structure list changed (for snapshots). */
  structuresDirty = true;
  /** Set when lining (planned or built) changed (for snapshots). */
  liningDirty = true;
  /**
   * Where structures may be planned (fog of war: known land only), or null
   * for anywhere. Lining is clipped to it; a weir or gate that would touch
   * a forbidden cell is not placed at all.
   */
  allow: ((i: number) => boolean) | null = null;
  /** Told when the crew finishes lining a cell (achievements; an observer only). */
  onLined: ((i: number) => void) | null = null;

  constructor(private readonly world: World) {}

  get pending(): boolean {
    return this.lining.size > 0 || this.gates.some((g) => g.progress < 1) || this.wheels.some((wh) => wh.progress < 1);
  }

  // ---------------------------------------------------------------------------
  // Placement

  /** Plan lining on the cells within width/2 of the path. Returns the cells added. */
  planLining(points: readonly Pt[], width: number): number[] {
    const w = this.world;
    const added: number[] = [];
    for (const i of rasterisePath(w, points, Math.max(0.5, width / 2)).keys()) {
      if (this.allow && !this.allow(i)) continue;
      if (this.addLining(i)) added.push(i);
    }
    return added;
  }

  private addLining(i: number): boolean {
    if ((this.world.flags[i]! & CellFlag.Lined) !== 0 || this.lining.has(i)) return false;
    this.lining.set(i, 0);
    // The site is cleared for the stone work.
    this.world.vegetation[i] = Math.min(this.world.vegetation[i]!, 0.05);
    this.liningDirty = true;
    return true;
  }

  /**
   * Weir along the straight line from the first to the last point: a dike
   * with a level crest `height` above the lowest ground on the line, lined.
   * Returns the earthwork plan cells (for the builders' queue).
   */
  planWeir(points: readonly Pt[], width: number, height: number): number[] {
    if (points.length === 0) return [];
    const w = this.world;
    const a = points[0]!;
    const b = points[points.length - 1]!;
    const line: Pt[] = [a, b];
    const half = width / 2;
    if (!this.allowedAlong(line, half + 1)) return [];
    let lowest = Infinity;
    for (const i of rasterisePath(w, line, half).keys()) lowest = Math.min(lowest, w.terrain(i));
    if (!Number.isFinite(lowest)) return [];
    const changed = planDike(w, line, width, height);
    const cells: number[] = [];
    for (const i of rasterisePath(w, line, half + 1).keys()) {
      this.addLining(i);
      cells.push(i);
    }
    this.weirs.push({ id: this.nextId++, x: a[0], y: a[1], x2: b[0], y2: b[1], top: lowest + height, width, cells });
    this.structuresDirty = true;
    return changed;
  }

  private allowedAlong(line: readonly Pt[], half: number): boolean {
    const allow = this.allow;
    if (!allow) return true;
    for (const i of rasterisePath(this.world, line, half).keys()) if (!allow(i)) return false;
    return true;
  }

  /**
   * Sluice gate (see the protocol's placeGate). Returns the earthwork plan
   * cells, or null if no gate fits here (e.g. tapping flat ground).
   */
  placeGate(points: readonly Pt[], width: number, height: number): { cells: number[]; gate: Gate } | null {
    if (points.length === 0) return null;
    const w = this.world;
    const W = w.width;
    const n = Math.max(1, Math.min(3, Math.round(width)));
    const a = points[0]!;
    const b = points[points.length - 1]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!this.allowedAlong(len < 1.5 ? [a] : [a, b], PASSAGE_REACH + 1)) return null;
    const changed: number[] = [];
    let cx: number;
    let cy: number;
    /** Unit step along the gate line (axis-aligned). */
    let dx: number;
    let dy: number;
    let top: number;
    let sill: number;
    const at = (x: number, y: number): number => w.idx(Math.max(0, Math.min(W - 1, x)), Math.max(0, Math.min(w.height - 1, y)));

    if (len < 1.5) {
      // Tap on a dike or weir: the gate line follows the ridge.
      cx = Math.round(a[0]);
      cy = Math.round(a[1]);
      if (!w.inBounds(cx, cy)) return null;
      const ridge = (ux: number, uy: number): number => {
        let s = 0;
        for (const k of [-2, -1, 1, 2]) s += current(w, at(cx + ux * k, cy + uy * k));
        return s;
      };
      if (ridge(1, 0) >= ridge(0, 1)) [dx, dy] = [1, 0];
      else [dx, dy] = [0, 1];
      top = current(w, w.idx(cx, cy));
      sill = Infinity;
      for (const s of [-1, 1])
        for (let k = 2; k <= PASSAGE_REACH; k++) sill = Math.min(sill, current(w, at(cx - dy * k * s, cy + dx * k * s)));
    } else {
      // Stroke across a channel: a dike along it with the gate at the lowest point.
      const ux = (b[0] - a[0]) / len;
      const uy = (b[1] - a[1]) / len;
      if (Math.abs(ux) >= Math.abs(uy)) [dx, dy] = [1, 0];
      else [dx, dy] = [0, 1];
      let low = Infinity;
      cx = Math.round(a[0]);
      cy = Math.round(a[1]);
      for (let t = 0; t <= len; t += 0.5) {
        const x = Math.round(a[0] + ux * t);
        const y = Math.round(a[1] + uy * t);
        if (!w.inBounds(x, y)) continue;
        const h = current(w, w.idx(x, y));
        if (h < low) {
          low = h;
          cx = x;
          cy = y;
        }
      }
      if (!Number.isFinite(low)) return null;
      // The sill is the lowest (planned) ground on the line, e.g. the floor of
      // a canal still being dug; the dam's crest is `height` above it.
      const line: Pt[] = [a, b];
      let lowest = Infinity;
      for (const i of rasterisePath(w, line, 1).keys()) lowest = Math.min(lowest, w.terrain(i));
      sill = low;
      top = low + height;
      for (const i of planDike(w, line, 2, top - lowest)) changed.push(i);
    }
    if (!(top - sill >= MIN_GATE_HEAD)) return null;

    // Wall cells, centred on (cx, cy) along the gate line.
    const offs = n === 1 ? [0] : n === 2 ? [0, 1] : [-1, 0, 1];
    const cells: number[] = [];
    for (const k of offs) {
      const x = cx + dx * k;
      const y = cy + dy * k;
      if (w.inBounds(x, y)) cells.push(w.idx(x, y));
    }
    // The passage: across the line (perpendicular (-dy, dx)) through everything above the sill.
    const passage = new Set<number>(cells);
    for (const c of cells) {
      const x0 = c % W;
      const y0 = (c / W) | 0;
      for (const s of [-1, 1]) {
        for (let k = 1; k <= PASSAGE_REACH; k++) {
          const x = x0 - dy * k * s;
          const y = y0 + dx * k * s;
          if (!w.inBounds(x, y)) break;
          const i = w.idx(x, y);
          if (current(w, i) <= sill + 0.05) break;
          passage.add(i);
        }
      }
    }
    let top0 = Infinity;
    for (const c of cells) top0 = Math.min(top0, w.terrain(c));
    top0 = Math.max(sill, Math.min(top, top0));
    for (const i of passage) {
      const t = w.terrain(i);
      if (t > sill + 0.01) {
        w.plan[i] = sill;
        changed.push(i);
      } else if (!Number.isNaN(w.plan[i]!)) {
        w.plan[i] = NaN;
      }
      this.addLining(i);
    }
    // Line the flanks too (the gate posts), so fast water does not scour the dike beside the gate.
    for (const i of passage) {
      const x = i % W;
      const y = (i / W) | 0;
      for (const s of [-1, 1]) {
        const fx = x + dx * s;
        const fy = y + dy * s;
        if (!w.inBounds(fx, fy)) continue;
        const f = w.idx(fx, fy);
        if (!passage.has(f)) this.addLining(f);
      }
    }
    let sx = 0;
    let sy = 0;
    for (const c of cells) {
      sx += c % W;
      sy += (c / W) | 0;
    }
    const gate: Gate = {
      id: this.nextId++,
      cells,
      passage: [...passage],
      x: sx / cells.length,
      y: sy / cells.length,
      rot: dx === 1 ? 0 : Math.PI / 2,
      width: cells.length,
      top,
      top0,
      sill,
      open: false,
      progress: 0,
      lift: 0,
      mode: 0,
      lastSwitch: -1e9,
      operator: -1,
      want: -1,
      reliefDay: -1,
      wetDay: -1e9,
    };
    this.gates.push(gate);
    this.structuresDirty = true;
    this.updateWalls();
    return { cells: changed, gate };
  }

  /**
   * Water wheel (see the protocol's placeWheel and structures/wheel.ts).
   * Returns the new wheel, or null if no wheel fits here.
   */
  placeWheel(points: readonly Pt[]): Wheel | null {
    const w = this.world;
    const site = wheelSite(
      {
        width: w.width,
        height: w.height,
        terrain: (i) => w.terrain(i),
        depth: (i) => w.water[i]!,
        allowed: this.allow ?? undefined,
      },
      points,
    );
    if (!site?.ok) return null;
    const cell = w.idx(site.x, site.y);
    const head = w.idx(site.hx, site.hy);
    if (this.wheels.some((o) => o.cell === cell || o.head === cell || o.cell === head)) return null;
    const wheel: Wheel = { id: this.nextId++, cell, head, x: site.x, y: site.y, hx: site.hx, hy: site.hy, progress: 0, speed: 0, flow: 0, lifted: 0 };
    this.wheels.push(wheel);
    // The trough's outlet gets a stone apron, so the falling water does not scour it.
    this.addLining(head);
    this.structuresDirty = true;
    return wheel;
  }

  /**
   * Turn the finished wheels (every step, after the flow): move the lifted
   * water from the river cell to the head cell. Returns the volume moved (m³).
   */
  stepWheels(): number {
    const w = this.world;
    const water = w.water;
    let moved = 0;
    for (const wh of this.wheels) {
      if (wh.progress < 1) continue;
      const i = wh.cell;
      const h = water[i]!;
      const v = Math.hypot(w.velX[i]!, w.velY[i]!);
      const head = w.terrain(wh.head) - (w.terrain(i) + h);
      let q = water[wh.head]! < HEAD_FULL ? wheelLift(v, h, head) : 0;
      const vol = Math.min(q * DT, Math.max(0, h - WHEEL_KEEP) * CELL_AREA);
      if (vol > 0) {
        water[i] = h - vol / CELL_AREA;
        water[wh.head]! += vol / CELL_AREA;
        wh.lifted += vol;
        moved += vol;
      } else q = 0;
      // Report changes the renderer can see (a tenth of a m/s; the trough running or not), signed
      // by which way the current passes under the wheel (across its axle, wheel → head).
      const across = -(wh.hy - wh.y) * w.velX[i]! + (wh.hx - wh.x) * w.velY[i]!;
      const sp = v >= WHEEL_MIN_SPEED && h >= 0.05 ? (Math.round(v * 10) / 10) * (across < 0 ? -1 : 1) : 0;
      if (sp !== wh.speed || (q > 0) !== (wh.flow > 0)) {
        wh.speed = sp;
        wh.flow = q;
        this.structuresDirty = true;
      }
    }
    return moved;
  }

  /**
   * Open or close a gate by hand (the toggleGate command: tests, scenes and
   * debugging; players do not work gates). The gate is then held: the
   * gatekeeping leaves it alone.
   */
  toggleGate(id: number, open?: boolean): boolean {
    const g = this.gates.find((g) => g.id === id);
    if (!g) return false;
    g.manual = true;
    g.want = -1;
    const next = open ?? !g.open;
    if (next === g.open) return false;
    g.open = next;
    this.structuresDirty = true;
    return true;
  }

  /** Move the gate leaves towards their targets (every step). */
  stepGates(): void {
    let moved = false;
    for (const g of this.gates) {
      const target = g.open ? 1 : 0;
      const l = g.lift ?? target;
      if (l === target) continue;
      const next = target > l ? Math.min(1, l + 1 / LIFT_STEPS) : Math.max(0, l - 1 / LIFT_STEPS);
      g.lift = next;
      moved = true;
      // Snapshots at tenths of the travel (the renderer eases in between).
      if (Math.floor(next * 10) !== Math.floor(l * 10) || next === target) this.structuresDirty = true;
    }
    if (moved) this.updateWalls();
  }

  /** Remove planned lining and unfinished gates within a radius (the Remove tool). */
  cancel(x: number, y: number, radius: number): boolean {
    const w = this.world;
    const W = w.width;
    const r2 = radius * radius;
    let any = false;
    for (const i of [...this.lining.keys()]) {
      const dx = (i % W) - x;
      const dy = ((i / W) | 0) - y;
      if (dx * dx + dy * dy <= r2) {
        this.lining.delete(i);
        any = true;
      }
    }
    const gates = this.gates.filter((g) => g.progress >= 1 || (g.x - x) ** 2 + (g.y - y) ** 2 > r2);
    if (gates.length !== this.gates.length) {
      for (const g of this.gates) if (!gates.includes(g)) for (const c of g.passage) this.lining.delete(c);
      this.gates = gates;
      this.updateWalls();
      any = true;
    }
    const wheels = this.wheels.filter((wh) => wh.progress >= 1 || (wh.x - x) ** 2 + (wh.y - y) ** 2 > r2);
    if (wheels.length !== this.wheels.length) {
      for (const wh of this.wheels) if (!wheels.includes(wh)) this.lining.delete(wh.head);
      this.wheels = wheels;
      any = true;
    }
    const weirs = this.weirs.filter((wr) => wr.cells.some((c) => (w.flags[c]! & CellFlag.Lined) !== 0 || this.lining.has(c)));
    if (weirs.length !== this.weirs.length) this.weirs = weirs;
    if (any) {
      this.liningDirty = true;
      this.structuresDirty = true;
    }
    return any;
  }

  // ---------------------------------------------------------------------------
  // Building

  /** Gate whose work site is cell i (its first wall cell). */
  private gateAt(i: number): Gate | undefined {
    return this.gates.find((g) => g.progress < 1 && g.cells[0] === i);
  }

  private gateReady(g: Gate): boolean {
    const plan = this.world.plan;
    return g.passage.every((c) => Number.isNaN(plan[c]!));
  }

  /**
   * Cells where structure work can be done now: planned lining whose
   * earthworks are finished, and unfinished gates whose passage is dug.
   */
  sites(): number[] {
    const plan = this.world.plan;
    const out: number[] = [];
    for (const g of this.gates) if (g.progress < 1 && this.gateReady(g)) out.push(g.cells[0]!);
    for (const wh of this.wheels) if (wh.progress < 1) out.push(wh.cell);
    for (const i of this.lining.keys()) if (Number.isNaN(plan[i]!)) out.push(i);
    return out;
  }

  /**
   * Do `amount` of work at site i (1 = one cell fully lined; a gate takes
   * 1/GATE_WORK). Returns true if anything changed.
   */
  work(i: number, amount: number): boolean {
    const p = this.lining.get(i);
    if (p !== undefined && Number.isNaN(this.world.plan[i]!)) {
      const np = p + amount;
      if (np >= 1) {
        this.lining.delete(i);
        this.world.flags[i]! |= CellFlag.Lined;
        this.onLined?.(i);
      } else this.lining.set(i, np);
      this.liningDirty = true;
      if (np >= 1) this.weirProgressChanged(i);
      return true;
    }
    const g = this.gateAt(i);
    if (g && this.gateReady(g)) {
      g.progress = Math.min(1, g.progress + amount * GATE_WORK);
      this.structuresDirty = true;
      this.updateWalls();
      return true;
    }
    const wh = this.wheels.find((o) => o.progress < 1 && o.cell === i);
    if (wh) {
      wh.progress = Math.min(1, wh.progress + amount * WHEEL_WORK);
      this.structuresDirty = true;
      return true;
    }
    return false;
  }

  /** Spirit crew: work on up to `maxCells` ready sites. */
  crewWork(amount: number, maxCells: number): void {
    let n = 0;
    for (const i of this.sites()) {
      if (n >= maxCells) break;
      this.work(i, amount);
      n++;
    }
  }

  private weirProgressChanged(i: number): void {
    for (const wr of this.weirs) if (wr.cells.includes(i)) this.structuresDirty = true;
  }

  /** Rebuild the flow kernel's wall list from the gates. */
  updateWalls(): void {
    let n = 0;
    for (const g of this.gates) if (gateLift(g) < 1) n += g.cells.length;
    const wl = this.walls;
    if (wl.cell.length < n) {
      wl.cell = new Int32Array(n * 2);
      wl.top = new Float32Array(n * 2);
    }
    let k = 0;
    for (const g of this.gates) {
      const lift = gateLift(g);
      if (lift >= 1) continue;
      const closed = g.top0 + (g.top - g.top0) * g.progress;
      // A rising leaf lets the pool down gently: the crest falls towards the sill.
      const h = closed + (g.sill - closed) * lift;
      for (const c of g.cells) {
        wl.cell[k] = c;
        wl.top[k] = h;
        k++;
      }
    }
    wl.count = k;
  }

  // ---------------------------------------------------------------------------
  // Snapshots and persistence

  /** Lining per cell (see LINING_DONE); `quay` marks lined cells shown as quays. */
  packLining(out: Uint8Array, quay?: Uint8Array | null): void {
    const flags = this.world.flags;
    for (let i = 0; i < out.length; i++)
      out[i] = (flags[i]! & CellFlag.Lined) !== 0 ? (quay && quay[i] ? LINING_QUAY : LINING_DONE) : 0;
    for (const [i, p] of this.lining) out[i] = 1 + Math.min(252, Math.floor(p * 253));
  }

  info(): StructureInfo[] {
    const flags = this.world.flags;
    const out: StructureInfo[] = [];
    for (const g of this.gates) {
      out.push({
        id: g.id,
        kind: 'gate',
        x: g.x,
        y: g.y,
        rot: g.rot,
        width: g.width,
        top: g.top,
        sill: g.sill,
        open: g.open,
        progress: g.progress,
        lift: gateLift(g),
      });
    }
    for (const wr of this.weirs) {
      let done = 0;
      for (const c of wr.cells) if ((flags[c]! & CellFlag.Lined) !== 0) done++;
      out.push({
        id: wr.id,
        kind: 'weir',
        x: wr.x,
        y: wr.y,
        x2: wr.x2,
        y2: wr.y2,
        rot: Math.atan2(wr.y2 - wr.y, wr.x2 - wr.x),
        width: Math.hypot(wr.x2 - wr.x, wr.y2 - wr.y),
        top: wr.top,
        sill: wr.top,
        open: false,
        progress: wr.cells.length ? done / wr.cells.length : 1,
      });
    }
    for (const wh of this.wheels) {
      out.push({
        id: wh.id,
        kind: 'wheel',
        x: wh.x,
        y: wh.y,
        x2: wh.hx,
        y2: wh.hy,
        rot: Math.atan2(wh.hy - wh.y, wh.hx - wh.x),
        width: Math.hypot(wh.hx - wh.x, wh.hy - wh.y),
        top: this.world.terrain(wh.head),
        sill: this.world.terrain(wh.cell),
        open: wh.flow > 0,
        progress: wh.progress,
        speed: wh.speed,
        flow: wh.flow,
      });
    }
    return out;
  }

  getState(): StructuresState {
    const lining: number[] = [];
    for (const [i, p] of this.lining) lining.push(i, p);
    return structuredClone({ nextId: this.nextId, lining, gates: this.gates, weirs: this.weirs, wheels: this.wheels });
  }

  setState(st: StructuresState): void {
    const s = structuredClone(st);
    this.nextId = s.nextId;
    this.lining.clear();
    for (let k = 0; k + 1 < s.lining.length; k += 2) this.lining.set(s.lining[k]!, s.lining[k + 1]!);
    this.gates = s.gates;
    // Saves from before villager-worked gates: the leaf is where the gate is set.
    for (const g of this.gates) g.lift ??= g.open ? 1 : 0;
    this.weirs = s.weirs;
    this.wheels = s.wheels ?? [];
    this.updateWalls();
    this.structuresDirty = true;
    this.liningDirty = true;
  }
}

/** How far a gate's leaf is up (0..1). */
export function gateLift(g: Gate): number {
  return g.lift ?? (g.open ? 1 : 0);
}
