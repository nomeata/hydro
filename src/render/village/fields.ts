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

/** Expand snapshot fields (FIELD_BYTES per cell) into RGBA texels. */
export function fieldsToRgba(src: Uint8Array, dst: Uint8Array, n: number): void {
  for (let i = 0; i < n; i++) {
    dst[4 * i] = src[FIELD_BYTES * i]!;
    dst[4 * i + 1] = src[FIELD_BYTES * i + 1]!;
    dst[4 * i + 2] = src[FIELD_BYTES * i + 2]!;
    dst[4 * i + 3] = src[FIELD_BYTES * i + 3]!;
  }
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

float pathAt(ivec2 c) {
  return abs(fieldAt(c).r - 4.0) < 0.5 ? 1.0 : 0.0;
}

// How much of a desire path covers this point (0..1): blended between cell
// centres with a noisy, organic edge. Also tramples the snow (terrain.ts).
float pathMask(vec3 world, out float p) {
  p = 0.0;
  if (uFieldsOn < 0.5) return 0.0;
  vec2 q = world.xz - 0.5;
  ivec2 c = ivec2(floor(q));
  vec2 f = fract(q);
  float a = pathAt(c);
  float b = pathAt(c + ivec2(1, 0));
  float d = pathAt(c + ivec2(0, 1));
  float e = pathAt(c + ivec2(1, 1));
  if (a + b + d + e < 0.5) return 0.0;
  f = f * f * (3.0 - 2.0 * f);
  p = mix(mix(a, b, f.x), mix(d, e, f.x), f.y);
  float n = fieldNoise(world.xz * 2.1 + 7.3) * 0.6 + fieldNoise(world.xz * 6.5) * 0.4;
  return smoothstep(0.32, 0.62, p + (n - 0.5) * 0.45);
}

// Desire paths: trodden earth with a little grass still showing along the middle.
vec3 pathColour(vec3 ground, vec3 world) {
  float p;
  float m = pathMask(world, p);
  if (m <= 0.0) return ground;
  vec3 earth = uPath * mix(0.9, 1.08, fieldNoise(world.xz * 4.7 + 1.9));
  // Tufts of grass survive where fewer feet go.
  float tuft = smoothstep(0.62, 0.8, fieldNoise(world.xz * 9.0 + 3.3)) * (1.0 - smoothstep(0.75, 1.0, p));
  return mix(ground, earth, m * (0.92 - 0.6 * tuft));
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
