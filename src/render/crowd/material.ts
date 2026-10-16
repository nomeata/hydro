/**
 * Shader patches for the crowd: GPU skinning from a baked bone texture on
 * top of MeshLambertMaterial (so lighting, fog and colour management match
 * the other objects), and the merged-prop selector.
 */
import * as THREE from 'three';
import { MAX_CLIPS } from './clips';
import type { BoneAnimation } from './bake';

const SKIN_HEAD = /* glsl */ `
uniform highp sampler2D uBoneTex;
uniform float uCrowdTime;
uniform vec4 uClips[${MAX_CLIPS}];
attribute vec4 aBoneIdx;
attribute vec4 aBoneW;
// Per instance: (clip, phase at uCrowdTime = 0, rate, weight of this clip vs aAnimPrev).
attribute vec4 aAnim;
attribute vec4 aAnimPrev;

// Mirrors clipFrames() in bake.ts. uClips[i] = (first row, frames, fps, -).
void crowdFrame(vec4 a, out int f0, out int f1, out float w) {
  vec4 c = uClips[int(a.x + 0.5)];
  float t = (a.y + uCrowdTime * a.z) * c.z;
  t -= floor(t / c.y) * c.y;
  float fi = floor(t);
  w = t - fi;
  float nx = fi + 1.0 >= c.y ? 0.0 : fi + 1.0;
  f0 = int(c.x + min(fi, c.y - 1.0));
  f1 = int(c.x + nx);
}

mat4 crowdBone(int b, int f) {
  ivec2 p = ivec2(b * 3, f);
  vec4 r0 = texelFetch(uBoneTex, p, 0);
  vec4 r1 = texelFetch(uBoneTex, p + ivec2(1, 0), 0);
  vec4 r2 = texelFetch(uBoneTex, p + ivec2(2, 0), 0);
  return mat4(r0.x, r1.x, r2.x, 0.0, r0.y, r1.y, r2.y, 0.0, r0.z, r1.z, r2.z, 0.0, r0.w, r1.w, r2.w, 1.0);
}
`;

const SKIN_NORMAL = /* glsl */ `
int cf0; int cf1; float cw;
crowdFrame(aAnim, cf0, cf1, cw);
float crowdFade = aAnim.w;
int pf0 = 0; int pf1 = 0; float pw = 0.0;
if (crowdFade < 0.999) crowdFrame(aAnimPrev, pf0, pf1, pw);
mat4 crowdSkin = mat4(0.0);
for (int k = 0; k < 4; k++) {
  float bw = aBoneW[k];
  if (bw <= 0.0) continue;
  int b = int(aBoneIdx[k] + 0.5);
  mat4 m = crowdBone(b, cf0) * (1.0 - cw) + crowdBone(b, cf1) * cw;
  if (crowdFade < 0.999)
    m = m * crowdFade + (crowdBone(b, pf0) * (1.0 - pw) + crowdBone(b, pf1) * pw) * (1.0 - crowdFade);
  crowdSkin += bw * m;
}
vec3 objectNormal = normalize(mat3(crowdSkin) * normal);
`;

export interface SkinUniforms {
  uBoneTex: { value: THREE.Texture };
  uCrowdTime: { value: number };
  uClips: { value: THREE.Vector4[] };
}

export function clipTable(anim: BoneAnimation): THREE.Vector4[] {
  const out: THREE.Vector4[] = [];
  for (let i = 0; i < MAX_CLIPS; i++) {
    const c = anim.clips[i] ?? anim.clips[0]!;
    out.push(new THREE.Vector4(c.start, c.frames, c.fps, 0));
  }
  return out;
}

/** A Lambert material skinned on the GPU from `tex`. */
export function crowdSkinMaterial(map: THREE.Texture | null, tex: THREE.Texture, anim: BoneAnimation, time: { value: number }): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ map, vertexColors: true, name: 'crowd-skin' });
  const uniforms: SkinUniforms = { uBoneTex: { value: tex }, uCrowdTime: time, uClips: { value: clipTable(anim) } };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SKIN_HEAD}`)
      .replace('#include <beginnormal_vertex>', SKIN_NORMAL)
      .replace('#include <begin_vertex>', 'vec3 transformed = (crowdSkin * vec4(position, 1.0)).xyz;');
  };
  mat.customProgramCacheKey = () => 'crowd-skin-1';
  return mat;
}

/** Vertex-coloured Lambert material showing only the prop whose `aPropKind` matches the instance's `aKind`. */
export function crowdPropMaterial(): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, name: 'crowd-props' });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aPropKind;\nattribute float aKind;')
      .replace(
        '#include <begin_vertex>',
        'vec3 transformed = abs(aPropKind - aKind) < 0.5 ? position : vec3(0.0);',
      );
  };
  mat.customProgramCacheKey = () => 'crowd-props-1';
  return mat;
}
