/**
 * Macro river network (ARCHITECTURE §2.2). The base terrain is sampled on a
 * coarse grid (1/F resolution) over an area much larger than the active map.
 * Priority-flood depression filling + D8 routing + flow accumulation of a
 * rainfall proxy give river paths and discharges. Paths are traced as a tree
 * (trunks first, tributaries ending on their parent), smoothed, given gentle
 * meanders and a graded (monotonically non-increasing) bed profile.
 *
 * The coarse grid is aligned to global coordinates and the domain is snapped
 * to a global block grid, so neighbouring windows see the same network apart
 * from the influence of the domain border on far-away drainage.
 */
import { CELL } from '../constants';
import { fbm, perlin } from '../../shared/noise';
import { hash2 } from '../../shared/rng';
import type { TerrainGen } from './terrain';
import { MinHeap, bilinear, chaikin, clamp, resample, smoothstep, subSeed } from './util';

/** Coarse cell size in fine cells. */
export const MACRO_F = 8;
/** Margin (fine cells) of the macro domain around the map. */
export const MACRO_MARGIN = 768;
/** Domain snapping (coarse cells). */
const SNAP = 16;
/** Rain-weighted coarse-cell accumulation where a river starts. */
const RIVER_THRESHOLD = 160;
/** Discharge (m³/s) per unit of accumulation. */
const Q_PER_ACC = 0.0065;
/** 0 = rivers cut through every sill, 1 = beds follow the filled surface. */
const CUT_FILL_BLEND = 0;
/** Filled-DEM epsilon per unit distance (m per coarse cell). */
const FILL_EPS = 0.02;

const D8X = [1, 1, 0, -1, -1, -1, 0, 1];
const D8Y = [0, 1, 1, 1, 0, -1, -1, -1];
const D8L = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2];

export interface MacroGrid {
  /** Global coarse index of the domain's first column/row. */
  ci0: number;
  cj0: number;
  cw: number;
  ch: number;
  height: Float32Array;
  filled: Float32Array;
  rain: Float32Array;
  acc: Float32Array;
  receiver: Int32Array;
  jitterSeed: number;
}

export interface RiverPath {
  /** Vertices in global fine-cell coordinates, downstream order, ~2 cells apart. */
  x: number[];
  y: number[];
  /** Discharge (m³/s). */
  q: number[];
  /** Bed elevation (m), non-increasing downstream. */
  bed: number[];
  /** Channel width (cells). */
  width: number[];
  /** Bankfull depth (m). */
  depth: number[];
  /** Floodplain half-width beyond the banks (cells). */
  plain: number[];
  /** Index of the path this one flows into, -1 for a trunk. */
  parent: number;
}

export interface MacroResult {
  grid: MacroGrid;
  paths: RiverPath[];
  /** Multiplier applied to macro discharges (see buildMacro). */
  riverScale: number;
}

/** Discharge (m³/s) the biggest river in a fresh window is scaled up to, at least. */
const MAIN_RIVER_Q = 28;
const MAX_RIVER_SCALE = 8;

/** Fine global coordinate of a coarse cell centre. */
export function coarseCentre(ci: number): number {
  return ci * MACRO_F + (MACRO_F - 1) / 2;
}

/** Fraction of a coarse cell by which node positions are jittered. */
const JITTER = 0.7;

/**
 * Jittered node position of a coarse cell (global fine coordinates). Jitter
 * breaks up the straight 8-direction runs that D8 routing produces.
 */
export function coarseNode(ci: number, cj: number, seed: number, out: { x: number; y: number }): void {
  out.x = coarseCentre(ci) + (hash2(ci, cj, seed) - 0.5) * JITTER * MACRO_F;
  out.y = coarseCentre(cj) + (hash2(ci, cj, seed + 1) - 0.5) * JITTER * MACRO_F;
}

/** Sample a coarse field at global fine coordinates. */
export function sampleMacro(g: MacroGrid, field: Float32Array, gx: number, gy: number): number {
  const cx = (gx - (MACRO_F - 1) / 2) / MACRO_F - g.ci0;
  const cy = (gy - (MACRO_F - 1) / 2) / MACRO_F - g.cj0;
  return bilinear(field, g.cw, g.ch, cx, cy);
}

/** Softly limit very large discharges to the range the game is tuned for. */
function compressQ(q: number): number {
  const knee = 35;
  return q <= knee ? q : knee + 25 * Math.tanh((q - knee) / 25);
}

/** Normalised river size 0 (small creek) .. 1 (big river) from discharge. */
export function riverSize(q: number): number {
  return clamp(Math.log(q / 1.0) / Math.log(60), 0, 1);
}

/**
 * Build the macro network. Discharges are multiplied by `riverScale`; when it
 * is not given, it is chosen so that the biggest river within the window
 * carries at least MAIN_RIVER_Q (water is the protagonist: every map gets a
 * real river). Pass the returned scale back in when regenerating or
 * extending the same world.
 */
export function buildMacro(
  gen: TerrainGen,
  originX: number,
  originY: number,
  width: number,
  height: number,
  riverScale?: number,
): MacroResult {
  const F = MACRO_F;
  const ci0 = Math.floor(Math.floor((originX - MACRO_MARGIN) / F) / SNAP) * SNAP;
  const cj0 = Math.floor(Math.floor((originY - MACRO_MARGIN) / F) / SNAP) * SNAP;
  const ci1 = Math.ceil(Math.ceil((originX + width + MACRO_MARGIN) / F) / SNAP) * SNAP;
  const cj1 = Math.ceil(Math.ceil((originY + height + MACRO_MARGIN) / F) / SNAP) * SNAP;
  const cw = ci1 - ci0;
  const ch = cj1 - cj0;
  const n = cw * ch;

  const H = new Float32Array(n);
  const jSeed = subSeed(gen.seed, 88);
  const node = { x: 0, y: 0 };
  for (let j = 0; j < ch; j++)
    for (let i = 0; i < cw; i++) {
      coarseNode(ci0 + i, cj0 + j, jSeed, node);
      H[j * cw + i] = gen.height(node.x, node.y, false);
    }

  const rain = computeRain(gen, H, cw, ch, ci0, cj0);

  // --- Priority flood (8-connected) from the domain border -----------------
  const filled = new Float32Array(n);
  const done = new Uint8Array(n);
  const order = new Int32Array(n);
  const heap = new MinHeap(4 * (cw + ch));
  for (let j = 0; j < ch; j++)
    for (let i = 0; i < cw; i++) {
      if (i === 0 || j === 0 || i === cw - 1 || j === ch - 1) {
        const c = j * cw + i;
        filled[c] = H[c]!;
        done[c] = 1;
        heap.push(H[c]!, c);
      }
    }
  let no = 0;
  const epsSeed = subSeed(gen.seed, 77);
  while (heap.size > 0) {
    const c = heap.pop();
    order[no++] = c;
    const cx = c % cw;
    const cy = (c - cx) / cw;
    const fc = filled[c]!;
    for (let d = 0; d < 8; d++) {
      const nx = cx + D8X[d]!;
      const ny = cy + D8Y[d]!;
      if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
      const nb = ny * cw + nx;
      if (done[nb]) continue;
      done[nb] = 1;
      // Randomised epsilon: flats drain along irregular, natural-looking paths
      // instead of straight D8 lines.
      const jit = 0.15 + 1.7 * hash2(ci0 + nx, cj0 + ny, epsSeed);
      const f = Math.max(H[nb]!, fc + FILL_EPS * jit * D8L[d]!);
      filled[nb] = f;
      heap.push(f, nb);
    }
  }

  // --- D8 receivers (steepest descent on the filled surface) ---------------
  const receiver = new Int32Array(n).fill(-1);
  for (let cy = 1; cy < ch - 1; cy++)
    for (let cx = 1; cx < cw - 1; cx++) {
      const c = cy * cw + cx;
      const fc = filled[c]!;
      let best = 0;
      let r = -1;
      for (let d = 0; d < 8; d++) {
        const nb = (cy + D8Y[d]!) * cw + cx + D8X[d]!;
        const s = (fc - filled[nb]!) / D8L[d]!;
        if (s > best) {
          best = s;
          r = nb;
        }
      }
      receiver[c] = r;
    }

  // --- Flow accumulation (reverse flood order is topological) --------------
  const acc = new Float32Array(n);
  for (let c = 0; c < n; c++) acc[c] = rain[c]!;
  for (let k = n - 1; k >= 0; k--) {
    const c = order[k]!;
    const r = receiver[c]!;
    if (r >= 0) acc[r] = acc[r]! + acc[c]!;
  }

  const grid: MacroGrid = { ci0, cj0, cw, ch, height: H, filled, rain, acc, receiver, jitterSeed: jSeed };
  if (riverScale === undefined) {
    let maxAcc = 1;
    for (let cy = 0; cy < ch; cy++)
      for (let cx = 0; cx < cw; cx++) {
        const gx = coarseCentre(ci0 + cx);
        const gy = coarseCentre(cj0 + cy);
        if (gx < originX || gy < originY || gx >= originX + width || gy >= originY + height) continue;
        maxAcc = Math.max(maxAcc, acc[cy * cw + cx]!);
      }
    riverScale = clamp(MAIN_RIVER_Q / (maxAcc * Q_PER_ACC), 1, MAX_RIVER_SCALE);
  }
  const paths = tracePaths(gen, grid, originX, originY, width, height, riverScale);
  return { grid, paths, riverScale };
}

function computeRain(gen: TerrainGen, H: Float32Array, cw: number, ch: number, ci0: number, cj0: number): Float32Array {
  const n = cw * ch;
  const rain = new Float32Array(n);
  const sorted = Float32Array.from(H).sort();
  const median = sorted[n >> 1]!;
  const wx = gen.windX;
  const wy = gen.windY;
  const sN = subSeed(gen.seed, 101);
  const span = MACRO_F * CELL;
  for (let j = 0; j < ch; j++)
    for (let i = 0; i < cw; i++) {
      const c = j * cw + i;
      const h = H[c]!;
      // Windward slope: terrain rising in the wind direction.
      const up = bilinear(H, cw, ch, i + 1.5 * wx, j + 1.5 * wy) - bilinear(H, cw, ch, i - 1.5 * wx, j - 1.5 * wy);
      const slope = up / (3 * span);
      const oro = 1 + 0.9 * clamp(slope * 8, -0.4, 1.5);
      const elev = 1 + 0.5 * clamp((h - median) / 200, -0.5, 1.2);
      // Rain shadow behind higher terrain upwind.
      let shadow = 0;
      for (let k = 4; k <= 36; k += 4) {
        const hu = bilinear(H, cw, ch, i - k * wx, j - k * wy);
        const e = hu - h - 15 - k * 0.5;
        if (e > shadow) shadow = e;
      }
      const sh = 1 / (1 + shadow / 80);
      const X = (ci0 + i) * span;
      const Y = (cj0 + j) * span;
      const nz = 1 + 0.6 * fbm(X / 5000, Y / 5000, sN, 2);
      rain[c] = clamp(gen.wetness * oro * elev * sh * nz, 0.15, 3);
    }
  return rain;
}

/** Pool-adjacent-violators: weighted L2 fit of a non-increasing sequence. */
function isotonicDecreasing(v: number[], w: number[]): number[] {
  const n = v.length;
  const val: number[] = [];
  const wt: number[] = [];
  const cnt: number[] = [];
  for (let k = 0; k < n; k++) {
    val.push(v[k]!);
    wt.push(w[k]!);
    cnt.push(1);
    while (val.length > 1 && val[val.length - 2]! < val[val.length - 1]!) {
      const b = val.length - 1;
      const nw = wt[b - 1]! + wt[b]!;
      val[b - 1] = (val[b - 1]! * wt[b - 1]! + val[b]! * wt[b]!) / nw;
      wt[b - 1] = nw;
      cnt[b - 1] = cnt[b - 1]! + cnt[b]!;
      val.pop();
      wt.pop();
      cnt.pop();
    }
  }
  const out: number[] = [];
  for (let b = 0; b < val.length; b++) for (let k = 0; k < cnt[b]!; k++) out.push(val[b]!);
  return out;
}

function nearestOnPath(p: RiverPath, x: number, y: number): { k: number; t: number; d2: number } {
  let best = { k: 0, t: 0, d2: Infinity };
  for (let k = 0; k < p.x.length - 1; k++) {
    const ax = p.x[k]!;
    const ay = p.y[k]!;
    const dx = p.x[k + 1]! - ax;
    const dy = p.y[k + 1]! - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? clamp(((x - ax) * dx + (y - ay) * dy) / l2, 0, 1) : 0;
    const ex = ax + t * dx - x;
    const ey = ay + t * dy - y;
    const d2 = ex * ex + ey * ey;
    if (d2 < best.d2) best = { k, t, d2 };
  }
  return best;
}

function tracePaths(
  gen: TerrainGen,
  g: MacroGrid,
  ox: number,
  oy: number,
  mw: number,
  mh: number,
  qScale: number,
): RiverPath[] {
  const { cw, ch, acc, receiver, filled } = g;
  const n = cw * ch;
  const isRiver = new Uint8Array(n);
  // Maps whose rivers had to be scaled up (small catchments) also get a
  // lower threshold, so that small maps still have creeks.
  const threshold = RIVER_THRESHOLD / Math.pow(Math.max(1, qScale), 0.75);
  for (let c = 0; c < n; c++) if (acc[c]! >= threshold) isRiver[c] = 1;

  // Donor lists (CSR) for river cells.
  const dcount = new Int32Array(n + 1);
  for (let c = 0; c < n; c++) if (isRiver[c] && receiver[c]! >= 0) dcount[receiver[c]! + 1]!++;
  for (let c = 0; c < n; c++) dcount[c + 1] = dcount[c + 1]! + dcount[c]!;
  const donors = new Int32Array(dcount[n]!);
  const fillp = dcount.slice(0, n);
  for (let c = 0; c < n; c++) if (isRiver[c] && receiver[c]! >= 0) donors[fillp[receiver[c]!]!++] = c;

  // Only keep subtrees that come near the map: mark river cells whose
  // downstream course passes within reach, so far-away basins are skipped.
  const reach = 160;
  const near = (c: number): boolean => {
    const gx = coarseCentre(g.ci0 + (c % cw));
    const gy = coarseCentre(g.cj0 + Math.floor(c / cw));
    return gx > ox - reach && gx < ox + mw + reach && gy > oy - reach && gy < oy + mh + reach;
  };
  // A trunk is relevant if any of its cells (or tributaries) is near the map;
  // compute relevance bottom-up via the upstream tree.
  const relevant = new Uint8Array(n);
  for (let c = 0; c < n; c++) {
    if (!isRiver[c] || !near(c)) continue;
    let r = c;
    while (r >= 0 && !relevant[r]) {
      relevant[r] = 1;
      r = receiver[r]!;
    }
  }

  interface Raw {
    cells: number[];
    parent: number;
    junction: number;
  }
  const raws: Raw[] = [];
  const outlets: number[] = [];
  for (let c = 0; c < n; c++) if (isRiver[c] && relevant[c] && receiver[c]! < 0) outlets.push(c);
  outlets.sort((a, b) => acc[b]! - acc[a]! || a - b);
  for (const o of outlets) {
    const stack: { start: number; parent: number; junction: number }[] = [{ start: o, parent: -1, junction: -1 }];
    while (stack.length > 0) {
      const item = stack.pop()!;
      const idx = raws.length;
      const cells = [item.start];
      let c = item.start;
      for (;;) {
        let main = -1;
        const branches: number[] = [];
        for (let k = dcount[c]!; k < dcount[c + 1]!; k++) {
          const d = donors[k]!;
          if (!relevant[d]) continue;
          if (main < 0 || acc[d]! > acc[main]!) {
            if (main >= 0) branches.push(main);
            main = d;
          } else branches.push(d);
        }
        for (const b of branches) stack.push({ start: b, parent: idx, junction: c });
        if (main < 0) break;
        c = main;
        cells.push(c);
      }
      cells.reverse(); // downstream order
      if (item.junction >= 0) cells.push(item.junction);
      raws.push({ cells, parent: item.parent, junction: item.junction });
    }
  }

  const sMeander = subSeed(gen.seed, 202);
  const paths: RiverPath[] = [];
  for (const r of raws) {
    // Coarse vertices in fine global coordinates, plus accumulation.
    let chs: number[][] = [[], [], [], []];
    const node = { x: 0, y: 0 };
    for (const c of r.cells) {
      coarseNode(g.ci0 + (c % cw), g.cj0 + Math.floor(c / cw), g.jitterSeed, node);
      chs[0]!.push(node.x);
      chs[1]!.push(node.y);
      chs[2]!.push(acc[c]!);
      chs[3]!.push(filled[c]!);
    }
    const parent = r.parent >= 0 ? paths[r.parent]! : null;
    if (parent) {
      // Attach to the parent's final (smoothed, meandered) course.
      const e = chs[0]!.length - 1;
      const nb = nearestOnPath(parent, chs[0]![e]!, chs[1]![e]!);
      chs[0]![e] = parent.x[nb.k]! + nb.t * (parent.x[nb.k + 1]! - parent.x[nb.k]!);
      chs[1]![e] = parent.y[nb.k]! + nb.t * (parent.y[nb.k + 1]! - parent.y[nb.k]!);
      // The junction cell itself carries the parent's accumulation; use the
      // tributary's own for its last vertex.
      chs[2]![e] = chs[2]![e - 1]!;
    }
    for (let it = 0; it < 3; it++) chs = chaikin(chs);
    chs = resample(chs, 2);
    const m = chs[0]!.length;
    const xs = chs[0]!;
    const ys = chs[1]!;
    const qs = chs[2]!.map((a) => compressQ(a * Q_PER_ACC * qScale));
    const fs = chs[3]!;

    // Meanders: perpendicular offset from a position-based noise, tapered at
    // both ends and reduced in steep terrain.
    const cum = [0];
    for (let k = 1; k < m; k++) cum.push(cum[k - 1]! + Math.hypot(xs[k]! - xs[k - 1]!, ys[k]! - ys[k - 1]!));
    const total = cum[m - 1]!;
    const ox2: number[] = [];
    const oy2: number[] = [];
    for (let k = 0; k < m; k++) {
      const a = Math.max(0, k - 1);
      const b = Math.min(m - 1, k + 1);
      let tx = xs[b]! - xs[a]!;
      let ty = ys[b]! - ys[a]!;
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl;
      ty /= tl;
      const sz = riverSize(qs[k]!);
      const sl = macroSlope(g, xs[k]!, ys[k]!);
      const flat = 1 - smoothstep(0.03, 0.15, sl);
      const taper = smoothstep(0, 50, Math.min(cum[k]!, total - cum[k]!));
      const amp = (3 + 12 * sz) * (0.3 + 0.7 * flat) * taper;
      const nz = perlin(xs[k]! / (60 + 40 * sz), ys[k]! / (60 + 40 * sz), sMeander) * 2.4;
      ox2.push(xs[k]! - ty * amp * nz);
      oy2.push(ys[k]! + tx * amp * nz);
    }
    let chs2 = resample([ox2, oy2, qs, fs], 2);
    chs2 = chaikin(chs2);
    chs2 = resample(chs2, 2);
    const px = chs2[0]!;
    const py = chs2[1]!;
    const pq = chs2[2]!;
    // Sources: the channel starts small and grows over the first ~60 cells.
    for (let k = 0, d = 0; k < pq.length && d < 60; k++) {
      if (k > 0) d += Math.hypot(chs2[0]![k]! - chs2[0]![k - 1]!, chs2[1]![k]! - chs2[1]![k - 1]!);
      pq[k] = pq[k]! * (0.25 + 0.75 * smoothstep(0, 60, d));
    }
    const pf = chs2[3]!;
    const mm = px.length;

    const width: number[] = [];
    const depth: number[] = [];
    const plain: number[] = [];
    const raw: number[] = [];
    const wts: number[] = [];
    for (let k = 0; k < mm; k++) {
      const sz = riverSize(pq[k]!);
      const sl = macroSlope(g, px[k]!, py[k]!);
      const flat = 1 - smoothstep(0.02, 0.12, sl);
      width.push(3 + 5 * sz);
      depth.push(1 + 2.5 * sz);
      plain.push((1 + 16 * sz * Math.sqrt(sz)) * flat + 1);
      raw.push(pf[k]! - depth[k]!);
      wts.push(1);
    }
    // Near the map, follow the actual (fine) terrain where it lies below the
    // filled macro surface, e.g. where the coarse grid filled a basin. The
    // isotonic fit below then balances cutting through sills and raising the
    // bed over hollows (which become lakes on the river).
    const fine: number[] = new Array<number>(mm).fill(NaN);
    const margin = 48;
    for (let k = 0; k < mm; k++) {
      const x = px[k]!;
      const y = py[k]!;
      if (x > ox - margin && y > oy - margin && x < ox + mw + margin && y < oy + mh + margin) fine[k] = gen.height(x, y, true);
    }
    for (let k = 0; k < mm; k++) {
      if (Number.isNaN(fine[k]!)) continue;
      let sum = 0;
      let cnt = 0;
      for (let j = Math.max(0, k - 3); j <= Math.min(mm - 1, k + 3); j++)
        if (!Number.isNaN(fine[j]!)) {
          sum += fine[j]!;
          cnt++;
        }
      raw[k] = Math.min(raw[k]!, sum / cnt - depth[k]!);
    }
    // Graded bed: mostly a "cut" profile (running minimum downstream: the
    // river incises through sills), blended with an isotonic fit (which
    // raises the bed over hollows, leaving small lakes on the river).
    let jb = -Infinity;
    if (parent) {
      const nb = nearestOnPath(parent, px[mm - 1]!, py[mm - 1]!);
      jb = parent.bed[nb.k]! + nb.t * (parent.bed[nb.k + 1]! - parent.bed[nb.k]!);
      raw[mm - 1] = jb;
      wts[mm - 1] = 1e6;
    }
    const fit = isotonicDecreasing(raw, wts);
    const bed: number[] = [];
    let cut = Infinity;
    for (let k = 0; k < mm; k++) {
      cut = Math.min(cut, raw[k]!);
      bed.push(cut + CUT_FILL_BLEND * (Math.max(fit[k]!, cut) - cut));
    }
    // Grade flat runs: spread the drop at the end of a plateau evenly over it.
    for (let k = 0; k < mm - 1; ) {
      let j = k;
      while (j + 1 < mm && bed[j + 1]! >= bed[k]! - 1e-4) j++;
      if (j + 1 < mm && j > k) {
        const a = bed[k]!;
        const b = bed[j + 1]!;
        for (let i = k + 1; i <= j; i++) bed[i] = a + ((b - a) * (i - k)) / (j + 1 - k);
      }
      k = j + 1;
    }
    for (let k = 0; k < mm; k++) bed[k] = Math.max(bed[k]!, jb);
    if (parent) bed[mm - 1] = jb;
    // Minimal downstream slope so that there are no perfectly flat reaches.
    for (let k = mm - 2; k >= 0; k--) bed[k] = Math.max(bed[k]!, bed[k + 1]! + 5e-4);

    paths.push({ x: px, y: py, q: pq, bed, width, depth, plain, parent: r.parent });
  }
  return paths;
}

/** Slope magnitude (rise/run) of the coarse unfilled height at a fine global point. */
export function macroSlope(g: MacroGrid, gx: number, gy: number): number {
  const d = MACRO_F;
  const hx = sampleMacro(g, g.height, gx + d, gy) - sampleMacro(g, g.height, gx - d, gy);
  const hy = sampleMacro(g, g.height, gx, gy + d) - sampleMacro(g, g.height, gx, gy - d);
  return Math.hypot(hx, hy) / (2 * d * CELL);
}
