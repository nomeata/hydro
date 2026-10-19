/**
 * Fields on the terrain: shared conventions between the terrain shader
 * (furrows and crop colour from the per-cell fields texture) and the crop
 * model layer, so model rows sit on the painted rows.
 *
 * The fields texture is the snapshot's `fields` array uploaded as RGBA8:
 * R = LandUse, G = crop stage (0 bare/ploughed, 8 sown, ≥ 230 ripe),
 * B = crop stress (see STRESS_WET in protocol.ts), A = field crop (FieldCrop:
 * the ordinary crop, millet, paddy, or a pegged plot on unploughed land).
 */
import { FIELD_BYTES, STRESS_WET } from '../../shared/protocol';

/** Cells per patch block: furrow direction and crop kind are constant per block. */
export const PATCH = 6;
/** Furrows (crop rows) per cell. */
export const ROWS_PER_CELL = 4;
/** Crop stage at which a field counts as ripe (sim: CROP_RIPE). */
export const CROP_RIPE = 230;
/** Crop stage of freshly sown fields. */
export const CROP_SOWN = 8;

/** Dryness and wetness 0..1 of a stress byte (at most one is non-zero). */
export function decodeStress(b: number): { dry: number; wet: number } {
  if (b >= STRESS_WET) return { dry: 0, wet: (b - STRESS_WET + 1) / (256 - STRESS_WET) };
  return { dry: b / (STRESS_WET - 1), wet: 0 };
}

/**
 * Expand snapshot fields (FIELD_BYTES per cell) into RGBA texels. With the
 * grid width, path cells (LandUse.Path) get their links instead of crop
 * stress and crop kind (see pathLinks): B = the ring mask of the
 * neighbours the way joins, A = those of them that are yards, houses or
 * bridges (the way runs on into them).
 */
export function fieldsToRgba(src: Uint8Array, dst: Uint8Array, n: number, width = 0): void {
  for (let i = 0; i < n; i++) {
    dst[4 * i] = src[FIELD_BYTES * i]!;
    dst[4 * i + 1] = src[FIELD_BYTES * i + 1]!;
    dst[4 * i + 2] = src[FIELD_BYTES * i + 2]!;
    dst[4 * i + 3] = src[FIELD_BYTES * i + 3]!;
  }
  if (width <= 0) return;
  const height = Math.floor(n / width);
  const lu = (x: number, y: number) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : src[FIELD_BYTES * (y * width + x)]!);
  for (let i = 0; i < n; i++) {
    if (src[FIELD_BYTES * i] !== LU_PATH) continue;
    const [links, ends, street] = pathLinks(lu, i % width, (i / width) | 0);
    dst[4 * i + 2] = links;
    dst[4 * i + 3] = ends;
    // Ways between the houses are a little wider (the shader reads width from the footfall).
    if (street) dst[4 * i + 1] = Math.max(dst[4 * i + 1]!, 150);
  }
  joinYards(src, dst, n, width);
}

/**
 * A way that passes a cluster of yards without running into it (pathLinks
 * draws no rungs) still joins it once: the most trodden of its cells beside
 * the cluster gets a spur into the nearest yard.
 */
function joinYards(src: Uint8Array, dst: Uint8Array, n: number, width: number): void {
  const height = Math.floor(n / width);
  const at = (i: number) => src[FIELD_BYTES * i]!;
  const isYard = (v: number) => v === LU_YARD || v === LU_BUILDING;
  // Label the 8-connected pieces of path and the clusters of yards.
  const label = new Int32Array(n).fill(-1);
  let next = 0;
  const stack: number[] = [];
  for (let s = 0; s < n; s++) {
    const v = at(s);
    if (label[s]! >= 0 || (v !== LU_PATH && !isYard(v))) continue;
    const yard = isYard(v);
    label[s] = next;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % width;
      const y = (i / width) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = x + RING_X[k]!;
        const ny = y + RING_Y[k]!;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (label[j]! >= 0 || (yard ? !isYard(at(j)) : at(j) !== LU_PATH)) continue;
        label[j] = next;
        stack.push(j);
      }
    }
    next++;
  }
  // Per (piece, cluster): joined already, or the best cell and its yard direction.
  const best = new Map<number, { cell: number; k: number; t: number }>();
  const joined = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (at(i) !== LU_PATH) continue;
    const x = i % width;
    const y = (i / width) | 0;
    const links = dst[4 * i + 2]!;
    const t = src[FIELD_BYTES * i + 1]!;
    for (let k = 0; k < 8; k++) {
      const nx = x + RING_X[k]!;
      const ny = y + RING_Y[k]!;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const j = ny * width + nx;
      if (!isYard(at(j))) continue;
      const key = label[i]! * next + label[j]!;
      if (links & (1 << k)) {
        joined.add(key);
        continue;
      }
      const b = best.get(key);
      // The most trodden cell; an orthogonal step into the yard over a diagonal one.
      if (!b || t > b.t || (t === b.t && b.cell === i && (b.k & 1) === 1 && (k & 1) === 0)) best.set(key, { cell: i, k, t });
    }
  }
  for (const [key, b] of best) {
    if (joined.has(key)) continue;
    dst[4 * b.cell + 2] = dst[4 * b.cell + 2]! | (1 << b.k);
    dst[4 * b.cell + 3] = dst[4 * b.cell + 3]! | (1 << b.k);
  }
}

const LU_PATH = 4;
const LU_YARD = 5;
const LU_BUILDING = 6;
const LU_BRIDGE = 7;
/** Ring order of a cell's neighbours (E, NE, N, NW, W, SW, S, SE; N = +y), as in sim/people/desire.ts. */
export const RING_X = [1, 1, 0, -1, -1, -1, 0, 1] as const;
export const RING_Y = [0, 1, 1, 1, 0, -1, -1, -1] as const;

/**
 * The links of the path cell at (x, y), as ring masks: which neighbours the
 * drawn way runs to, and which of those are ends (yard, house, bridge);
 * plus whether it is a street (beside a yard or house). A path joins its
 * path neighbours (a diagonal one only where neither cell at the corner is
 * path), bridges, and, only where it ends (at most one path link), one yard
 * or house: a way passing along the yards does not sprout rungs into them.
 * `lu(x, y)` gives the land use of any cell (0 outside the grid).
 */
export function pathLinks(lu: (x: number, y: number) => number, x: number, y: number): [number, number, boolean] {
  let links = 0;
  let ends = 0;
  let paths = 0;
  let yard = -1;
  let street = false;
  for (let k = 0; k < 8; k++) {
    const v = lu(x + RING_X[k]!, y + RING_Y[k]!);
    if (v === LU_YARD || v === LU_BUILDING) street = true;
    const diag = (k & 1) === 1;
    // Diagonal: the two cells at the corner.
    const blocked = diag && (lu(x + RING_X[k]!, y) === LU_PATH || lu(x, y + RING_Y[k]!) === LU_PATH);
    if (v === LU_PATH) {
      if (!blocked) {
        links |= 1 << k;
        paths++;
      }
    } else if (v === LU_BRIDGE) {
      if (!diag || (lu(x + RING_X[k]!, y) !== LU_BRIDGE && lu(x, y + RING_Y[k]!) !== LU_BRIDGE)) {
        links |= 1 << k;
        ends |= 1 << k;
      }
    } else if ((v === LU_YARD || v === LU_BUILDING) && (yard < 0 || ((yard & 1) === 1 && !diag))) {
      // One yard: an orthogonal one if any, else the first diagonal.
      if (!diag || !blocked) yard = k;
    }
  }
  if (yard >= 0 && paths <= 1 && ends === 0) {
    links |= 1 << yard;
    ends |= 1 << yard;
  }
  return [links, ends, street];
}

/** 32-bit integer hash of a patch block (identical in GLSL, see FIELDS_GLSL). */
export function patchHash(bx: number, by: number): number {
  let h = (Math.imul(bx | 0, 0x9e3779b1) ^ Math.imul(by | 0, 0x85ebca77)) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h = (h ^ (h >>> 12)) >>> 0;
  return h;
}

/** Furrows of the patch containing cell (x, y) run along x (else along z/y). */
export function furrowsAlongX(x: number, y: number): boolean {
  return (patchHash(Math.floor(x / PATCH), Math.floor(y / PATCH)) & 1) === 1;
}

export const enum CropKind {
  Wheat = 0,
  Corn = 1,
  Cabbage = 2,
  Pumpkin = 3,
}

/** Crop kind of the patch containing cell (x, y): mostly grain. */
export function cropKind(x: number, y: number): CropKind {
  const h = (patchHash(Math.floor(x / PATCH), Math.floor(y / PATCH)) >>> 8) % 20;
  if (h < 11) return CropKind.Wheat;
  if (h < 15) return CropKind.Corn;
  if (h < 18) return CropKind.Cabbage;
  return CropKind.Pumpkin;
}

/**
 * GLSL: `vec3 fieldColour(vec3 ground, vec3 world, out float mask)` blends a
 * field look over the ground colour for LandUse.Field cells (mask = how much
 * field), and trampled earth under buildings. Needs uniforms uFields
 * (RG8), uGrid, and the colour uniforms declared here.
 */
export const FIELDS_GLSL = /* glsl */ `
uniform sampler2D uFields;
uniform float uFieldsOn;
uniform vec3 uFieldSoil;
uniform vec3 uCropYoung;
uniform vec3 uCropGreen;
uniform vec3 uCropRipe;
uniform vec3 uYard;
/** Trodden earth of desire paths (LandUse.Path). */
uniform vec3 uPath;
/** 1 in autumn: harvested (bare) fields show straw stubble rows. */
uniform float uStubble;

uint patchHash(ivec2 b) {
  uint h = (uint(b.x) * 0x9e3779b1u) ^ (uint(b.y) * 0x85ebca77u);
  h ^= h >> 15u;
  h *= 0x2c1b3c6du;
  h ^= h >> 12u;
  return h;
}

vec3 fieldAt(ivec2 c) {
  return texelFetch(uFields, clamp(c, ivec2(0), ivec2(uGrid) - 1), 0).rgb * 255.0;
}

// FieldCrop of a cell (0 ordinary, 1 millet, 2 paddy, 3 pegged plot).
int fieldCropAt(ivec2 c) {
  return int(texelFetch(uFields, clamp(c, ivec2(0), ivec2(uGrid) - 1), 0).a * 255.0 + 0.5);
}

// An anti-aliased line of half-width w at distance d (in cells), never thinner than a pixel (fainter instead).
float fieldLine(float d, float w) {
  float px = fwidth(d);
  float ww = max(w, px * 0.75);
  return (1.0 - smoothstep(ww - px * 0.5, ww + px * 0.5, d)) * min(1.0, w / ww);
}

// Smooth value noise (patches of stressed crops, puddles); tHash from the terrain shader.
float fieldNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = tHash(i);
  float b = tHash(i + vec2(1.0, 0.0));
  float c = tHash(i + vec2(0.0, 1.0));
  float d = tHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Stress of a cell, bilinearly blended with its neighbours so patches cross cell borders: (dry, wet).
vec2 stressAt(vec2 p) {
  vec2 q = p - 0.5;
  ivec2 c = ivec2(floor(q));
  vec2 f = fract(q);
  vec2 s00, s10, s01, s11;
  vec3 a;
  a = fieldAt(c); s00 = a.r > 0.5 && a.r < 1.5 ? vec2(a.b < 127.5 ? a.b / 127.0 : 0.0, a.b > 127.5 ? (a.b - 127.0) / 128.0 : 0.0) : vec2(0.0);
  a = fieldAt(c + ivec2(1, 0)); s10 = a.r > 0.5 && a.r < 1.5 ? vec2(a.b < 127.5 ? a.b / 127.0 : 0.0, a.b > 127.5 ? (a.b - 127.0) / 128.0 : 0.0) : vec2(0.0);
  a = fieldAt(c + ivec2(0, 1)); s01 = a.r > 0.5 && a.r < 1.5 ? vec2(a.b < 127.5 ? a.b / 127.0 : 0.0, a.b > 127.5 ? (a.b - 127.0) / 128.0 : 0.0) : vec2(0.0);
  a = fieldAt(c + ivec2(1, 1)); s11 = a.r > 0.5 && a.r < 1.5 ? vec2(a.b < 127.5 ? a.b / 127.0 : 0.0, a.b > 127.5 ? (a.b - 127.0) / 128.0 : 0.0) : vec2(0.0);
  return mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);
}

// Desire paths are drawn as smooth bands through the centres of the path
// cells: each path cell carries its links (fields texture B, A for the ends
// among them: see pathLinks), and draws a curve from the middle of one link
// to the middle of the other (a quadratic Bézier with the cell centre as its
// control point: neighbouring cells' curves meet there with the same
// tangent), spokes from the centre at a junction or a dead end (blended
// with a smooth minimum, so junctions fill in), and a dot for a lone cell.
// Only the 2 × 2 cells around a point can reach it. The lookup point is
// gently displaced by low-frequency noise, so ways wind a little; the edge
// is noisy, and the width grows with the footfall (G: traffic, raised
// between the houses), blended across cells.
// Cached per fragment: fieldColour and the snow (terrain.ts) both ask.
bool gPathDone = false;
float gPathM = 0.0;
float gPathP = 0.0;
/** Traffic 0..1 of the nearest stretch of path. */
float gPathWear = 0.0;
/** Distance (cells) from the centre line of the nearest stretch. */
float gPathAcross = 9.0;
/** Half-width (cells) of the nearest stretch (0: no path near). */
float gPathHalf = 0.0;
/** Soil moisture 0..1 under the fragment (set by the terrain shader before fieldColour): muddy paths. */
float gMoist = 0.0;

float pathDot2(vec2 v) { return dot(v, v); }

// Distance from p to the quadratic Bézier A-B-C (Inigo Quilez's exact solution).
float pathBezier(vec2 pos, vec2 A, vec2 B, vec2 C) {
  vec2 a = B - A;
  vec2 b = A - 2.0 * B + C;
  vec2 c = a * 2.0;
  vec2 d = A - pos;
  float kk = 1.0 / dot(b, b);
  float kx = kk * dot(a, b);
  float ky = kk * (2.0 * dot(a, a) + dot(d, b)) / 3.0;
  float kz = kk * dot(d, a);
  float p = ky - kx * kx;
  float p3 = p * p * p;
  float q = kx * (2.0 * kx * kx - 3.0 * ky) + kz;
  float h = q * q + 4.0 * p3;
  float res;
  if (h >= 0.0) {
    h = sqrt(h);
    vec2 x = (vec2(h, -h) - q) / 2.0;
    vec2 uv = sign(x) * pow(abs(x), vec2(1.0 / 3.0));
    float t = clamp(uv.x + uv.y - kx, 0.0, 1.0);
    res = pathDot2(d + (c + b * t) * t);
  } else {
    float z = sqrt(-p);
    float v = acos(q / (p * z * 2.0)) / 3.0;
    float m = cos(v);
    float n = sin(v) * 1.732050808;
    vec3 t = clamp(vec3(m + m, -n - m, n - m) * z - kx, 0.0, 1.0);
    res = min(pathDot2(d + (c + b * t.x) * t.x), pathDot2(d + (c + b * t.y) * t.y));
  }
  return sqrt(res);
}

// Distance from p to segment a-b.
float pathSeg(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  vec2 ap = p - a;
  float t = clamp(dot(ap, ab) / dot(ab, ab), 0.0, 1.0);
  return length(ap - ab * t);
}

// Polynomial smooth minimum (fills the inner corners of junctions).
float pathSmin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

vec2 pathRing(int k) {
  return vec2(float(k == 0 || k == 1 || k == 7) - float(k == 3 || k == 4 || k == 5), float(k == 1 || k == 2 || k == 3) - float(k == 5 || k == 6 || k == 7));
}

// Distance from p (relative to the cell centre) to the way drawn in a path cell.
float pathCellDist(vec2 p, int links, int ends) {
  if (links == 0) return length(p);
  int n = 0;
  int k1 = -1;
  int k2 = -1;
  float best = 9.0;
  for (int k = 0; k < 8; k++) {
    if ((links & (1 << k)) == 0) continue;
    n++;
    if (k1 < 0) k1 = k; else k2 = k;
    // Into a yard, house or bridge: on to just past the edge.
    if ((ends & (1 << k)) != 0) best = min(best, pathSeg(p, pathRing(k) * 0.5, pathRing(k) * 0.62));
  }
  if (n == 2) {
    vec2 a = pathRing(k1) * 0.5;
    vec2 b = pathRing(k2) * 0.5;
    // Straight on: a segment (the curve would be degenerate).
    float d = (k2 - k1 == 4) ? pathSeg(p, a, b) : pathBezier(p, a, vec2(0.0), b);
    return min(best, d);
  }
  float d = 9.0;
  for (int k = 0; k < 8; k++)
    if ((links & (1 << k)) != 0) d = pathSmin(d, pathSeg(p, vec2(0.0), pathRing(k) * 0.5), 0.14);
  return min(best, d);
}

// How much of a desire path covers this point (0..1); p: 1 on the centre line, 0 at the edge.
float pathMask(vec3 world, out float p) {
  if (gPathDone) {
    p = gPathP;
    return gPathM;
  }
  gPathDone = true;
  p = 0.0;
  if (uFieldsOn < 0.5) return 0.0;
  vec2 wq = world.xz + (vec2(fieldNoise(world.xz * 0.31 + 11.0), fieldNoise(world.xz * 0.31 + 23.7)) - 0.5) * 0.4;
  // Cell (cx, cy) has its centre at q = (cx, cy).
  vec2 q = wq - 0.5;
  ivec2 c0 = ivec2(floor(q));
  vec2 f = q - vec2(c0);
  float best = 9.0;
  float wsum = 0.0;
  float wear = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 o = ivec2(k & 1, k >> 1);
    vec4 t = texelFetch(uFields, clamp(c0 + o, ivec2(0), ivec2(uGrid) - 1), 0) * 255.0;
    if (int(t.r + 0.5) != 4) continue;
    float d = pathCellDist(q - vec2(c0 + o), int(t.b + 0.5), int(t.a + 0.5));
    best = pathSmin(best, d, 0.1);
    // Bilinear weight of the cell: the width blends smoothly from cell to cell.
    float bw = (o.x == 1 ? f.x : 1.0 - f.x) * (o.y == 1 ? f.y : 1.0 - f.y) + 1e-3;
    wsum += bw;
    wear += bw * t.g / 255.0;
  }
  if (wsum <= 0.0) return 0.0;
  wear /= wsum;
  float edgeN = fieldNoise(world.xz * 1.9 + 7.3) * 0.75 + fieldNoise(world.xz * 4.3) * 0.25;
  float half_ = (0.17 + 0.15 * smoothstep(0.25, 0.95, wear)) * (0.8 + 0.4 * edgeN);
  float soft = 0.05 + 0.6 * length(fwidth(world.xz));
  gPathWear = wear;
  gPathAcross = best;
  gPathHalf = half_;
  gPathP = clamp(1.0 - best / half_, 0.0, 1.0);
  gPathM = 1.0 - smoothstep(half_ - soft, half_ + soft, best);
  p = gPathP;
  return gPathM;
}

// Desire paths: warm trodden earth, darker and rutted where many feet go,
// a margin of flattened grass, tufts on little-used ways; muddy when wet.
vec3 pathColour(vec3 ground, vec3 world) {
  float p;
  float m = pathMask(world, p);
  if (gPathHalf <= 0.0) return ground;
  // Flattened, paler grass in a margin along the edge.
  float margin = (1.0 - smoothstep(gPathHalf, gPathHalf + 0.16, abs(gPathAcross))) * (1.0 - m);
  ground = mix(ground, ground * vec3(1.06, 1.02, 0.84) + vec3(0.03, 0.025, 0.0), margin * 0.55);
  if (m <= 0.0) return ground;
  float grain = fieldNoise(world.xz * 5.3 + 1.9);
  vec3 earth = uPath * mix(0.88, 1.1, grain);
  // Worn ways: a darker, packed centre with two ruts.
  float wear = smoothstep(0.3, 1.0, gPathWear);
  float a = abs(gPathAcross) / max(gPathHalf, 0.05);
  float rut = (1.0 - smoothstep(0.08, 0.2, abs(a - 0.5))) * wear;
  earth *= mix(1.0, 0.86, wear * p);
  earth *= 1.0 - 0.22 * rut;
  // Mud in the wet: dark, glossy, puddles in the ruts.
  float wet = smoothstep(0.35, 0.75, gMoist);
  earth = mix(earth, vec3(0.3, 0.21, 0.13) * mix(0.85, 1.1, grain), wet * 0.6);
  float pud = wet * smoothstep(0.55, 0.75, rut + 0.5 * fieldNoise(world.xz * 3.3 + 5.1) - 0.2);
  earth = mix(earth, vec3(0.4, 0.5, 0.56) * (0.9 + 0.1 * sin(uTime * 1.2 + world.x * 2.3)), pud * 0.7);
  // Tufts of grass survive where fewer feet go (and along the middle of a little-used way).
  float tuft = smoothstep(0.68, 0.85, fieldNoise(world.xz * 6.0 + 3.3)) * (1.0 - wear) * smoothstep(0.55, 0.9, p);
  return mix(ground, earth, m * (0.95 - 0.55 * tuft));
}

// Pegged plot (good land staked out, not ploughed): the meadow a little trodden and
// paler inside, a string along the plot's outline and a peg at each corner of it.
vec3 peggedColour(vec3 ground, ivec2 c, vec2 f) {
  bool w = fieldCropAt(c + ivec2(-1, 0)) != 3 || int(fieldAt(c + ivec2(-1, 0)).r + 0.5) != 0;
  bool e = fieldCropAt(c + ivec2(1, 0)) != 3 || int(fieldAt(c + ivec2(1, 0)).r + 0.5) != 0;
  bool s = fieldCropAt(c + ivec2(0, -1)) != 3 || int(fieldAt(c + ivec2(0, -1)).r + 0.5) != 0;
  bool n = fieldCropAt(c + ivec2(0, 1)) != 3 || int(fieldAt(c + ivec2(0, 1)).r + 0.5) != 0;
  vec3 col = mix(ground, ground * vec3(1.08, 1.06, 0.92) + vec3(0.02, 0.02, 0.0), 0.7);
  float str = 0.0;
  if (w) str = max(str, fieldLine(f.x, 0.022));
  if (e) str = max(str, fieldLine(1.0 - f.x, 0.022));
  if (s) str = max(str, fieldLine(f.y, 0.022));
  if (n) str = max(str, fieldLine(1.0 - f.y, 0.022));
  col = mix(col, vec3(0.93, 0.9, 0.78), str * 0.9);
  // Pegs: dark wood at the outline's corners (shadow-like dots; the 3D pegs stand on them).
  float peg = 0.0;
  vec2 g = vec2(f.x < 0.5 ? f.x : 1.0 - f.x, f.y < 0.5 ? f.y : 1.0 - f.y);
  bool xe = f.x < 0.5 ? w : e;
  bool ye = f.y < 0.5 ? s : n;
  if (xe || ye) peg = fieldLine(length(g), 0.06);
  return mix(col, vec3(0.28, 0.2, 0.12), peg * 0.85);
}

// Paddies: small basins of standing water between low earth bunds, the rice planted in clumps.
vec3 paddyColour(vec3 soil, vec3 world, ivec2 c, vec2 f, float crop, float g, vec2 st) {
  // Bunds on the plot's outline and between pairs of cells.
  float bund = 0.0;
  bool wx = int(fieldAt(c + ivec2(-1, 0)).r + 0.5) != 1 || fieldCropAt(c + ivec2(-1, 0)) != 2 || (c.x & 1) == 0;
  bool ex = int(fieldAt(c + ivec2(1, 0)).r + 0.5) != 1 || fieldCropAt(c + ivec2(1, 0)) != 2 || (c.x & 1) == 1;
  bool sy = int(fieldAt(c + ivec2(0, -1)).r + 0.5) != 1 || fieldCropAt(c + ivec2(0, -1)) != 2 || (c.y & 1) == 0;
  bool ny = int(fieldAt(c + ivec2(0, 1)).r + 0.5) != 1 || fieldCropAt(c + ivec2(0, 1)) != 2 || (c.y & 1) == 1;
  if (wx) bund = max(bund, fieldLine(f.x, 0.09));
  if (ex) bund = max(bund, fieldLine(1.0 - f.x, 0.09));
  if (sy) bund = max(bund, fieldLine(f.y, 0.09));
  if (ny) bund = max(bund, fieldLine(1.0 - f.y, 0.09));
  float sheen = 0.9 + 0.1 * sin(uTime * 1.1 + world.x * 1.7 + world.z * 2.3);
  vec3 water = mix(vec3(0.2, 0.27, 0.24), vec3(0.4, 0.55, 0.6), 0.45 + 0.2 * fieldNoise(world.xz * 3.1)) * sheen;
  vec3 col = water;
  // Rice clumps on a 4 x 4 grid per cell, growing from points into tufts.
  if (crop >= ${CROP_SOWN}.0) {
    vec2 q = fract(world.xz * 4.0) - 0.5;
    float r = mix(0.12, 0.36, smoothstep(0.0, 0.6, g)) * (1.0 - 0.5 * st.x);
    float tuft = 1.0 - smoothstep(r - 0.1, r + 0.04, length(q));
    vec3 rice = mix(vec3(0.5, 0.8, 0.24), vec3(0.4, 0.72, 0.2), smoothstep(0.1, 0.5, g));
    rice = mix(rice, vec3(0.78, 0.7, 0.3), smoothstep(0.78, 1.0, g));
    rice = mix(rice, vec3(0.62, 0.42, 0.12), st.x * 0.7);
    float aa = 1.0 - smoothstep(0.3, 0.6, fwidth(world.x * 4.0));
    col = mix(col, rice, mix(r * 1.6, tuft, aa) * 0.95);
  }
  vec3 bundCol = mix(vec3(0.52, 0.42, 0.24), vec3(0.45, 0.62, 0.24), 0.4 + 0.35 * fieldNoise(world.xz * 5.0));
  return mix(col, bundCol, bund);
}

bool isField(ivec2 c) {
  return int(fieldAt(c).r + 0.5) == 1;
}

// Distance-based mask that fades a cell's field look towards non-field neighbours.
float fieldEdge(ivec2 c, vec2 f) {
  float m = 1.0;
  float w = 0.09;
  if (!isField(c + ivec2(-1, 0))) m = min(m, smoothstep(0.015, w, f.x));
  if (!isField(c + ivec2(1, 0))) m = min(m, smoothstep(0.015, w, 1.0 - f.x));
  if (!isField(c + ivec2(0, -1))) m = min(m, smoothstep(0.015, w, f.y));
  if (!isField(c + ivec2(0, 1))) m = min(m, smoothstep(0.015, w, 1.0 - f.y));
  return m;
}

vec3 fieldColour(vec3 ground, vec3 world) {
  if (uFieldsOn < 0.5) return ground;
  // Cell (cx, cy) covers world [cx, cx+1) x [cy, cy+1) (centre at cx + 0.5).
  ivec2 c = ivec2(floor(world.xz));
  vec2 f = fract(world.xz);
  ground = pathColour(ground, world);
  vec3 fd = fieldAt(c);
  int lu = int(fd.r + 0.5);
  if (lu == 5) {
    // Trampled earth around a building.
    float d = length(f - 0.5);
    return mix(ground, uYard, (1.0 - smoothstep(0.38, 0.52, d)) * 0.85);
  }
  int kind = fieldCropAt(c);
  if (lu == 0 && kind == 3) return peggedColour(ground, c, f);
  if (lu != 1) return ground;
  float crop = fd.g;
  float g = clamp((crop - ${CROP_SOWN}.0) / (${CROP_RIPE}.0 - ${CROP_SOWN}.0), 0.0, 1.0);
  vec2 st = stressAt(world.xz);
  if (kind == 2) return mix(ground, paddyColour(uFieldSoil, world, c, f, crop, g, st), fieldEdge(c, f));
  bool millet = kind == 1;
  bool alongX = (patchHash(c / ${PATCH}) & 1u) == 1u;
  float t = (alongX ? world.z : world.x) * ${ROWS_PER_CELL}.0;
  // 1 on a ridge (crop row), 0 in the furrow between.
  float row = 0.5 + 0.5 * cos(6.2831853 * t);
  float aa = 1.0 - smoothstep(0.18, 0.5, fwidth(t));
  float rowA = mix(0.5, row, aa);
  // Millet: on sandy, pale soil.
  vec3 soil = (millet ? mix(uFieldSoil, vec3(0.62, 0.5, 0.32), 0.6) : uFieldSoil) * mix(0.72, 1.12, rowA);
  // Noise for patches of stress.
  float pn = fieldNoise(world.xz * 1.7 + 3.1) * 0.65 + fieldNoise(world.xz * 4.3) * 0.35;
  // Dry: pale, cracked-looking soil; wet: dark mud.
  soil = mix(soil, vec3(0.50, 0.36, 0.20) * mix(0.85, 1.08, rowA), st.x * 0.75);
  soil = mix(soil, vec3(0.13, 0.085, 0.05) * mix(0.8, 1.1, rowA), st.y * 0.7);
  // Ground covered by the crop: rows widen as the crop grows; stress thins them in patches.
  float cover = crop < ${CROP_SOWN}.0 ? 0.0 : mix(0.12, 1.05, smoothstep(0.0, 0.55, g));
  cover *= 1.0 - st.x * smoothstep(0.3, 0.6, pn) * 0.95 - st.y * smoothstep(0.45, 0.75, pn) * 0.6;
  if (millet) {
    // Short, sparse rows with gaps: the sandy soil shows between.
    float along = (alongX ? world.x : world.z) * 2.3 + 1.7 * floor(t);
    cover *= 0.5 * smoothstep(0.25, 0.45, fieldNoise(vec2(along, floor(t) * 3.1)));
  }
  float rowMask = smoothstep(1.0 - cover - 0.08, 1.0 - cover + 0.08, row);
  rowMask = mix(cover * 0.9, rowMask, aa);
  vec3 cropCol = mix(uCropYoung, uCropGreen, smoothstep(0.1, 0.5, g));
  cropCol = mix(cropCol, mix(uCropGreen, uCropRipe, 0.45), smoothstep(0.72, 0.95, g));
  if (crop >= ${CROP_RIPE}.0) cropCol = uCropRipe;
  // Millet: olive green, ripening to a bronze brown (wheat turns gold).
  if (millet) cropCol = mix(mix(vec3(0.42, 0.52, 0.2), vec3(0.36, 0.44, 0.16), smoothstep(0.1, 0.5, g)), vec3(0.6, 0.38, 0.14), smoothstep(0.7, 1.0, g));
  // Dry crops turn straw yellow-brown, waterlogged ones dull brown (patchy).
  cropCol = mix(cropCol, vec3(0.62, 0.42, 0.12), st.x * mix(0.6, 1.0, pn));
  cropCol = mix(cropCol, vec3(0.24, 0.17, 0.07), st.y * mix(0.55, 0.95, pn));
  cropCol *= mix(0.86, 1.06, rowA);
  vec3 col = mix(soil, cropCol, rowMask);
  if (crop < ${CROP_SOWN}.0 && uStubble > 0.0) {
    float along = (alongX ? world.x : world.z) * 9.0;
    float dash = step(0.35, fract(along + 0.37 * floor(t)));
    col = mix(col, uCropRipe * 0.82, smoothstep(0.72, 0.9, row) * dash * aa * 0.8 * uStubble);
  }
  // Waterlogged: puddles in the furrows with a soft sky sheen.
  if (st.y > 0.01) {
    float pud = smoothstep(1.0 - 0.55 * st.y, 1.06 - 0.55 * st.y, 1.0 - pn * 0.85 - row * 0.2);
    float sheen = 0.85 + 0.15 * sin(uTime * 1.3 + world.x * 2.1 + world.z * 1.7);
    col = mix(col, vec3(0.42, 0.55, 0.62) * sheen, pud * 0.9);
  }
  return mix(ground, col, fieldEdge(c, f));
}
`;
