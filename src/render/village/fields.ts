/**
 * Fields on the terrain: shared conventions between the terrain shader
 * (furrows and crop colour from the per-cell fields texture) and the crop
 * model layer, so model rows sit on the painted rows.
 *
 * The fields texture is the snapshot's `fields` array uploaded as RGBA8:
 * R = LandUse, G = crop stage (0 bare/ploughed, 8 sown, ≥ 230 ripe),
 * B = crop stress (see STRESS_WET in protocol.ts), A unused.
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

// Desire paths: trodden earth, blended between cell centres with a noisy,
// organic edge and a little grass still showing along the middle.
vec3 pathColour(vec3 ground, vec3 world) {
  vec2 q = world.xz - 0.5;
  ivec2 c = ivec2(floor(q));
  vec2 f = fract(q);
  float a = pathAt(c);
  float b = pathAt(c + ivec2(1, 0));
  float d = pathAt(c + ivec2(0, 1));
  float e = pathAt(c + ivec2(1, 1));
  if (a + b + d + e < 0.5) return ground;
  f = f * f * (3.0 - 2.0 * f);
  float p = mix(mix(a, b, f.x), mix(d, e, f.x), f.y);
  float n = fieldNoise(world.xz * 2.1 + 7.3) * 0.6 + fieldNoise(world.xz * 6.5) * 0.4;
  float m = smoothstep(0.32, 0.62, p + (n - 0.5) * 0.45);
  vec3 earth = uPath * mix(0.9, 1.08, fieldNoise(world.xz * 4.7 + 1.9));
  // Tufts of grass survive where fewer feet go.
  float tuft = smoothstep(0.62, 0.8, fieldNoise(world.xz * 9.0 + 3.3)) * (1.0 - smoothstep(0.75, 1.0, p));
  return mix(ground, earth, m * (0.92 - 0.6 * tuft));
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
  if (lu != 1) return ground;
  float crop = fd.g;
  bool alongX = (patchHash(c / ${PATCH}) & 1u) == 1u;
  float t = (alongX ? world.z : world.x) * ${ROWS_PER_CELL}.0;
  // 1 on a ridge (crop row), 0 in the furrow between.
  float row = 0.5 + 0.5 * cos(6.2831853 * t);
  float aa = 1.0 - smoothstep(0.18, 0.5, fwidth(t));
  float rowA = mix(0.5, row, aa);
  vec3 soil = uFieldSoil * mix(0.72, 1.12, rowA);
  float g = clamp((crop - ${CROP_SOWN}.0) / (${CROP_RIPE}.0 - ${CROP_SOWN}.0), 0.0, 1.0);
  // Crop stress (dry, wet), and noise for patches.
  vec2 st = stressAt(world.xz);
  float pn = fieldNoise(world.xz * 1.7 + 3.1) * 0.65 + fieldNoise(world.xz * 4.3) * 0.35;
  // Dry: pale, cracked-looking soil; wet: dark mud.
  soil = mix(soil, vec3(0.50, 0.36, 0.20) * mix(0.85, 1.08, rowA), st.x * 0.75);
  soil = mix(soil, vec3(0.13, 0.085, 0.05) * mix(0.8, 1.1, rowA), st.y * 0.7);
  // Ground covered by the crop: rows widen as the crop grows; stress thins them in patches.
  float cover = crop < ${CROP_SOWN}.0 ? 0.0 : mix(0.12, 1.05, smoothstep(0.0, 0.55, g));
  cover *= 1.0 - st.x * smoothstep(0.3, 0.6, pn) * 0.95 - st.y * smoothstep(0.45, 0.75, pn) * 0.6;
  float rowMask = smoothstep(1.0 - cover - 0.08, 1.0 - cover + 0.08, row);
  rowMask = mix(cover * 0.9, rowMask, aa);
  vec3 cropCol = mix(uCropYoung, uCropGreen, smoothstep(0.1, 0.5, g));
  cropCol = mix(cropCol, mix(uCropGreen, uCropRipe, 0.45), smoothstep(0.72, 0.95, g));
  if (crop >= ${CROP_RIPE}.0) cropCol = uCropRipe;
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
