/**
 * Base terrain: a pure function of (seed, global cell coordinates), before
 * rivers are carved in. It mixes several landscape "regions" through
 * low-frequency masks: ridged mountains, rolling hills, flat plains and closed
 * basins. Per seed, the noise domain is shifted so that the default map shows
 * a chosen landscape style (a mountain range on one side, a big plain, hill
 * country...). The shift is a function of the seed only, so the terrain stays
 * a pure function of global coordinates and the world can be extended.
 */
import { CELL } from '../constants';
import { fbm, perlin, ridged } from '../../shared/noise';
import { Rng } from '../../shared/rng';
import { smoothstep, subSeed } from './util';

export type LandscapeStyle = 'mountains' | 'plain' | 'hills' | 'mixed' | 'highlands';

/** Size (cells) of the reference area the style targeting looks at. */
const STYLE_AREA = 256;

export class TerrainGen {
  readonly seed: number;
  readonly style: LandscapeStyle;
  /** Prevailing wind direction (unit vector, the direction the wind blows to). */
  readonly windX: number;
  readonly windY: number;
  /** Overall climate wetness factor (~0.7 dry .. 1.3 wet). */
  readonly wetness: number;
  /** Noise-domain offset in metres. */
  private offX = 0;
  private offY = 0;
  /** Seed-dependent bias on the mountain mask. */
  private mBias = 0;
  private readonly s: Int32Array;

  constructor(seed: number) {
    this.seed = seed;
    const s = new Int32Array(16);
    for (let k = 0; k < s.length; k++) s[k] = subSeed(seed, k + 1);
    this.s = s;
    const rng = new Rng(seed ^ 0x5eed1234);
    const a = rng.next() * Math.PI * 2;
    this.windX = Math.cos(a);
    this.windY = Math.sin(a);
    this.wetness = 0.75 + 0.5 * rng.next();

    // Pick a landscape style and targets for the fraction of mountains/hills
    // within the reference map area.
    const r = rng.next();
    let tm: number;
    let th: number;
    if (r < 0.3) {
      this.style = 'mountains';
      tm = rng.range(0.25, 0.45);
      th = rng.range(0.2, 0.6);
    } else if (r < 0.5) {
      this.style = 'plain';
      tm = 0;
      th = rng.range(0, 0.2);
    } else if (r < 0.72) {
      this.style = 'hills';
      tm = rng.range(0, 0.08);
      th = rng.range(0.7, 1);
    } else if (r < 0.9) {
      this.style = 'mixed';
      tm = rng.range(0.1, 0.25);
      th = rng.range(0.3, 0.6);
    } else {
      this.style = 'highlands';
      tm = rng.range(0.5, 0.8);
      th = rng.range(0.4, 0.8);
    }
    this.mBias = rng.range(-0.05, 0.05);

    let best = Infinity;
    let bx = 0;
    let by = 0;
    const N = 7;
    for (let c = 0; c < 24; c++) {
      this.offX = rng.range(-2e5, 2e5);
      this.offY = rng.range(-2e5, 2e5);
      let fm = 0;
      let fh = 0;
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++) {
          const gx = ((i + 0.5) / N) * STYLE_AREA;
          const gy = ((j + 0.5) / N) * STYLE_AREA;
          const m = this.masks(gx, gy);
          fm += m.m;
          fh += m.h;
        }
      fm /= N * N;
      fh /= N * N;
      const score = Math.abs(fm - tm) + 0.5 * Math.abs(fh - th);
      if (score < best) {
        best = score;
        bx = this.offX;
        by = this.offY;
      }
    }
    this.offX = bx;
    this.offY = by;
  }

  private readonly maskOut = { m: 0, h: 0, wx: 0, wy: 0 };

  /** Mountain and hill masks (0..1) plus the domain warp, at a global cell. */
  masks(gx: number, gy: number): { m: number; h: number; wx: number; wy: number } {
    const s = this.s;
    const X = gx * CELL + this.offX;
    const Y = gy * CELL + this.offY;
    const wx = fbm(X / 3000, Y / 3000, s[0]!, 2) * 900;
    const wy = fbm(X / 3000 + 17.3, Y / 3000 - 9.1, s[0]!, 2) * 900;
    const mN = fbm((X + wx) / 3400, (Y + wy) / 3400, s[1]!, 3) + this.mBias;
    const hN = fbm((X + wx) / 2200, (Y + wy) / 2200, s[2]!, 2);
    const o = this.maskOut;
    o.m = smoothstep(0.02, 0.3, mN);
    o.h = smoothstep(-0.15, 0.18, hN);
    o.wx = wx;
    o.wy = wy;
    return o;
  }

  /**
   * Base terrain height (m) at global cell coordinates. `detail` adds the
   * high-frequency octaves; the coarse macro grid leaves them out.
   */
  height(gx: number, gy: number, detail: boolean): number {
    const s = this.s;
    const { m, h: hills, wx, wy } = this.masks(gx, gy);
    const X = gx * CELL + this.offX;
    const Y = gy * CELL + this.offY;

    // Regional elevation and a very gentle continental tilt.
    let z = 160 + 70 * fbm(X / 14000, Y / 14000, s[3]!, 2) + 200 * perlin(X / 70000, Y / 70000, s[4]!);

    // Mountains: ridged multifractal, sharper and higher in the core of the mask.
    if (m > 1e-3) {
      const r = ridged((X + 0.4 * wx) / 1500, (Y + 0.4 * wy) / 1500, s[5]!, detail ? 6 : 4);
      z += m * (15 + 240 * r * r * (0.55 + 0.45 * m));
    }

    // Rolling hills.
    const hw = hills * (1 - 0.7 * m);
    if (hw > 1e-3) {
      const f = fbm(X / 650, Y / 650, s[6]!, detail ? 5 : 3);
      z += hw * 55 * (f + 0.3);
    }

    // Plains: low undulation everywhere.
    z += 7 * fbm(X / 800, Y / 800, s[7]!, 3);
    if (detail) z += 1.2 * fbm(X / 200, Y / 200, s[10]!, 2);

    // Closed basins (lakes, bogs) outside the mountains.
    const b = smoothstep(0.1, 0.32, fbm(X / 1000, Y / 1000, s[8]!, 3)) * (1 - m);
    if (b > 0) z -= 11 * b;

    if (detail) z += fbm(X / 90, Y / 90, s[9]!, 3) * (0.6 + 1.5 * hills + 5 * m);
    return z;
  }
}
