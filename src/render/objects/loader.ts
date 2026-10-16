/**
 * Loading and preparing Kenney models.
 *
 * - `ModelLibrary` loads GLBs listed in the manifest (cached per name).
 * - `mergeStatic` flattens any static model into ONE BufferGeometry with
 *   linear vertex colours (material colour × existing vertex colours) so it can
 *   be drawn with a single shared material as an InstancedMesh. When the
 *   source uses a texture, the UVs are kept and the (first) texture is returned.
 * - `unifyAnimated` turns an animated model (skinned meshes and/or
 *   node-animated rigid parts like the cube pets) into ONE SkinnedMesh with a
 *   single skeleton and material, so each character/pet costs one draw call.
 *   Clone instances with `instantiateAnimated` (SkeletonUtils.clone).
 */
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { MODELS, assetUrl, type ModelName } from './manifest';

export interface StaticModel {
  readonly name: ModelName;
  /** Geometry in world units (manifest scale applied), origin at the model's foot. */
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.Material;
  /** World-space height of the model at scale 1. */
  readonly height: number;
  /** Horizontal radius (max |x|,|z|) at scale 1. */
  readonly radius: number;
}

export interface AnimatedModel {
  readonly name: ModelName;
  /** Template; do not add to the scene, clone with `instantiateAnimated`. */
  readonly template: THREE.Object3D;
  readonly clips: THREE.AnimationClip[];
  /** Uniform scale applied to the template to reach the manifest height. */
  readonly scale: number;
}

let sharedVertexColorMaterial: THREE.MeshLambertMaterial | null = null;
let sharedVertexColorMaterialDS: THREE.MeshLambertMaterial | null = null;

/** The one material all merged, untextured static models share. */
export function vertexColorMaterial(doubleSided = false): THREE.MeshLambertMaterial {
  if (doubleSided) {
    sharedVertexColorMaterialDS ??= new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, name: 'objects-vc-ds' });
    return sharedVertexColorMaterialDS;
  }
  sharedVertexColorMaterial ??= new THREE.MeshLambertMaterial({ vertexColors: true, name: 'objects-vc' });
  return sharedVertexColorMaterial;
}

const texturedMaterials = new Map<THREE.Texture, THREE.MeshLambertMaterial>();
function texturedMaterial(map: THREE.Texture, skinned: boolean): THREE.MeshLambertMaterial {
  let m = texturedMaterials.get(map);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ map, vertexColors: true, name: skinned ? 'objects-skinned' : 'objects-tex' });
    texturedMaterials.set(map, m);
  }
  return m;
}

function materialsOf(mesh: THREE.Mesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

function mapOf(m: THREE.Material): THREE.Texture | null {
  return (m as THREE.MeshStandardMaterial).map ?? null;
}

function colorOf(m: THREE.Material): THREE.Color {
  const c = (m as THREE.MeshStandardMaterial).color;
  return c ? c.clone() : new THREE.Color(1, 1, 1);
}

/**
 * Merge all meshes below `root` (with their transforms relative to root) into
 * one indexed geometry with POSITION, NORMAL, COLOR (linear) and UV (when
 * textured). `scale` is applied on top.
 */
export function mergeStatic(root: THREE.Object3D, scale = 1): { geometry: THREE.BufferGeometry; map: THREE.Texture | null; doubleSided: boolean } {
  root.updateMatrixWorld(true);
  const rootInv = root.matrixWorld.clone().invert();
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  let map: THREE.Texture | null = null;
  let doubleSided = false;
  const m = new THREE.Matrix4();
  const nm = new THREE.Matrix3();
  const v = new THREE.Vector3();
  const scaleM = new THREE.Matrix4().makeScale(scale, scale, scale);

  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const g = mesh.geometry;
    const p = g.getAttribute('position');
    if (!p) return;
    m.multiplyMatrices(rootInv, mesh.matrixWorld).premultiply(scaleM);
    nm.getNormalMatrix(m);
    const flip = m.determinant() < 0;
    const n = g.getAttribute('normal');
    const c = g.getAttribute('color');
    const uv = g.getAttribute('uv');
    const mats = materialsOf(mesh);
    for (const mat of mats) {
      if (mat.side === THREE.DoubleSide) doubleSided = true;
      if (!map && mapOf(mat)) map = mapOf(mat);
    }
    // Per-vertex material colour: resolve material groups.
    const vertMat = new Int32Array(p.count);
    const index = g.getIndex();
    if (Array.isArray(mesh.material) && g.groups.length) {
      for (const grp of g.groups) {
        for (let k = grp.start; k < grp.start + grp.count; k++) {
          const vi = index ? index.getX(k) : k;
          if (vi < p.count) vertMat[vi] = grp.materialIndex ?? 0;
        }
      }
    }
    const matColors = mats.map(colorOf);
    const base = pos.length / 3;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m);
      pos.push(v.x, v.y, v.z);
      if (n) {
        v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize();
        nor.push(v.x, v.y, v.z);
      } else nor.push(0, 1, 0);
      const mc = matColors[vertMat[i]!] ?? matColors[0]!;
      let r = mc.r;
      let gg = mc.g;
      let b = mc.b;
      if (c) {
        r *= c.getX(i);
        gg *= c.getY(i);
        b *= c.getZ(i);
      }
      col.push(r, gg, b);
      if (uv) uvs.push(uv.getX(i), uv.getY(i));
      else uvs.push(0, 0);
    }
    const count = index ? index.count : p.count;
    for (let k = 0; k + 2 < count; k += 3) {
      const a = base + (index ? index.getX(k) : k);
      const b2 = base + (index ? index.getX(k + 1) : k + 1);
      const c2 = base + (index ? index.getX(k + 2) : k + 2);
      if (flip) idx.push(a, c2, b2);
      else idx.push(a, b2, c2);
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  if (map) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(idx);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return { geometry, map, doubleSided };
}

/**
 * Convert an animated model into a single SkinnedMesh (one draw call).
 * Rigid mesh nodes become bones (weight 1 to themselves); existing skins are
 * remapped onto the unified skeleton. Returns false (model left unchanged)
 * when parts use different textures.
 */
export function unifyAnimated(root: THREE.Object3D): boolean {
  root.updateMatrixWorld(true);
  const rootInv = root.matrixWorld.clone().invert();
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
  });
  if (!meshes.length) return false;
  let map: THREE.Texture | null = null;
  for (const mesh of meshes)
    for (const mat of materialsOf(mesh)) {
      const mm = mapOf(mat);
      if (mm && map && mm !== map && (mm.image !== map.image || !mm.image)) return false;
      map ??= mm;
    }

  const bones: THREE.Object3D[] = [];
  const inverses: THREE.Matrix4[] = [];
  const boneIndex = (bone: THREE.Object3D, inv: THREE.Matrix4): number => {
    for (let i = 0; i < bones.length; i++) if (bones[i] === bone && inverses[i]!.equals(inv)) return i;
    bones.push(bone);
    inverses.push(inv.clone());
    return bones.length - 1;
  };

  const pos: number[] = [];
  const nor: number[] = [];
  const uvs: number[] = [];
  const col: number[] = [];
  const si: number[] = [];
  const sw: number[] = [];
  const idx: number[] = [];
  const v = new THREE.Vector3();
  const local = new THREE.Matrix4();
  const nm = new THREE.Matrix3();

  // Replace rigid Mesh nodes by plain Object3Ds with the same name so that
  // animation tracks still bind to them.
  const replacements: [THREE.Mesh, THREE.Object3D][] = [];

  for (const mesh of meshes) {
    const g = mesh.geometry;
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const uv = g.getAttribute('uv');
    const c = g.getAttribute('color');
    const mc = colorOf(materialsOf(mesh)[0]!);
    const base = pos.length / 3;
    const skinned = (mesh as THREE.SkinnedMesh).isSkinnedMesh;
    if (skinned) {
      const sm = mesh as THREE.SkinnedMesh;
      // Vertex in root space at bind pose = rootInv * bindMatrix * v.
      local.multiplyMatrices(rootInv, sm.bindMatrix);
      const remap = sm.skeleton.bones.map((b, k) => boneIndex(b, sm.skeleton.boneInverses[k]!));
      const ski = g.getAttribute('skinIndex');
      const skw = g.getAttribute('skinWeight');
      for (let i = 0; i < p.count; i++) {
        si.push(remap[ski.getX(i)] ?? 0, remap[ski.getY(i)] ?? 0, remap[ski.getZ(i)] ?? 0, remap[ski.getW(i)] ?? 0);
        sw.push(skw.getX(i), skw.getY(i), skw.getZ(i), skw.getW(i));
      }
    } else {
      local.multiplyMatrices(rootInv, mesh.matrixWorld);
      const holder = new THREE.Object3D();
      replacements.push([mesh, holder]);
      const bi = boneIndex(holder, mesh.matrixWorld.clone().invert());
      for (let i = 0; i < p.count; i++) {
        si.push(bi, 0, 0, 0);
        sw.push(1, 0, 0, 0);
      }
    }
    nm.getNormalMatrix(local);
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(local);
      pos.push(v.x, v.y, v.z);
      if (n) {
        v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize();
        nor.push(v.x, v.y, v.z);
      } else nor.push(0, 1, 0);
      uvs.push(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
      col.push(mc.r * (c ? c.getX(i) : 1), mc.g * (c ? c.getY(i) : 1), mc.b * (c ? c.getZ(i) : 1));
    }
    const index = g.getIndex();
    const count = index ? index.count : p.count;
    for (let k = 0; k < count; k++) idx.push(base + (index ? index.getX(k) : k));
  }

  for (const [mesh, holder] of replacements) {
    holder.name = mesh.name;
    holder.position.copy(mesh.position);
    holder.quaternion.copy(mesh.quaternion);
    holder.scale.copy(mesh.scale);
    const parent = mesh.parent!;
    parent.add(holder);
    for (const ch of [...mesh.children]) holder.add(ch);
    parent.remove(mesh);
  }
  for (const mesh of meshes) mesh.parent?.remove(mesh);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  geometry.setIndex(idx);
  geometry.computeBoundingSphere();

  const material = map ? texturedMaterial(map, true) : vertexColorMaterial();
  const skinnedMesh = new THREE.SkinnedMesh(geometry, material);
  skinnedMesh.name = 'unified';
  root.add(skinnedMesh);
  root.updateMatrixWorld(true);
  // Bones need not be THREE.Bone; Skeleton only reads matrixWorld.
  skinnedMesh.bind(new THREE.Skeleton(bones as THREE.Bone[], inverses), root.matrixWorld.clone());
  skinnedMesh.frustumCulled = false;
  return true;
}

/** Clone an animated template (with its own skeleton). */
export function instantiateAnimated(model: AnimatedModel): THREE.Object3D {
  const o = SkeletonUtils.clone(model.template);
  o.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) {
      c.castShadow = true;
      c.frustumCulled = false;
    }
  });
  return o;
}

export class ModelLibrary {
  private readonly loader = new GLTFLoader();
  private readonly gltfs = new Map<ModelName, Promise<GLTF>>();
  private readonly statics = new Map<ModelName, Promise<StaticModel>>();
  private readonly animated = new Map<ModelName, Promise<AnimatedModel>>();
  private readonly mapsByUrl = new Map<string, THREE.Texture>();

  constructor(
    private readonly urlFor: (file: string) => string = assetUrl,
    /** Merge animated models into one SkinnedMesh (disable for debugging). */
    private readonly unify = true,
  ) {}

  loadGltf(name: ModelName): Promise<GLTF> {
    let p = this.gltfs.get(name);
    if (!p) {
      const url = this.urlFor(MODELS[name].file);
      p = this.loader.loadAsync(url).then((g) => {
        this.dedupeTextures(g, url);
        return g;
      });
      this.gltfs.set(name, p);
    }
    return p;
  }

  /** Share one Texture per image URL across all GLBs (GLTFLoader caches per file). */
  private dedupeTextures(g: GLTF, url: string): void {
    const dir = url.slice(0, url.lastIndexOf('/') + 1);
    const json = g.parser.json as { images?: { uri?: string }[] };
    const uris = (json.images ?? []).map((i) => (i.uri ? dir + i.uri : null));
    g.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const mat of materialsOf(mesh)) {
        const sm = mat as THREE.MeshStandardMaterial;
        if (!sm.map) continue;
        // Kenney GLBs reference exactly one image.
        const key = uris[0] ?? sm.map.uuid;
        const shared = this.mapsByUrl.get(key);
        if (shared && shared !== sm.map) {
          sm.map.dispose();
          sm.map = shared;
        } else if (!shared) {
          sm.map.colorSpace = THREE.SRGBColorSpace;
          this.mapsByUrl.set(key, sm.map);
        }
      }
    });
  }

  loadStatic(name: ModelName): Promise<StaticModel> {
    let p = this.statics.get(name);
    if (!p) {
      p = this.loadGltf(name).then((g) => {
        const e = MODELS[name] as { scale?: number; doubleSided?: boolean };
        const merged = mergeStatic(g.scene, e.scale ?? 1);
        const bb = merged.geometry.boundingBox!;
        const material = merged.map ? texturedMaterial(merged.map, false) : vertexColorMaterial(e.doubleSided ?? false);
        return {
          name,
          geometry: merged.geometry,
          material,
          height: bb.max.y,
          radius: Math.max(-bb.min.x, bb.max.x, -bb.min.z, bb.max.z),
        };
      });
      this.statics.set(name, p);
    }
    return p;
  }

  loadAnimated(name: ModelName): Promise<AnimatedModel> {
    let p = this.animated.get(name);
    if (!p) {
      p = this.loadGltf(name).then((g) => {
        const e = MODELS[name] as { scale?: number; height?: number };
        const template = SkeletonUtils.clone(g.scene);
        if (this.unify) unifyAnimated(template);
        const box = new THREE.Box3().setFromObject(g.scene, true);
        const h = Math.max(1e-6, box.max.y - Math.min(0, box.min.y));
        const scale = e.height !== undefined ? e.height / h : (e.scale ?? 1);
        template.scale.setScalar(scale);
        return { name, template, clips: g.animations, scale };
      });
      this.animated.set(name, p);
    }
    return p;
  }

  preloadStatic(names: readonly ModelName[]): Promise<StaticModel[]> {
    return Promise.all(names.map((n) => this.loadStatic(n)));
  }
}

let defaultLibrary: ModelLibrary | null = null;
/** Process-wide library (shares caches between layers). */
export function modelLibrary(): ModelLibrary {
  defaultLibrary ??= new ModelLibrary(assetUrl, !(globalThis as { __hydroRawModels?: boolean }).__hydroRawModels);
  return defaultLibrary;
}
