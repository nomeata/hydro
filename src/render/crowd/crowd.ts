/**
 * CrowdLayer: renders people and animals from EntityFrames.
 *
 * - One InstancedMesh per character/pet model (draw calls = models in use,
 *   at most 10 people + 5 animals), plus ONE InstancedMesh for all carried
 *   props and hand tools.
 * - Skinning on the GPU from baked bone textures (see bake.ts). The
 *   animation clock advances on the GPU from a uniform; each instance has a
 *   clip, a phase and a rate (`aAnim`) and the previous clip for a short
 *   crossfade (`aAnimPrev`).
 * - Positions are interpolated between snapshots (tracks.ts), placed on the
 *   terrain, and on the water surface minus a wading depth when in water.
 * - Props follow the hand bones: the CPU evaluates the same baked matrices.
 */
import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { EntityFrame } from '../../shared/protocol';
import { heightToY, type HeightSampler } from '../coords';
import { modelLibrary, unifyAnimated } from '../objects/loader';
import { MODELS, type ModelName } from '../objects/manifest';
import { bakeBoneAnimation, boneAnchors, boneTexture, sampleBone, type BoneAnimation } from './bake';
import {
  crowdModels,
  gaitRate,
  headingToYaw,
  lookFor,
  PERSON_CLIP_SPECS,
  PET_CLIP_SPECS,
  personClip,
  petClip,
  PropKind,
  type ClipChoice,
  type KindLook,
} from './clips';
import { crowdPropMaterial, crowdSkinMaterial } from './material';
import { buildPropGeometry, isTool, type PropSource } from './props';
import { EntityTracks, type Track } from './tracks';

/** Where models come from (the ModelLibrary, or a stub in tests). */
export interface CrowdModelSource extends PropSource {
  loadGltf(name: ModelName): Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }>;
}

export interface CrowdOptions {
  library?: CrowdModelSource;
  /** Models to prepare (default: all people and animals). */
  models?: readonly ModelName[];
  /** Camera for per-instance frustum culling (optional). */
  camera?: THREE.Camera;
}

const CROSSFADE_S = 0.22;
/** How far below the water surface a wading person's / animal's feet go (m). */
const WADE_PERSON = 0.55;
const WADE_ANIMAL = 0.3;
const INITIAL_CAPACITY = 32;

interface Rig {
  readonly name: ModelName;
  readonly anim: BoneAnimation;
  readonly tex: THREE.DataTexture;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.MeshLambertMaterial;
  readonly scale: number;
  readonly person: boolean;
  /** Bind-space hand positions (people). */
  readonly handL: THREE.Vector3;
  readonly handR: THREE.Vector3;
  readonly armL: number;
  readonly armR: number;
  mesh: THREE.InstancedMesh;
  aAnim: THREE.InstancedBufferAttribute;
  aPrev: THREE.InstancedBufferAttribute;
  capacity: number;
  count: number;
}

/** Renderer-side per-entity state. */
interface Ext {
  look: KindLook;
  rig: Rig | null;
  choice: ClipChoice;
  clip: number;
  rate: number;
  phase: number;
  prevClip: number;
  prevRate: number;
  prevPhase: number;
  fade: number;
  yM: number;
  jitter: number;
  key: number;
}

function hashId(id: number): number {
  let h = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export interface CrowdStats {
  entities: number;
  drawn: number;
  props: number;
  drawCalls: number;
  /** Smoothed CPU time of update() (ms). */
  updateMs: number;
  /** Number and bytes of the (shared) bone textures. */
  textures: number;
  textureBytes: number;
}

export class CrowdLayer {
  readonly group = new THREE.Group();
  readonly ready: Promise<void>;
  readonly tracks = new EntityTracks();
  readonly stats: CrowdStats = { entities: 0, drawn: 0, props: 0, drawCalls: 0, updateMs: 0, textures: 0, textureBytes: 0 };
  /** Animation playback speed (0 freezes poses). */
  timeScale = 1;

  private readonly rigs = new Map<ModelName, Rig>();
  private readonly textures: { anim: BoneAnimation; tex: THREE.DataTexture }[] = [];
  private readonly time = { value: 0 };
  private clock = 0;
  private propMesh: THREE.InstancedMesh | null = null;
  private propKind: THREE.InstancedBufferAttribute | null = null;
  private propCapacity = 0;
  private readonly propMaterial = crowdPropMaterial();
  private propGeometry: THREE.BufferGeometry | null = null;
  private disposed = false;
  private camera: THREE.Camera | null;
  private readonly frustum = new THREE.Frustum();
  private readonly projView = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  private readonly mInst = new THREE.Matrix4();
  private readonly mBone = new THREE.Matrix4();
  private readonly mTmp = new THREE.Matrix4();
  private readonly vA = new THREE.Vector3();
  private readonly vB = new THREE.Vector3();
  private readonly toolLocal = new THREE.Matrix4();
  private readonly rodLocal = new THREE.Matrix4().makeRotationX(-0.55);

  constructor(
    scene: THREE.Object3D,
    private readonly heights: HeightSampler,
    opts: CrowdOptions = {},
  ) {
    this.group.name = 'crowd';
    scene.add(this.group);
    this.camera = opts.camera ?? null;
    const lib: CrowdModelSource = opts.library ?? (modelLibrary() as unknown as CrowdModelSource);
    const names = opts.models ?? crowdModels();
    // Tools: the handle along +z from the grip; tilt it down/forward in the fist.
    this.toolLocal.makeRotationX(0.35);
    this.ready = Promise.all([
      ...names.map((n) =>
        this.prepare(lib, n).catch((e) => {
          console.warn(`crowd: could not prepare ${n}`, e);
        }),
      ),
      buildPropGeometry(lib).then((g) => {
        this.propGeometry = g;
      }),
    ]).then(() => undefined);
  }

  setCamera(camera: THREE.Camera | null): void {
    this.camera = camera;
  }

  /** New entity snapshot; `snapshotTimeMs` is its arrival time on the performance.now() clock. */
  setFrame(f: EntityFrame, snapshotTimeMs: number): void {
    this.tracks.setFrame(f, snapshotTimeMs);
  }

  get count(): number {
    return this.tracks.tracks.size;
  }

  /** Number of crowd draw calls in the last update. */
  get drawCalls(): number {
    return this.stats.drawCalls;
  }

  update(dtSec: number, nowMs: number): void {
    if (this.disposed) return;
    const t0 = performance.now();
    const dt = Math.min(0.25, Math.max(0, dtSec));
    this.tracks.advance(dt, nowMs);
    const adt = dt * this.timeScale;
    // GPU clock: seconds since the last rebase. Phases are written relative to it.
    this.clock += adt;
    if (this.clock > 60) this.clock = 0;
    const T = this.clock;
    this.time.value = T;

    for (const r of this.rigs.values()) r.count = 0;
    let props = 0;
    if (this.camera) {
      this.camera.updateMatrixWorld();
      this.projView.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
      this.frustum.setFromProjectionMatrix(this.projView);
    }
    const kFade = adt / CROSSFADE_S;
    const kY = 1 - Math.exp(-10 * dt);
    const h = this.heights;
    let drawn = 0;

    for (const t of this.tracks.tracks.values()) {
      const e = this.ext(t);
      if (!e.rig) continue;
      const rig = e.rig;
      // Animation state.
      const choice = e.look.person ? personClip(t.anim, t.carry, t.id) : petClip(t.anim);
      e.choice = choice;
      if (choice.clip !== e.clip) {
        e.prevClip = e.clip;
        e.prevPhase = e.phase;
        e.prevRate = e.rate;
        e.fade = 0;
        e.clip = choice.clip;
        e.phase = choice.gait ? e.phase : 0;
      }
      let rate = choice.rate * e.jitter;
      if (choice.gait === 1) rate *= gaitRate(t.speed, e.look.walkRef * e.look.scale);
      else if (choice.gait === 2) rate *= gaitRate(t.speed, e.look.runRef * e.look.scale);
      e.rate = rate;
      e.phase = wrap(e.phase + adt * rate, rig.anim.clips[e.clip]?.duration ?? 1);
      if (e.fade < 1) {
        e.fade = Math.min(1, e.fade + kFade);
        e.prevPhase = wrap(e.prevPhase + adt * e.prevRate, rig.anim.clips[e.prevClip]?.duration ?? 1);
      }

      // Height: terrain, or the water surface minus a wading depth.
      const ground = h.terrainAt(t.x, t.y);
      const depth = h.depthAt(t.x, t.y);
      const target = depth > 0 ? Math.max(ground, ground + depth - (e.look.person ? WADE_PERSON : WADE_ANIMAL)) : ground;
      e.yM = Number.isNaN(e.yM) ? target : e.yM + (target - e.yM) * kY;

      const X = t.x + 0.5;
      const Y = heightToY(e.yM);
      const Z = t.y + 0.5;
      if (this.camera) {
        this.sphere.center.set(X, Y + 0.3, Z);
        this.sphere.radius = 0.7;
        if (!this.frustum.intersectsSphere(this.sphere)) continue;
      }
      drawn++;
      if (rig.count >= rig.capacity) this.grow(rig, rig.capacity * 2);
      const i = rig.count++;
      const S = rig.scale * e.look.scale;
      const yaw = headingToYaw(t.heading);
      const c = Math.cos(yaw) * S;
      const s = Math.sin(yaw) * S;
      const me = rig.mesh.instanceMatrix.array as Float32Array;
      const o = i * 16;
      me[o] = c;
      me[o + 1] = 0;
      me[o + 2] = -s;
      me[o + 3] = 0;
      me[o + 4] = 0;
      me[o + 5] = S;
      me[o + 6] = 0;
      me[o + 7] = 0;
      me[o + 8] = s;
      me[o + 9] = 0;
      me[o + 10] = c;
      me[o + 11] = 0;
      me[o + 12] = X;
      me[o + 13] = Y;
      me[o + 14] = Z;
      me[o + 15] = 1;
      const a = rig.aAnim.array as Float32Array;
      a[i * 4] = e.clip;
      a[i * 4 + 1] = e.phase - T * rate;
      a[i * 4 + 2] = rate;
      a[i * 4 + 3] = e.fade;
      const p = rig.aPrev.array as Float32Array;
      p[i * 4] = e.prevClip;
      p[i * 4 + 1] = e.prevPhase - T * e.prevRate;
      p[i * 4 + 2] = e.prevRate;
      p[i * 4 + 3] = 0;
      const col = rig.mesh.instanceColor!.array as Float32Array;
      col[i * 3] = e.look.tint[0];
      col[i * 3 + 1] = e.look.tint[1];
      col[i * 3 + 2] = e.look.tint[2];

      if (choice.prop !== PropKind.None && rig.person && this.propGeometry) {
        this.mInst.fromArray(me, o);
        this.placeProp(rig, e, choice.prop, props++);
      }
    }

    let calls = 0;
    for (const r of this.rigs.values()) {
      r.mesh.count = r.count;
      r.mesh.visible = r.count > 0;
      if (r.count > 0) {
        calls++;
        r.mesh.instanceMatrix.needsUpdate = true;
        r.mesh.instanceColor!.needsUpdate = true;
        r.aAnim.needsUpdate = true;
        r.aPrev.needsUpdate = true;
      }
    }
    if (this.propMesh) {
      this.propMesh.count = props;
      this.propMesh.visible = props > 0;
      if (props > 0) {
        calls++;
        this.propMesh.instanceMatrix.needsUpdate = true;
        this.propKind!.needsUpdate = true;
      }
    }
    const st = this.stats;
    st.entities = this.tracks.tracks.size;
    st.drawn = drawn;
    st.props = props;
    st.drawCalls = calls;
    st.updateMs += (performance.now() - t0 - st.updateMs) * 0.05;
  }

  dispose(): void {
    this.disposed = true;
    this.group.removeFromParent();
    for (const r of this.rigs.values()) {
      r.geometry.dispose();
      r.material.dispose();
      r.mesh.dispose();
    }
    this.rigs.clear();
    for (const t of this.textures) t.tex.dispose();
    this.textures.length = 0;
    this.propGeometry?.dispose();
    this.propMaterial.dispose();
    this.propMesh?.dispose();
  }

  // ---------------------------------------------------------------------------

  private ext(t: Track): Ext {
    let e = t.ext as Ext | null;
    const look = lookFor(t.kind, t.variant);
    const key = t.kind * 256 + t.variant;
    if (!e || e.key !== key || !e.rig) {
      const rig = this.rigs.get(look.model) ?? null;
      const r = hashId(t.id);
      const clip = 0;
      e = {
        look,
        rig,
        choice: { clip, rate: 1, gait: 0, prop: PropKind.None },
        clip,
        rate: 1,
        phase: r * 10,
        prevClip: clip,
        prevRate: 1,
        prevPhase: 0,
        fade: 1,
        yM: e?.yM ?? NaN,
        jitter: 0.92 + 0.16 * r,
        key,
      };
      t.ext = e;
    }
    return e;
  }

  private placeProp(rig: Rig, e: Ext, kind: PropKind, index: number): void {
    if (index >= this.propCapacity) this.growProps(Math.max(32, this.propCapacity * 2));
    const out = this.mTmp;
    if (kind === PropKind.Rod) {
      // The rod sticks out over the water: at the hand, tilted up and forward.
      const hnd = this.vA.copy(rig.handR).applyMatrix4(sampleBone(rig.anim, e.clip, e.phase, rig.armR, this.mBone));
      out.copy(this.mInst).multiply(this.mBone.makeTranslation(hnd.x, hnd.y, hnd.z)).multiply(this.rodLocal);
    } else if (isTool(kind)) {
      // Instance · armR(t) · T(hand) · toolLocal.
      sampleBone(rig.anim, e.clip, e.phase, rig.armR, this.mBone);
      out.copy(this.mInst).multiply(this.mBone);
      this.mBone.makeTranslation(rig.handR.x, rig.handR.y, rig.handR.z);
      out.multiply(this.mBone).multiply(this.toolLocal);
    } else {
      // Between both hands, facing the carrier's heading.
      const l = this.vA.copy(rig.handL).applyMatrix4(sampleBone(rig.anim, e.clip, e.phase, rig.armL, this.mBone));
      const r = this.vB.copy(rig.handR).applyMatrix4(sampleBone(rig.anim, e.clip, e.phase, rig.armR, this.mBone));
      l.add(r).multiplyScalar(0.5);
      l.z += kind === PropKind.Bucket || kind === PropKind.Fish ? 0.02 : 0.06;
      if (kind === PropKind.Fish || kind === PropKind.Bucket) l.y -= 0.06;
      out.copy(this.mInst).multiply(this.mBone.makeTranslation(l.x, l.y, l.z));
    }
    out.toArray(this.propMesh!.instanceMatrix.array as Float32Array, index * 16);
    (this.propKind!.array as Float32Array)[index] = kind;
  }

  private growProps(cap: number): void {
    const old = this.propMesh;
    const g = this.propGeometry!;
    const mesh = new THREE.InstancedMesh(g, this.propMaterial, cap);
    mesh.name = 'crowd-props';
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const kind = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    kind.setUsage(THREE.DynamicDrawUsage);
    if (old) {
      (mesh.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array);
      kind.array.set(this.propKind!.array);
      old.removeFromParent();
      old.dispose();
    }
    g.setAttribute('aKind', kind);
    this.propKind = kind;
    this.propMesh = mesh;
    this.propCapacity = cap;
    this.group.add(mesh);
  }

  private grow(rig: Rig, cap: number): void {
    const old = rig.mesh;
    const mesh = new THREE.InstancedMesh(rig.geometry, rig.material, cap);
    mesh.name = `crowd-${rig.name}`;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    const aAnim = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    const aPrev = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    aAnim.setUsage(THREE.DynamicDrawUsage);
    aPrev.setUsage(THREE.DynamicDrawUsage);
    if (old) {
      (mesh.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array);
      (mesh.instanceColor.array as Float32Array).set(old.instanceColor!.array);
      aAnim.array.set(rig.aAnim.array);
      aPrev.array.set(rig.aPrev.array);
      old.removeFromParent();
      old.dispose();
    }
    rig.geometry.setAttribute('aAnim', aAnim);
    rig.geometry.setAttribute('aAnimPrev', aPrev);
    rig.mesh = mesh;
    rig.aAnim = aAnim;
    rig.aPrev = aPrev;
    rig.capacity = cap;
    this.group.add(mesh);
  }

  private async prepare(lib: CrowdModelSource, name: ModelName): Promise<void> {
    const gltf = await lib.loadGltf(name);
    if (this.disposed) return;
    const root = SkeletonUtils.clone(gltf.scene);
    if (!unifyAnimated(root)) throw new Error('model parts use different textures');
    let skinned: THREE.SkinnedMesh | null = null;
    root.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh && o.name === 'unified') skinned = o as THREE.SkinnedMesh;
    });
    const sm = skinned as THREE.SkinnedMesh | null;
    if (!sm) throw new Error('no skinned mesh');
    const entry = MODELS[name] as { category: string; height?: number; scale?: number };
    const person = entry.category === 'character';
    const anim = bakeBoneAnimation(root, sm, gltf.animations, person ? PERSON_CLIP_SPECS : PET_CLIP_SPECS);
    // Models sharing a skeleton and clips (most mini-characters) share one texture.
    let tex = this.textures.find((t) => sameData(t.anim.data, anim.data))?.tex;
    if (!tex) {
      tex = boneTexture(anim);
      this.textures.push({ anim, tex });
      this.stats.textureBytes += anim.data.byteLength;
      this.stats.textures = this.textures.length;
    }
    const box = new THREE.Box3().setFromObject(gltf.scene, true);
    const hgt = Math.max(1e-6, box.max.y - Math.min(0, box.min.y));
    const scale = entry.height !== undefined ? entry.height / hgt : (entry.scale ?? 1);

    const src = sm.geometry;
    const geometry = new THREE.BufferGeometry();
    for (const k of ['position', 'normal', 'uv', 'color']) {
      const a = src.getAttribute(k);
      if (a) geometry.setAttribute(k, a);
    }
    const si = src.getAttribute('skinIndex');
    const sw = src.getAttribute('skinWeight');
    const idx = new Float32Array(si.count * 4);
    for (let i = 0; i < si.count; i++) for (let k = 0; k < 4; k++) idx[i * 4 + k] = si.getComponent(i, k);
    geometry.setAttribute('aBoneIdx', new THREE.BufferAttribute(idx, 4));
    geometry.setAttribute('aBoneW', sw);
    geometry.setIndex(src.getIndex());
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const map = (sm.material as THREE.MeshLambertMaterial).map ?? null;
    const material = crowdSkinMaterial(map, tex, anim, this.time);
    const anchors = boneAnchors(sm);
    const armL = anim.boneNames.indexOf('arm-left');
    const armR = anim.boneNames.indexOf('arm-right');
    const rig: Rig = {
      name,
      anim,
      tex,
      geometry,
      material,
      scale,
      person,
      handL: anchors[Math.max(0, armL)]!.tip.clone(),
      handR: anchors[Math.max(0, armR)]!.tip.clone(),
      armL: Math.max(0, armL),
      armR: Math.max(0, armR),
      mesh: null as unknown as THREE.InstancedMesh,
      aAnim: null as unknown as THREE.InstancedBufferAttribute,
      aPrev: null as unknown as THREE.InstancedBufferAttribute,
      capacity: 0,
      count: 0,
    };
    this.grow(rig, INITIAL_CAPACITY);
    rig.mesh.count = 0;
    rig.mesh.visible = false;
    this.rigs.set(name, rig);
  }
}

function sameData(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > 1e-5) return false;
  return true;
}

function wrap(x: number, period: number): number {
  return x - Math.floor(x / period) * period;
}
