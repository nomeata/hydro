/**
 * Terrain layer: shared chunk grid displaced by the terrain height texture,
 * flat-shaded (dFdx/dFdy) MeshLambertMaterial with ground colours from the
 * per-cell look texture and an animated plan overlay.
 */
import * as THREE from 'three';
import { HEIGHT_SCALE } from './coords';
import { CHUNK, GRID_VERTEX_GLSL, chunkOrigins } from './grid';
import { PLAN_GLSL } from './planOverlay';
import { CLOUD_SHADOW_GLSL, type FrontUniforms } from './weather';
import { FIELDS_GLSL } from './village/fields';
import { FOG_GLSL, FOG_VERTEX_GLSL, type FogUniforms } from './fog';

/** Soil base colours (sRGB), indexed by SoilType. */
export const SOIL_COLOURS: readonly number[] = [
  0x9c9a94, // rock
  0xb9a990, // gravel
  0xecd59c, // sand
  0x9a7448, // loam (bare)
  0xc98f52, // clay (ochre)
  0x7f5a3a, // silt (rich brown)
  0x4a3a2e, // peat (brown-black)
];

export interface TerrainTextures {
  terrain: THREE.DataTexture;
  look: THREE.DataTexture;
  plan: THREE.DataTexture;
  preview: THREE.DataTexture;
  /** Land use and crop stage (RG8), see village/fields.ts. */
  fields: THREE.DataTexture;
}

export interface TerrainUniforms extends FrontUniforms, FogUniforms {
  uTerrain: { value: THREE.Texture };
  uLook: { value: THREE.Texture };
  uPlan: { value: THREE.Texture };
  uPreview: { value: THREE.Texture };
  uGrid: { value: THREE.Vector2 };
  uHeightScale: { value: number };
  uSkirtY: { value: number };
  uTime: { value: number };
  uPlanOn: { value: number };
  uPreviewOn: { value: number };
  uSoil: { value: THREE.Color[] };
  uGrassDry: { value: THREE.Color };
  uGrassLush: { value: THREE.Color };
  uForest: { value: THREE.Color };
  uSnow: { value: THREE.Color };
  uFields: { value: THREE.Texture };
  uFieldsOn: { value: number };
  uFieldSoil: { value: THREE.Color };
  uCropYoung: { value: THREE.Color };
  uCropGreen: { value: THREE.Color };
  uCropRipe: { value: THREE.Color };
  uYard: { value: THREE.Color };
  uStubble: { value: number };
}

const COMMON_GLSL = /* glsl */ `
uniform highp sampler2D uTerrain;
uniform vec2 uGrid;
uniform float uHeightScale;
uniform float uSkirtY;
uniform float uTime;
${FOG_GLSL}
`;

const VARYINGS = /* glsl */ `
centroid varying vec3 vTerrWorld;
varying float vSkirt;
`;

const VERTEX_DISPLACE = /* glsl */ `
  vec3 transformed;
  {
    ${GRID_VERTEX_GLSL}
    float hY = texelFetch(uTerrain, gridCell, 0).r * uHeightScale;
    {
      // Fog of war: hidden land becomes the cloud sea.
      vec2 fogCell = vec2(gridCell);
      ${FOG_VERTEX_GLSL}
    }
    float yy = gridSkirt ? min(uSkirtY, hY - 1.0) : hY;
    vec3 world = vec3(float(gridCell.x) + 0.5, yy, float(gridCell.y) + 0.5);
    transformed = world - modelMatrix[3].xyz;
    #ifdef TERRAIN_VARYINGS
      vTerrWorld = world;
      vSkirt = gridSkirt ? 1.0 : 0.0;
    #endif
  }
`;

const FRAGMENT_PARS = /* glsl */ `
uniform sampler2D uLook;
uniform highp sampler2D uPlan;
uniform highp sampler2D uPreview;
uniform float uPlanOn;
uniform float uPreviewOn;
uniform vec3 uSoil[7];
uniform vec3 uGrassDry;
uniform vec3 uGrassLush;
uniform vec3 uForest;
uniform vec3 uSnow;

float tHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

vec4 lookAt(ivec2 c) {
  return texelFetch(uLook, clamp(c, ivec2(0), ivec2(uGrid) - 1), 0);
}

vec3 soilBase(vec4 l) {
  int s = int(l.r * 255.0 + 0.5);
  return uSoil[clamp(s, 0, 6)];
}

${PLAN_GLSL}
${CLOUD_SHADOW_GLSL}
${FIELDS_GLSL}
`;

const FRAGMENT_COLOUR = /* glsl */ `
  vec3 planGlow = vec3(0.0);
  vec3 fogGlow = vec3(0.0);
  {
    vec3 groundCol;
    if (vSkirt > 0.001) {
      // Diorama side wall: layered earth / stone strata.
      float band = floor(vTerrWorld.y * 0.9);
      float hb = tHash(vec2(band, 3.7));
      vec3 dirt = vec3(0.36, 0.24, 0.15);
      vec3 stone = mix(vec3(0.42, 0.38, 0.34), vec3(0.5, 0.45, 0.4), hb);
      float topSoil = 1.0 - smoothstep(0.02, 0.12, vSkirt);
      groundCol = mix(stone, dirt, max(topSoil, step(0.7, hb) * 0.6));
    } else {
      vec2 cell = vTerrWorld.xz - 0.5;
      vec2 q = floor(cell);
      vec2 f = cell - q;
      ivec2 qi = ivec2(q);
      bool lower = f.x + f.y < 1.0;
      ivec2 c0 = lower ? qi : qi + ivec2(1, 1);
      ivec2 c1 = qi + ivec2(1, 0);
      ivec2 c2 = qi + ivec2(0, 1);
      vec4 l0 = lookAt(c0);
      vec4 l1 = lookAt(c1);
      vec4 l2 = lookAt(c2);
      vec3 base = (soilBase(l0) + soilBase(l1) + soilBase(l2)) / 3.0;
      vec4 l = (l0 + l1 + l2) / 3.0;
      float moist = l.g;
      float veg = l.b;
      float snow = l.a;
      // Vegetation: yellowish when dry, lush when moist, dark forest when dense.
      vec3 grass = mix(uGrassDry, uGrassLush, smoothstep(0.1, 0.6, moist));
      grass = mix(grass, uForest, smoothstep(0.62, 0.9, veg));
      vec3 c = mix(base, grass, smoothstep(0.04, 0.26, veg));
      // Fields (furrows, crops) and trampled earth around buildings.
      c = fieldColour(c, vTerrWorld);
      // Moisture darkens (wet soil), a little less under vegetation.
      c *= mix(1.0, 0.68, moist * mix(1.0, 0.45, veg));
      // Steep slopes show rock / bare earth.
      vec3 wn = normalize(cross(dFdx(vTerrWorld), dFdy(vTerrWorld)));
      float ny = abs(wn.y);
      float slope = sqrt(max(1.0 - ny * ny, 0.0)) / max(ny, 0.05);
      vec3 cliff = mix(vec3(0.30, 0.18, 0.09), uSoil[0], smoothstep(1.0, 1.8, slope));
      c = mix(c, cliff, smoothstep(0.55, 1.1, slope) * 0.85);
      // Snow.
      c = mix(c, uSnow, smoothstep(0.15, 0.6, snow));
      // Per-triangle variation.
      float n = tHash(q * 2.0 + (lower ? 0.0 : 1.0) + 0.5);
      c *= 0.9 + 0.16 * n;
      c.g *= 0.98 + 0.04 * tHash(q + 17.0);
      groundCol = c;

      // Plan overlays (existing plan, then optimistic preview on top).
      if (uPlanOn > 0.5) {
        vec4 t = planOverlay(uPlan, cell, 0.35, 1.0, 0.14);
        groundCol = mix(groundCol, t.rgb, t.a);
        planGlow += t.rgb * t.a * 0.12;
      }
      if (uPreviewOn > 0.5) {
        vec4 t = planOverlay(uPreview, cell, 0.8, 1.35, 0.14);
        groundCol = mix(groundCol, mix(t.rgb, vec3(1.0), 0.15), t.a);
        planGlow += t.rgb * t.a * 0.2;
      }
    }
    // Fog of war: a soft, billowing haze over unknown land (and its side walls).
    if (uFogOn > 0.5) {
      vec2 fc = vTerrWorld.xz - 0.5;
      float rv = revealAt(fc);
      if (rv < 0.999) {
        float fb = fogBillow(fc, uTime);
        float fogT = 1.0 - smoothstep(0.2, 0.8, rv + (fb - 0.5) * 0.45);
        vec3 fcol = fogColour(fogBillow(fc * 1.9 + 3.1, uTime * 1.4));
        groundCol = mix(groundCol, fcol, fogT);
        planGlow *= 1.0 - fogT;
        fogGlow = fcol * fogT * 0.38;
      }
    }
    if (vSkirt <= 0.001) groundCol *= cloudShadow(vTerrWorld.xz);
    diffuseColor.rgb = groundCol;
  }
`;

export function createTerrainUniforms(
  tex: TerrainTextures,
  width: number,
  height: number,
  fronts: FrontUniforms,
  fog: FogUniforms,
): TerrainUniforms {
  return {
    ...fronts,
    ...fog,
    uTerrain: { value: tex.terrain },
    uLook: { value: tex.look },
    uPlan: { value: tex.plan },
    uPreview: { value: tex.preview },
    uGrid: { value: new THREE.Vector2(width, height) },
    uHeightScale: { value: HEIGHT_SCALE },
    uSkirtY: { value: -2 },
    uTime: { value: 0 },
    uPlanOn: { value: 0 },
    uPreviewOn: { value: 0 },
    uSoil: { value: SOIL_COLOURS.map((c) => new THREE.Color(c)) },
    uGrassDry: { value: new THREE.Color(0xa8bf58) },
    uGrassLush: { value: new THREE.Color(0x62b44a) },
    uForest: { value: new THREE.Color(0x3c8640) },
    uSnow: { value: new THREE.Color(0xf3f6fb) },
    uFields: { value: tex.fields },
    uFieldsOn: { value: 0 },
    uFieldSoil: { value: new THREE.Color(0x8a5d3b) },
    uCropYoung: { value: new THREE.Color(0x7fb04a) },
    uCropGreen: { value: new THREE.Color(0x5e9e3a) },
    uCropRipe: { value: new THREE.Color(0xe8c050) },
    uYard: { value: new THREE.Color(0xa08060) },
    uStubble: { value: 0 },
  };
}

export function createTerrainMaterial(u: TerrainUniforms): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n#define TERRAIN_VARYINGS\n${COMMON_GLSL}\n${VARYINGS}`)
      .replace('#include <begin_vertex>', VERTEX_DISPLACE);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${COMMON_GLSL}\n${VARYINGS}\n${FRAGMENT_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAGMENT_COLOUR}`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += planGlow + fogGlow;');
  };
  mat.customProgramCacheKey = () => 'hydro-terrain-v4';
  return mat;
}

/** Depth material for shadow casting (same displacement). */
export function createTerrainDepthMaterial(u: TerrainUniforms): THREE.MeshDepthMaterial {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTerrain = u.uTerrain;
    shader.uniforms.uGrid = u.uGrid;
    shader.uniforms.uHeightScale = u.uHeightScale;
    shader.uniforms.uSkirtY = u.uSkirtY;
    shader.uniforms.uTime = u.uTime;
    shader.uniforms.uReveal = u.uReveal;
    shader.uniforms.uFogH = u.uFogH;
    shader.uniforms.uFogGrid = u.uFogGrid;
    shader.uniforms.uFogOn = u.uFogOn;
    shader.uniforms.uFogHigh = u.uFogHigh;
    shader.uniforms.uFogLow = u.uFogLow;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${COMMON_GLSL}`)
      .replace('#include <begin_vertex>', VERTEX_DISPLACE);
  };
  mat.customProgramCacheKey = () => 'hydro-terrain-depth-v2';
  return mat;
}

export class TerrainLayer {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshLambertMaterial;
  readonly depthMaterial: THREE.MeshDepthMaterial;
  readonly meshes: THREE.Mesh[] = [];

  constructor(geometry: THREE.BufferGeometry, readonly uniforms: TerrainUniforms, width: number, height: number) {
    this.group.name = 'terrain';
    this.material = createTerrainMaterial(uniforms);
    this.depthMaterial = createTerrainDepthMaterial(uniforms);
    for (const [ox, oy] of chunkOrigins(width, height)) {
      const m = new THREE.Mesh(geometry, this.material);
      m.name = `terrain-${ox / CHUNK}-${oy / CHUNK}`;
      m.position.set(ox + 0.5, 0, oy + 0.5);
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      m.customDepthMaterial = this.depthMaterial;
      m.receiveShadow = true;
      this.meshes.push(m);
      this.group.add(m);
    }
  }

  setCastShadow(on: boolean): void {
    for (const m of this.meshes) m.castShadow = on;
  }

  dispose(): void {
    this.material.dispose();
    this.depthMaterial.dispose();
  }
}
