/**
 * Snow on objects: a variant of an instanced object material that whitens
 * the upward-facing faces by a per-instance amount, and dulls green leaves
 * towards a wintry olive-brown. Both are done per vertex (the models are
 * low-poly and flat-shaded, so per face), which costs the fragment shader
 * nothing.
 *
 * Per instance, the attribute `aSnow` = (snow cap 0..1, winter dulling 0..1).
 * Meshes without the attribute read (0, 0): unchanged.
 */
import * as THREE from 'three';

export const SNOW_ATTRIBUTE = 'aSnow';

/** Fresh snow, faintly blue (linear). */
const SNOW = new THREE.Color().setHex(0xf2f7ff, THREE.SRGBColorSpace);

const cache = new WeakMap<THREE.Material, THREE.Material>();

/** GLSL injected after `beginnormal_vertex` (needs `objectNormal`, and `vColor` set by `color_vertex`). */
export const SNOW_CAP_VERTEX = /* glsl */ `
  #if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
  {
    #ifdef USE_INSTANCING
      vec3 snowUp = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);
    #else
      vec3 snowUp = normalize(mat3(modelMatrix) * objectNormal);
    #endif
    vec3 cv = vColor.rgb;
    #ifdef USE_COLOR
      // Leaves (greener than they are red or blue) fade in winter.
      float leaf = smoothstep(0.015, 0.08, color.g - max(color.r, color.b));
      float lum = dot(cv, vec3(0.3, 0.55, 0.15));
      cv = mix(cv, vec3(lum * 1.08, lum * 0.95, lum * 0.74), aSnow.y * leaf * 0.85);
    #endif
    vColor.rgb = mix(cv, uSnowCap, clamp(aSnow.x * smoothstep(0.2, 0.7, snowUp.y), 0.0, 1.0));
  }
  #endif
`;

/** The snow-capable variant of `base` (one per base material, shared). */
export function snowCapMaterial<M extends THREE.Material>(base: M): M {
  const hit = cache.get(base);
  if (hit) return hit as M;
  const m = base.clone() as M;
  m.name = `${base.name || 'object'}-snow`;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uSnowCap = { value: SNOW };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec2 ${SNOW_ATTRIBUTE};\nuniform vec3 uSnowCap;`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${SNOW_CAP_VERTEX}`);
  };
  m.customProgramCacheKey = () => `snowcap-v1-${base.customProgramCacheKey()}`;
  cache.set(base, m);
  return m;
}
