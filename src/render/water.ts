/**
 * Water layer: the shared chunk grid, raised to terrain + depth (mixed between
 * the previous and current snapshot). Dry vertices next to wet ones take the
 * highest neighbouring wet surface so the depth test cuts a smooth waterline;
 * dry areas are pushed below the terrain and discarded.
 */
import * as THREE from 'three';
import { HEIGHT_SCALE } from './coords';
import { VEL_SCALE } from '../shared/protocol';
import { CHUNK, GRID_VERTEX_GLSL, chunkOrigins } from './grid';
import { PLAN_GLSL } from './planOverlay';
import { CLOUD_SHADOW_GLSL, type FrontUniforms } from './weather';
import { FOG_GLSL, type FogUniforms } from './fog';

/** Depth (m) above which a cell counts as wet for rendering. */
export const WET_DEPTH = 0.01;

export interface WaterUniforms extends FrontUniforms {
  [k: string]: THREE.IUniform;
  uPlan: { value: THREE.Texture };
  uPreview: { value: THREE.Texture };
  uPlanOn: { value: number };
  uPreviewOn: { value: number };
  uTerrain: { value: THREE.Texture };
  uDepthA: { value: THREE.Texture };
  uDepthB: { value: THREE.Texture };
  uVel: { value: THREE.Texture };
  uNoise: { value: THREE.Texture };
  uMix: { value: number };
  uGrid: { value: THREE.Vector2 };
  uHeightScale: { value: number };
  uTime: { value: number };
  uSunDir: { value: THREE.Vector3 };
  uSunColor: { value: THREE.Color };
  uSkyColor: { value: THREE.Color };
  uGroundColor: { value: THREE.Color };
  uViewDir: { value: THREE.Vector3 };
  uShallow: { value: THREE.Color };
  uDeep: { value: THREE.Color };
  uFoam: { value: THREE.Color };
}

const VERT = /* glsl */ `
uniform highp sampler2D uTerrain;
uniform highp sampler2D uDepthA;
uniform highp sampler2D uDepthB;
uniform sampler2D uVel;
uniform vec2 uGrid;
uniform float uHeightScale;
uniform float uMix;
uniform float uTime;
varying vec3 vWorld;
varying float vDepth;
varying vec2 vVel;
${FOG_GLSL}

float depthAt(ivec2 c) {
  return mix(texelFetch(uDepthA, c, 0).r, texelFetch(uDepthB, c, 0).r, uMix);
}

vec2 velAt(ivec2 c) {
  vec2 b = texelFetch(uVel, c, 0).rg * 255.0;
  b = mix(b, b - 256.0, step(127.5, b));
  return b * (${VEL_SCALE.toFixed(1)} / 127.0);
}

void main() {
  ${GRID_VERTEX_GLSL}
  ivec2 C = gridCell;
  float h = texelFetch(uTerrain, C, 0).r;
  float d = depthAt(C);
  float surf;
  float dep;
  vec2 vel = vec2(0.0);
  // Fog of war: no water on unknown land.
  if (revealAt(vec2(C)) < 0.4) d = 0.0;
  if (d > ${WET_DEPTH}) {
    surf = h + d;
    dep = d;
    vel = velAt(C);
  } else {
    float best = -1e9;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        if (i == 0 && j == 0) continue;
        ivec2 n = clamp(C + ivec2(i, j), ivec2(0), gridMax);
        float dn = depthAt(n);
        if (dn > ${WET_DEPTH}) best = max(best, texelFetch(uTerrain, n, 0).r + dn);
      }
    }
    if (best > -1e8) {
      // Below a higher bank: extend the neighbour's surface so the depth test
      // cuts the waterline. If the neighbour's surface is above this (dry)
      // vertex — sheet flow on a slope — meet the ground here instead of
      // floating a ledge above it.
      surf = min(best, h);
      dep = surf - h;
    } else {
      surf = h - 4.0;
      dep = -1.0;
    }
  }
  vec3 world = vec3(float(C.x) + 0.5, surf * uHeightScale, float(C.y) + 0.5);
  // Gentle bobbing of open water: animated facets read as lively water.
  float bob = smoothstep(0.05, 0.8, dep);
  world.y += bob * 0.06 * (sin(uTime * 1.7 + world.x * 1.3 + world.z * 0.7) + 0.6 * sin(uTime * 2.3 - world.z * 1.1 + world.x * 0.4));
  vWorld = world;
  vDepth = dep;
  vVel = vel;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const FRAG = /* glsl */ `
#include <common>
uniform highp sampler2D uTerrain;
uniform highp sampler2D uPlan;
uniform highp sampler2D uPreview;
uniform float uPlanOn;
uniform float uPreviewOn;
uniform vec2 uGrid;
uniform sampler2D uNoise;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform vec3 uViewDir;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uFoam;
varying vec3 vWorld;
varying float vDepth;
varying vec2 vVel;
${PLAN_GLSL}
${CLOUD_SHADOW_GLSL}
${FOG_GLSL}

void main() {
  if (vDepth <= 0.0) discard;
  float fogA = 1.0;
  if (uFogOn > 0.5) {
    vec2 fc = vWorld.xz - 0.5;
    fogA = smoothstep(0.45, 0.8, revealAt(fc) + (fogBillow(fc, uTime) - 0.5) * 0.3);
    if (fogA <= 0.0) discard;
  }
  vec3 fn = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  if (fn.y < 0.0) fn = -fn;

  // Flow-mapped ripples: two phases of the noise advected along the velocity.
  float speed = length(vVel);
  vec2 flow = vVel * 0.26;
  float ph0 = fract(uTime * 0.35);
  float ph1 = fract(uTime * 0.35 + 0.5);
  float w1 = abs(1.0 - 2.0 * ph0);
  vec2 uv = vWorld.xz * 0.11;
  vec2 drift = vec2(uTime * 0.012, uTime * 0.008);
  vec4 n0 = texture(uNoise, uv - flow * ph0 + drift);
  vec4 n1 = texture(uNoise, uv - flow * ph1 + drift + vec2(0.47, 0.21));
  vec4 nz = mix(n0, n1, w1);
  vec4 nf = texture(uNoise, vWorld.xz * 0.33 - flow * ph0 * 2.0 - drift * 2.0);
  vec2 rip = (nz.rg - 0.5) * 1.1 + (nf.rg - 0.5) * 0.6;
  vec3 n = normalize(fn + vec3(rip.x, 0.0, rip.y) * 0.55);

  float deepT = 1.0 - exp(-vDepth / 1.6);
  vec3 base = mix(uShallow, uDeep, deepT);

  float ndl = max(dot(n, uSunDir), 0.0);
  vec3 amb = mix(uGroundColor, uSkyColor, n.y * 0.5 + 0.5);
  vec3 lit = base * (amb + uSunColor * (0.35 + 0.65 * ndl)) * RECIPROCAL_PI;

  // Sun glint.
  vec3 H = normalize(uSunDir + uViewDir);
  float spec = pow(max(dot(n, H), 0.0), 90.0) * 0.9;
  float sparkle = smoothstep(0.82, 0.95, nf.a) * pow(max(dot(fn, H), 0.0), 8.0) * 0.6;
  vec3 glint = uSunColor * (spec + sparkle) * RECIPROCAL_PI;

  // Foam: on fast flow and along the shore.
  float fast = smoothstep(1.0, 3.0, speed);
  float shore = 1.0 - smoothstep(0.0, 0.15, vDepth);
  float shoreWave = 0.5 + 0.5 * sin(uTime * 2.0 + nz.b * 12.0);
  // Foam streaks stretched along the flow.
  vec2 fdir = speed > 0.01 ? vVel / speed : vec2(1.0, 0.0);
  vec2 sp = vec2(dot(vWorld.xz, fdir), dot(vWorld.xz, vec2(-fdir.y, fdir.x)));
  float streak = texture(uNoise, vec2(sp.x * 0.08 - uTime * speed * 0.05, sp.y * 0.45)).b;
  float mask = max(fast * 0.55, shore * mix(0.3, 0.6, shoreWave));
  float fn2 = mix(mix(nz.b, nf.b, 0.5), streak, fast);
  float foam = smoothstep(1.0 - mask, 1.0 - mask + 0.1, fn2);
  vec3 foamCol = uFoam * (amb + uSunColor) * RECIPROCAL_PI;

  // Stylised sky reflection and soft ripple highlights (readable from any sun angle).
  float fres = 0.12 + 0.25 * (1.0 - n.y);
  vec3 refl = uSkyColor * RECIPROCAL_PI * 1.3;
  float hl = smoothstep(0.62, 0.78, nz.r * 0.6 + nf.g * 0.4) * 0.22;
  lit = mix(lit, refl, fres) + uSunColor * RECIPROCAL_PI * hl * 0.5;
  // Crisp foam line at the very edge of the water.
  float edge = 1.0 - smoothstep(0.015, 0.05 + 0.03 * nf.b, vDepth);
  foam = max(foam, edge * 0.85);
  vec3 col = mix(lit + glint, foamCol, foam * 0.9);
  float alpha = mix(0.62, 0.9, deepT);
  alpha = max(alpha, foam * 0.85);
  col *= cloudShadow(vWorld.xz);

  // Plans stay visible under water: stripes + outline drawn on the surface.
  vec2 cell = vWorld.xz - 0.5;
  if (uPlanOn > 0.5) {
    vec4 t = planOverlay(uPlan, cell, 0.35, 1.0, 0.16);
    vec3 pc = t.rgb * (amb + uSunColor) * RECIPROCAL_PI;
    float pa = clamp(t.a * 1.45, 0.0, 0.92);
    col = mix(col, pc, pa);
    alpha = max(alpha, pa);
  }
  if (uPreviewOn > 0.5) {
    vec4 t = planOverlay(uPreview, cell, 0.8, 1.35, 0.16);
    vec3 pc = mix(t.rgb, vec3(1.0), 0.15) * (amb + uSunColor) * RECIPROCAL_PI;
    float pa = clamp(t.a * 1.3, 0.0, 0.95);
    col = mix(col, pc, pa);
    alpha = max(alpha, pa);
  }
  alpha *= smoothstep(0.0, 0.05, vDepth) * fogA;
  gl_FragColor = vec4(col, alpha);
  #include <colorspace_fragment>
}
`;

export function createWaterUniforms(
  tex: {
    terrain: THREE.Texture;
    depthA: THREE.Texture;
    depthB: THREE.Texture;
    vel: THREE.Texture;
    noise: THREE.Texture;
    plan: THREE.Texture;
    preview: THREE.Texture;
  },
  width: number,
  height: number,
  fronts: FrontUniforms,
  fog: FogUniforms,
): WaterUniforms {
  return {
    ...fronts,
    ...fog,
    uPlan: { value: tex.plan },
    uPreview: { value: tex.preview },
    uPlanOn: { value: 0 },
    uPreviewOn: { value: 0 },
    uTerrain: { value: tex.terrain },
    uDepthA: { value: tex.depthA },
    uDepthB: { value: tex.depthB },
    uVel: { value: tex.vel },
    uNoise: { value: tex.noise },
    uMix: { value: 1 },
    uGrid: { value: new THREE.Vector2(width, height) },
    uHeightScale: { value: HEIGHT_SCALE },
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(1, 1, 1) },
    uSkyColor: { value: new THREE.Color(0.5, 0.6, 0.8) },
    uGroundColor: { value: new THREE.Color(0.3, 0.3, 0.25) },
    uViewDir: { value: new THREE.Vector3(0, 1, 0) },
    uShallow: { value: new THREE.Color(0x5fe0d2) },
    uDeep: { value: new THREE.Color(0x2c78d4) },
    uFoam: { value: new THREE.Color(0xffffff) },
  };
}

export class WaterLayer {
  readonly group = new THREE.Group();
  readonly material: THREE.ShaderMaterial;
  readonly meshes: THREE.Mesh[] = [];
  private readonly origins: [number, number][];

  constructor(
    geometry: THREE.BufferGeometry,
    readonly uniforms: WaterUniforms,
    private readonly width: number,
    private readonly height: number,
  ) {
    this.group.name = 'water';
    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
    this.origins = chunkOrigins(width, height);
    for (const [ox, oy] of this.origins) {
      const m = new THREE.Mesh(geometry, this.material);
      m.name = `water-${ox / CHUNK}-${oy / CHUNK}`;
      m.position.set(ox + 0.5, 0, oy + 0.5);
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      m.renderOrder = 10;
      this.meshes.push(m);
      this.group.add(m);
    }
  }

  /** Chunks entirely under the fog of war (never drawn). */
  hiddenChunks: boolean[] = [];

  /** Hide chunks with no wet cell (including a one-cell margin) in either depth buffer, or under fog. */
  updateVisibility(a: Float32Array, b: Float32Array): void {
    const w = this.width;
    const h = this.height;
    for (let k = 0; k < this.origins.length; k++) {
      const [ox, oy] = this.origins[k]!;
      if (this.hiddenChunks[k]) {
        this.meshes[k]!.visible = false;
        continue;
      }
      const x0 = Math.max(0, ox - 1);
      const y0 = Math.max(0, oy - 1);
      const x1 = Math.min(w, ox + CHUNK + 2);
      const y1 = Math.min(h, oy + CHUNK + 2);
      let wet = false;
      for (let y = y0; y < y1 && !wet; y++) {
        const row = y * w;
        for (let x = x0; x < x1; x++) {
          if (a[row + x]! > WET_DEPTH || b[row + x]! > WET_DEPTH) {
            wet = true;
            break;
          }
        }
      }
      this.meshes[k]!.visible = wet;
    }
  }

  dispose(): void {
    this.material.dispose();
  }
}
