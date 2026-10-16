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
  constructor(size: number) {
    this.table = new Float32Array(size);
    this.delta = new Float32Array(size);
    this.cond = new Float32Array(size);
    this.poro = new Float32Array(size);
  }
}

/** Largest fraction of a donor cell's groundwater one face may move per update. */
const MAX_FACE_FRACTION = 0.12;

export function groundwaterStep(world: World, s: GroundwaterScratch, p: GroundwaterParams = DEFAULT_GROUNDWATER): void {
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
