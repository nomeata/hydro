/**
 * Stone lining look, shared by the terrain shader (cobbles on the ground)
 * and the water shader (the cobbled bed showing through clear water).
 *
 * The lining texture is R8 per cell (protocol LINING_DONE): 0 none,
 * 1..253 planned with build progress, 254 a quay (dressed stone slabs with
 * a pale coping along the water), 255 lined (cobbles). Requires
 * `uniform vec2 uGrid; uniform float uTime;` in the including shader. The
 * full code is compiled only with `#define HYDRO_LINING` (see
 * GameRenderer.uploadLining), so worlds without lining pay nothing.
 */
import * as THREE from 'three';
import { LINING_DONE, LINING_QUAY } from '../../shared/protocol';

export function makeLiningTexture(width: number, height: number): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array(width * height), width, height, THREE.RedFormat, THREE.UnsignedByteType);
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.flipY = false;
  t.unpackAlignment = 1;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

export const LINING_GLSL = /* glsl */ `
uniform sampler2D uLining;
uniform float uLiningOn;

#ifdef HYDRO_LINING
float liningAt(ivec2 c) {
  if (c.x < 0 || c.y < 0 || c.x >= int(uGrid.x) || c.y >= int(uGrid.y)) return 0.0;
  return texelFetch(uLining, c, 0).r * 255.0;
}

float lHash(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

// Cobbles: jittered cells (3 per world cell) → stone id, mortar mask and
// a rounded "bulge" for shading. Returns (id hash, mortar, bulge, edge distance).
vec4 cobbles(vec2 wp) {
  vec2 p = wp * 3.0;
  vec2 ip = floor(p);
  vec2 fp = p - ip;
  float d1 = 8.0, d2 = 8.0;
  vec2 best = vec2(0.0);
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = vec2(lHash(ip + g), lHash(ip + g + 17.3)) * 0.7 + 0.15;
      vec2 r = g + o - fp;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; best = ip + g; }
      else if (d < d2) d2 = d;
    }
  float edge = sqrt(d2) - sqrt(d1);
  float mortar = 1.0 - smoothstep(0.05, 0.13, edge);
  return vec4(lHash(best + 3.1), mortar, smoothstep(0.0, 0.5, edge), edge);
}

// Lining colour over a ground colour c. cell: fractional cell coords.
// Returns rgb and coverage (0 = no lining here).
vec4 liningColour(vec3 c, vec2 cell) {
  if (uLiningOn < 0.5) return vec4(c, 0.0);
  ivec2 ci = ivec2(floor(cell + 0.5));
  float v = liningAt(ci);
  if (v < 0.5) return vec4(c, 0.0);
  vec2 wp = cell + 0.5;
  vec4 cb = cobbles(wp);
  vec3 stone = mix(vec3(0.56, 0.55, 0.52), vec3(0.72, 0.69, 0.63), cb.x);
  stone = mix(stone, vec3(0.62, 0.58, 0.50), step(0.8, cb.x) * 0.6);   // a few warm stones
  stone = mix(stone, vec3(0.48, 0.50, 0.50), step(cb.x, 0.12) * 0.6);  // and some bluish ones
  stone *= 0.86 + 0.2 * cb.z;
  vec3 mortarCol = vec3(0.36, 0.34, 0.31);
  vec3 lined = mix(stone, mortarCol, cb.y);
  // A darker kerb where the lining ends.
  vec2 f = cell - vec2(ci);
  float kerb = 0.0;
  if (liningAt(ci + ivec2(1, 0)) < 0.5) kerb = max(kerb, smoothstep(0.38, 0.5, f.x));
  if (liningAt(ci - ivec2(1, 0)) < 0.5) kerb = max(kerb, smoothstep(0.38, 0.5, -f.x));
  if (liningAt(ci + ivec2(0, 1)) < 0.5) kerb = max(kerb, smoothstep(0.38, 0.5, f.y));
  if (liningAt(ci - ivec2(0, 1)) < 0.5) kerb = max(kerb, smoothstep(0.38, 0.5, -f.y));
  if (v > ${LINING_DONE - 0.5}) {
    lined *= 1.0 - 0.28 * kerb;
    return vec4(lined, 1.0);
  }
  if (v > ${LINING_QUAY - 0.5}) {
    // Quay: dressed slabs in courses (two per cell, offset rows), pale and
    // neat, with a light coping stone where the quay meets the water.
    vec2 q = wp * vec2(2.0, 2.0);
    q.x += step(1.0, mod(floor(q.y), 2.0)) * 0.5;
    vec2 iq = floor(q);
    vec2 fq = q - iq;
    float h = lHash(iq + 7.7);
    float joint = 1.0 - smoothstep(0.03, 0.07, min(min(fq.x, 1.0 - fq.x), min(fq.y, 1.0 - fq.y)));
    vec3 slab = mix(vec3(0.74, 0.71, 0.65), vec3(0.83, 0.80, 0.73), h);
    slab = mix(slab, vec3(0.70, 0.64, 0.56), step(0.85, h) * 0.5);
    vec3 quay = mix(slab, vec3(0.47, 0.44, 0.40), joint * 0.85);
    float cope = 0.0;
    if (liningAt(ci + ivec2(1, 0)) < 0.5) cope = max(cope, smoothstep(0.30, 0.34, f.x));
    if (liningAt(ci - ivec2(1, 0)) < 0.5) cope = max(cope, smoothstep(0.30, 0.34, -f.x));
    if (liningAt(ci + ivec2(0, 1)) < 0.5) cope = max(cope, smoothstep(0.30, 0.34, f.y));
    if (liningAt(ci - ivec2(0, 1)) < 0.5) cope = max(cope, smoothstep(0.30, 0.34, -f.y));
    quay = mix(quay, vec3(0.90, 0.88, 0.82), cope);
    quay *= 1.0 - 0.3 * kerb * (1.0 - cope);
    return vec4(quay, 1.0);
  }
  // Planned: grey dashes, with stones laid as the work progresses.
  float prog = (v - 1.0) / 252.0;
  float stripe = step(0.5, fract((wp.x - wp.y) * 0.35 - uTime * 0.3));
  vec3 planCol = mix(c, vec3(0.80, 0.80, 0.84), mix(0.25, 0.5, stripe) + 0.4 * kerb);
  float laid = step(cb.x, prog) * (1.0 - cb.y);
  return vec4(mix(planCol, lined, laid), 1.0);
}
#else
// No lining anywhere yet: a trivial stand-in keeps the shader small (and
// quick to compile in software GL) until the first stones are planned.
vec4 liningColour(vec3 c, vec2 cell) { return vec4(c, 0.0); }
#endif
`;
