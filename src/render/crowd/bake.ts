/**
 * Baking skeletal animation into a "bone texture" for GPU crowd skinning.
 *
 * Why bone matrices and not vertex animation textures (VAT)? A Kenney
 * mini-character has ~1300 vertices but only 7 bones (cube pets: 5–7 rigid
 * parts). Per baked frame a VAT stores every vertex (1300 × RGBA ≈ 20 KB at
 * 32-bit) whereas a bone texture stores 7 × 3 texels (336 B): ~60× smaller,
 * so all clips of all models fit in a few KB and baking at 30 fps is free.
 * The vertex shader does 4–6 `texelFetch`es per vertex (every Kenney vertex
 * has a single bone of weight 1), which is cheap even on mobile GPUs.
 *
 * Layout: an RGBA32F texture, width = 3 × boneCount, height = total frames.
 * Row f holds frame f of the concatenated clips; texels 3b..3b+2 are the
 * three rows of bone b's 3×4 skinning matrix (bind space → animated bind
 * space, so `Σ w_b · M_b · v` gives the posed vertex in model space).
 * Sampled with `texelFetch` (NEAREST, no float filtering needed).
 *
 * Kept free of DOM access so it can be unit-tested in Node.
 */
import * as THREE from 'three';

export const BAKE_FPS = 30;

/** A clip to bake: a source clip, optionally with some bones' tracks taken from another clip. */
export interface ClipSpec {
  /** Name of the baked clip. */
  readonly name: string;
  /** Source clip name. */
  readonly source: string;
  /** Replace the tracks of these bones by those of `overrideSource` (e.g. walk legs + carrying arms). */
  readonly overrideBones?: readonly string[];
  readonly overrideSource?: string;
}

export interface BakedClip {
  readonly name: string;
  /** First row in the bone texture. */
  readonly start: number;
  /** Number of frames (the clip loops: frame `frames` ≡ frame 0). */
  readonly frames: number;
  readonly fps: number;
  /** Seconds (frames / fps). */
  readonly duration: number;
}

export interface BoneAnimation {
  readonly boneCount: number;
  readonly frameCount: number;
  /** frameCount × boneCount × 12 floats: per bone the 3 rows of a 3×4 matrix. */
  readonly data: Float32Array;
  readonly clips: readonly BakedClip[];
  readonly boneNames: readonly string[];
}

/** Split a track name like "arm-left.quaternion" into node and property. */
function trackNode(track: THREE.KeyframeTrack): string {
  return THREE.PropertyBinding.parseTrackName(track.name).nodeName ?? '';
}

/** Build the clip described by `spec` from the available clips (null if the source is missing). */
export function composeClip(clips: readonly THREE.AnimationClip[], spec: ClipSpec): THREE.AnimationClip | null {
  const src = clips.find((c) => c.name === spec.source);
  if (!src) return null;
  if (!spec.overrideBones?.length || !spec.overrideSource) return src;
  const ov = clips.find((c) => c.name === spec.overrideSource);
  if (!ov) return src;
  const bones = new Set(spec.overrideBones);
  const tracks = [
    ...src.tracks.filter((t) => !bones.has(trackNode(t))),
    ...ov.tracks.filter((t) => bones.has(trackNode(t))),
  ].map((t) => t.clone());
  return new THREE.AnimationClip(spec.name, src.duration, tracks);
}

/** Number of frames baked for a clip of `duration` seconds at `fps`. */
export function frameCountFor(duration: number, fps: number): number {
  return Math.max(1, Math.round(duration * fps));
}

/**
 * Bake `specs` of `mesh` (a SkinnedMesh below `root`, e.g. from
 * `unifyAnimated`) into bone matrices. `root` is posed by an AnimationMixer;
 * its own transform is ignored (matrices are relative to it).
 */
export function bakeBoneAnimation(
  root: THREE.Object3D,
  mesh: THREE.SkinnedMesh,
  clips: readonly THREE.AnimationClip[],
  specs: readonly ClipSpec[],
  fps = BAKE_FPS,
): BoneAnimation {
  const skeleton = mesh.skeleton;
  const bones = skeleton.bones as THREE.Object3D[];
  const boneCount = bones.length;
  // Rest pose of every node below root, restored before each sample so that
  // bones without tracks in a clip stay at rest.
  const nodes: THREE.Object3D[] = [];
  root.traverse((o) => nodes.push(o));
  const rest = nodes.map((o) => ({ p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() }));
  const restore = () => {
    for (let i = 0; i < nodes.length; i++) {
      nodes[i]!.position.copy(rest[i]!.p);
      nodes[i]!.quaternion.copy(rest[i]!.q);
      nodes[i]!.scale.copy(rest[i]!.s);
    }
  };
  const rootMatrix = root.matrix.clone();
  const rootParent = root.parent;
  root.removeFromParent();
  root.matrix.identity();
  root.matrix.decompose(root.position, root.quaternion, root.scale);

  const composed: { spec: ClipSpec; clip: THREE.AnimationClip }[] = [];
  for (const spec of specs) {
    const clip = composeClip(clips, spec) ?? composeClip(clips, { name: spec.name, source: 'idle' });
    if (clip) composed.push({ spec, clip });
  }
  const baked: BakedClip[] = [];
  let total = 0;
  for (const { spec, clip } of composed) {
    const frames = frameCountFor(clip.duration, fps);
    baked.push({ name: spec.name, start: total, frames, fps, duration: frames / fps });
    total += frames;
  }
  if (!composed.length) {
    baked.push({ name: 'rest', start: 0, frames: 1, fps, duration: 1 / fps });
    total = 1;
  }

  const data = new Float32Array(total * boneCount * 12);
  // Rest of rest-shape transform chain: v_model = Binv · bone.world · boneInv · B · v.
  root.updateMatrixWorld(true);
  const B = mesh.bindMatrix.clone();
  const Binv = mesh.bindMatrixInverse.clone();
  const m = new THREE.Matrix4();
  const writeFrame = (row: number) => {
    root.updateMatrixWorld(true);
    for (let b = 0; b < boneCount; b++) {
      m.multiplyMatrices(bones[b]!.matrixWorld, skeleton.boneInverses[b]!);
      m.premultiply(Binv).multiply(B);
      const e = m.elements;
      const o = (row * boneCount + b) * 12;
      for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) data[o + r * 4 + c] = e[c * 4 + r]!;
    }
  };

  if (!composed.length) {
    restore();
    writeFrame(0);
  }
  for (let k = 0; k < composed.length; k++) {
    const { clip } = composed[k]!;
    const bc = baked[k]!;
    // Evaluate the tracks directly (no AnimationMixer: its loop/enable state
    // machine is not meant for random access).
    const bound = clip.tracks.flatMap((track) => {
      const { nodeName, propertyName } = THREE.PropertyBinding.parseTrackName(track.name);
      const node = nodeName ? root.getObjectByName(nodeName) : null;
      if (!node || !['position', 'quaternion', 'scale'].includes(propertyName)) return [];
      return [{ node, prop: propertyName as 'position' | 'quaternion' | 'scale', interp: (track as unknown as { createInterpolant(): THREE.Interpolant }).createInterpolant() }];
    });
    for (let f = 0; f < bc.frames; f++) {
      restore();
      // Sample within [0, duration): the last frame wraps to the first.
      const t = (f / bc.frames) * clip.duration;
      for (const b of bound) {
        const v = b.interp.evaluate(t);
        if (b.prop === 'quaternion') b.node.quaternion.set(v[0]!, v[1]!, v[2]!, v[3]!).normalize();
        else b.node[b.prop].set(v[0]!, v[1]!, v[2]!);
      }
      writeFrame(bc.start + f);
    }
  }
  restore();
  root.matrix.copy(rootMatrix);
  root.matrix.decompose(root.position, root.quaternion, root.scale);
  rootParent?.add(root);
  root.updateMatrixWorld(true);

  return { boneCount, frameCount: total, data, clips: baked, boneNames: bones.map((b) => b.name) };
}

/** RGBA32F data texture of a bone animation (width 3·bones, height frames). */
export function boneTexture(anim: BoneAnimation): THREE.DataTexture {
  const tex = new THREE.DataTexture(anim.data, anim.boneCount * 3, anim.frameCount, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

/** Frame pair and blend factor for clip time `t` (seconds) — mirrors the GLSL `crowdFrame`. */
export function clipFrames(clip: BakedClip, t: number, out: { f0: number; f1: number; a: number }): void {
  let x = t * clip.fps;
  x = x - Math.floor(x / clip.frames) * clip.frames;
  const fi = Math.floor(x);
  out.a = x - fi;
  out.f0 = clip.start + Math.min(fi, clip.frames - 1);
  const nx = fi + 1 >= clip.frames ? 0 : fi + 1;
  out.f1 = clip.start + nx;
}

const tmpFrames = { f0: 0, f1: 0, a: 0 };

/**
 * Interpolated skinning matrix of `bone` at clip time `t` (seconds) into
 * `out` (a column-major Matrix4) — the CPU twin of the shader, used to attach
 * carried props to hands.
 */
export function sampleBone(anim: BoneAnimation, clipIndex: number, t: number, bone: number, out: THREE.Matrix4): THREE.Matrix4 {
  const clip = anim.clips[clipIndex] ?? anim.clips[0]!;
  clipFrames(clip, t, tmpFrames);
  const { f0, f1, a } = tmpFrames;
  const d = anim.data;
  const o0 = (f0 * anim.boneCount + bone) * 12;
  const o1 = (f1 * anim.boneCount + bone) * 12;
  const e = out.elements;
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 4; c++) e[c * 4 + r] = d[o0 + r * 4 + c]! * (1 - a) + d[o1 + r * 4 + c]! * a;
  e[3] = 0;
  e[7] = 0;
  e[11] = 0;
  e[15] = 1;
  return out;
}

/**
 * Bind-space anchor points per bone: the bone's origin and its "tip" (mean of
 * the vertices farthest from the origin, e.g. the hand of an arm).
 */
export function boneAnchors(mesh: THREE.SkinnedMesh): { origin: THREE.Vector3; tip: THREE.Vector3 }[] {
  const g = mesh.geometry;
  const pos = g.getAttribute('position');
  const si = g.getAttribute('skinIndex');
  const sw = g.getAttribute('skinWeight');
  const n = mesh.skeleton.bones.length;
  const Binv = mesh.bindMatrixInverse;
  const out = Array.from({ length: n }, (_, b) => {
    // Bone rest world matrix = inverse(boneInverse); into bind (mesh) space.
    const m = mesh.skeleton.boneInverses[b]!.clone().invert().premultiply(Binv);
    return { origin: new THREE.Vector3().setFromMatrixPosition(m), tip: new THREE.Vector3(), max: 0 };
  });
  const v = new THREE.Vector3();
  const dominant = (i: number) => {
    let best = 0;
    let bw = -1;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (w > bw) {
        bw = w;
        best = si.getComponent(i, k);
      }
    }
    return best;
  };
  for (let i = 0; i < pos.count; i++) {
    const b = dominant(i);
    v.fromBufferAttribute(pos, i);
    const d = v.distanceTo(out[b]!.origin);
    if (d > out[b]!.max) out[b]!.max = d;
  }
  const cnt = new Array<number>(n).fill(0);
  for (let i = 0; i < pos.count; i++) {
    const b = dominant(i);
    v.fromBufferAttribute(pos, i);
    if (v.distanceTo(out[b]!.origin) >= out[b]!.max * 0.85) {
      out[b]!.tip.add(v);
      cnt[b]!++;
    }
  }
  return out.map((o, b) => ({ origin: o.origin, tip: cnt[b] ? o.tip.multiplyScalar(1 / cnt[b]!) : o.origin.clone() }));
}
