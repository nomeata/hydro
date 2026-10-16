/**
 * Soils, initial groundwater, fertility and vegetation, derived from the
 * carved terrain and its hydrology.
 */
import { CELL } from '../constants';
import { SOIL_PROPS, SoilType } from '../world';
import { fbm, perlin } from '../../shared/noise';
import { clamp, smoothstep, subSeed } from './util';

export interface SoilInputs {
  W: number;
  H: number;
  originX: number;
  originY: number;
  seed: number;
  z: Float32Array;
  slope: Float32Array;
  water: Float32Array;
  chanU: Float32Array;
  chanQ: Float32Array;
  riverDist: Float32Array;
  plain: Float32Array;
  depDepth: Float32Array;
  acc: Float32Array;
  /** Rainfall proxy relative to the map mean (≈1). */
  rain: Float32Array;
}

export interface SoilOutputs {
  soilType: Uint8Array;
  soil: Float32Array;
  ground: Float32Array;
  fertility: Float32Array;
  vegetation: Float32Array;
  /** 0..1 moisture used for the above. */
  moisture: Float32Array;
}

/** Box blur via a summed-area table (radius r, clamped at edges). */
export function boxBlur(src: Float32Array, W: number, H: number, r: number): Float32Array {
  const sat = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += src[y * W + x]!;
      sat[(y + 1) * (W + 1) + x + 1] = sat[y * (W + 1) + x + 1]! + row;
    }
  }
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(W, x + r + 1);
      const s = sat[y1 * (W + 1) + x1]! - sat[y0 * (W + 1) + x1]! - sat[y1 * (W + 1) + x0]! + sat[y0 * (W + 1) + x0]!;
      out[y * W + x] = s / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

export function computeSoils(inp: SoilInputs): SoilOutputs {
  const { W, H, z, slope, water, chanU, riverDist, plain, depDepth, acc, rain } = inp;
  const n = W * H;
  const soilType = new Uint8Array(n);
  const soil = new Float32Array(n);
  const ground = new Float32Array(n);
  const fertility = new Float32Array(n);
  const vegetation = new Float32Array(n);
  const moisture = new Float32Array(n);

  let zmin = Infinity;
  let zmax = -Infinity;
  for (let i = 0; i < n; i++) {
    if (z[i]! < zmin) zmin = z[i]!;
    if (z[i]! > zmax) zmax = z[i]!;
  }
  const relief = Math.max(20, zmax - zmin);
  const blur = boxBlur(z, W, H, 12);
  // Smoothed log-accumulation so moisture follows drainage lines softly.
  const lacc = new Float32Array(n);
  for (let i = 0; i < n; i++) lacc[i] = Math.log(acc[i]! * CELL);
  const lacc2 = boxBlur(lacc, W, H, 2);
  const sSand = subSeed(inp.seed, 301);
  const sPatch = subSeed(inp.seed, 302);
  const sThick = subSeed(inp.seed, 303);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const gx = (inp.originX + x) * CELL;
      const gy = (inp.originY + y) * CELL;
      const s = slope[i]!;
      const rel = (z[i]! - zmin) / relief;
      const local = z[i]! - blur[i]!; // >0 ridge, <0 hollow
      const twi = lacc2[i]! - Math.log(Math.max(s, 0.004));
      const wetIdx = clamp((twi - 5) / 8, 0, 1);
      const near = Math.exp(-riverDist[i]! / 14);
      const dd = depDepth[i]!;
      const basin = smoothstep(0.05, 1.0, dd);
      const r = rain[i]!;
      const wet = water[i]! > 0.05;

      // Saturation of the soil column.
      let sat =
        0.18 +
        0.32 * wetIdx +
        0.4 * near +
        0.45 * basin +
        0.15 * plain[i]! -
        0.25 * smoothstep(0, 8, local) -
        0.15 * smoothstep(0.6, 1, rel) +
        0.25 * (r - 1);
      sat = clamp(sat, 0.03, 1);
      if (wet) sat = 1;

      const sandN = fbm(gx / 700, gy / 700, sSand, 3);
      const thN = perlin(gx / 120, gy / 120, sThick);
      let t: SoilType;
      let th: number;
      if (s > 0.7 || (rel > 0.8 && s > 0.33) || (rel > 0.92 && s > 0.2)) {
        t = SoilType.Rock;
        th = 0.05 + 0.3 * (1 - smoothstep(0.75, 1.3, s)) + 0.1 * thN;
      } else if (s > 0.4 || (rel > 0.7 && s > 0.2) || (rel > 0.85 && s > 0.1)) {
        t = SoilType.Gravel;
        th = 0.3 + 0.4 * (1 - smoothstep(0.42, 0.75, s)) + 0.15 * thN;
      } else if (chanU[i]! < 1.25) {
        // River bed and bars: gravel in steep channels, sand bars elsewhere.
        if (s > 0.12) t = SoilType.Gravel;
        else if (chanU[i]! > 0.55 && sandN + 0.2 * thN > -0.05) t = SoilType.Sand;
        else t = s > 0.04 ? SoilType.Gravel : SoilType.Sand;
        th = 1.0 + 0.8 * thN;
      } else if (dd > 0.4 && sat > 0.75 && r > 0.85) {
        t = SoilType.Peat;
        th = 1.5 + 2.2 * smoothstep(0.4, 4, dd) + 0.5 * thN;
      } else if (dd > 0.25 || (local < -2.5 && s < 0.06 && rel < 0.45)) {
        t = SoilType.Clay;
        th = 2.2 + 1.5 * basin + 0.6 * thN;
      } else if (plain[i]! > 0.45 && s < 0.08) {
        t = SoilType.Silt;
        th = 2.5 + 1.5 * plain[i]! + 0.5 * thN;
      } else if (sandN + 0.1 * thN > 0.24 + 0.5 * (r - 1) && sat < 0.5 && s < 0.15) {
        t = SoilType.Sand;
        th = 1.5 + 1.5 * smoothstep(0.1, 0.4, sandN) + 0.5 * thN;
      } else if (s > 0.28 && rel > 0.55) {
        t = SoilType.Gravel;
        th = 0.4 + 0.4 * thN + 0.2;
      } else {
        t = SoilType.Loam;
        th = 2.6 - 5 * s + 0.8 * thN + 0.8 * near;
      }
      if (t !== SoilType.Rock) th = clamp(th, 0.3, 5);
      else th = clamp(th, 0.02, 0.5);
      soilType[i] = t;
      soil[i] = th;

      const props = SOIL_PROPS[t]!;
      ground[i] = Math.min(sat, 1) * th * props.porosity;

      const moist = sat;
      moisture[i] = moist;
      const waterlog = smoothstep(0.85, 1, moist) * (t === SoilType.Peat ? 0.2 : 0.35);
      fertility[i] = wet ? 0 : clamp(props.fertility * (0.5 + 0.5 * moist) * (1 - waterlog) + 0.05 * thN, 0, 1);

      // Vegetation: grass where soil allows, forest patches on moist mid slopes.
      let v: number;
      if (wet) v = 0;
      else {
        const grass = (0.3 + 0.5 * moist) * (t === SoilType.Rock ? 0.15 : t === SoilType.Sand ? 0.4 : t === SoilType.Gravel ? 0.55 : 1);
        const patch = smoothstep(-0.1, 0.15, fbm(gx / 380, gy / 380, sPatch, 3) + 0.3 * (moist - 0.4));
        const suit =
          smoothstep(0.18, 0.45, moist) *
          (1 - smoothstep(0.5, 0.9, s)) *
          (1 - smoothstep(0.8, 0.95, rel)) *
          (t === SoilType.Loam || t === SoilType.Clay || t === SoilType.Silt ? 1 : t === SoilType.Gravel ? 0.6 : 0.3) *
          (0.6 + 0.4 * smoothstep(0.02, 0.1, s) + 0.3 * plain[i]!);
        v = clamp(grass * 0.55 + 0.6 * suit * patch, 0, 1);
        if (t === SoilType.Peat) v = Math.max(v, 0.55);
      }
      vegetation[i] = v;
    }
  }
  respectRepose(z, W, H, soilType, soil, ground);
  return { soilType, soil, ground, fertility, vegetation, moisture };
}

/** Margin below the angle of repose that loose soil must keep at generation. */
const REPOSE_MARGIN = 0.85;

/**
 * Where a cell is steeper towards any of its 8 neighbours than its soil can
 * stand (talus would slump it at once), make it a rocky crag with a thin
 * regolith instead, so the generated world starts in talus equilibrium.
 */
function respectRepose(z: Float32Array, W: number, H: number, soilType: Uint8Array, soil: Float32Array, ground: Float32Array): void {
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const t = soilType[i]!;
      if (t === SoilType.Rock) continue;
      let steep = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if ((dx === 0 && dy === 0) || xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const s = (z[i]! - z[yy * W + xx]!) / (CELL * (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1));
          if (s > steep) steep = s;
        }
      if (steep > REPOSE_MARGIN * SOIL_PROPS[t]!.repose) {
        soilType[i] = SoilType.Rock;
        soil[i] = Math.min(soil[i]!, 0.3);
        ground[i] = Math.min(ground[i]!, soil[i]! * SOIL_PROPS[SoilType.Rock]!.porosity);
      }
    }
}
