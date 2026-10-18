/**
 * Lateral groundwater flow (Darcy-like diffusion of the water table).
 *
 * Each cell's soil holds `ground` metres of water column; the water table is
 * at bedrock + ground / porosity. Water moves between neighbours in
 * proportion to the table difference and the (harmonic mean) conductivity,
 * so canals and rivers wet the surrounding soil, hillsides drain into
 * valleys, and springs appear where the table meets the surface (the soil
 * bucket overflow in soilwater.ts turns that into surface water).
 *
 * Explicit scheme, conservative by construction (each face flux is applied
 * to both sides), stable by limiting each face flux to a fraction of the
 * donor's water.
 */
import type { ActiveSet } from '../active';
import { TILE } from '../constants';
import { SOIL_PROPS, type World } from '../world';

export interface GroundwaterParams {
  /** Exchange coefficient per update for conductivity 1 (fraction of the head difference). */
  kBase: number;
}

export const DEFAULT_GROUNDWATER: GroundwaterParams = {
  kBase: 0.08,
};

export class GroundwaterScratch {
  readonly table: Float32Array;
  readonly delta: Float32Array;
  readonly cond: Float32Array;
  readonly poro: Float32Array;
  /** Water column (m, summed over cells) that came in from / left into the frozen land in the last update. */
  edgeIn = 0;
  edgeOut = 0;
  constructor(size: number) {
    this.table = new Float32Array(size);
    this.delta = new Float32Array(size);
    this.cond = new Float32Array(size);
    this.poro = new Float32Array(size);
  }
}

/** Largest fraction of a donor cell's groundwater one face may move per update. */
const MAX_FACE_FRACTION = 0.12;

/**
 * One lateral update. With an `active` set (not all tiles), only active
 * cells change; the frozen cells around them keep their water table, and
 * the exchange with them is reported in `s.edgeIn`/`s.edgeOut`.
 */
export function groundwaterStep(world: World, s: GroundwaterScratch, p: GroundwaterParams = DEFAULT_GROUNDWATER, active?: ActiveSet | null): void {
  s.edgeIn = 0;
  s.edgeOut = 0;
  if (active && !active.all) {
    sparseStep(world, s, p, active);
    return;
  }
  const { width: W, height: H, size, bedrock, soil, soilType, ground } = world;
  const { table, delta, cond, poro } = s;
  for (let i = 0; i < size; i++) {
    const props = SOIL_PROPS[soilType[i]!]!;
    const n = Math.max(props.porosity, 0.02);
    poro[i] = n;
    // Thin soil conducts little; conductivity contrast is clamped to ≤ 100×.
    cond[i] = Math.max(0.01, props.conductivity) * Math.min(1, soil[i]! / 1.5);
    table[i] = bedrock[i]! + ground[i]! / n;
    delta[i] = 0;
  }
  const k = p.kBase;
  const face = (i: number, j: number) => {
    const dh = table[i]! - table[j]!;
    if (dh === 0) return;
    const ci = cond[i]!;
    const cj = cond[j]!;
    const c = (2 * ci * cj) / (ci + cj);
    // Water column moved: head difference × storage of the donor × coefficient.
    let q = k * c * dh * (dh > 0 ? poro[i]! : poro[j]!) * 0.5;
    if (q > 0) q = Math.min(q, ground[i]! * MAX_FACE_FRACTION);
    else q = Math.max(q, -ground[j]! * MAX_FACE_FRACTION);
    delta[i]! -= q;
    delta[j]! += q;
  };
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const i = row + x;
      if (x < W - 1) face(i, i + 1);
      if (y < H - 1) face(i, i + W);
    }
  }
  for (let i = 0; i < size; i++) {
    const g = ground[i]! + delta[i]!;
    ground[i] = g > 0 ? g : 0;
  }
}

function prepare(world: World, s: GroundwaterScratch, i: number): void {
  const props = SOIL_PROPS[world.soilType[i]!]!;
  const n = Math.max(props.porosity, 0.02);
  s.poro[i] = n;
  s.cond[i] = Math.max(0.01, props.conductivity) * Math.min(1, world.soil[i]! / 1.5);
  s.table[i] = world.bedrock[i]! + world.ground[i]! / n;
  s.delta[i] = 0;
}

/** groundwaterStep on the active tiles, with the frozen halo as a fixed-table boundary. */
function sparseStep(world: World, s: GroundwaterScratch, p: GroundwaterParams, act: ActiveSet): void {
  const { width: W, height: H, ground } = world;
  const { table, delta, cond, poro } = s;
  const { tw, tile } = act;
  const hs = act.haloSpans;
  for (let k = 0; k < hs.length; k += 3) {
    const y0 = hs[k]! * TILE;
    const x0 = hs[k + 1]! * TILE;
    const x1 = Math.min(W, hs[k + 2]! * TILE);
    for (let y = y0; y < Math.min(H, y0 + TILE); y++) for (let i = y * W + x0; i < y * W + x1; i++) prepare(world, s, i);
  }
  const kb = p.kBase;
  const face = (i: number, j: number) => {
    const dh = table[i]! - table[j]!;
    if (dh === 0) return;
    const ci = cond[i]!;
    const cj = cond[j]!;
    const c = (2 * ci * cj) / (ci + cj);
    let q = kb * c * dh * (dh > 0 ? poro[i]! : poro[j]!) * 0.5;
    if (q > 0) q = Math.min(q, ground[i]! * MAX_FACE_FRACTION);
    else q = Math.max(q, -ground[j]! * MAX_FACE_FRACTION);
    delta[i]! -= q;
    delta[j]! += q;
  };
  const sp = act.spans;
  for (let k = 0; k < sp.length; k += 3) {
    const ty = sp[k]!;
    const tx0 = sp[k + 1]!;
    const y0 = ty * TILE;
    const x0 = tx0 * TILE;
    const x1 = Math.min(W, sp[k + 2]! * TILE);
    const leftFrozen = x0 > 0 && !tile[ty * tw + tx0 - 1];
    for (let y = y0; y < Math.min(H, y0 + TILE); y++) {
      const row = y * W;
      if (leftFrozen) face(row + x0 - 1, row + x0);
      for (let x = x0; x < x1; x++) {
        const i = row + x;
        if (y === y0 && y > 0 && !tile[(ty - 1) * tw + ((x / TILE) | 0)]) face(i - W, i);
        if (x < W - 1) face(i, i + 1);
        if (y < H - 1) face(i, i + W);
      }
    }
  }
  // Frozen cells keep their water; what they would have gained or lost crossed the edge.
  for (let k = 0; k < hs.length; k += 3) {
    const ty = hs[k]!;
    const y0 = ty * TILE;
    for (let tx = hs[k + 1]!; tx < hs[k + 2]!; tx++) {
      const x0 = tx * TILE;
      const x1 = Math.min(W, x0 + TILE);
      const live = tile[ty * tw + tx] === 1;
      for (let y = y0; y < Math.min(H, y0 + TILE); y++)
        for (let i = y * W + x0; i < y * W + x1; i++) {
          const d = delta[i]!;
          if (live) {
            const g = ground[i]! + d;
            ground[i] = g > 0 ? g : 0;
          } else if (d > 0) s.edgeOut += d;
          else if (d < 0) s.edgeIn -= d;
        }
    }
  }
}
