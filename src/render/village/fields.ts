/**
 * Fields on the terrain: shared conventions between the terrain shader
 * (furrows and crop colour from the per-cell fields texture) and the crop
 * model layer, so model rows sit on the painted rows.
 *
 * The fields texture is the snapshot's `fields` array uploaded as RG8:
 * R = LandUse, G = crop stage (0 bare/ploughed, 8 sown, ≥ 230 ripe).
 */

/** Cells per patch block: furrow direction and crop kind are constant per block. */
export const PATCH = 6;
/** Furrows (crop rows) per cell. */
export const ROWS_PER_CELL = 4;
/** Crop stage at which a field counts as ripe (sim: CROP_RIPE). */
export const CROP_RIPE = 230;
/** Crop stage of freshly sown fields. */
export const CROP_SOWN = 8;

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

uint patchHash(ivec2 b) {
  uint h = (uint(b.x) * 0x9e3779b1u) ^ (uint(b.y) * 0x85ebca77u);
  h ^= h >> 15u;
  h *= 0x2c1b3c6du;
  h ^= h >> 12u;
  return h;
}

vec2 fieldAt(ivec2 c) {
  return texelFetch(uFields, clamp(c, ivec2(0), ivec2(uGrid) - 1), 0).rg * 255.0;
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
  vec2 fd = fieldAt(c);
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
  // Ground covered by the crop: rows widen as the crop grows.
  float cover = crop < ${CROP_SOWN}.0 ? 0.0 : mix(0.12, 1.05, smoothstep(0.0, 0.55, g));
  float rowMask = smoothstep(1.0 - cover - 0.08, 1.0 - cover + 0.08, row);
  rowMask = mix(cover * 0.9, rowMask, aa);
  vec3 cropCol = mix(uCropYoung, uCropGreen, smoothstep(0.1, 0.5, g));
  cropCol = mix(cropCol, mix(uCropGreen, uCropRipe, 0.45), smoothstep(0.72, 0.95, g));
  if (crop >= ${CROP_RIPE}.0) cropCol = uCropRipe;
  cropCol *= mix(0.86, 1.06, rowA);
  vec3 col = mix(soil, cropCol, rowMask);
  return mix(ground, col, fieldEdge(c, f));
}
`;
