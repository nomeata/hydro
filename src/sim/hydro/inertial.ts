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
 *
 * Walls (closed sluice gates) are thin crests on a cell: every face of a
 * wall cell sees the bed max(z_i, z_j, top), so water passes only above the
 * top. They are applied after the main face loop by recomputing just the
 * faces of the (few) wall cells, so they cost nothing in the hot loop.
 *
 * Sparse running (docs/ENDLESS.md §3–4):
 *  - Only the tiles of an ActiveSet are simulated. Cells outside are frozen
 *    (the halo): faces between an active and a halo cell use the halo's
 *    state as a fixed-level boundary, the flux is applied to the active cell
 *    only, and the exchange is reported in `stats.edgeIn`/`edgeOut`.
 *  - Dry tiles sleep: an active tile with no water at all, whose
 *    face-neighbouring cells in the adjacent tiles are dry too, is skipped.
 *    Every face it touches would be dry on both sides, so the full kernel
 *    would set it to zero and change nothing: sleeping is exact (bit-for-bit
 *    the same result). Rain, inflows or works that wet a cell wake its tile
 *    on the next call, because wetness is rescanned at the start of each
 *    call.
 */
import { ActiveSet } from '../active';
import { CELL, CELL_AREA, DRY, GRAVITY, TILE } from '../constants';
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

/** Thin walls on cells (closed gates): `count` cells with their crest heights (m). */
export interface Walls {
  count: number;
  cell: Int32Array;
  top: Float32Array;
}

/** Wet bits per tile: any cell, and the four edge rows/columns. */
const WET_ANY = 1;
const WET_W = 2;
const WET_E = 4;
const WET_N = 8;
const WET_S = 16;

/** Reusable scratch buffers. */
export class FlowScratch {
  readonly qxOld: Float32Array;
  readonly qyOld: Float32Array;
  /** Outflow scaling factor per cell. */
  readonly limit: Float32Array;
  /** Sediment concentration per cell (m³ sediment per m³ water). */
  readonly conc: Float32Array;
  /** Per tile: wet bits, awake now, awake in the previous call (sized on first use). */
  wet = new Uint8Array(0);
  awake = new Uint8Array(0);
  wasAwake = new Uint8Array(0);
  /** Runs of awake tiles, (ty, tx0, tx1) triples; `nRuns` of them are valid. */
  runs = new Int32Array(0);
  nRuns = 0;
  awakeTiles = 0;
  /** Let dry tiles sleep (exact; off only to test that). */
  sleep = true;
  /** The set used when the caller passes none (every tile active). */
  private allSet: ActiveSet | null = null;
  /** The active set (and its version) the halo scratch was set up for. */
  set: ActiveSet | null = null;
  version = -1;
  constructor(size: number) {
    this.qxOld = new Float32Array(size);
    this.qyOld = new Float32Array(size);
    this.limit = new Float32Array(size);
    this.conc = new Float32Array(size);
  }

  defaultSet(world: World): ActiveSet {
    if (!this.allSet || this.allSet.width !== world.width || this.allSet.height !== world.height) this.allSet = new ActiveSet(world.width, world.height);
    return this.allSet;
  }
}

export interface FlowStats {
  /** Water volume (m³) drained through outlets during the step. */
  outflow: number;
  /** Max depth seen (m), for choosing the next stable dt. */
  maxDepth: number;
  /** Max |velocity| seen (m/s). */
  maxSpeed: number;
  /**
   * Max over the cells of the wave speed √(g·h) + |u| (m/s; |u| as |u_x| + |u_y|): the
   * Courant limit of the next step (`stableDtWave`). Absent in older saves (then `stableDt`).
   */
  maxWave?: number;
  /** Sediment volume (m³) drained through outlets during the step. */
  sedimentOut?: number;
  /** Water (m³) that came in from, or left into, the frozen land outside the active set. */
  edgeIn?: number;
  edgeOut?: number;
  /** Sediment (m³) carried across the active edge. */
  edgeSedIn?: number;
  edgeSedOut?: number;
  /** Tiles the kernel ran on (awake), of the active ones. */
  awakeTiles?: number;
}

/** Largest stable time step from the cells' wave speeds (FlowStats.maxWave; Courant number alpha). */
export function stableDtWave(maxWave: number, alpha = 0.7): number {
  return (alpha * CELL) / Math.max(maxWave, Math.sqrt(GRAVITY * 0.01));
}

/**
 * Largest stable time step for the given conditions (Courant-like): the
 * deepest water's wave speed plus the fastest flow anywhere, which may be
 * different cells (a thin film over a bank), so it is stricter than
 * `stableDtWave`.
 */
export function stableDt(maxDepth: number, maxSpeed: number, alpha = 0.7): number {
  return (alpha * CELL) / (Math.sqrt(GRAVITY * Math.max(maxDepth, 0.01)) + maxSpeed);
}

/** Set up the scratch for a new active set: halo cells pass flow unlimited and carry their frozen concentration. */
function initHalo(world: World, scratch: FlowScratch, act: ActiveSet): void {
  const { width: W, height: H, water, sediment, qx, qy } = world;
  const { limit, conc, qxOld, qyOld } = scratch;
  const nt = act.tw * act.th;
  if (scratch.wet.length !== nt) {
    scratch.wet = new Uint8Array(nt);
    scratch.awake = new Uint8Array(nt);
    scratch.wasAwake = new Uint8Array(nt);
    scratch.runs = new Int32Array(nt * 3);
  }
  // Every active tile counts as just awake, so tiles that sleep at once get their faces cleared.
  scratch.wasAwake.set(act.tile);
  qxOld.set(qx);
  qyOld.set(qy);
  const hs = act.haloSpans;
  for (let k = 0; k < hs.length; k += 3) {
    const ty = hs[k]!;
    for (let tx = hs[k + 1]!; tx < hs[k + 2]!; tx++) {
      if (act.tile[ty * act.tw + tx]) continue;
      for (let y = ty * TILE; y < Math.min(H, (ty + 1) * TILE); y++)
        for (let x = tx * TILE; x < Math.min(W, (tx + 1) * TILE); x++) {
          const i = y * W + x;
          limit[i] = 1;
          const vol = water[i]! * CELL_AREA;
          conc[i] = vol > 0 ? sediment[i]! / vol : 0;
        }
    }
  }
  scratch.set = act;
  scratch.version = act.version;
}

/** Copy the faces of the active and halo tiles to the "old" buffers (the rest never changes). */
function copyOld(world: World, scratch: FlowScratch, act: ActiveSet): void {
  const { width: W, height: H, qx, qy } = world;
  const { qxOld, qyOld } = scratch;
  if (act.all) {
    qxOld.set(qx);
    qyOld.set(qy);
    return;
  }
  const hs = act.haloSpans;
  for (let k = 0; k < hs.length; k += 3) {
    const ty = hs[k]!;
    const x0 = hs[k + 1]! * TILE;
    const x1 = Math.min(W, hs[k + 2]! * TILE);
    const y0 = ty * TILE;
    const y1 = Math.min(H, y0 + TILE);
    if (x0 === 0 && x1 === W) {
      qxOld.set(qx.subarray(y0 * W, y1 * W), y0 * W);
      qyOld.set(qy.subarray(y0 * W, y1 * W), y0 * W);
    } else
      for (let y = y0; y < y1; y++) {
        const a = y * W + x0;
        const b = y * W + x1;
        qxOld.set(qx.subarray(a, b), a);
        qyOld.set(qy.subarray(a, b), a);
      }
  }
}

/** Rescan which tiles hold water, decide which active tiles are awake, and build their runs. */
function wake(world: World, scratch: FlowScratch, act: ActiveSet): void {
  const { width: W, height: H, water, qx, qy, velX, velY } = world;
  const { wet, awake, wasAwake, runs } = scratch;
  const { tw, th, tile } = act;
  const hs = act.haloSpans;
  for (let k = 0; k < hs.length; k += 3) {
    const ty = hs[k]!;
    const y0 = ty * TILE;
    const y1 = Math.min(H, y0 + TILE);
    for (let tx = hs[k + 1]!; tx < hs[k + 2]!; tx++) {
      const x0 = tx * TILE;
      const x1 = Math.min(W, x0 + TILE);
      let bits = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * W;
        let any = false;
        for (let i = row + x0; i < row + x1; i++)
          if (water[i]! > 0) {
            any = true;
            break;
          }
        if (!any) continue;
        bits |= WET_ANY;
        if (y === y0) bits |= WET_N;
        if (y === y1 - 1) bits |= WET_S;
        if (water[row + x0]! > 0) bits |= WET_W;
        if (water[row + x1 - 1]! > 0) bits |= WET_E;
      }
      wet[ty * tw + tx] = bits;
    }
  }
  let n = 0;
  let awakeTiles = 0;
  const s = act.spans;
  for (let k = 0; k < s.length; k += 3) {
    const ty = s[k]!;
    let open = -1;
    for (let tx = s[k + 1]!; tx < s[k + 2]!; tx++) {
      const t = ty * tw + tx;
      const a =
        !scratch.sleep ||
        (wet[t]! & WET_ANY) !== 0 ||
        (tx > 0 && (wet[t - 1]! & WET_E) !== 0) ||
        (tx < tw - 1 && (wet[t + 1]! & WET_W) !== 0) ||
        (ty > 0 && (wet[t - tw]! & WET_S) !== 0) ||
        (ty < th - 1 && (wet[t + tw]! & WET_N) !== 0);
      awake[t] = a ? 1 : 0;
      if (a) {
        awakeTiles++;
        if (open < 0) open = tx;
      } else {
        if (open >= 0) {
          runs[n++] = ty;
          runs[n++] = open;
          runs[n++] = tx;
          open = -1;
        }
        if (wasAwake[t]) {
          // Falling asleep: the faces it touches are dry on both sides, so the full kernel would zero them.
          const x0 = tx * TILE;
          const x1 = Math.min(W, x0 + TILE);
          const y0 = ty * TILE;
          const y1 = Math.min(H, y0 + TILE);
          for (let y = y0; y < y1; y++) {
            const row = y * W;
            qx.fill(0, row + x0, row + x1);
            qy.fill(0, row + x0, row + x1);
            velX.fill(0, row + x0, row + x1);
            velY.fill(0, row + x0, row + x1);
            if (x0 > 0 && !tile[t - 1]) qx[row + x0 - 1] = 0;
          }
          if (y0 > 0 && !tile[t - tw]) qy.fill(0, (y0 - 1) * W + x0, (y0 - 1) * W + x1);
        }
      }
      wasAwake[t] = a ? 1 : 0;
    }
    if (open >= 0) {
      runs[n++] = ty;
      runs[n++] = open;
      runs[n++] = s[k + 2]!;
    }
  }
  scratch.nRuns = n / 3;
  scratch.awakeTiles = awakeTiles;
}

/**
 * Advance surface water by dt seconds on the active tiles (all tiles if
 * `active` is omitted). Allocation-free.
 */
export function flowStep(
  world: World,
  scratch: FlowScratch,
  p: FlowParams,
  dt: number,
  stats: FlowStats,
  walls?: Walls | null,
  active?: ActiveSet | null,
): void {
  const { width: W, height: H, bedrock, soil, water, sediment, qx, qy, flags, velX, velY } = world;
  const { qxOld, qyOld, limit, conc } = scratch;
  const act = active ?? scratch.defaultSet(world);
  if (scratch.set !== act || scratch.version !== act.version) initHalo(world, scratch, act);
  else copyOld(world, scratch, act);
  wake(world, scratch, act);
  const runs = scratch.runs;
  const nRuns = scratch.nRuns;
  const { tw, tile } = act;

  const g = GRAVITY;
  const n2 = p.manning * p.manning;
  const theta = p.theta;
  const side = (1 - theta) * 0.5;
  const minH = p.minFaceDepth;
  const maxV = p.maxVelocity;
  const invDx = 1 / CELL;

  // --- 1. Face discharges, and each cell's outflow limit -------------------
  // Two passes over the awake tiles (docs/ARCHITECTURE.md §3.2, steps 1–4):
  // (a) the faces, and right behind them the outflow limit and sediment
  // concentration of each cell (all four of its faces are known by then:
  // the left and upper ones were computed earlier in the same order);
  // (b) each cell scales the two faces it owns (right, down) by their donor's
  // limit, then applies continuity. The faces into a run from outside it
  // (frozen halo or a sleeping tile) are scaled in between. Every value is
  // computed as in a plain four-pass version, so the result is the same.
  const k = dt * CELL; // volume per unit of q
  for (let r = 0; r < nRuns; r++) {
    const ty = runs[3 * r]!;
    const tx0 = runs[3 * r + 1]!;
    const tx1 = runs[3 * r + 2]!;
    const cx0 = tx0 * TILE;
    const cx1 = Math.min(W, tx1 * TILE);
    const ry0 = ty * TILE;
    const ry1 = Math.min(H, ry0 + TILE);
    // Faces from the row above, where that tile is frozen (halo).
    if (ry0 > 0)
      for (let tx = tx0; tx < tx1; tx++) {
        if (tile[(ty - 1) * tw + tx]) continue;
        const row = (ry0 - 1) * W;
        for (let x = tx * TILE; x < Math.min(W, (tx + 1) * TILE); x++) {
          const i = row + x;
          const q0 = qyOld[i]!;
          qy[i] = haloFace(world, p, dt, i, i + W, q0, ry0 - 1 > 0 ? qyOld[i - W]! : q0, ry0 - 1 < H - 2 ? qyOld[i + W]! : q0);
        }
      }
    for (let y = ry0; y < ry1; y++) {
      const row = y * W;
      // The face from the left neighbour (halo, or a sleeping tile: then it is dry on both sides).
      if (cx0 > 0) {
        const i = row + cx0 - 1;
        const q0 = qxOld[i]!;
        qx[i] = haloFace(world, p, dt, i, i + 1, q0, cx0 - 1 > 0 ? qxOld[i - 1]! : q0, cx0 - 1 < W - 2 ? qxOld[i + 1]! : q0);
      }
      const hasDown = y < H - 1;
      // This cell's bed and depth, carried over from the previous cell's right neighbour.
      let zi = bedrock[row + cx0]! + soil[row + cx0]!;
      let hi = water[row + cx0]!;
      // The left face's outflow from this cell (carried as well).
      let qLeft = cx0 > 0 ? qx[row + cx0 - 1]! : 0;
      for (let x = cx0; x < cx1; x++) {
        const i = row + x;
        const ei = zi + hi;
        let zR = 0;
        let hR = 0;
        let qR = 0;

        // x-face (i → i+1)
        if (x < W - 1) {
          const j = i + 1;
          hR = water[j]!;
          zR = bedrock[j]! + soil[j]!;
          if (hi > 0 || hR > 0) {
            const ej = zR + hR;
            const hf = Math.max(ei, ej) - Math.max(zi, zR);
            if (hf > minH) {
              const q0 = qxOld[i]!;
              const qa = x > 0 ? qxOld[i - 1]! : q0;
              const qb = x < W - 2 ? qxOld[i + 1]! : q0;
              const qt = theta * q0 + side * (qa + qb);
              let q = qt - g * hf * dt * (ej - ei) * invDx;
              if (q0 !== 0) q /= 1 + (g * dt * n2 * Math.abs(q0)) / (hf * hf * Math.sqrt(Math.sqrt(hf)));
              const qmax = hf * maxV;
              if (q > qmax) q = qmax;
              else if (q < -qmax) q = -qmax;
              qR = q;
            }
          }
        }
        qx[i] = qR;

        // y-face (i → i+W)
        let qD = 0;
        if (hasDown) {
          const j = i + W;
          const hj = water[j]!;
          if (hi > 0 || hj > 0) {
            const zj = bedrock[j]! + soil[j]!;
            const ej = zj + hj;
            const hf = Math.max(ei, ej) - Math.max(zi, zj);
            if (hf > minH) {
              const q0 = qyOld[i]!;
              const qa = y > 0 ? qyOld[i - W]! : q0;
              const qb = y < H - 2 ? qyOld[i + W]! : q0;
              const qt = theta * q0 + side * (qa + qb);
              let q = qt - g * hf * dt * (ej - ei) * invDx;
              if (q0 !== 0) q /= 1 + (g * dt * n2 * Math.abs(q0)) / (hf * hf * Math.sqrt(Math.sqrt(hf)));
              const qmax = hf * maxV;
              if (q > qmax) q = qmax;
              else if (q < -qmax) q = -qmax;
              qD = q;
            }
          }
        }
        qy[i] = qD;

        // Outflow limit: no cell may lose more water than it holds.
        // (Faces are read back as stored, f32, as a separate pass would.)
        let out = 0;
        const fr = qx[i]!;
        if (fr > 0) out += fr;
        if (qLeft < 0) out -= qLeft;
        const fd = qy[i]!;
        if (fd > 0) out += fd;
        if (y > 0) {
          const qu = qy[i - W]!;
          if (qu < 0) out -= qu;
        }
        const vol = hi * CELL_AREA;
        const outVol = out * k;
        limit[i] = outVol > vol ? vol / outVol : 1;
        conc[i] = vol > 0 ? sediment[i]! / vol : 0;

        qLeft = fr;
        zi = zR;
        hi = hR;
      }
    }
  }

  if (walls && walls.count > 0) {
    applyWalls(world, scratch, p, dt, walls);
    // Their faces changed: the limits of the cells round them again.
    for (let n = 0; n < walls.count; n++) {
      const c = walls.cell[n]!;
      limitAt(world, scratch, act, c, k);
      if (c % W > 0) limitAt(world, scratch, act, c - 1, k);
      if (c % W < W - 1) limitAt(world, scratch, act, c + 1, k);
      if (c >= W) limitAt(world, scratch, act, c - W, k);
      if (c < W * (H - 1)) limitAt(world, scratch, act, c + W, k);
    }
  }

  // --- 2. Faces into each run from outside it, scaled by their donor's limit --
  for (let r = 0; r < nRuns; r++) {
    const ty = runs[3 * r]!;
    const tx0 = runs[3 * r + 1]!;
    const tx1 = runs[3 * r + 2]!;
    const cx0 = tx0 * TILE;
    const ry0 = ty * TILE;
    const ry1 = Math.min(H, ry0 + TILE);
    if (ry0 > 0)
      for (let tx = tx0; tx < tx1; tx++) {
        if (tile[(ty - 1) * tw + tx]) continue;
        const row = (ry0 - 1) * W;
        for (let x = tx * TILE; x < Math.min(W, (tx + 1) * TILE); x++) scale(qy, limit, row + x, W);
      }
    if (cx0 > 0) for (let y = ry0; y < ry1; y++) scale(qx, limit, y * W + cx0 - 1, 1);
  }

  // --- 3. Own faces scaled; continuity, sediment transport, velocity, outlets --
  let outflow = 0;
  let sedOut = 0;
  let maxDepth = 0;
  let maxSpeed = 0;
  let maxWave = 0;
  for (let r = 0; r < nRuns; r++) {
    const ty = runs[3 * r]!;
    const tx0 = runs[3 * r + 1]!;
    const tx1 = runs[3 * r + 2]!;
    const cx0 = tx0 * TILE;
    const cx1 = Math.min(W, tx1 * TILE);
    const ry0 = ty * TILE;
    const ry1 = Math.min(H, ry0 + TILE);
    for (let y = ry0; y < ry1; y++) {
      const row = y * W;
      let qL = cx0 > 0 ? qx[row + cx0 - 1]! : 0;
      for (let x = cx0; x < cx1; x++) {
        const i = row + x;
        let qR = qx[i]!;
        if (qR > 0) qx[i] = qR * limit[i]!;
        else if (qR < 0) qx[i] = qR * limit[i + 1]!;
        qR = qx[i]!;
        let qD = qy[i]!;
        if (qD > 0) qy[i] = qD * limit[i]!;
        else if (qD < 0) qy[i] = qD * limit[i + W]!;
        qD = qy[i]!;
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
          // sp + √(g·h) > maxWave without a square root per cell.
          const d = maxWave - sp;
          if (d < 0 || g * h > d * d) maxWave = sp + Math.sqrt(g * h);
        } else {
          velX[i] = 0;
          velY[i] = 0;
        }
        if (h > maxDepth) maxDepth = h;
        qL = qR;
      }
    }
  }
  stats.outflow = outflow;
  stats.sedimentOut = sedOut;
  stats.maxDepth = maxDepth;
  stats.maxSpeed = maxSpeed;
  stats.maxWave = maxWave;
  bookEdges(world, scratch, act, k, stats);
  stats.awakeTiles = scratch.awakeTiles;
}

/** Recompute the outflow limit of cell i (if its tile is awake) from its four faces. */
function limitAt(world: World, scratch: FlowScratch, act: ActiveSet, i: number, k: number): void {
  const { width: W, water, qx, qy } = world;
  const x = i % W;
  const y = (i / W) | 0;
  const t = ((y / TILE) | 0) * act.tw + ((x / TILE) | 0);
  if (!act.tile[t] || !scratch.awake[t]) return;
  let out = 0;
  const qr = qx[i]!;
  if (qr > 0) out += qr;
  if (x > 0) {
    const ql = qx[i - 1]!;
    if (ql < 0) out -= ql;
  }
  const qd = qy[i]!;
  if (qd > 0) out += qd;
  if (y > 0) {
    const qu = qy[i - W]!;
    if (qu < 0) out -= qu;
  }
  const vol = water[i]! * CELL_AREA;
  const outVol = out * k;
  scratch.limit[i] = outVol > vol ? vol / outVol : 1;
}

/** Scale face f's discharge by its donor's outflow limit (`step` = 1 for x faces, W for y faces). */
function scale(q: Float32Array, limit: Float32Array, f: number, step: number): void {
  const v = q[f]!;
  if (v > 0) q[f] = v * limit[f]!;
  else if (v < 0) q[f] = v * limit[f + step]!;
}

/** One face a → b (b = a+1 or a+W) next to the hot loop (halo faces): the same formula. */
function haloFace(world: World, p: FlowParams, dt: number, a: number, b: number, q0: number, qa: number, qb: number): number {
  const { bedrock, soil, water } = world;
  const za = bedrock[a]! + soil[a]!;
  const zb = bedrock[b]! + soil[b]!;
  const ha = water[a]!;
  const hb = water[b]!;
  const ea = za + ha;
  const eb = zb + hb;
  const hf = Math.max(ea, eb) - Math.max(za, zb);
  if (!(hf > p.minFaceDepth && (ha > 0 || hb > 0))) return 0;
  const theta = p.theta;
  const qt = theta * q0 + (1 - theta) * 0.5 * (qa + qb);
  let q = qt - GRAVITY * hf * dt * (eb - ea) * (1 / CELL);
  const n2 = p.manning * p.manning;
  if (q0 !== 0) q /= 1 + (GRAVITY * dt * n2 * Math.abs(q0)) / (hf * hf * Math.sqrt(Math.sqrt(hf)));
  const qmax = hf * p.maxVelocity;
  return q > qmax ? qmax : q < -qmax ? -qmax : q;
}

/** The exchange with frozen neighbours across the active edge, as phase 3 applied it (k = volume per unit q). */
function bookEdges(world: World, scratch: FlowScratch, act: ActiveSet, k: number, stats: FlowStats): void {
  let inW = 0;
  let outW = 0;
  let inS = 0;
  let outS = 0;
  if (!act.all) {
    const { width: W, height: H, qx, qy } = world;
    const { conc, runs, nRuns } = scratch;
    const { tw, th, tile } = act;
    /** `q` is the discharge from the frozen cell into the active one. */
    const edge = (q: number, frozen: number, inner: number): void => {
      if (q > 0) {
        inW += q * k;
        inS += q * k * conc[frozen]!;
      } else if (q < 0) {
        outW -= q * k;
        outS -= q * k * conc[inner]!;
      }
    };
    for (let r = 0; r < nRuns; r++) {
      const ty = runs[3 * r]!;
      const tx0 = runs[3 * r + 1]!;
      const tx1 = runs[3 * r + 2]!;
      const cx0 = tx0 * TILE;
      const cx1 = Math.min(W, tx1 * TILE);
      const ry0 = ty * TILE;
      const ry1 = Math.min(H, ry0 + TILE);
      for (let y = ry0; y < ry1; y++) {
        const row = y * W;
        if (cx0 > 0 && !tile[ty * tw + tx0 - 1]) edge(qx[row + cx0 - 1]!, row + cx0 - 1, row + cx0);
        if (cx1 < W && !tile[ty * tw + tx1]) edge(-qx[row + cx1 - 1]!, row + cx1, row + cx1 - 1);
      }
      for (let tx = tx0; tx < tx1; tx++) {
        const xa = tx * TILE;
        const xb = Math.min(W, xa + TILE);
        if (ty > 0 && !tile[(ty - 1) * tw + tx]) {
          const row = (ry0 - 1) * W;
          for (let x = xa; x < xb; x++) edge(qy[row + x]!, row + x, row + x + W);
        }
        if (ty < th - 1 && ry1 < H && !tile[(ty + 1) * tw + tx]) {
          const row = (ry1 - 1) * W;
          for (let x = xa; x < xb; x++) edge(-qy[row + x]!, row + x + W, row + x);
        }
      }
    }
  }
  stats.edgeIn = inW;
  stats.edgeOut = outW;
  stats.edgeSedIn = inS;
  stats.edgeSedOut = outS;
}

function wallTop(walls: Walls, i: number): number {
  let t = -Infinity;
  for (let k = 0; k < walls.count; k++) if (walls.cell[k] === i && walls.top[k]! > t) t = walls.top[k]!;
  return t;
}

/** Recompute the faces of wall cells with the wall crest as the face bed (same formula as the main loop). */
function applyWalls(world: World, scratch: FlowScratch, p: FlowParams, dt: number, walls: Walls): void {
  const { width: W, height: H, bedrock, soil, water, qx, qy } = world;
  const { qxOld, qyOld } = scratch;
  const g = GRAVITY;
  const n2 = p.manning * p.manning;
  const theta = p.theta;
  const side = (1 - theta) * 0.5;
  const invDx = 1 / CELL;
  const face = (a: number, b: number, q0: number, qa: number, qb: number): number => {
    const za = bedrock[a]! + soil[a]!;
    const zb = bedrock[b]! + soil[b]!;
    const ha = water[a]!;
    const hb = water[b]!;
    const ea = za + ha;
    const eb = zb + hb;
    const bed = Math.max(za, zb, wallTop(walls, a), wallTop(walls, b));
    const hf = Math.max(ea, eb) - bed;
    if (!(hf > p.minFaceDepth && (ha > 0 || hb > 0))) return 0;
    const qt = theta * q0 + side * (qa + qb);
    let q = qt - g * hf * dt * (eb - ea) * invDx;
    if (q0 !== 0) q /= 1 + (g * dt * n2 * Math.abs(q0)) / (hf * hf * Math.sqrt(Math.sqrt(hf)));
    const qmax = hf * p.maxVelocity;
    return q > qmax ? qmax : q < -qmax ? -qmax : q;
  };
  const xFace = (f: number): void => {
    const x = f % W;
    if (x >= W - 1) return;
    const q0 = qxOld[f]!;
    qx[f] = face(f, f + 1, q0, x > 0 ? qxOld[f - 1]! : q0, x < W - 2 ? qxOld[f + 1]! : q0);
  };
  const yFace = (f: number): void => {
    const y = (f / W) | 0;
    if (y >= H - 1) return;
    const q0 = qyOld[f]!;
    qy[f] = face(f, f + W, q0, y > 0 ? qyOld[f - W]! : q0, y < H - 2 ? qyOld[f + W]! : q0);
  };
  for (let k = 0; k < walls.count; k++) {
    const i = walls.cell[k]!;
    xFace(i);
    if (i % W > 0) xFace(i - 1);
    yFace(i);
    if (i >= W) yFace(i - W);
  }
}
