/**
 * Season palette: light, sky and ground-cover colours per season, blended
 * smoothly over the year. `season` is fractional 0..4 (yearFrac × 4):
 * 0 = start of spring, 1 = start of summer, … Each season's key colours sit
 * at its middle (k + 0.5), with a smooth blend across season boundaries.
 */
import * as THREE from 'three';

export interface SeasonPalette {
  /** Direct sunlight colour (multiplied by intensity in sky.ts). */
  sun: THREE.Color;
  sunIntensity: number;
  /** Hemisphere sky / ground light. */
  sky: THREE.Color;
  ground: THREE.Color;
  /** Background gradient. */
  skyTop: THREE.Color;
  skyBottom: THREE.Color;
  /** Terrain ground cover. */
  grassDry: THREE.Color;
  grassLush: THREE.Color;
  forest: THREE.Color;
  /** Water tints. */
  waterShallow: THREE.Color;
  waterDeep: THREE.Color;
  /** Floating leaves. */
  leafA: THREE.Color;
  leafB: THREE.Color;
}

type Key = Record<keyof SeasonPalette, number>;

const KEYS: Key[] = [
  // Spring: fresh, bright greens, clear light.
  {
    sun: 0xfff6e6,
    sunIntensity: 2.85,
    sky: 0xd2eaff,
    ground: 0x8a8462,
    skyTop: 0x80bdf0,
    skyBottom: 0xe6f6fb,
    grassDry: 0xb2cf62,
    grassLush: 0x6cc44e,
    forest: 0x46944a,
    waterShallow: 0x62e2d4,
    waterDeep: 0x2c7ad6,
    leafA: 0x7cbc48,
    leafB: 0xb4d65a,
  },
  // Summer: warm, saturated, deep greens drying at the edges.
  {
    sun: 0xfff0d2,
    sunIntensity: 3.0,
    sky: 0xcfe4ff,
    ground: 0x8e8060,
    skyTop: 0x6aacec,
    skyBottom: 0xe2f0fa,
    grassDry: 0xb2c05a,
    grassLush: 0x58aa40,
    forest: 0x347a38,
    waterShallow: 0x5cdccc,
    waterDeep: 0x2a72cc,
    leafA: 0x5a9a38,
    leafB: 0x88b040,
  },
  // Autumn: golden light, yellowed grass.
  {
    sun: 0xffdcaa,
    sunIntensity: 2.85,
    sky: 0xf0dcc4,
    ground: 0x907650,
    skyTop: 0x88aad4,
    skyBottom: 0xf6e2c6,
    grassDry: 0xbeb460,
    grassLush: 0xa2aa4c,
    forest: 0x788a40,
    waterShallow: 0x6ad2c0,
    waterDeep: 0x2e6cb8,
    leafA: 0xe8902c,
    leafB: 0xd8562a,
  },
  // Winter: cool, pale, muted.
  {
    sun: 0xe8eeff,
    sunIntensity: 2.45,
    sky: 0xe0eaf8,
    ground: 0x80848a,
    skyTop: 0x9cb6d6,
    skyBottom: 0xeef3f8,
    grassDry: 0xb8bcaa,
    grassLush: 0x9cac92,
    forest: 0x667c68,
    waterShallow: 0x7ccccc,
    waterDeep: 0x3a6ca8,
    leafA: 0x8a6a44,
    leafB: 0xa88450,
  },
];

const tmpA = new THREE.Color();
const tmpB = new THREE.Color();

/** Blend weights: season index pair and fraction for fractional season s (0..4). */
export function seasonBlend(season: number): { a: number; b: number; t: number } {
  const s = (((season - 0.5) % 4) + 4) % 4; // 0 = mid-spring
  const a = Math.floor(s);
  const f = s - a;
  // Hold each season's look for the middle half, blend across the boundary.
  const t = f < 0.25 ? 0 : f > 0.75 ? 1 : ((x) => x * x * (3 - 2 * x))((f - 0.25) / 0.5);
  return { a, b: (a + 1) % 4, t };
}

export function seasonPalette(season: number, out?: SeasonPalette): SeasonPalette {
  const { a, b, t } = seasonBlend(season);
  const A = KEYS[a]!;
  const B = KEYS[b]!;
  const p: SeasonPalette =
    out ??
    ({
      sun: new THREE.Color(),
      sunIntensity: 0,
      sky: new THREE.Color(),
      ground: new THREE.Color(),
      skyTop: new THREE.Color(),
      skyBottom: new THREE.Color(),
      grassDry: new THREE.Color(),
      grassLush: new THREE.Color(),
      forest: new THREE.Color(),
      waterShallow: new THREE.Color(),
      waterDeep: new THREE.Color(),
      leafA: new THREE.Color(),
      leafB: new THREE.Color(),
    } as SeasonPalette);
  for (const k of Object.keys(A) as (keyof SeasonPalette)[]) {
    if (k === 'sunIntensity') {
      p.sunIntensity = A.sunIntensity + (B.sunIntensity - A.sunIntensity) * t;
      continue;
    }
    (p[k] as THREE.Color).copy(tmpA.set(A[k])).lerp(tmpB.set(B[k]), t);
  }
  return p;
}
