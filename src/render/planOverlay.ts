/**
 * GLSL for the plan overlay (planned digging / raising), shared by the
 * terrain shader and the water surface shader so plans stay readable under
 * water. Requires `uniform highp sampler2D uTerrain; uniform vec2 uGrid;
 * uniform float uTime;` in the including shader.
 */
import { PLAN_NONE } from './textures';

export const PLAN_GLSL = /* glsl */ `
float planTarget(highp sampler2D tex, ivec2 c) {
  return texelFetch(tex, clamp(c, ivec2(0), ivec2(uGrid) - 1), 0).r;
}

bool planHas(highp sampler2D tex, ivec2 c) {
  if (c.x < 0 || c.y < 0 || c.x >= int(uGrid.x) || c.y >= int(uGrid.y)) return false;
  return texelFetch(tex, c, 0).r > ${PLAN_NONE / 2}.0;
}

// Plan overlay for fractional cell coordinates \`cell\` (cell i centre at i).
// Returns rgb + alpha: animated diagonal stripes inside the plan and a crisp
// outline along edges that border a cell without a plan.
// edgeW: outline width in cells.
vec4 planOverlay(highp sampler2D tex, vec2 cell, float speed, float boost, float edgeW) {
  ivec2 c = ivec2(floor(cell + 0.5));
  float target = planTarget(tex, c);
  if (target < ${PLAN_NONE / 2}.0) return vec4(0.0);
  float h = texelFetch(uTerrain, clamp(c, ivec2(0), ivec2(uGrid) - 1), 0).r;
  float diff = target - h;
  vec3 col;
  vec3 edgeCol;
  float a;
  if (diff < -0.05) { col = vec3(1.0, 0.42, 0.08); edgeCol = vec3(1.0, 0.55, 0.12); a = 0.45; }     // dig: orange
  else if (diff > 0.05) { col = vec3(0.36, 0.17, 0.06); edgeCol = vec3(0.98, 0.78, 0.36); a = 0.6; } // raise: earth brown
  else { col = vec3(1.0, 0.86, 0.45); edgeCol = vec3(1.0, 0.92, 0.6); a = 0.25; }                   // reached: pale gold
  vec2 wp = cell + 0.5;
  float stripe = step(0.5, fract((wp.x + wp.y) * 0.35 - uTime * speed));
  a *= mix(0.45, 1.0, stripe);
  // Outline where the neighbour has no plan.
  vec2 f = cell - vec2(c);
  float e = 0.0;
  float lo = 0.5 - edgeW;
  float hi = 0.5 - edgeW * 0.35;
  if (!planHas(tex, c + ivec2(1, 0))) e = max(e, smoothstep(lo, hi, f.x));
  if (!planHas(tex, c - ivec2(1, 0))) e = max(e, smoothstep(lo, hi, -f.x));
  if (!planHas(tex, c + ivec2(0, 1))) e = max(e, smoothstep(lo, hi, f.y));
  if (!planHas(tex, c - ivec2(0, 1))) e = max(e, smoothstep(lo, hi, -f.y));
  col = mix(col, edgeCol, e);
  a = mix(a, 0.95, e);
  return vec4(col, clamp(a * boost, 0.0, 0.95));
}
`;
