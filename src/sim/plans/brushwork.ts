/**
 * The sim's side of the sculpting brushes (plans/sculpt.ts): applies brush
 * samples to the World at once (works while paused), keeping the current
 * stroke's ground from before it (the stamp's reference).
 *
 * Sculpted earth is loose: it slumps and erodes readily (the erosion
 * scratch's `loose`, set by the host), so a rough channel grades itself
 * once water runs in it. Heaped earth (ground above the original ground) is
 * CellFlag.Fill: water pouring over its edge scours it (overtopStep), so an
 * overtopped bank breaches. Ground dug 0.3 m below the original is
 * CellFlag.Canal (villagers line those near home). Fields, gardens and
 * pastures survive gentle work: one is lost only where the ground becomes
 * too steep to farm (FIELD_MAX_SLOPE), or later as usual when it goes under
 * water. Paths and yards under the brush go back to plain land, the
 * villagers' stone lining comes off, and plants are buried or dug out.
 * Water depth is not touched, so water is conserved exactly.
 */
import type { BrushTool, Pt } from '../../shared/protocol';
import { CELL, CELL_AREA } from '../constants';
import { CellFlag, LandUse, SOIL_PROPS, SoilType, type World } from '../world';
import { clearGround, planDike, planLevel, planTrench, type PlanGrid } from './plans';
import { brushSample, newStamp, type SculptGrid, type Stamp } from './sculpt';

/** A cell's ground before a stroke first touched it. */
interface Orig {
  bedrock: number;
  soil: number;
  soilType: number;
  flags: number;
}

interface Stroke {
  id: number;
  orig: Map<number, Orig>;
  /** Total |change| per cell in this stroke (m). */
  moved: Map<number, number>;
  /** The brush's stamp (Raise, Dig), carried from sample to sample. */
  stamp: Stamp;
}

/** Wet for the stamp's slopes: under this much water (m), as hydro/talus.ts. */
const WET_DEPTH = 0.05;
/** Change (m) in a stroke after which what stood on a cell is cleared. */
const CLEAR_AT = 0.05;
/** Depth below the original ground that makes a cell part of a canal (m). */
const CANAL_DEPTH = 0.3;
/** Height above the original ground that makes a cell a heaped bank (m). */
const FILL_HEIGHT = 0.05;
/**
 * Steepest rise to a neighbour (m per 5 m cell, over 5: as Village.slope)
 * a field, garden or pasture survives the brush on; villagers plant below
 * 0.25, so ground they would farm is kept.
 */
export const FIELD_MAX_SLOPE = 0.3;
/** Plants lost per metre of earth moved on a cell (vegetation 0..1). */
const VEG_PER_M = 1.5;

/** What the host (Simulation) wires in. */
export interface BrushHost {
  /** Whether the brush must leave cell i alone (houses, structures, unknown land…). */
  fixed(i: number): boolean;
  /** The ground of cell i before the player's first work on it (undefined: untouched so far). */
  original(i: number): number | undefined;
  /** Cell i is about to change for the first time by the player's hand. */
  willChange(i: number): void;
  /** Cell i's terrain changed. */
  changed(i: number): void;
  /** What stood on cell i (field, path, lining) was cleared. */
  cleared(i: number, lining: boolean): void;
}

export class Brushwork {
  /** Sequence number of the last sculpt command applied (the client's prediction waits for it). */
  seq = 0;
  /**
   * Earth moved so far (m³, raised plus dug):
   * by the brushes, and by scripted lines (shapeLine: bots, scenes, tests).
   * Saved with the world, so a later round can give the bots a budget.
   */
  readonly moved = { brush: 0, script: 0 };
  private scripted = false;
  private current: Stroke | null = null;
  /** Cells changed since the last field check. */
  private touched = new Set<number>();
  private readonly grid: SculptGrid;

  constructor(
    private readonly world: World,
    private readonly host: BrushHost,
  ) {
    this.grid = {
      width: world.width,
      height: world.height,
      terrain: (i) => world.terrain(i),
      fixed: (i) => host.fixed(i),
      orig: (i) => {
        const o = this.current?.orig.get(i);
        return o ? o.bedrock + o.soil : world.terrain(i);
      },
      wet: (i) => world.water[i]! > WET_DEPTH,
    };
  }

  /** Forget the current stroke (a new world, a load). */
  reset(): void {
    this.current = null;
  }

  private stroke(id: number): Stroke {
    let s = this.current;
    if (!s || s.id !== id) {
      s = { id, orig: new Map(), moved: new Map(), stamp: newStamp() };
      this.current = s;
    }
    return s;
  }

  /**
   * Apply brush samples (flat [x, y, dt, …]) of stroke `stroke`. Returns the
   * row range touched (for the renderer), or null.
   */
  sculpt(tool: BrushTool, radius: number, stroke: number, samples: readonly number[]): { y0: number; y1: number } | null {
    const s = this.stroke(stroke);
    let y0 = Infinity;
    let y1 = -Infinity;
    const r = Math.max(0.5, Math.min(8, radius));
    for (let k = 0; k + 2 < samples.length; k += 3) {
      const x = samples[k]!;
      const y = samples[k + 1]!;
      const dt = samples[k + 2]!;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(dt)) continue;
      // The whole brush's rows count as changed (the client predicted them; the sim's word is final).
      y0 = Math.min(y0, Math.max(0, Math.floor(y - r)));
      y1 = Math.max(y1, Math.min(this.world.height - 1, Math.ceil(y + r)));
      brushSample(this.grid, tool, x, y, r, dt, s.stamp, (i, dz) => {
        this.change(s, i, dz);
        const cy = (i / this.world.width) | 0;
        if (cy < y0) y0 = cy;
        if (cy > y1) y1 = cy;
      });
    }
    this.checkFields();
    return y1 >= y0 ? { y0, y1 } : null;
  }

  /**
   * A whole line shaped at once, with the old trench / dike / level profiles
   * (scripted strokes: tests, scenes; the old plan commands map to it):
   * dig grades the floor evenly from start to end `amount` below the
   * ground (or between absolute `floor` heights), raise heaps a level bank `amount` above the lowest ground on
   * the line, even flattens to the height at its start. Fixed cells are
   * left alone. Returns the changed cells.
   */
  shapeLine(kind: BrushTool, points: readonly Pt[], width: number, amount: number, stroke: number, floor?: readonly [number, number]): number[] {
    const w = this.world;
    const grid: PlanGrid = {
      width: w.width,
      height: w.height,
      plan: new Float32Array(w.size).fill(NaN),
      idx: (x, y) => w.idx(x, y),
      terrain: (i) => w.terrain(i),
    };
    const cells =
      kind === 'dig' ? planTrench(grid, points, width, amount, floor) : kind === 'raise' ? planDike(grid, points, width, amount) : planLevel(grid, points, width);
    const s = this.stroke(stroke);
    const done: number[] = [];
    this.scripted = true;
    for (const i of cells) {
      if (this.host.fixed(i)) continue;
      const dz = grid.plan[i]! - w.terrain(i);
      if (Math.abs(dz) < 1e-4) continue;
      this.change(s, i, dz);
      done.push(i);
    }
    this.scripted = false;
    this.checkFields();
    return done;
  }

  /** Move cell i's ground by dz within stroke s. */
  private change(s: Stroke, i: number, dz: number): void {
    const w = this.world;
    if (!s.orig.has(i)) {
      this.host.willChange(i);
      s.orig.set(i, { bedrock: w.bedrock[i]!, soil: w.soil[i]!, soilType: w.soilType[i]!, flags: w.flags[i]! });
    }
    this.moved[this.scripted ? 'script' : 'brush'] += Math.abs(dz) * CELL_AREA;
    const before = s.moved.get(i) ?? 0;
    const moved = before + Math.abs(dz);
    s.moved.set(i, moved);
    if (dz > 0) {
      w.soil[i]! += dz;
      if (w.soilType[i] === SoilType.Rock && w.soil[i]! >= 0.3) w.soilType[i] = SoilType.Clay;
    } else {
      let dig = -dz;
      const soil = w.soil[i]!;
      const fromSoil = Math.min(soil, dig);
      w.soil[i] = soil - fromSoil;
      dig -= fromSoil;
      if (dig > 0) w.bedrock[i]! -= dig;
      if (w.soil[i]! < 0.05) w.soilType[i] = SoilType.Rock;
      this.squeeze(i);
    }
    w.vegetation[i] = Math.max(0, w.vegetation[i]! - Math.abs(dz) * VEG_PER_M);
    // Banks and canals, measured from the ground before the player's first work.
    const g0 = this.host.original(i) ?? s.orig.get(i)!.bedrock + s.orig.get(i)!.soil;
    const z = w.terrain(i);
    let f = w.flags[i]!;
    if (z > g0 + FILL_HEIGHT && w.soil[i]! > 0.05) f |= CellFlag.Fill;
    else f &= ~CellFlag.Fill;
    if (z < g0 - CANAL_DEPTH) f |= CellFlag.Canal;
    else if (z > g0 - CANAL_DEPTH / 2) f &= ~CellFlag.Canal;
    w.flags[i] = f;
    if (before < CLEAR_AT && moved >= CLEAR_AT) {
      const lined = (w.flags[i]! & CellFlag.Lined) !== 0;
      if (lined) w.flags[i]! &= ~CellFlag.Lined;
      // Fields, gardens and pastures stay unless it gets too steep (checkFields).
      const cleared = !farmed(w.landuse[i]!) && clearGround(w, i);
      if (cleared || lined) this.host.cleared(i, lined);
    }
    this.touched.add(i);
    this.host.changed(i);
  }

  /** Fields, gardens and pastures on or next to changed cells that are now too steep to farm go back to plain land. */
  private checkFields(): void {
    if (!this.touched.size) return;
    const w = this.world;
    const W = w.width;
    const seen = new Set<number>();
    for (const i of this.touched) {
      const x = i % W;
      const y = (i / W) | 0;
      for (const j of [i, x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < w.height - 1 ? i + W : -1]) {
        if (j < 0 || seen.has(j)) continue;
        seen.add(j);
        if (farmed(w.landuse[j]!) && cellSlope(w, j) > FIELD_MAX_SLOPE && clearGround(w, j)) this.host.cleared(j, false);
      }
    }
    this.touched.clear();
  }

  /** Groundwater above the soil's new capacity comes out onto the surface (conserved). */
  private squeeze(i: number): void {
    const w = this.world;
    const cap = w.soil[i]! * SOIL_PROPS[w.soilType[i]!]!.porosity;
    if (w.ground[i]! > cap) {
      w.water[i]! += w.ground[i]! - cap;
      w.ground[i] = cap;
    }
  }
}

function farmed(lu: number): boolean {
  return lu === LandUse.Field || lu === LandUse.Garden || lu === LandUse.Pasture;
}

/** Steepest rise from cell i to a neighbour (m per 5 m, over 5; as Village.slope). */
export function cellSlope(w: World, i: number): number {
  const W = w.width;
  const x = i % W;
  const y = (i / W) | 0;
  const h = w.terrain(i);
  let m = 0;
  if (x > 0) m = Math.max(m, Math.abs(w.terrain(i - 1) - h));
  if (x < W - 1) m = Math.max(m, Math.abs(w.terrain(i + 1) - h));
  if (y > 0) m = Math.max(m, Math.abs(w.terrain(i - W) - h));
  if (y < w.height - 1) m = Math.max(m, Math.abs(w.terrain(i + W) - h));
  return m / CELL;
}
