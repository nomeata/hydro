/**
 * Surface water flow: local inertial approximation of the shallow water
 * equations (Bates, Horritt & Fewtrell 2010) with the θ-weighted face flux of
 * de Almeida et al. (2012) to suppress checkerboard oscillations, and a
 * semi-implicit Manning friction term. The friction depth exponent 7/3 is
 * approximated by 9/4 (two square roots instead of a slow cube root).
 *
 * Face discharges are per unit width (m²/s). qx[i] is the face between cell i
 * and its +x neighbour; qy[i] the face to its +y neighbour. Map edges are
 * walls; cells flagged as Outlet drain at critical flow.
 *
 * Sediment moves with the same volumes (upwind concentration), so both water
 * and sediment are conserved exactly apart from the outlet drain.
 */
import { CELL, CELL_AREA, DRY, GRAVITY } from '../constants';
import { CellFlag, type World } from '../world';

export interface FlowParams {
  /** Manning roughness n (s/m^(1/3)). */
  manning: number;
  /** θ weighting; 1 = plain Bates scheme. */
  theta: number;
  /** Velocity clamp (m/s) as a final safety net. */
  maxVelocity: number;
  /** Faces with flow depth below this carry no flow (m). */
  minFaceDepth: number;
}

export const DEFAULT_FLOW_PARAMS: FlowParams = {
  manning: 0.035,
  theta: 0.8,
  maxVelocity: 5,
  minFaceDepth: 1e-4,
};

/** Reusable scratch buffers. */
export class FlowScratch {
  readonly qxOld: Float32Array;
  readonly qyOld: Float32Array;
  /** Outflow scaling factor per cell. */
  readonly limit: Float32Array;
  /** Sediment concentration per cell (m³ sediment per m³ water). */
  readonly conc: Float32Array;
  constructor(size: number) {
    this.qxOld = new Float32Array(size);
    this.qyOld = new Float32Array(size);
    this.limit = new Float32Array(size);
    this.conc = new Float32Array(size);
  }
}

export interface FlowStats {
  /** Water volume (m³) drained through outlets during the step. */
  outflow: number;
  /** Max depth seen (m), for choosing the next stable dt. */
  maxDepth: number;
  /** Max |velocity| seen (m/s). */
  maxSpeed: number;
  /** Sediment volume (m³) drained through outlets during the step. */
  sedimentOut?: number;
}

/** Largest stable time step for the given conditions (Courant-like). */
export function stableDt(maxDepth: number, maxSpeed: number, alpha = 0.7): number {
  return (alpha * CELL) / (Math.sqrt(GRAVITY * Math.max(maxDepth, 0.01)) + maxSpeed);
}

/**
 * Advance surface water by dt seconds. Allocation-free.
 */
export function flowStep(world: World, scratch: FlowScratch, p: FlowParams, dt: number, stats: FlowStats): void {
  const { width: W, height: H, size, bedrock, soil, water, sediment, qx, qy, flags, velX, velY } = world;
  const { qxOld, qyOld, limit, conc } = scratch;
  qxOld.set(qx);
  qyOld.set(qy);

  const g = GRAVITY;
  const n2 = p.manning * p.manning;
  const theta = p.theta;
  const side = (1 - theta) * 0.5;
  const minH = p.minFaceDepth;
  const maxV = p.maxVelocity;
  const invDx = 1 / CELL;

  // --- 1. Face discharges ---------------------------------------------------
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const i = row + x;
      const zi = bedrock[i]! + soil[i]!;
      const hi = water[i]!;
      const ei = zi + hi;

      // x-face (i → i+1)
      if (x < W - 1) {
        const j = i + 1;
        const zj = bedrock[j]! + soil[j]!;
        const hj = water[j]!;
        const ej = zj + hj;
        const hf = Math.max(ei, ej) - Math.max(zi, zj);
        if (hf > minH && (hi > 0 || hj > 0)) {
          const q0 = qxOld[i]!;
          const qa = x > 0 ? qxOld[i - 1]! : q0;
          const qb = x < W - 2 ? qxOld[i + 1]! : q0;
          const qt = theta * q0 + side * (qa + qb);
          let q = qt - g * hf * dt * (ej - ei) * invDx;
          if (q0 !== 0) q /= 1 + (g * dt * n2 * Math.abs(q0)) / (hf * hf * Math.sqrt(Math.sqrt(hf)));
          const qmax = hf * maxV;
          if (q > qmax) q = qmax;
          else if (q < -qmax) q = -qmax;
          qx[i] = q;
        } else {
          qx[i] = 0;
        }
      } else {
        qx[i] = 0;
      }

      // y-face (i → i+W)
      if (y < H - 1) {
        const j = i + W;
        const zj = bedrock[j]! + soil[j]!;
        const hj = water[j]!;
        const ej = zj + hj;
        const hf = Math.max(ei, ej) - Math.max(zi, zj);
        if (hf > minH && (hi > 0 || hj > 0)) {
          const q0 = qyOld[i]!;
          const qa = y > 0 ? qyOld[i - W]! : q0;
          const qb = y < H - 2 ? qyOld[i + W]! : q0;
          const qt = theta * q0 + side * (qa + qb);
          let q = qt - g * hf * dt * (ej - ei) * invDx;
          if (q0 !== 0) q /= 1 + (g * dt * n2 * Math.abs(q0)) / (hf * hf * Math.sqrt(Math.sqrt(hf)));
          const qmax = hf * maxV;
          if (q > qmax) q = qmax;
          else if (q < -qmax) q = -qmax;
          qy[i] = q;
        } else {
          qy[i] = 0;
        }
      } else {
        qy[i] = 0;
      }
    }
  }

  // --- 2. Outflow limiting: no cell may lose more water than it holds -------
  const k = dt * CELL; // volume per unit of q
  for (let i = 0, x = 0; i < size; i++, x = x === W - 1 ? 0 : x + 1) {
    let out = 0;
    const qr = qx[i]!;
    if (qr > 0) out += qr;
    if (x > 0) {
      const ql = qx[i - 1]!;
      if (ql < 0) out -= ql;
    }
    const qd = qy[i]!;
    if (qd > 0) out += qd;
    if (i >= W) {
      const qu = qy[i - W]!;
      if (qu < 0) out -= qu;
    }
    const vol = water[i]! * CELL_AREA;
    const outVol = out * k;
    limit[i] = outVol > vol ? vol / outVol : 1;
    conc[i] = vol > 0 ? sediment[i]! / vol : 0;
  }
  for (let i = 0; i < size; i++) {
    const q1 = qx[i]!;
    if (q1 > 0) qx[i] = q1 * limit[i]!;
    else if (q1 < 0) qx[i] = q1 * limit[i + 1]!;
    const q2 = qy[i]!;
    if (q2 > 0) qy[i] = q2 * limit[i]!;
    else if (q2 < 0) qy[i] = q2 * limit[i + W]!;
  }

  // --- 3. Continuity, sediment transport, velocity, outlets -----------------
  let outflow = 0;
  let sedOut = 0;
  let maxDepth = 0;
  let maxSpeed = 0;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const i = row + x;
      const qR = qx[i]!;
      const qL = x > 0 ? qx[i - 1]! : 0;
      const qD = qy[i]!;
      const qU = y > 0 ? qy[i - W]! : 0;
      // Net inflow volume (m³)
      const net = (qL - qR + qU - qD) * k;
      const h0 = water[i]!;
      let h = h0 + net / CELL_AREA;
      if (h < 0) h = 0;

      // Sediment, upwind.
      let s = sediment[i]!;
      if (qR > 0) s -= qR * k * conc[i]!;
      else if (qR < 0) s -= qR * k * conc[i + 1]!;
      if (qL > 0) s += qL * k * conc[i - 1]!;
      else if (qL < 0) s += qL * k * conc[i]!;
      if (qD > 0) s -= qD * k * conc[i]!;
      else if (qD < 0) s -= qD * k * conc[i + W]!;
      if (qU > 0) s += qU * k * conc[i - W]!;
      else if (qU < 0) s += qU * k * conc[i]!;
      if (s < 0) s = 0;

      // Open boundary: critical-flow drain.
      if ((flags[i]! & CellFlag.Outlet) !== 0 && h > 0) {
        const vol = h * CELL_AREA;
        const out = Math.min(vol, h * Math.sqrt(g * h) * CELL * dt);
        const so = s * (out / vol);
        s -= so;
        sedOut += so;
        h -= out / CELL_AREA;
        outflow += out;
      }

      water[i] = h;
      sediment[i] = s;

      const hm = 0.5 * (h0 + h);
      if (hm > DRY) {
        // Thin films (water dropping over a bank) give huge q/h; clamp so that
        // the time-step limit and erosion see physically sensible speeds.
        let vx = (0.5 * (qL + qR)) / hm;
        let vy = (0.5 * (qU + qD)) / hm;
        if (vx > maxV) vx = maxV;
        else if (vx < -maxV) vx = -maxV;
        if (vy > maxV) vy = maxV;
        else if (vy < -maxV) vy = -maxV;
        velX[i] = vx;
        velY[i] = vy;
        const sp = Math.abs(vx) + Math.abs(vy);
        if (sp > maxSpeed) maxSpeed = sp;
      } else {
        velX[i] = 0;
        velY[i] = 0;
      }
      if (h > maxDepth) maxDepth = h;
    }
  }
  stats.outflow = outflow;
  stats.sedimentOut = sedOut;
  stats.maxDepth = maxDepth;
  stats.maxSpeed = maxSpeed;
}
