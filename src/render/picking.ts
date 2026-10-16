/**
 * Ray-marching against a heightfield, used for picking. Pure math, no three.js
 * scene access, so it is unit-testable in Node.
 */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface MarchBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export interface MarchHit {
  x: number;
  y: number;
  z: number;
  t: number;
}

/** Intersect a ray with an axis-aligned box. Returns [tEnter, tExit] or null. */
export function rayBox(o: Vec3Like, d: Vec3Like, b: MarchBounds): [number, number] | null {
  let t0 = -Infinity;
  let t1 = Infinity;
  const axes: [number, number, number, number][] = [
    [o.x, d.x, b.minX, b.maxX],
    [o.y, d.y, b.minY, b.maxY],
    [o.z, d.z, b.minZ, b.maxZ],
  ];
  for (const [oo, dd, lo, hi] of axes) {
    if (Math.abs(dd) < 1e-12) {
      if (oo < lo || oo > hi) return null;
      continue;
    }
    let ta = (lo - oo) / dd;
    let tb = (hi - oo) / dd;
    if (ta > tb) [ta, tb] = [tb, ta];
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return null;
  }
  if (t1 < 0) return null;
  return [Math.max(t0, 0), t1];
}

/**
 * March along origin + t·dir (dir need not be normalised) and return the first
 * point where the ray is at or below `surfaceY(x, z)`. `step` is the march step
 * in horizontal world units; the hit is refined by bisection.
 */
export function rayMarchHeightfield(
  origin: Vec3Like,
  dir: Vec3Like,
  surfaceY: (x: number, z: number) => number,
  bounds: MarchBounds,
  step = 0.5,
): MarchHit | null {
  const span = rayBox(origin, dir, bounds);
  if (!span) return null;
  const [tEnter, tExit] = span;
  const horiz = Math.hypot(dir.x, dir.z);
  const len = Math.hypot(dir.x, dir.y, dir.z);
  // Step so that both horizontal travel ≤ step and total travel ≤ 4·step.
  const dt = Math.min(horiz > 1e-9 ? step / horiz : Infinity, (4 * step) / len);
  const below = (t: number): boolean => {
    const x = origin.x + dir.x * t;
    const z = origin.z + dir.z * t;
    return origin.y + dir.y * t <= surfaceY(x, z);
  };
  if (below(tEnter)) return point(origin, dir, tEnter);
  let prev = tEnter;
  for (let t = tEnter + dt; ; t += dt) {
    const tt = Math.min(t, tExit);
    if (below(tt)) {
      let lo = prev;
      let hi = tt;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (below(mid)) hi = mid;
        else lo = mid;
      }
      return point(origin, dir, hi);
    }
    if (tt >= tExit) return null;
    prev = tt;
  }
}

function point(o: Vec3Like, d: Vec3Like, t: number): MarchHit {
  return { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t, t };
}
