/**
 * Small helpers shared by the world generator: a typed-array binary heap for
 * priority-flood, interpolation and smoothing functions.
 */
import { hash2 } from '../../shared/rng';

/** Min-heap of (key, value) with float keys and int values, FIFO-stable for ties. */
export class MinHeap {
  private keys: Float64Array;
  private vals: Int32Array;
  private order: Float64Array;
  private counter = 0;
  size = 0;

  constructor(capacity = 1024) {
    this.keys = new Float64Array(capacity);
    this.vals = new Int32Array(capacity);
    this.order = new Float64Array(capacity);
  }

  clear(): void {
    this.size = 0;
    this.counter = 0;
  }

  private less(a: number, b: number): boolean {
    const ka = this.keys[a]!;
    const kb = this.keys[b]!;
    return ka < kb || (ka === kb && this.order[a]! < this.order[b]!);
  }

  push(key: number, val: number): void {
    if (this.size === this.keys.length) {
      const n = this.keys.length * 2;
      const k = new Float64Array(n);
      k.set(this.keys);
      const v = new Int32Array(n);
      v.set(this.vals);
      const o = new Float64Array(n);
      o.set(this.order);
      this.keys = k;
      this.vals = v;
      this.order = o;
    }
    let i = this.size++;
    this.keys[i] = key;
    this.vals[i] = val;
    this.order[i] = this.counter++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }

  /** Key of the top element. */
  topKey(): number {
    return this.keys[0]!;
  }

  /** Pops the minimum and returns its value. */
  pop(): number {
    const top = this.vals[0]!;
    const last = --this.size;
    if (last > 0) {
      this.keys[0] = this.keys[last]!;
      this.vals[0] = this.vals[last]!;
      this.order[0] = this.order[last]!;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= last) break;
        const r = l + 1;
        const c = r < last && this.less(r, l) ? r : l;
        if (!this.less(c, i)) break;
        this.swap(i, c);
        i = c;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const k = this.keys[a]!;
    this.keys[a] = this.keys[b]!;
    this.keys[b] = k;
    const v = this.vals[a]!;
    this.vals[a] = this.vals[b]!;
    this.vals[b] = v;
    const o = this.order[a]!;
    this.order[a] = this.order[b]!;
    this.order[b] = o;
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Polynomial smooth minimum with blend width k. */
export function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Smooth ramp: 0 for x < -k, x for x > k, quadratic in between. */
export function softRamp(x: number, k: number): number {
  if (x <= -k) return 0;
  if (x >= k) return x;
  const t = x + k;
  return (t * t) / (4 * k);
}

/** Derive an independent 32-bit sub-seed. */
export function subSeed(seed: number, k: number): number {
  return (hash2(k * 7919 + 13, k * 104729 + 7, seed) * 4294967296) | 0;
}

/** Bilinear sample of a grid (clamped to its edges). */
export function bilinear(grid: Float32Array | Float64Array, w: number, h: number, x: number, y: number): number {
  if (x < 0) x = 0;
  else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0;
  else if (y > h - 1) y = h - 1;
  const x0 = Math.min(Math.floor(x), w - 2 < 0 ? 0 : w - 2);
  const y0 = Math.min(Math.floor(y), h - 2 < 0 ? 0 : h - 2);
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * w + x0;
  const a = grid[i]!;
  const b = grid[i + 1]!;
  const c = grid[i + w]!;
  const d = grid[i + w + 1]!;
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** One Chaikin corner-cutting pass over parallel channels; endpoints are kept. */
export function chaikin(chs: number[][]): number[][] {
  const n = chs[0]!.length;
  if (n < 3) return chs.map((c) => c.slice());
  const out = chs.map(() => [] as number[]);
  for (let c = 0; c < chs.length; c++) out[c]!.push(chs[c]![0]!);
  for (let k = 0; k < n - 1; k++) {
    for (let c = 0; c < chs.length; c++) {
      const a = chs[c]![k]!;
      const b = chs[c]![k + 1]!;
      if (k > 0) out[c]!.push(0.75 * a + 0.25 * b);
      if (k < n - 2) out[c]!.push(0.25 * a + 0.75 * b);
    }
  }
  for (let c = 0; c < chs.length; c++) out[c]!.push(chs[c]![n - 1]!);
  return out;
}

/** Resample a polyline (channel 0 = x, 1 = y) to roughly uniform spacing. */
export function resample(chs: number[][], spacing: number): number[][] {
  const xs = chs[0]!;
  const ys = chs[1]!;
  const n = xs.length;
  const cum = [0];
  for (let k = 1; k < n; k++) cum.push(cum[k - 1]! + Math.hypot(xs[k]! - xs[k - 1]!, ys[k]! - ys[k - 1]!));
  const total = cum[n - 1]!;
  const m = Math.max(2, Math.round(total / spacing) + 1);
  const out = chs.map(() => [] as number[]);
  let seg = 0;
  for (let j = 0; j < m; j++) {
    const s = (total * j) / (m - 1);
    while (seg < n - 2 && cum[seg + 1]! < s) seg++;
    const len = cum[seg + 1]! - cum[seg]!;
    const t = len > 0 ? clamp((s - cum[seg]!) / len, 0, 1) : 0;
    for (let c = 0; c < chs.length; c++) out[c]!.push(lerp(chs[c]![seg]!, chs[c]![seg + 1]!, t));
  }
  return out;
}
