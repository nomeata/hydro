/**
 * Talus (thermal erosion): soil on slopes steeper than its angle of repose
 * slumps to lower neighbours (8-connected). The repose slope comes from
 * SOIL_PROPS and drops when the soil is wet (saturated ground or under
 * water), so loose sand banks of a flooded trench slump while dry ones stand.
 *
 * Two passes (compute deltas, then apply), so the result does not depend on
 * the iteration order and soil volume is conserved exactly. Only soil moves,
 * never bedrock; lined cells neither give nor receive.
 */
import { CELL } from '../constants';
import { CellFlag, SOIL_PROPS, SOIL_TYPE_COUNT, type World } from '../world';
import type { GeoParams, RowRange, SedimentLedger } from './erosion';

export class TalusScratch {
  readonly delta: Float32Array;
  /** Soil type of the main donor for cells that had (almost) no soil, 255 = none. */
  readonly donor: Uint8Array;
  readonly reposeDry = new Float32Array(SOIL_TYPE_COUNT);
  readonly ex = new Float64Array(8);
  readonly nb = new Int32Array(8);
  constructor(size: number) {
    this.delta = new Float32Array(size);
    this.donor = new Uint8Array(size).fill(255);
    for (let t = 0; t < SOIL_TYPE_COUNT; t++) this.reposeDry[t] = SOIL_PROPS[t]!.repose;
  }
}

const DIAG = Math.SQRT2;
/** Wet if the surface water is deeper than this (m). */
const WET_DEPTH = 0.05;
/** A slope's toe counts as wet under this much water (m). */
const TOE_DEPTH = 0.01;
/** Cells with less soil than this adopt the donor's soil type. */
const BARE = 0.05;

/**
 * One talus pass. `frac` is the fraction of the excess height difference
 * removed in this pass (≤ 0.5 for stability). Returns nothing; updates
 * `dirty` and the ledger.
 */
export function talusStep(world: World, scratch: TalusScratch, frac: number, p: GeoParams, ledger: SedimentLedger, dirty: RowRange): void {
  const { width: W, height: H, bedrock, soil, soilType, water, ground, flags } = world;
  const { delta, donor, reposeDry } = scratch;
  const wetSat = p.wetSaturation;
  const wetF = p.reposeWet;
  const k = Math.min(0.5, frac);
  let moved = 0;
  let y0 = dirty.y0;
  let y1 = dirty.y1;
  // Excess per neighbour, reused.
  const ex = scratch.ex;
  const nb = scratch.nb;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const so = soil[i]!;
      if (so <= 0) continue;
      if ((flags[i]! & CellFlag.Lined) !== 0) continue;
      const st = soilType[i]!;
      const zi = bedrock[i]! + so;
      const rep = reposeDry[st]!;
      const repWet = rep * wetF[st]!;
      const cap = so * SOIL_PROPS[st]!.porosity;
      // Wet soil, or a toe under water, stands at a lower angle.
      const selfWet = water[i]! > WET_DEPTH || (cap > 0 && ground[i]! > wetSat * cap);
      const dDry = rep * CELL;
      const dWet = repWet * CELL;
      let n = 0;
      let total = 0;
      let maxEx = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const j = yy * W + xx;
          if ((flags[j]! & CellFlag.Lined) !== 0) continue;
          const diag = dx !== 0 && dy !== 0 ? DIAG : 1;
          const drop = zi - (bedrock[j]! + soil[j]!);
          let e = drop - dWet * diag;
          if (e <= 0) continue;
          if (!selfWet) {
            // Dry slope: only a wet toe (under water or saturated) lowers its angle.
            const sj = soil[j]!;
            const toeWet = water[j]! > TOE_DEPTH || (sj > 0 && ground[j]! > wetSat * sj * SOIL_PROPS[soilType[j]!]!.porosity);
            if (!toeWet) e = drop - dDry * diag;
          }
          if (e > 0) {
            ex[n] = e;
            nb[n] = j;
            n++;
            total += e;
            if (e > maxEx) maxEx = e;
          }
        }
      }
      if (n === 0) continue;
      // Move half the largest excess (times k), shared by excess, capped by the soil.
      let m = 0.5 * k * maxEx;
      if (m > so) m = so;
      if (m <= 1e-6) continue;
      delta[i]! -= m;
      const inv = m / total;
      for (let q = 0; q < n; q++) {
        const j = nb[q]!;
        delta[j]! += ex[q]! * inv;
        if (soil[j]! < BARE) donor[j] = st;
      }
      moved += m;
      if (y - 1 < y0) y0 = Math.max(0, y - 1);
      if (y + 1 > y1) y1 = Math.min(H - 1, y + 1);
    }
  }
  if (moved > 0) {
    const r0 = Math.max(0, y0);
    const r1 = Math.min(H - 1, y1);
    for (let i = r0 * W; i < (r1 + 1) * W; i++) {
      const d = delta[i]!;
      if (d === 0) continue;
      delta[i] = 0;
      let s = soil[i]! + d;
      if (s < 0) s = 0;
      soil[i] = s;
      const dn = donor[i]!;
      if (dn !== 255) {
        soilType[i] = dn;
        donor[i] = 255;
      }
      if (d < 0) {
        const cap = s * SOIL_PROPS[soilType[i]!]!.porosity;
        if (ground[i]! > cap) {
          water[i]! += ground[i]! - cap;
          ground[i] = cap;
        }
      }
    }
  }
  ledger.talus += moved * CELL * CELL;
  dirty.y0 = y0;
  dirty.y1 = y1;
}
