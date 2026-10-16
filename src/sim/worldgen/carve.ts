/**
 * Carve the macro river paths into the fine terrain: a channel with smooth
 * banks around the centreline, a floodplain for big rivers and valley walls
 * that blend smoothly into the base terrain. Several rivers combine by taking
 * the lowest carved surface.
 */
import { CELL } from '../constants';
import type { RiverPath } from './macro';
import { smin, smoothstep, softRamp } from './util';

export interface CarveResult {
  /** Carved terrain height (m). */
  terrain: Float32Array;
  /** Distance to the nearest centreline in units of channel half-width (∞ far away). */
  chanU: Float32Array;
  /** Initial water level for channel cells (m). */
  chanLevel: Float32Array;
  /** Bed elevation at the nearest centreline (m). */
  chanBed: Float32Array;
  /** Discharge of the nearest river (m³/s). */
  chanQ: Float32Array;
  /** Distance (cells) to the nearest centreline, capped at 255. */
  riverDist: Float32Array;
  /** 0..1, how much a cell lies on a floodplain. */
  plain: Float32Array;
}

/** Bank height above bankfull water (m). */
const BANK = 0.3;
/** Manning roughness assumed for the initial channel water depth. */
const MANNING = 0.035;

export function carveRivers(
  base: Float32Array,
  W: number,
  H: number,
  originX: number,
  originY: number,
  paths: readonly RiverPath[],
): CarveResult {
  const n = W * H;
  const terrain = Float32Array.from(base);
  const chanU = new Float32Array(n).fill(Infinity);
  const chanLevel = new Float32Array(n);
  const chanQ = new Float32Array(n);
  const chanBed = new Float32Array(n);
  const riverDist = new Float32Array(n).fill(255);
  const plainW = new Float32Array(n);

  for (const p of paths) {
    const m = p.x.length;
    for (let k = 0; k < m - 1; k++) {
      const ax = p.x[k]! - originX;
      const ay = p.y[k]! - originY;
      const bx = p.x[k + 1]! - originX;
      const by = p.y[k + 1]! - originY;
      const wMax = Math.max(p.width[k]!, p.width[k + 1]!);
      const pMax = Math.max(p.plain[k]!, p.plain[k + 1]!);
      const reach = 0.7 * wMax + pMax + 14 + 26 * smoothstep(3, 8, wMax);
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - reach));
      const x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + reach));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - reach));
      const y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + reach));
      if (x0 > x1 || y0 > y1) continue;
      const dx = bx - ax;
      const dy = by - ay;
      const l2 = dx * dx + dy * dy;
      const inv = l2 > 0 ? 1 / l2 : 0;
      const fade0 = 0.6 * reach;
      // Initial water depth: Manning normal depth for this reach, h = (Q n / (B √S))^(3/5).
      const segLen = Math.sqrt(l2) * CELL;
      const S = Math.max(1e-4, (p.bed[k]! - p.bed[k + 1]!) / Math.max(segLen, 1e-3));
      const qSeg = 0.5 * (p.q[k]! + p.q[k + 1]!);
      const B = 0.5 * (p.width[k]! + p.width[k + 1]!) * CELL;
      const hN = Math.pow((qSeg * MANNING) / (B * Math.sqrt(S)), 0.6);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          let t = ((x - ax) * dx + (y - ay) * dy) * inv;
          if (t < 0) t = 0;
          else if (t > 1) t = 1;
          const ex = ax + t * dx - x;
          const ey = ay + t * dy - y;
          const d = Math.sqrt(ex * ex + ey * ey);
          if (d >= reach) continue;
          const bed = p.bed[k]! + t * (p.bed[k + 1]! - p.bed[k]!);
          const w = p.width[k]! + t * (p.width[k + 1]! - p.width[k]!);
          const dep = p.depth[k]! + t * (p.depth[k + 1]! - p.depth[k]!);
          const pl = p.plain[k]! + t * (p.plain[k + 1]! - p.plain[k]!);
          const hw = 0.5 * w;
          const u = d / hw;
          let z: number;
          if (u <= 1.4) {
            z = bed + (dep + BANK) * smoothstep(0.3, 1.4, u);
          } else {
            const e = d - 1.4 * hw;
            z = bed + dep + BANK + 0.06 * e + 0.22 * CELL * softRamp(e - pl, 4);
          }
          const i = y * W + x;
          const b = base[i]!;
          const v = smin(b, z, 2.5);
          const wR = d <= fade0 ? 1 : 1 - smoothstep(fade0, reach, d);
          const r = b + wR * (v - b);
          if (r < terrain[i]!) terrain[i] = r;
          if (u < chanU[i]!) {
            chanU[i] = u;
            chanLevel[i] = bed + Math.min(Math.max(hN, 0.25), 0.85 * dep);
            chanBed[i] = bed;
            chanQ[i] = p.q[k]! + t * (p.q[k + 1]! - p.q[k]!);
          }
          if (d < riverDist[i]!) riverDist[i] = d;
          const pw = 1 - smoothstep(pl * 0.8, pl + 3, d - 1.4 * hw);
          if (pw > plainW[i]!) plainW[i] = pw;
        }
      }
    }
  }
  return { terrain, chanU, chanLevel, chanBed, chanQ, riverDist, plain: plainW };
}
