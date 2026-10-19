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
import { LINING_GLSL } from './structures/lining';
import { FOG_FRAGMENT_GLSL, FOG_GLSL, FOG_VERTEX_GLSL, type FogUniforms } from './fog';

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
  /** Land use, crop stage and crop stress (RGBA8), see village/fields.ts. */
  fields: THREE.DataTexture;
  /** Stone lining per cell (R8), see structures/lining.ts. */
  lining: THREE.DataTexture;
  /** Tileable noise (textures.ts makeNoiseTexture): breaks up the snow's edge. */
  noise: THREE.Texture;
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
  uSnowShade: { value: THREE.Color };
  uNoise: { value: THREE.Texture };
  /** Hoar frost on the grass on freezing days (0..1, from the air temperature). */
  uFrost: { value: number };
  /** 1 when any cell has snow or there is frost (the snow noise is fetched only then). */
  uSnowAny: { value: number };
  uFields: { value: THREE.Texture };
  uFieldsOn: { value: number };
  uFieldSoil: { value: THREE.Color };
  uCropYoung: { value: THREE.Color };
  uCropGreen: { value: THREE.Color };
  uCropRipe: { value: THREE.Color };
  uYard: { value: THREE.Color };
  uPath: { value: THREE.Color };
  uStubble: { value: number };
  uLining: { value: THREE.Texture };
  uLiningOn: { value: number };
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
${FOG_FRAGMENT_GLSL}
float fogVis = 1.0;
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
uniform vec3 uSnowShade;
uniform sampler2D uNoise;
uniform float uFrost;
uniform float uSnowAny;

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
${LINING_GLSL}
`;

const FRAGMENT_COLOUR = /* glsl */ `
  vec3 planGlow = vec3(0.0);
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
      // Vegetation: yellowish when dry, lush when moist, dark forest when dense.
      vec3 grass = mix(uGrassDry, uGrassLush, smoothstep(0.1, 0.6, moist));
      grass = mix(grass, uForest, smoothstep(0.62, 0.9, veg));
      vec3 c = mix(base, grass, smoothstep(0.04, 0.26, veg));
      // Fields (furrows, crops), desire paths and trampled earth around buildings.
      gMoist = moist;
      c = fieldColour(c, vTerrWorld);
      // Moisture darkens (wet soil), a little less under vegetation.
      c *= mix(1.0, 0.68, moist * mix(1.0, 0.45, veg));
      // Steep slopes show rock / bare earth.
      vec3 wn = normalize(cross(dFdx(vTerrWorld), dFdy(vTerrWorld)));
      float ny = abs(wn.y);
      float slope = sqrt(max(1.0 - ny * ny, 0.0)) / max(ny, 0.05);
      vec3 cliff = mix(vec3(0.30, 0.18, 0.09), uSoil[0], smoothstep(1.0, 1.8, slope));
      c = mix(c, cliff, smoothstep(0.55, 1.1, slope) * 0.85);
      // Snow and frost: skipped while the whole valley is free of both
      // (uSnowAny: a uniform, so the noise's derivatives stay defined).
      float cover = 0.0;
      if (uSnowAny > 0.5) {
        // Snow is smooth across cells: bilinear over the four cells around (the
        // fourth is the one this triangle does not touch), eased so no grid shows.
        float s3 = lookAt(lower ? qi + ivec2(1, 1) : qi).a;
        float s00 = lower ? l0.a : s3;
        float s11 = lower ? s3 : l0.a;
        vec2 fe = f * f * (3.0 - 2.0 * f);
        float snow = mix(mix(s00, l1.a, fe.x), mix(l2.a, s11, fe.x), fe.y);
        vec2 nuv = vTerrWorld.xz;
        float snowN = texture(uNoise, nuv * 0.045).r * 0.6 + texture(uNoise, nuv * 0.19 + 0.31).b * 0.4;
        // Hoar frost on freezing days: pale, bluish grass in patches.
        // (Not on the desire paths: feet scuff it off.)
        float pathP;
        float trod = pathMask(vTerrWorld, pathP);
        if (uFrost > 0.0) c = mix(c, vec3(0.80, 0.85, 0.88), uFrost * 0.55 * smoothstep(0.3, 0.75, snowN + 0.25 * veg) * (1.0 - 0.85 * trod));
        // Snow: soft-edged patches where it is thin (the noise decides which
        // ground shows first), less on steep slopes; white with a cool shade.
        cover = smoothstep(0.0, 0.18, snow - mix(0.12, 0.62, snowN) + 0.12) * (1.0 - 0.7 * smoothstep(0.9, 1.7, slope));
        vec3 snowCol = mix(uSnowShade, uSnow, smoothstep(0.35, 0.8, snowN + 0.3 * snow));
        // Desire paths through the snow: trodden, thinner, grey-brown slush
        // with darker wet ruts (the sim melts it faster too, soilwater.ts).
        if (trod > 0.0) {
          float rut = fieldNoise(nuv * 4.3 + 9.1) * 0.65 + fieldNoise(nuv * 11.0) * 0.35;
          cover = max(cover, smoothstep(0.0, 0.1, snow) * 0.9) * (1.0 - trod * 0.4 * smoothstep(0.45, 0.8, rut));
          // Grey-brown trampled slush, wet brown earth showing in patches, pocked
          // by countless feet (fine speckle), and a few white clumps left.
          vec3 slush = mix(vec3(0.29, 0.20, 0.12), vec3(0.56, 0.51, 0.45), smoothstep(0.3, 0.5, rut));
          slush *= mix(0.82, 1.06, fieldNoise(nuv * 23.0 + 3.7));
          slush = mix(slush, uSnowShade, smoothstep(0.75, 0.9, rut) * 0.55);
          // Two darker wet tracks along a well-trodden way.
          float lane = abs(gPathAcross) / max(gPathHalf, 0.05);
          slush *= 1.0 - 0.3 * (1.0 - smoothstep(0.1, 0.25, abs(lane - 0.5))) * smoothstep(0.2, 0.8, gPathWear);
          snowCol = mix(snowCol, slush, trod * mix(0.7, 0.92, pathP));
        }
        c = mix(c, snowCol, cover);
        // Snow glows a little (it reads white, not grey, under the soft winter light).
        planGlow += snowCol * cover * 0.1;
      }
      // Stone lining (cobbles), and planned lining.
      vec4 ln = liningColour(c, cell);
      c = mix(c, ln.rgb, ln.a);
      // Per-triangle variation.
      float n = tHash(q * 2.0 + (lower ? 0.0 : 1.0) + 0.5);
      c *= mix(0.9 + 0.16 * n, 0.98 + 0.03 * n, cover);
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
    // Fog of war: known land fades into the background; unknown land and the
    // map's side walls (until the edge is explored) are not drawn at all.
    if (uFogOn > 0.5) {
      vec2 fc = vTerrWorld.xz - 0.5;
      float rv = revealAt(fc);
      if (rv < 0.999) {
        float n = fogNoise(fc * 0.18) * 0.6 + fogNoise(fc * 0.55 + 4.7) * 0.4;
        fogVis = smoothstep(0.25, 0.85, rv + (n - 0.5) * 0.35);
        if (vSkirt > 0.001) fogVis = 0.0;
        if (fogVis <= 0.002) discard;
        planGlow *= fogVis;
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
    uSnow: { value: new THREE.Color(0xfbfdff) },
    uSnowShade: { value: new THREE.Color(0xd6e4f4) },
    uNoise: { value: tex.noise },
    uFrost: { value: 0 },
    uSnowAny: { value: 1 },
    uFields: { value: tex.fields },
    uFieldsOn: { value: 0 },
    uFieldSoil: { value: new THREE.Color(0x8a5d3b) },
    uCropYoung: { value: new THREE.Color(0x7fb04a) },
    uCropGreen: { value: new THREE.Color(0x5e9e3a) },
    uCropRipe: { value: new THREE.Color(0xe8c050) },
    uYard: { value: new THREE.Color(0xa08060) },
    uPath: { value: new THREE.Color(0xa4835a) },
    uStubble: { value: 0 },
    uLining: { value: tex.lining },
    uLiningOn: { value: 0 },
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
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += planGlow;')
      .replace(
        '#include <colorspace_fragment>',
        '#include <colorspace_fragment>\n  if (fogVis < 1.0) gl_FragColor.rgb = mix(linearToOutputTexel(vec4(fogBackground(), 1.0)).rgb, gl_FragColor.rgb, fogVis);',
      );
  };
  const withDefines = mat as unknown as { defines: Record<string, string> };
  withDefines.defines = {};
  mat.customProgramCacheKey = () => `hydro-terrain-v9${withDefines.defines.HYDRO_LINING !== undefined ? '-lined' : ''}`;
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
