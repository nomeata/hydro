/**
 * Buildings layer: houses (by variant and construction stage) and the store
 * (by food level) from the snapshot's BuildingInfo list.
 *
 * Each (design, stage) is merged once into a single vertex-coloured
 * geometry; every combination in use gets one InstancedMesh with the shared
 * object material, so the layer costs one draw call per combination present
 * (typically 3–6). Instances are re-laid only when the list (or a stage)
 * changes, or when the terrain under them changes (`refreshHeights`).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BuildingInfo, VillageStats } from '../../shared/protocol';
import { heightToY, type HeightSampler } from '../coords';
import { modelLibrary, vertexColorMaterial, type StaticModel } from '../objects/loader';
import { SNOW_ATTRIBUTE, snowCapMaterial } from '../objects/snowCap';
import { LOOK_CHANNELS } from '../../shared/protocol';
import { MODELS, TOWN_SCALE, type ModelName } from '../objects/manifest';
import type { StaticModelSource } from '../objects/vegetation';
import {
  HOUSE_DESIGNS,
  buildStage,
  campDesign,
  foodLevel,
  houseVariant,
  isProc,
  millDesign,
  partsAt,
  ruinDesign,
  wellDesign,
  storeDesign,
  woodLevel,
  villageModels,
  Stage,
  STONE,
  type Design,
  type ProcKind,
} from './houses';

/** Flat colours (sRGB) of the procedural pieces. */
const PROC_COLOURS: Record<ProcKind, number> = {
  plinth: 0x8f8a80,
  stake: 0x7a5a38,
  pole: 0x9a7a52,
  beam: 0x8d6c45,
  board: 0xb98f5e,
  sack: 0xe0cfa6,
  hay: 0xe2c25a,
  soil: 0x6e4e32,
  fish: 0x8fb3c9,
  ring: 0xa8a196,
  water: 0x3f7896,
  gable: 0x8a4a3a,
  mud: 0x6b5a3e,
  timber: 0x5e4630,
  shard: 0xa4583e,
  rubble: 0x9a9286,
  weed: 0x6e9a3c,
  shrub: 0x5c8a34,
  bloom: 0xe8c64a,
};

function procGeometry(kind: ProcKind): THREE.BufferGeometry {
  let g: THREE.BufferGeometry;
  if (kind === 'sack') {
    // A plump low-poly sack, origin at its bottom.
    g = new THREE.IcosahedronGeometry(0.5, 1);
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      // Flat bottom, slight neck at the top.
      const yy = Math.max(-0.38, y);
      const pinch = y > 0.3 ? 0.65 : 1;
      p.setXYZ(i, p.getX(i) * pinch, yy + 0.38, p.getZ(i) * pinch);
    }
    g.scale(1, 1 / 0.88, 1);
  } else if (kind === 'fish') {
    // A slim fish hanging head down: a stretched octahedron with a tail fin.
    g = new THREE.OctahedronGeometry(0.5, 0);
    g.translate(0, 0.5, 0);
    const tail = new THREE.ConeGeometry(0.45, 0.35, 4);
    tail.rotateX(Math.PI);
    tail.translate(0, 1.1, 0);
    g = mergeGeometries([g.index ? g.toNonIndexed() : g, tail.index ? tail.toNonIndexed() : tail], false);
    // Hangs down from its tail at the origin.
    g.translate(0, -1.27, 0);
  } else if (kind === 'ring') {
    // A round wall of rough stones: a low-poly drum with a bevelled rim.
    g = new THREE.CylinderGeometry(0.5, 0.54, 1, 10, 2);
    g.translate(0, 0.5, 0);
  } else if (kind === 'water') {
    g = new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 1);
    g.translate(0, 0.5, 0);
  } else if (kind === 'gable') {
    // A pitched roof: a triangular prism along z, ridge on top, origin at the eaves' middle.
    const tri = new THREE.Shape([new THREE.Vector2(-0.5, 0), new THREE.Vector2(0.5, 0), new THREE.Vector2(0, 1)]);
    g = new THREE.ExtrudeGeometry(tri, { depth: 1, bevelEnabled: false });
    g.translate(0, 0, -0.5);
  } else if (kind === 'mud') {
    // A ragged flat stain: a disc with a wobbly rim.
    g = new THREE.CylinderGeometry(0.5, 0.5, 1, 14, 1);
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const z = p.getZ(i);
      const a = Math.atan2(z, x);
      const k = 0.78 + 0.16 * Math.sin(a * 3 + 1) + 0.08 * Math.sin(a * 5 + 2);
      p.setXYZ(i, x * k, p.getY(i), z * k);
    }
    g.translate(0, 0.5, 0);
  } else if (kind === 'weed' || kind === 'bloom') {
    // A tuft: a few thin blades fanning out (a bloom: with a flower head on top).
    const blades: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 5; k++) {
      const b = new THREE.ConeGeometry(0.12, 1, 3);
      b.translate(0, 0.5, 0);
      b.rotateZ(0.35 * Math.cos(k * 2.4));
      b.rotateX(0.35 * Math.sin(k * 2.4));
      b.translate(0.25 * Math.cos(k * 1.3), 0, 0.25 * Math.sin(k * 1.3));
      blades.push(b.index ? b.toNonIndexed() : b);
    }
    if (kind === 'bloom') {
      const head = new THREE.IcosahedronGeometry(0.28, 0);
      head.translate(0, 1.05, 0);
      blades.push(head.index ? head.toNonIndexed() : head);
    }
    g = mergeGeometries(blades, false);
  } else if (kind === 'shrub') {
    g = new THREE.IcosahedronGeometry(0.5, 0);
    g.scale(1, 0.8, 1);
    g.translate(0, 0.4, 0);
  } else if (kind === 'rubble') {
    // A lumpy stone.
    g = new THREE.IcosahedronGeometry(0.5, 0);
    g.translate(0, 0.35, 0);
  } else if (kind === 'hay') {
    g = new THREE.CylinderGeometry(0.5, 0.5, 1, 8, 1);
    g.translate(0, 0.5, 0);
  } else {
    g = new THREE.BoxGeometry(1, 1, 1);
    g.translate(0, 0.5, 0);
  }
  g.deleteAttribute('uv');
  const ng = g.index ? g.toNonIndexed() : g;
  ng.computeVertexNormals();
  const n = ng.getAttribute('position').count;
  const c = new THREE.Color(PROC_COLOURS[kind]);
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    // Subtle top-to-bottom shading for depth.
    const y = ng.getAttribute('position').getY(i);
    let k = kind === 'plinth' ? 0.85 + 0.15 * Math.min(1, Math.max(0, y)) : 1;
    // Rough stones: each vertex a little lighter or darker.
    if (kind === 'ring' || kind === 'rubble' || kind === 'shrub') k = 0.82 + 0.3 * (((i * 2654435761) >>> 0) / 4294967296);
    if (kind === 'bloom' && y < 0.8) {
      // Green stalks under the flower.
      col[i * 3] = 0.16;
      col[i * 3 + 1] = 0.32;
      col[i * 3 + 2] = 0.07;
      continue;
    }
    // The stain is darker in the middle, where the water stood longest.
    if (kind === 'mud') {
      const r = Math.hypot(ng.getAttribute('position').getX(i), ng.getAttribute('position').getZ(i));
      k = 0.8 + 0.35 * Math.min(1, r * 2);
    }
    col[i * 3] = c.r * k;
    col[i * 3 + 1] = c.g * k;
    col[i * 3 + 2] = c.b * k;
  }
  ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return ng;
}

const KIT_TEAL_G = 0.45;
const KIT_PLASTER_B = 0.694;

/**
 * Repaint the kit's teal roof tiles and blue-grey plaster (vertex colours,
 * linear), keeping the baked shading by scaling with the source brightness.
 */
export function repaint(col: Float32Array, roof: THREE.Color | null, plaster: THREE.Color | null): void {
  for (let i = 0; i < col.length; i += 3) {
    const r = col[i]!;
    const g = col[i + 1]!;
    const b = col[i + 2]!;
    let to: THREE.Color | null = null;
    let k = 1;
    if (roof && g > r * 2.5 && g > b) {
      to = roof;
      k = g / KIT_TEAL_G;
    } else if (plaster && b > r * 1.4 && b > g * 1.3 && r > 0.1) {
      to = plaster;
      k = b / KIT_PLASTER_B;
    }
    if (!to) continue;
    col[i] = to.r * k;
    col[i + 1] = to.g * k;
    col[i + 2] = to.b * k;
  }
}

/**
 * Ruins: weathered (colours drained towards a dull grey) and, below height
 * h (world units), stained brown by the flood's mud.
 */
function weather(g: THREE.BufferGeometry, h: number): void {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const col = g.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (!col) return;
  const mud = new THREE.Color(0x5a4630);
  for (let i = 0; i < pos.count; i++) {
    let r = col.getX(i);
    let gg = col.getY(i);
    let b = col.getZ(i);
    const l = 0.3 * r + 0.55 * gg + 0.15 * b;
    r = r * 0.55 + l * 0.4;
    gg = gg * 0.55 + l * 0.4;
    b = b * 0.55 + l * 0.38;
    const y = pos.getY(i);
    const t = y < h ? Math.min(1, (h - y) / 0.08) * 0.55 : 0;
    col.setXYZ(i, r * (1 - t) + mud.r * t, gg * (1 - t) + mud.g * t, b * (1 - t) + mud.b * t);
  }
  col.needsUpdate = true;
}

/** Merge a design's parts at a stage into one non-indexed geometry (position, normal, color). */
export function buildDesignGeometry(d: Design, stage: Stage, models: ReadonlyMap<ModelName, StaticModel>): THREE.BufferGeometry {
  const geos: THREE.BufferGeometry[] = [];
  const m = new THREE.Matrix4();
  const tmp = new THREE.Matrix4();
  const roof = d.roof !== undefined ? new THREE.Color(d.roof) : null;
  const plaster = d.plaster !== undefined ? new THREE.Color(d.plaster) : null;
  const stone = new THREE.Color(STONE);
  for (const p of partsAt(d, stage)) {
    let g: THREE.BufferGeometry;
    m.makeTranslation(p.x * d.scale, p.y * d.vscale, p.z * d.scale);
    m.multiply(tmp.makeRotationY(((p.rot ?? 0) * Math.PI) / 2));
    if (p.lean || p.roll) {
      // Ruins: tip the part about its foot.
      const px = (p.pivot ?? 0) * d.scale;
      m.multiply(tmp.makeTranslation(px, 0, 0));
      if (p.lean) m.multiply(tmp.makeRotationZ(-p.lean));
      if (p.roll) m.multiply(tmp.makeRotationX(p.roll));
      m.multiply(tmp.makeTranslation(-px, 0, 0));
    }
    if (isProc(p.m)) {
      g = procGeometry(p.m);
      const s = p.s ?? [1, 1, 1];
      m.multiply(tmp.makeScale(s[0] * d.scale, s[1] * d.vscale, s[2] * d.scale));
    } else {
      const model = models.get(p.m);
      if (!model) continue;
      const src = model.geometry;
      g = (src.index ? src.toNonIndexed() : src.clone()) as THREE.BufferGeometry;
      for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'color') g.deleteAttribute(name);
      const col = g.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (col) {
        const arr = new Float32Array(col.count * 3);
        for (let i = 0; i < col.count; i++) {
          arr[i * 3] = col.getX(i);
          arr[i * 3 + 1] = col.getY(i);
          arr[i * 3 + 2] = col.getZ(i);
        }
        repaint(arr, roof, p.stone ? stone : plaster);
        g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      }
      const s = p.s ?? [1, 1, 1];
      m.multiply(tmp.makeScale(s[0], s[1], s[2]));
      // Town parts are authored in tiles: undo the manifest scale, apply the design's.
      if (MODELS[p.m].category === 'building')
        m.multiply(tmp.makeScale(d.scale / TOWN_SCALE, d.vscale / TOWN_SCALE, d.scale / TOWN_SCALE));
    }
    g.applyMatrix4(m);
    if (d.stain !== undefined && !p.fresh) weather(g, d.stain * d.vscale);
    geos.push(g);
  }
  const merged = geos.length ? mergeGeometries(geos, false) : new THREE.BufferGeometry();
  for (const g of geos) g.dispose();
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/** Geometry/mesh key of a building given its village's food level (and whether it fishes). */
export function buildingKey(b: BuildingInfo, food: number, fish = false, wood = 0): string {
  if (b.kind === 'store') return `store:${food}:${fish ? 1 : 0}:${wood}`;
  // Ruins: wrecked walls, the roof caved in, mud and debris; weeds as it ages.
  if (b.kind === 'ruin') return `ruin:${houseVariant(b.id)}:${b.weeds ?? 2}`;
  if (b.kind === 'well') return `well:${buildStage(b.progress)}:${b.dry ? 1 : 0}`;
  if (b.kind === 'mill') return `mill:${buildStage(b.progress)}:${b.sacks ?? 0}`;
  if (b.kind === 'camp') return 'camp';
  return `house:${houseVariant(b.id)}:${buildStage(b.progress)}`;
}

function designFor(key: string): { design: Design; stage: Stage } {
  const parts = key.split(':');
  if (parts[0] === 'store') return { design: storeDesign(Number(parts[1]), parts[2] === '1', Number(parts[3] ?? 0)), stage: Stage.Done };
  if (parts[0] === 'well') return { design: wellDesign(parts[2] === '1'), stage: Number(parts[1]) as Stage };
  if (parts[0] === 'mill') return { design: millDesign(Number(parts[2] ?? 0)), stage: Number(parts[1]) as Stage };
  if (parts[0] === 'camp') return { design: campDesign(), stage: Stage.Done };
  if (parts[0] === 'ruin') return { design: ruinDesign(Number(parts[1]), Number(parts[2] ?? 0)), stage: Stage.Done };
  return { design: HOUSE_DESIGNS[Number(parts[1])]!, stage: Number(parts[2]) as Stage };
}

interface Batch {
  mesh: THREE.InstancedMesh;
  capacity: number;
}

export interface BuildingsOptions {
  library?: StaticModelSource;
}

export class BuildingsLayer {
  readonly group = new THREE.Group();
  readonly ready: Promise<void>;
  private models = new Map<ModelName, StaticModel>();
  private readonly geometries = new Map<string, THREE.BufferGeometry>();
  private readonly batches = new Map<string, Batch>();
  private list: BuildingInfo[] = [];
  /** Food level and fishing per village (index into the stats' village list). */
  private villages: { x: number; y: number; food: number; fish: boolean; wood: number }[] = [];
  private villageSig = '';
  private loaded = false;
  private layoutSig = '';
  private shadows = false;
  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpP = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly up = new THREE.Vector3(0, 1, 0);
  /** The ground look (snow cover in A) and its width, for snow on the roofs. */
  private look: Uint8Array | null = null;
  private lookWidth = 0;
  private snowSig = '';

  constructor(
    scene: THREE.Object3D,
    private readonly heights: HeightSampler,
    opts: BuildingsOptions = {},
  ) {
    this.group.name = 'buildings';
    scene.add(this.group);
    const lib = opts.library ?? modelLibrary();
    this.ready = lib.preloadStatic(villageModels()).then((ms) => {
      for (const m of ms) this.models.set(m.name, m);
      this.loaded = true;
      this.layout(true);
    });
  }

  /** The latest building list (as received). */
  get buildings(): readonly BuildingInfo[] {
    return this.list;
  }

  /** Number of InstancedMeshes drawn (≈ draw calls). */
  get meshCount(): number {
    let n = 0;
    for (const b of this.batches.values()) if (b.mesh.visible && b.mesh.count > 0) n++;
    return n;
  }

  setShadows(on: boolean): void {
    this.shadows = on;
    for (const b of this.batches.values()) b.mesh.castShadow = on;
  }

  setBuildings(list: readonly BuildingInfo[]): void {
    this.list = list.map((b) => ({ ...b }));
    this.layout(false);
  }

  /**
   * Per-village food stock (person-days), population and fishers: each
   * store shows 0–6 sacks (and hay, and a fish rack) for its own village,
   * the one nearest to it.
   */
  setVillages(vs: readonly VillageStats[]): void {
    const next = vs.map((v) => ({ x: v.x, y: v.y, food: foodLevel(v.food, v.population), fish: (v.fishers ?? 0) > 0, wood: woodLevel(v.wood ?? 0) }));
    const sig = next.map((v) => `${v.x},${v.y},${v.food},${v.fish},${v.wood}`).join(';');
    if (sig === this.villageSig) return;
    this.villageSig = sig;
    this.villages = next;
    this.layout(false);
  }

  private storeKey(b: BuildingInfo): string {
    let best: { food: number; fish: boolean; wood: number } | null = null;
    let bestD = Infinity;
    for (const v of this.villages) {
      const d = (v.x - b.x) ** 2 + (v.y - b.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    return buildingKey(b, best?.food ?? 0, best?.fish ?? false, best?.wood ?? 0);
  }

  /** Re-place everything on the terrain (after terrain edits). */
  refreshHeights(): void {
    this.layout(true);
  }

  dispose(): void {
    for (const b of this.batches.values()) b.mesh.dispose();
    for (const g of this.geometries.values()) g.dispose();
    this.batches.clear();
    this.geometries.clear();
    this.group.removeFromParent();
  }

  /** New ground look: roofs take the snow cover of their cell (in a few steps). */
  setLook(look: Uint8Array, width: number): void {
    this.look = look;
    this.lookWidth = width;
    let sig = '';
    for (const b of this.list) sig += this.roofSnow(b.x, b.y).toFixed(2);
    if (sig !== this.snowSig) this.layout(true);
  }

  private roofSnow(x: number, y: number): number {
    const l = this.look;
    if (!l) return 0;
    const i = (Math.round(y) * this.lookWidth + Math.round(x)) * LOOK_CHANNELS + 3;
    return Math.round(((l[i] ?? 0) / 255) * 4) / 4;
  }

  private geometry(key: string): THREE.BufferGeometry {
    let g = this.geometries.get(key);
    if (!g) {
      const { design, stage } = designFor(key);
      g = buildDesignGeometry(design, stage, this.models);
      this.geometries.set(key, g);
    }
    return g;
  }

  private layout(force: boolean): void {
    if (!this.loaded) return;
    const byKey = new Map<string, BuildingInfo[]>();
    let sig = '';
    for (const b of this.list) {
      const k = b.kind === 'store' ? this.storeKey(b) : buildingKey(b, 0);
      sig += `${b.id},${k},${b.x},${b.y},${b.rot};`;
      let arr = byKey.get(k);
      if (!arr) byKey.set(k, (arr = []));
      arr.push(b);
    }
    if (!force && sig === this.layoutSig) return;
    this.layoutSig = sig;
    this.snowSig = '';
    for (const b of this.list) this.snowSig += this.roofSnow(b.x, b.y).toFixed(2);
    for (const [k, batch] of this.batches)
      if (!byKey.has(k)) {
        batch.mesh.count = 0;
        batch.mesh.visible = false;
      }
    for (const [k, bs] of byKey) {
      let batch = this.batches.get(k);
      if (!batch || batch.capacity < bs.length) {
        if (batch) {
          batch.mesh.removeFromParent();
          batch.mesh.dispose();
        }
        const capacity = Math.max(4, bs.length * 2);
        const geometry = this.geometry(k);
        geometry.setAttribute(SNOW_ATTRIBUTE, new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2));
        const mesh = new THREE.InstancedMesh(geometry, snowCapMaterial(vertexColorMaterial()), capacity);
        mesh.name = `building-${k}`;
        mesh.castShadow = this.shadows;
        mesh.receiveShadow = true;
        this.group.add(mesh);
        batch = { mesh, capacity };
        this.batches.set(k, batch);
      }
      const mesh = batch.mesh;
      const snow = mesh.geometry.getAttribute(SNOW_ATTRIBUTE) as THREE.InstancedBufferAttribute;
      bs.forEach((b, i) => {
        const y = heightToY(this.footHeight(b.x, b.y));
        this.tmpP.set(b.x + 0.5, y, b.y + 0.5);
        this.tmpQ.setFromAxisAngle(this.up, b.rot);
        this.tmpM.compose(this.tmpP, this.tmpQ, this.one);
        mesh.setMatrixAt(i, this.tmpM);
        snow.setX(i, this.roofSnow(b.x, b.y) * 0.9);
      });
      snow.needsUpdate = true;
      mesh.count = bs.length;
      mesh.visible = true;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  /** Ground height for a footprint: a bit below the mean so the plinth hides slopes. */
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
