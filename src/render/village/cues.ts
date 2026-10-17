/**
 * Village cues (docs/PEOPLE.md §7, "watch and learn"): props that show a
 * village's hidden mood without any text.
 *
 * - Chimney smoke: soft puffs rising from finished houses and drifting
 *   downwind; every house of a prosperous village smokes, a third of an
 *   ordinary one's, none in a struggling village. One InstancedMesh.
 * - Decor of prosperous villages: laundry lines between neighbouring houses
 *   and flower patches by the doors, merged into ONE vertex-coloured mesh
 *   (rebuilt only when the houses or moods change).
 *
 * So the layer adds at most 2 draw calls. Children and the listless crowd at
 * the store of a struggling village are sim agents (people/village.ts).
 * The mood (with hysteresis) comes from the sim per village; each building
 * belongs to the nearest village centre (as in the sim).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BuildingInfo, VillageStats } from '../../shared/protocol';
import { heightToY, type HeightSampler } from '../coords';
import { modelLibrary, vertexColorMaterial } from '../objects/loader';
import { TOWN_SCALE } from '../objects/manifest';
import type { StaticModelSource } from '../objects/vegetation';
import { houseSpots, houseVariant } from './houses';

/** Puffs per smoking chimney, their life (s) and rise (world units). */
const PUFFS = 5;
const PUFF_LIFE = 5;
const PUFF_RISE = 1.5;
/** Hide the cues when zoomed out beyond this view height (cells). */
const MAX_VIEW = 90;

export function hash01(id: number, k: number): number {
  let h = Math.imul(id ^ Math.imul(k + 1, 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Index of the nearest village for each building (−1 if there are none). */
export function nearestVillage(bs: readonly BuildingInfo[], vs: readonly { x: number; y: number }[]): number[] {
  return bs.map((b) => {
    let best = -1;
    let bestD = Infinity;
    vs.forEach((v, i) => {
      const d = (v.x - b.x) ** 2 + (v.y - b.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  });
}

/** Rotate a building-local offset (x, z) by the building's rotation (as in BuildingsLayer). */
function rotate(x: number, z: number, rot: number): [number, number] {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return [x * c + z * s, -x * s + z * c];
}

export interface Chimney {
  /** World position of the chimney top (x, z in world units; y in world units). */
  x: number;
  y: number;
  z: number;
  /** 1 full smoke, < 1 a thinner wisp. */
  strength: number;
  seed: number;
}

export interface DecorItem {
  kind: 'flowers' | 'laundry';
  /** Cell coordinates (cell i centre at i). */
  x: number;
  y: number;
  /** Yaw (radians) about +y. */
  yaw: number;
  seed: number;
}

/** Which houses smoke, and how much: all in prosperous villages, a third in ordinary ones, none when struggling. */
export function smokeStrength(mood: number, id: number): number {
  if (mood > 0) return 1;
  if (mood < 0) return 0;
  return hash01(id, 7) < 0.34 ? 0.6 : 0;
}

/**
 * Decor of prosperous villages: flowers by the doors of most houses, and a
 * laundry line in the gap between a house and its nearest neighbour (for
 * some houses; each pair once).
 */
export function decorPlacements(bs: readonly BuildingInfo[], moods: readonly number[], owner: readonly number[]): DecorItem[] {
  const out: DecorItem[] = [];
  const houses = bs.map((b, i) => ({ b, i })).filter(({ b, i }) => b.kind === 'house' && b.progress >= 1 && (moods[owner[i]!] ?? 0) > 0);
  const pairs = new Set<string>();
  for (const { b, i } of houses) {
    if (hash01(b.id, 1) < 0.8) {
      const sp = houseSpots(houseVariant(b.id));
      // Beside the door, opposite the barrel/crate (which stands 0.35 to one side).
      const side = 0.32;
      const lx = (sp.door.x + sp.door.ox * 0.18) * sp.scale - sp.door.oz * side * sp.scale;
      const lz = (sp.door.z + sp.door.oz * 0.18) * sp.scale + sp.door.ox * side * sp.scale;
      const [dx, dz] = rotate(lx, lz, b.rot);
      out.push({ kind: 'flowers', x: b.x + dx, y: b.y + dz, yaw: b.rot, seed: b.id });
    }
    if (hash01(b.id, 2) < 0.6) {
      let best: BuildingInfo | null = null;
      let bestD = Infinity;
      for (const o of houses) {
        if (o.i === i || owner[o.i] !== owner[i]) continue;
        const d = Math.hypot(o.b.x - b.x, o.b.y - b.y);
        if (d >= 2 && d <= 5 && d < bestD) {
          bestD = d;
          best = o.b;
        }
      }
      if (best) {
        const key = b.id < best.id ? `${b.id}-${best.id}` : `${best.id}-${b.id}`;
        if (!pairs.has(key)) {
          pairs.add(key);
          // Strung across the gap between the two houses.
          const yaw = -Math.atan2(best.y - b.y, best.x - b.x) + Math.PI / 2;
          out.push({ kind: 'laundry', x: (b.x + best.x) / 2, y: (b.y + best.y) / 2, yaw, seed: b.id * 31 + best.id });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Geometry (procedural, vertex coloured, origin on the ground).

function coloured(g: THREE.BufferGeometry, hex: number, shade = true): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.deleteAttribute('uv');
  ng.computeVertexNormals();
  const c = new THREE.Color(hex);
  const pos = ng.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const k = shade ? 0.85 + 0.15 * Math.min(1, Math.max(0, pos.getY(i) * 4)) : 1;
    col[i * 3] = c.r * k;
    col[i * 3 + 1] = c.g * k;
    col[i * 3 + 2] = c.b * k;
  }
  ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return ng;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, hex: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y + h / 2, z);
  return coloured(g, hex, false);
}

const CLOTHS = [0xf4f1ea, 0xd9534f, 0x5b8fd6, 0xf2c94c, 0x9ad17a, 0xe58fb5];
const BLOSSOMS = [0xe8484f, 0xf7d046, 0xb46ad8, 0xffffff, 0xff9a3c];

/** A laundry line about one cell long along x: two posts, a line, cloths of a few colours. */
export function laundryGeometry(seed: number): THREE.BufferGeometry {
  const L = 1.0;
  const H = 0.42;
  const parts = [
    box(0.035, H, 0.035, -L / 2, 0, 0, 0x8a6a44),
    box(0.035, H, 0.035, L / 2, 0, 0, 0x8a6a44),
    box(L, 0.012, 0.012, 0, H - 0.03, 0, 0xe8e2d0),
  ];
  const n = 3 + Math.floor(hash01(seed, 3) * 2);
  for (let k = 0; k < n; k++) {
    const w = 0.13 + 0.07 * hash01(seed, 10 + k);
    const h = 0.12 + 0.1 * hash01(seed, 20 + k);
    const x = -L / 2 + 0.14 + ((L - 0.28) * (k + 0.5)) / n;
    const col = CLOTHS[Math.floor(hash01(seed, 30 + k) * CLOTHS.length)]!;
    parts.push(box(w, h, 0.012, x, H - 0.035 - h, 0, col));
  }
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return g;
}

/** A little patch of flowers: leafy mounds with coloured blossoms. */
export function flowerGeometry(seed: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const n = 3 + Math.floor(hash01(seed, 4) * 2);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + hash01(seed, 40 + k);
    const r = k === 0 ? 0 : 0.09;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const leaf = new THREE.IcosahedronGeometry(0.075, 0);
    leaf.scale(1, 0.75, 1);
    leaf.translate(x, 0.04, z);
    parts.push(coloured(leaf, 0x4f8f3a));
    const col = BLOSSOMS[Math.floor(hash01(seed, 50 + k) * BLOSSOMS.length)]!;
    for (let j = 0; j < 2; j++) {
      const b = new THREE.IcosahedronGeometry(0.032, 0);
      b.translate(x + (j ? 0.03 : -0.025), 0.1 + 0.02 * j, z + (j ? -0.02 : 0.025));
      parts.push(coloured(b, col, false));
    }
  }
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return g;
}

// ---------------------------------------------------------------------------

export interface VillageCuesOptions {
  library?: StaticModelSource;
}

export class VillageCuesLayer {
  readonly group = new THREE.Group();
  readonly ready: Promise<void>;
  private smoke: THREE.InstancedMesh;
  private smokeCapacity = 0;
  private decor: THREE.Mesh | null = null;
  private readonly decorMaterial = vertexColorMaterial();
  private buildings: readonly BuildingInfo[] = [];
  private moods: number[] = [];
  private villages: { x: number; y: number }[] = [];
  private chimneys: Chimney[] = [];
  private sig = '';
  private dirty = true;
  /** Chimney top above the chimney part's origin (tile units) and its stack centre offset in x. */
  private chimneyTop = 0.62;
  private chimneyDx = 0.32;
  private windX = 1;
  private windZ = 0;
  private wind = 1;
  private time = 0;
  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpP = new THREE.Vector3();
  private readonly tmpS = new THREE.Vector3();

  constructor(
    scene: THREE.Object3D,
    private readonly heights: HeightSampler,
    opts: VillageCuesOptions = {},
  ) {
    this.group.name = 'village-cues';
    scene.add(this.group);
    const mat = new THREE.MeshLambertMaterial({ color: 0xf2f0ec, transparent: true, opacity: 0.62, depthWrite: false, flatShading: true });
    mat.emissive.setRGB(0.22, 0.22, 0.23);
    this.smoke = this.makeSmoke(mat, 32);
    const lib = opts.library ?? modelLibrary();
    this.ready = lib
      .preloadStatic(['town_chimney'])
      .then(([m]) => {
        if (!m) return;
        m.geometry.computeBoundingBox();
        const bb = m.geometry.boundingBox!;
        this.chimneyTop = bb.max.y / TOWN_SCALE;
        this.chimneyDx = (bb.min.x + bb.max.x) / 2 / TOWN_SCALE;
        this.dirty = true;
      })
      .catch(() => undefined);
  }

  /** Draw calls of the layer (0–2). */
  get drawCalls(): number {
    if (!this.group.visible) return 0;
    return (this.smoke.count > 0 ? 1 : 0) + (this.decor ? 1 : 0);
  }

  get puffCount(): number {
    return this.smoke.count;
  }

  setBuildings(list: readonly BuildingInfo[]): void {
    this.buildings = list;
    this.dirty = true;
  }

  setVillages(vs: readonly VillageStats[]): void {
    const moods = vs.map((v) => v.mood ?? 0);
    const sig = vs.map((v, i) => `${v.x},${v.y},${moods[i]}`).join(';');
    if (sig === this.sig) return;
    this.sig = sig;
    this.moods = moods;
    this.villages = vs.map((v) => ({ x: v.x, y: v.y }));
    this.dirty = true;
  }

  /** Wind direction (radians, cell coordinates) and speed (rendering units) from the climate. */
  setWind(dir: number, speed: number): void {
    this.windX = Math.cos(dir);
    this.windZ = Math.sin(dir);
    this.wind = Math.min(1.6, Math.max(0.3, speed));
  }

  /** Terrain changed under the buildings. */
  refreshHeights(): void {
    this.dirty = true;
  }

  update(dt: number, viewHeight: number): void {
    const show = viewHeight < MAX_VIEW;
    this.group.visible = show;
    if (!show) return;
    if (this.dirty) this.rebuild();
    this.time += Math.min(0.1, Math.max(0, dt));
    this.animateSmoke();
  }

  dispose(): void {
    this.smoke.geometry.dispose();
    (this.smoke.material as THREE.Material).dispose();
    this.smoke.dispose();
    this.decor?.geometry.dispose();
    this.decorMaterial.dispose();
    this.group.removeFromParent();
  }

  private makeSmoke(mat: THREE.Material, capacity: number): THREE.InstancedMesh {
    const g = new THREE.IcosahedronGeometry(1, 0);
    const mesh = new THREE.InstancedMesh(g, mat, capacity);
    mesh.name = 'chimney-smoke';
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    this.smokeCapacity = capacity;
    this.group.add(mesh);
    return mesh;
  }

  private rebuild(): void {
    this.dirty = false;
    const bs = this.buildings;
    const owner = nearestVillage(bs, this.villages);
    const h = this.heights;
    // Chimneys.
    this.chimneys = [];
    bs.forEach((b, i) => {
      if (b.kind !== 'house' || b.progress < 1) return;
      const strength = smokeStrength(this.moods[owner[i]!] ?? 0, b.id);
      if (strength <= 0) return;
      const sp = houseSpots(houseVariant(b.id));
      const [dx, dz] = rotate((sp.chimney.x + this.chimneyDx) * sp.scale, sp.chimney.z * sp.scale, b.rot);
      const y = heightToY(this.footHeight(b.x, b.y)) + (sp.chimney.y + this.chimneyTop) * sp.vscale;
      this.chimneys.push({ x: b.x + 0.5 + dx, y, z: b.y + 0.5 + dz, strength, seed: b.id });
    });
    // Decor.
    if (this.decor) {
      this.decor.removeFromParent();
      this.decor.geometry.dispose();
      this.decor = null;
    }
    const items = decorPlacements(bs, this.moods, owner);
    if (items.length === 0) return;
    const geos: THREE.BufferGeometry[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const p = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    for (const it of items) {
      const g = it.kind === 'laundry' ? laundryGeometry(it.seed) : flowerGeometry(it.seed);
      p.set(it.x + 0.5, heightToY(h.terrainAt(it.x, it.y)) - 0.01, it.y + 0.5);
      q.setFromAxisAngle(up, it.yaw);
      g.applyMatrix4(m.compose(p, q, one));
      geos.push(g);
    }
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    merged.computeBoundingSphere();
    this.decor = new THREE.Mesh(merged, this.decorMaterial);
    this.decor.name = 'village-decor';
    this.decor.receiveShadow = true;
    this.group.add(this.decor);
  }

  private animateSmoke(): void {
    const n = this.chimneys.length * PUFFS;
    if (n > this.smokeCapacity) {
      const mat = this.smoke.material as THREE.Material;
      this.smoke.removeFromParent();
      this.smoke.geometry.dispose();
      this.smoke.dispose();
      this.smoke = this.makeSmoke(mat, Math.ceil(n * 1.5));
    }
    const t = this.time;
    let k = 0;
    for (const c of this.chimneys) {
      const off = hash01(c.seed, 5) * PUFF_LIFE;
      for (let j = 0; j < PUFFS; j++) {
        const u = (((t + off + (j * PUFF_LIFE) / PUFFS) % PUFF_LIFE) + PUFF_LIFE) % PUFF_LIFE / PUFF_LIFE;
        // Rise, drift downwind (more as it rises), wobble a little.
        const drift = Math.pow(u, 1.4) * 1.3 * this.wind;
        const wob = Math.sin((t + j * 1.7 + off) * 1.9) * 0.05 * u;
        this.tmpP.set(c.x + this.windX * drift - this.windZ * wob, c.y + u * PUFF_RISE * (0.7 + 0.3 * c.strength), c.z + this.windZ * drift + this.windX * wob);
        // Grow as it rises, then shrink away.
        const s = (0.07 + 0.2 * u) * Math.min(1, u / 0.08) * Math.min(1, (1 - u) / 0.3) * (0.6 + 0.4 * c.strength);
        this.tmpS.setScalar(Math.max(0.001, s));
        this.tmpQ.identity();
        this.tmpM.compose(this.tmpP, this.tmpQ, this.tmpS);
        this.smoke.setMatrixAt(k++, this.tmpM);
      }
    }
    this.smoke.count = k;
    this.smoke.instanceMatrix.needsUpdate = true;
  }

  /** As BuildingsLayer: a bit below the footprint mean. */
  private footHeight(x: number, y: number): number {
    const h = this.heights;
    const c = h.terrainAt(x, y);
    let lo = c;
    for (const [dx, dy] of [
      [0.5, 0.5],
      [0.5, -0.5],
      [-0.5, 0.5],
      [-0.5, -0.5],
    ] as const)
      lo = Math.min(lo, h.terrainAt(x + dx, y + dy));
    return c * 0.6 + lo * 0.4;
  }
}
