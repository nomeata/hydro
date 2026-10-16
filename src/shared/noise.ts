import { hash2 } from './rng';

/**
 * Coordinate-based gradient noise. Pure functions of (seed, x, y), so terrain
 * can be generated for any region of the (conceptually infinite) world.
 */

function grad(ix: number, iy: number, seed: number, dx: number, dy: number): number {
  const a = hash2(ix, iy, seed) * Math.PI * 2;
  return Math.cos(a) * dx + Math.sin(a) * dy;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Perlin-style gradient noise, roughly in [-0.7, 0.7]. */
export function perlin(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const u = fade(fx);
  const v = fade(fy);
  const n00 = grad(x0, y0, seed, fx, fy);
  const n10 = grad(x0 + 1, y0, seed, fx - 1, fy);
  const n01 = grad(x0, y0 + 1, seed, fx, fy - 1);
  const n11 = grad(x0 + 1, y0 + 1, seed, fx - 1, fy - 1);
  const nx0 = n00 + (n10 - n00) * u;
  const nx1 = n01 + (n11 - n01) * u;
  return nx0 + (nx1 - nx0) * v;
}

/** Fractal Brownian motion, normalised to roughly [-1, 1]. */
export function fbm(x: number, y: number, seed: number, octaves = 5, lacunarity = 2, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * perlin(x * f, y * f, seed + o * 1013);
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return (sum / norm) * 1.4;
}

/** Ridged multifractal noise in [0, 1] — sharp mountain ridges. */
export function ridged(x: number, y: number, seed: number, octaves = 5): number {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  let weight = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    let n = 1 - Math.abs(perlin(x * f, y * f, seed + o * 7919) * 1.4);
    n *= n;
    n *= weight;
    weight = Math.min(1, Math.max(0, n * 2));
    sum += n * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.1;
  }
  return sum / norm;
}

/** Domain-warped fbm for more organic shapes. */
export function warpedFbm(x: number, y: number, seed: number, warp = 0.6, octaves = 5): number {
  const wx = fbm(x + 5.2, y + 1.3, seed + 31, 3);
  const wy = fbm(x - 3.1, y + 7.7, seed + 57, 3);
  return fbm(x + warp * wx, y + warp * wy, seed, octaves);
}
