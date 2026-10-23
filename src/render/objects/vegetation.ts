/**
 * Instanced vegetation and small props scattered from the ground-look texture.
 *
 * Placement is a pure, deterministic function of (seed, cell, look, depth,
 * terrain): per-cell hashes decide probability, jitter, yaw and scale, so the
 * same world always looks the same and only cells whose class changes move.
 *
 * Instances are bucketed per CHUNK×CHUNK cells. Each chunk draws a small,
 * per-chunk palette of model variants (a forest stand is mostly one or two
 * species, which looks natural and keeps draw calls low): one InstancedMesh
 * per (chunk, model). Small props live in a separate detail layer that can be
 * hidden when zoomed out (`setDetail`).
 */
import * as THREE from 'three';
import { HEIGHT_SCALE, heightToY, type HeightSampler } from '../coords';
import { hash2 } from '../../shared/rng';
import { perlin } from '../../shared/noise';
import { LandUse, SoilType } from '../../sim/world';
import { FIELD_BYTES, LOOK_CHANNELS } from '../../shared/protocol';
import { modelLibrary, type StaticModel } from './loader';
import { SNOW_ATTRIBUTE, snowCapMaterial } from './snowCap';
import type { ModelName } from './manifest';

export const enum VegKind {
  Deciduous = 0,
  Conifer = 1,
  Bush = 2,
  Rock = 3,
  BigRock = 4,
  Reed = 5,
  Grass = 6,
  Flower = 7,
  Lily = 8,
  Mushroom = 9,
  Log = 10,
}
export const VEG_KIND_COUNT = 11;

/** Detail level at which each kind becomes visible (see setDetail). */
const KIND_DETAIL: readonly number[] = [0, 0, 1, 1, 0, 1, 2, 2, 2, 2, 2];

interface KindPalette {
  /** Candidate models; `perChunk` of them are picked per chunk. */
  readonly summer: readonly ModelName[];
  readonly autumn?: readonly ModelName[];
  readonly perChunk: number;
}

const PALETTES: readonly KindPalette[] = [
  {
    summer: ['tree_default', 'tree_oak', 'tree_oak_dark', 'tree_fat', 'tree_simple', 'tree_tall'],
    autumn: ['tree_default_fall', 'tree_oak_fall', 'tree_fat_fall', 'tree_simple_fall', 'tree_small_fall', 'tree_oak_dark'],
    perChunk: 3,
  },
  {
    summer: ['tree_cone', 'tree_cone_dark', 'tree_pineDefaultA', 'tree_pineRoundA', 'tree_pineTallA'],
    autumn: ['tree_cone', 'tree_cone_dark', 'tree_cone_fall', 'tree_pineDefaultA', 'tree_pineTallA'],
    perChunk: 2,
  },
  { summer: ['plant_bush', 'plant_bushLarge', 'plant_bushDetailed'], perChunk: 2 },
  { summer: ['stone_smallA', 'stone_smallB', 'rock_smallA'], perChunk: 2 },
  { summer: ['stone_largeA', 'stone_largeB', 'stone_tallA'], perChunk: 2 },
  { summer: ['reeds', 'plant_flatTall'], perChunk: 2 },
  { summer: ['grass_leafs', 'grass_leafsLarge'], perChunk: 1 },
  { summer: ['flower_purpleA', 'flower_redA', 'flower_yellowA'], perChunk: 2 },
  { summer: ['lily_large', 'lily_small'], perChunk: 2 },
  { summer: ['mushroom_redGroup', 'mushroom_tan'], perChunk: 1 },
  { summer: ['log', 'stump_old', 'stump_round'], perChunk: 2 },
];

/** All models the vegetation layer may use (for preloading). */
export function vegetationModels(): ModelName[] {
  const s = new Set<ModelName>();
  for (const p of PALETTES) {
    p.summer.forEach((n) => s.add(n));
    p.autumn?.forEach((n) => s.add(n));
  }
  return [...s];
}

/** One scattered object, in sampler cell coordinates (centre of cell i = i). */
export interface Placement {
  kind: VegKind;
  /** Index into the chunk palette for this kind. */
  variant: number;
  x: number;
  y: number;
  yaw: number;
  scale: number;
  /** Multiplicative colour tint (linear). */
  tint: number;
  /** Snow cover at the cell (0..1): a white cap on the upward faces. */
  snow?: number;
}

export interface ScatterInput {
  readonly heights: HeightSampler;
  readonly look: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly seed: number;
  /** Land use per cell (LandUse enum), or null: built-up and farmed cells get no vegetation. */
  readonly landuse?: Uint8Array | null;
  /** Stone lining per cell (planned or built): no vegetation there. */
  readonly lining?: Uint8Array | null;
  /** Fog of war (revealed 0..255 per cell), or null: nothing grows visibly on unknown land. */
  readonly revealed?: Uint8Array | null;
}

/** Revealed value below which no objects are placed. */
export const VEG_REVEALED = 128;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Deterministic placements for cells [x0,x1)×[y0,y1). Pure function of the
 * input (no Math.random); used by the layer and by tests.
 */
export function scatter(inp: ScatterInput, x0: number, y0: number, x1: number, y1: number, out: Placement[] = []): Placement[] {
  const { heights, look, width, height, seed, landuse, lining, revealed } = inp;
  const S = seed | 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (revealed && revealed[y * width + x]! < VEG_REVEALED) continue;
      if (landuse) {
        const lu = landuse[y * width + x]!;
        if (lu !== LandUse.None && lu !== LandUse.Pasture) continue;
      }
      if (lining && lining[y * width + x] !== 0) continue;
      const li = (y * width + x) * LOOK_CHANNELS;
      const soil = look[li]!;
      const moist = look[li + 1]! / 255;
      const veg = look[li + 2]! / 255;
      const snow = look[li + 3]! / 255;
      const depth = heights.depthAt(x, y);
      const h = (k: number) => hash2(x, y, S + k * 0x3c6ef372);

      // Shore: dry cell with standing water within two cells (computed lazily).
      const isShore = (): boolean => {
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            if (heights.depthAt(nx, ny) > 0.15) return true;
          }
        return false;
      };

      // Water cells: only lily pads in shallow, calm-ish water near the shore.
      if (depth > 0.08) {
        if (depth < 1.2 && depth > 0.12 && (soil === SoilType.Peat || soil === SoilType.Silt || soil === SoilType.Clay || moist > 0.6)) {
          if (h(1) < 0.06) {
            out.push({ kind: VegKind.Lily, variant: h(2), x: x + (h(3) - 0.5) * 0.7, y: y + (h(4) - 0.5) * 0.7, yaw: h(5) * Math.PI * 2, scale: 1.3 + 0.7 * h(6), tint: 1 });
          }
        }
        continue;
      }

      // Slope (rise over run).
      const gx = (heights.terrainAt(x + 1, y) - heights.terrainAt(x - 1, y)) / 10;
      const gy = (heights.terrainAt(x, y + 1) - heights.terrainAt(x, y - 1)) / 10;
      const slope = Math.sqrt(gx * gx + gy * gy);

      const jx = x + (h(10) - 0.5) * 0.76;
      const jy = y + (h(11) - 0.5) * 0.76;
      const yaw = h(12) * Math.PI * 2;
      const tint = 0.88 + 0.2 * h(13);
      const r = h(14);
      let large = false;

      // --- large objects (one per cell at most) ------------------------------
      if (soil === SoilType.Rock || soil === SoilType.Gravel) {
        const pRock = soil === SoilType.Rock ? 0.32 : 0.1;
        if (r < pRock) {
          const big = h(15) < (soil === SoilType.Rock ? 0.3 : 0.08);
          out.push({ kind: big ? VegKind.BigRock : VegKind.Rock, variant: h(16), x: jx, y: jy, yaw, scale: 0.7 + 0.7 * h(17), tint: 0.9 + 0.15 * h(18), snow });
          large = true;
        }
      } else if (r < 0.006 && slope < 1) {
        out.push({ kind: VegKind.Rock, variant: h(16), x: jx, y: jy, yaw, scale: 0.6 + 0.5 * h(17), tint: 0.9 + 0.15 * h(18), snow });
        large = true;
      }

      const shore = !large && slope < 0.5 && moist > 0.3 && soil !== SoilType.Rock && soil !== SoilType.Gravel && isShore();
      const reedy = (soil === SoilType.Peat && moist > 0.6) || shore;
      if (!large && reedy && slope < 0.5) {
        const pReed = shore ? 0.45 : 0.18;
        if (h(20) < pReed) {
          out.push({ kind: VegKind.Reed, variant: h(21), x: jx, y: jy, yaw, scale: 0.75 + 0.5 * h(22), tint });
          large = true;
        }
      }

      if (!large && slope < 0.7) {
        const pTree = smooth(0.5, 0.85, veg) * 0.85 * (1 - smooth(0.45, 0.7, slope));
        if (h(30) < pTree) {
          // Species clustering: low-frequency noise + soil preference.
          const coniferBias =
            perlin(x / 14, y / 14, S ^ 0x5bd1e995) +
            (soil === SoilType.Sand || soil === SoilType.Gravel || soil === SoilType.Peat ? 0.35 : 0) +
            (soil === SoilType.Rock ? 0.5 : 0) -
            (soil === SoilType.Silt || soil === SoilType.Loam ? 0.15 : 0);
          const conifer = coniferBias + (h(31) - 0.5) * 0.5 > 0.12;
          const fringe = 0.72 + 0.4 * smooth(0.5, 0.9, veg);
          out.push({
            kind: conifer ? VegKind.Conifer : VegKind.Deciduous,
            variant: h(32),
            x: jx,
            y: jy,
            yaw,
            scale: fringe * (0.8 + 0.45 * h(33)),
            tint,
            snow,
          });
          large = true;
        } else {
          const pBush = 0.22 * smooth(0.3, 0.5, veg) * (1 - 0.5 * smooth(0.75, 1, veg));
          if (h(34) < pBush) {
            out.push({ kind: VegKind.Bush, variant: h(35), x: jx, y: jy, yaw, scale: 0.8 + 0.6 * h(36), tint, snow });
            large = true;
          }
        }
      }

      // --- small detail objects ----------------------------------------------
      if (snow > 0.4 || slope > 0.9) continue;
      const sx = x + (h(40) - 0.5) * 0.8;
      const sy = y + (h(41) - 0.5) * 0.8;
      const syaw = h(42) * Math.PI * 2;
      if (veg > 0.72 && moist > 0.4 && h(43) < 0.035) {
        out.push({ kind: VegKind.Mushroom, variant: h(44), x: sx, y: sy, yaw: syaw, scale: 0.8 + 0.5 * h(45), tint: 1 });
      } else if (veg > 0.7 && h(46) < 0.018) {
        out.push({ kind: VegKind.Log, variant: h(47), x: sx, y: sy, yaw: syaw, scale: 0.8 + 0.3 * h(48), tint: 1 });
      } else if (veg > 0.25 && veg < 0.8 && perlin(x / 6, y / 6, S ^ 0x1234567) > 0.18 && h(49) < 0.3) {
        out.push({ kind: VegKind.Flower, variant: h(50), x: sx, y: sy, yaw: syaw, scale: 0.8 + 0.5 * h(51), tint: 1 });
      } else if (veg > 0.18 && h(52) < 0.3 * smooth(0.18, 0.5, veg) * (large ? 0.3 : 1)) {
        out.push({ kind: VegKind.Grass, variant: h(53), x: sx, y: sy, yaw: syaw, scale: 0.7 + 0.5 * h(54), tint: 0.9 + 0.2 * h(55) });
      }
    }
  }
  return out;
}

/** Moisture and snow bands the scatter distinguishes (look bytes; see `scatter`). */
const MOIST_BANDS = [77, 102, 153];
/** Snow bands: the detail objects go under 102; trees, bushes and rocks carry a cap that steps with the cover. */
const SNOW_BANDS = [26, 77, 102, 153, 204];
/** Snow cover → the cap's strength, in the steps the chunks are rebuilt at. */
export function snowCap(snow: number): number {
  return band(Math.round(snow * 255), SNOW_BANDS) / SNOW_BANDS.length;
}
const band = (v: number, edges: readonly number[]) => {
  let k = 0;
  for (const e of edges) if (v >= e) k++;
  return k;
};

/**
 * Indices of the chunks (row-major, `chunkSize` cells) in which a look byte
 * the scatter depends on differs between two looks: soil, vegetation, the
 * moisture bands and snow cover.
 */
export function changedChunks(prev: Uint8Array, next: Uint8Array, width: number, height: number, chunkSize: number): number[] {
  const nx = Math.ceil(width / chunkSize);
  const ny = Math.ceil(height / chunkSize);
  const out: number[] = [];
  for (let cy = 0; cy < ny; cy++)
    for (let cx = 0; cx < nx; cx++) {
      let changed = false;
      for (let y = cy * chunkSize; y < Math.min(height, (cy + 1) * chunkSize) && !changed; y++)
        for (let x = cx * chunkSize; x < Math.min(width, (cx + 1) * chunkSize); x++) {
          const o = (y * width + x) * LOOK_CHANNELS;
          if (
            prev[o] !== next[o] ||
            prev[o + 2] !== next[o + 2] ||
            band(prev[o + 1]!, MOIST_BANDS) !== band(next[o + 1]!, MOIST_BANDS) ||
            band(prev[o + 3]!, SNOW_BANDS) !== band(next[o + 3]!, SNOW_BANDS)
          ) {
            changed = true;
            break;
          }
        }
      if (changed) out.push(cy * nx + cx);
    }
  return out;
}

/** Order-dependent 32-bit hash of placements (cheap change detection). */
function signature(ps: readonly Placement[], palette: readonly (readonly ModelName[])[]): number {
  let s = 0x811c9dc5;
  for (const p of ps) {
    const m = palette[p.kind]!;
    const v = Math.floor(p.variant * m.length);
    s = Math.imul(s ^ ((p.kind << 8) | v | (Math.round(snowCap(p.snow ?? 0) * 8) << 16)), 0x01000193);
    s = Math.imul(s ^ Math.round(p.x * 64), 0x01000193);
    s = Math.imul(s ^ Math.round(p.y * 64), 0x01000193);
  }
  return s >>> 0;
}

interface ChunkModelData {
  matrices: Float32Array;
  colors: Float32Array;
  /** Per instance: snow cap, winter dulling of the leaves (snowCap.ts). */
  snow: Float32Array;
  count: number;
}

interface Chunk {
  readonly cx: number;
  readonly cy: number;
  data: Map<ModelName, ChunkModelData>;
  bounds: THREE.Box3;
  sig: number;
  forced: boolean;
}

/** One InstancedMesh per model; holds the instances of all currently visible chunks. */
interface Batch {
  readonly name: ModelName;
  readonly kind: VegKind;
  mesh: THREE.InstancedMesh | null;
  capacity: number;
}

/** Where models come from (a ModelLibrary, or a stub in tests). */
export interface StaticModelSource {
  preloadStatic(names: readonly ModelName[]): Promise<StaticModel[]>;
}

export interface VegetationOptions {
  chunkSize?: number;
  library?: StaticModelSource;
  /** 0 = spring, 1 = summer, 2 = autumn, 3 = winter. */
  season?: number;
  /** Time budget per rebuild slice (ms). */
  sliceMs?: number;
  /**
   * Cull chunks automatically against the camera passed to scene rendering
   * (chains `scene.onBeforeRender`). Otherwise call `cull(camera)` per frame.
   */
  autoCull?: boolean;
  /**
   * Direction towards the sun (three.js axes, live object). When given,
   * objects are darkened like the slope they stand on, so they don't glow
   * on shaded hillsides.
   */
  sunDir?: { x: number; y: number; z: number };
}

/**
 * Draw calls: one per model type with visible instances (≤ ~34 by palette
 * construction, typically 15–25). Instances are stored per chunk on the CPU
 * and each model's InstancedMesh is refilled with the instances of the chunks
 * inside the view frustum whenever that set changes (chunk-granular culling).
 */
export class VegetationLayer {
  readonly group = new THREE.Group();
  /** Resolves once models are loaded and the initial scatter is built. */
  readonly ready: Promise<void>;
  private look: Uint8Array;
  private landuse: Uint8Array | null = null;
  private lining: Uint8Array | null = null;
  private revealed: Uint8Array | null = null;
  private readonly chunkSize: number;
  private readonly chunks: Chunk[] = [];
  private readonly nx: number;
  private readonly ny: number;
  private models = new Map<ModelName, StaticModel>();
  private batches = new Map<ModelName, Batch>();
  private loaded = false;
  private pending = new Set<number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private detail = 2;
  private season: number;
  private readonly sliceMs: number;
  private disposed = false;
  private visibleKey = '';
  private refilled = false;
  private dataDirty = true;
  private lastCamera: THREE.Camera | null = null;
  private readonly frustum = new THREE.Frustum();
  private readonly projView = new THREE.Matrix4();
  private readonly scene: THREE.Object3D;
  private prevOnBeforeRender: THREE.Object3D['onBeforeRender'] | null = null;
  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpQ2 = new THREE.Quaternion();
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpN = { x: 0, y: 1, z: 0 };
  private readonly tmpP = new THREE.Vector3();
  private readonly tmpS = new THREE.Vector3();
  private readonly tmpC = new THREE.Color();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(
    scene: THREE.Object3D,
    private readonly heights: HeightSampler,
    look: Uint8Array,
    private readonly width: number,
    private readonly height: number,
    private readonly seed: number,
    private readonly opts: VegetationOptions = {},
  ) {
    this.scene = scene;
    this.look = look;
    this.chunkSize = opts.chunkSize ?? 64;
    this.season = opts.season ?? 1;
    this.sliceMs = opts.sliceMs ?? 6;
    this.nx = Math.ceil(width / this.chunkSize);
    this.ny = Math.ceil(height / this.chunkSize);
    for (let cy = 0; cy < this.ny; cy++)
      for (let cx = 0; cx < this.nx; cx++) this.chunks.push({ cx, cy, data: new Map(), bounds: new THREE.Box3(), sig: -1, forced: true });
    this.group.name = 'vegetation';
    scene.add(this.group);
    if (opts.autoCull !== false && (scene as THREE.Scene).isScene) {
      const prev = scene.onBeforeRender;
      this.prevOnBeforeRender = prev;
      scene.onBeforeRender = (renderer, sc, camera, geometry, material, group) => {
        prev.call(scene, renderer, sc, camera, geometry, material, group);
        this.cull(camera);
      };
    }
    const lib = opts.library ?? modelLibrary();
    this.ready = lib.preloadStatic(vegetationModels()).then((ms) => {
      for (const m of ms) this.models.set(m.name, m);
      PALETTES.forEach((p, kind) => {
        for (const n of [...p.summer, ...(p.autumn ?? [])]) if (!this.batches.has(n)) this.batches.set(n, { name: n, kind, mesh: null, capacity: 0 });
      });
      this.loaded = true;
      this.chunks.forEach((_, i) => this.pending.add(i));
      this.flush();
    });
  }

  /**
   * New look data (or none: just continue pending work). Only the chunks
   * where something the scatter reads changed are re-scattered (the
   * vegetation grows and declines daily, mostly in a few places), and of
   * those only the ones whose placements differ are rebuilt.
   */
  update(look?: Uint8Array): void {
    if (look) {
      const prev = this.look;
      this.look = look;
      if (prev.length !== look.length) this.chunks.forEach((_, i) => this.pending.add(i));
      else for (const i of changedChunks(prev, look, this.width, this.height, this.chunkSize)) this.pending.add(i);
    }
    this.schedule();
  }

  /**
   * Land use from a snapshot's `fields` (FIELD_BYTES per cell: LandUse, crop, stress).
   * Re-scatters the chunks whose land use changed (vegetation is cleared on
   * fields, buildings, paths…).
   */
  setFields(fields: Uint8Array): void {
    const n = this.width * this.height;
    const prev = this.landuse;
    const next = new Uint8Array(n);
    for (let i = 0; i < n; i++) next[i] = fields[FIELD_BYTES * i]!;
    // Keep the cells next to buildings clear too (a little yard around each house).
    const W = this.width;
    for (let i = 0; i < n; i++) {
      if (fields[FIELD_BYTES * i] !== LandUse.Building) continue;
      const x = i % W;
      const y = (i / W) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= this.height) continue;
          const j = ny * W + nx;
          if (next[j] === LandUse.None) next[j] = LandUse.Yard;
        }
    }
    this.landuse = next;
    const cs = this.chunkSize;
    for (let i = 0; i < n; i++) {
      if (prev ? prev[i] === next[i] : next[i] === LandUse.None) continue;
      const x = i % this.width;
      const y = (i / this.width) | 0;
      const ci = Math.floor(y / cs) * this.nx + Math.floor(x / cs);
      if (!this.pending.has(ci)) {
        this.chunks[ci]!.forced = true;
        this.pending.add(ci);
      }
    }
    this.schedule();
  }

  /** Stone lining per cell (from snapshots): re-scatters the chunks where it changed. */
  setLining(lining: Uint8Array): void {
    const prev = this.lining;
    this.lining = lining.slice();
    const cs = this.chunkSize;
    for (let i = 0; i < lining.length; i++) {
      if ((prev ? prev[i]! !== 0 : false) === (lining[i]! !== 0)) continue;
      const ci = Math.floor(((i / this.width) | 0) / cs) * this.nx + Math.floor((i % this.width) / cs);
      if (!this.pending.has(ci)) {
        this.chunks[ci]!.forced = true;
        this.pending.add(ci);
      }
    }
    this.schedule();
  }

  /**
   * Fog of war: objects only stand on known land. Re-scatters the chunks
   * where cells crossed the threshold.
   */
  setRevealed(revealed: Uint8Array): void {
    const n = this.width * this.height;
    const prev = this.revealed;
    const next = revealed.slice(0, n);
    this.revealed = next;
    const cs = this.chunkSize;
    for (let i = 0; i < n; i++) {
      if (prev && (prev[i]! >= VEG_REVEALED) === (next[i]! >= VEG_REVEALED)) continue;
      if (!prev && next[i]! >= VEG_REVEALED) continue;
      const ci = Math.floor(((i / this.width) | 0) / cs) * this.nx + Math.floor((i % this.width) / cs);
      if (!this.pending.has(ci)) {
        this.chunks[ci]!.forced = true;
        this.pending.add(ci);
      }
    }
    this.schedule();
  }

  /** Force re-scatter of the chunks overlapping a cell rectangle (e.g. after terrain edits). */
  invalidate(x0: number, y0: number, x1: number, y1: number): void {
    const cs = this.chunkSize;
    for (let cy = Math.max(0, Math.floor(y0 / cs)); cy <= Math.min(this.ny - 1, Math.floor(y1 / cs)); cy++)
      for (let cx = Math.max(0, Math.floor(x0 / cs)); cx <= Math.min(this.nx - 1, Math.floor(x1 / cs)); cx++) {
        const i = cy * this.nx + cx;
        this.chunks[i]!.forced = true;
        this.pending.add(i);
      }
    this.schedule();
  }

  /** 0 = trees and big rocks only, 1 = + bushes, small rocks, reeds, 2 = everything. */
  setDetail(level: number): void {
    this.detail = level;
    for (const b of this.batches.values()) if (b.mesh) b.mesh.visible = b.mesh.count > 0 && KIND_DETAIL[b.kind]! <= level;
  }

  setSeason(season: number): void {
    // Autumn swaps models; winter dulls the leaves.
    const look = (k: number) => (k === 2 ? 2 : k === 3 ? 3 : 0);
    const changed = look(season) !== look(this.season);
    this.season = season;
    if (changed) {
      this.chunks.forEach((c, i) => {
        c.forced = true;
        this.pending.add(i);
      });
      this.schedule();
    }
  }

  /** Synchronously process all pending chunk rebuilds. */
  flush(): void {
    if (!this.loaded) return;
    for (const i of this.pending) this.rebuild(i);
    this.pending.clear();
    if (this.lastCamera) this.cull(this.lastCamera);
  }

  /**
   * Refill the instanced meshes with the chunks visible from `camera`.
   * Cheap when the visible chunk set is unchanged.
   */
  cull(camera: THREE.Camera): void {
    if (!this.loaded) return;
    this.lastCamera = camera;
    camera.updateMatrixWorld();
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    let key = '';
    const vis: Chunk[] = [];
    for (const c of this.chunks) {
      const v = !c.bounds.isEmpty() && this.frustum.intersectsBox(c.bounds);
      key += v ? '1' : '0';
      if (v) vis.push(c);
    }
    if (key === this.visibleKey && !this.dataDirty) return;
    this.visibleKey = key;
    this.dataDirty = false;
    this.refilled = true;
    for (const b of this.batches.values()) {
      let n = 0;
      for (const c of vis) n += c.data.get(b.name)?.count ?? 0;
      if (n === 0) {
        if (b.mesh) {
          b.mesh.count = 0;
          b.mesh.visible = false;
        }
        continue;
      }
      if (!b.mesh || b.capacity < n) this.allocate(b, Math.max(n, Math.ceil(b.capacity * 1.5), 16));
      const mesh = b.mesh!;
      const mArr = mesh.instanceMatrix.array as Float32Array;
      const cArr = mesh.instanceColor!.array as Float32Array;
      const snowAttr = mesh.geometry.getAttribute(SNOW_ATTRIBUTE) as THREE.InstancedBufferAttribute;
      const sArr = snowAttr.array as Float32Array;
      let o = 0;
      for (const c of vis) {
        const d = c.data.get(b.name);
        if (!d) continue;
        mArr.set(d.matrices.subarray(0, d.count * 16), o * 16);
        cArr.set(d.colors.subarray(0, d.count * 3), o * 3);
        sArr.set(d.snow.subarray(0, d.count * 2), o * 2);
        o += d.count;
      }
      snowAttr.clearUpdateRanges();
      snowAttr.addUpdateRange(0, n * 2);
      snowAttr.needsUpdate = true;
      mesh.count = n;
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, n * 16);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor!.clearUpdateRanges();
      mesh.instanceColor!.addUpdateRange(0, n * 3);
      mesh.instanceColor!.needsUpdate = true;
      mesh.visible = KIND_DETAIL[b.kind]! <= this.detail;
    }
  }

  /** Chunks still waiting to be re-scattered. */
  get busy(): boolean {
    return this.loaded && this.pending.size > 0;
  }

  /** Whether the instances changed since the last call (they need drawing). */
  takeChange(): boolean {
    const c = this.refilled;
    this.refilled = false;
    return c;
  }

  /** Number of InstancedMeshes that will be drawn (≈ vegetation draw calls). */
  get meshCount(): number {
    let n = 0;
    for (const b of this.batches.values()) if (b.mesh && b.mesh.visible && b.mesh.count > 0) n++;
    return n;
  }

  /** Total scattered instances (all chunks, visible or not). */
  get instanceCount(): number {
    let n = 0;
    for (const c of this.chunks) for (const d of c.data.values()) n += d.count;
    return n;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const b of this.batches.values()) b.mesh?.dispose();
    this.batches.clear();
    if (this.prevOnBeforeRender) this.scene.onBeforeRender = this.prevOnBeforeRender;
    this.group.removeFromParent();
  }

  private allocate(b: Batch, capacity: number): void {
    if (b.mesh) {
      b.mesh.removeFromParent();
      b.mesh.dispose();
    }
    const model = this.models.get(b.name)!;
    // A geometry of its own per batch (sharing the model's buffers): it carries the per-instance snow.
    const geometry = new THREE.BufferGeometry();
    for (const [k, a] of Object.entries(model.geometry.attributes)) geometry.setAttribute(k, a);
    geometry.setIndex(model.geometry.index);
    geometry.boundingBox = model.geometry.boundingBox;
    geometry.boundingSphere = model.geometry.boundingSphere;
    const snow = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    snow.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(SNOW_ATTRIBUTE, snow);
    const mesh = new THREE.InstancedMesh(geometry, snowCapMaterial(model.material), capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, this.tmpC.setRGB(1, 1, 1));
    mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    mesh.name = `veg-${b.name}`;
    mesh.frustumCulled = false; // culled per chunk in cull()
    mesh.castShadow = b.kind === VegKind.Deciduous || b.kind === VegKind.Conifer || b.kind === VegKind.BigRock;
    this.group.add(mesh);
    b.mesh = mesh;
    b.capacity = capacity;
  }

  private schedule(): void {
    if (!this.loaded || this.timer || this.disposed || !this.pending.size) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const t0 = performance.now();
      for (const i of this.pending) {
        this.pending.delete(i);
        this.rebuild(i);
        if (performance.now() - t0 > this.sliceMs) break;
      }
      if (this.lastCamera) this.cull(this.lastCamera);
      this.schedule();
    }, 0);
  }

  private chunkPalette(c: Chunk): ModelName[][] {
    const autumn = this.season === 2;
    return PALETTES.map((p, k) => {
      const list = autumn && p.autumn ? p.autumn : p.summer;
      const picked: ModelName[] = [];
      let salt = 0;
      while (picked.length < Math.min(p.perChunk, new Set(list).size)) {
        const n = list[Math.floor(hash2(c.cx * 31 + k, c.cy * 17 + salt++, this.seed ^ 0x2545f491) * list.length)]!;
        if (!picked.includes(n)) picked.push(n);
      }
      return picked;
    });
  }

  private rebuild(i: number): void {
    const c = this.chunks[i]!;
    const cs = this.chunkSize;
    const x0 = c.cx * cs;
    const y0 = c.cy * cs;
    const x1 = Math.min(this.width, x0 + cs);
    const y1 = Math.min(this.height, y0 + cs);
    const placements = scatter(
      {
        heights: this.heights,
        look: this.look,
        width: this.width,
        height: this.height,
        seed: this.seed,
        landuse: this.landuse,
        revealed: this.revealed,
        lining: this.lining,
      },
      x0,
      y0,
      x1,
      y1,
    );
    const palette = this.chunkPalette(c);
    const sig = signature(placements, palette);
    if (sig === c.sig && !c.forced) return;
    c.sig = sig;
    c.forced = false;

    const byModel = new Map<ModelName, Placement[]>();
    for (const p of placements) {
      const list = palette[p.kind]!;
      const name = list[Math.min(list.length - 1, Math.floor(p.variant * list.length))]!;
      let arr = byModel.get(name);
      if (!arr) byModel.set(name, (arr = []));
      arr.push(p);
    }
    const autumn = this.season === 2;
    const winter = this.season === 3;
    c.data = new Map();
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [name, ps] of byModel) {
      const model = this.models.get(name);
      if (!model) continue;
      const d: ChunkModelData = {
        matrices: new Float32Array(ps.length * 16),
        colors: new Float32Array(ps.length * 3),
        snow: new Float32Array(ps.length * 2),
        count: ps.length,
      };
      const kind = ps[0]!.kind;
      // Bare-ish in winter: deciduous trees most, bushes and conifers a little.
      const dull = winter ? (kind === VegKind.Deciduous ? 1 : kind === VegKind.Bush ? 0.7 : kind === VegKind.Conifer ? 0.25 : 0) : 0;
      const isTree = kind === VegKind.Deciduous || kind === VegKind.Conifer || kind === VegKind.BigRock;
      // Rocks and logs lie on the ground: tilt them with the slope and bury
      // them partly, so they share the slope's lighting and never float.
      const lying = kind === VegKind.Rock || kind === VegKind.BigRock || kind === VegKind.Log;
      const bury = kind === VegKind.Log ? 0.15 : lying ? 0.3 : 0;
      for (let k = 0; k < ps.length; k++) {
        const p = ps[k]!;
        const n = this.tmpN;
        if (this.heights.normalAt) this.heights.normalAt(p.x, p.y, n, HEIGHT_SCALE);
        else (n.x = 0), (n.y = 1), (n.z = 0);
        // On a slope an upright object's downhill edge floats: sink it a bit.
        const steep = Math.sqrt(Math.max(0, 1 - n.y * n.y)) / Math.max(n.y, 0.2);
        let ty =
          kind === VegKind.Lily
            ? heightToY(this.heights.terrainAt(p.x, p.y) + this.heights.depthAt(p.x, p.y)) + 0.02
            : heightToY(this.heights.terrainAt(p.x, p.y)) - (isTree ? 0.02 : 0.005);
        if (kind !== VegKind.Lily) ty -= bury * model.height * p.scale + Math.min(0.3, steep * (lying ? 0.05 : 0.12) * p.scale);
        if (ty < minY) minY = ty;
        if (ty + model.height * p.scale > maxY) maxY = ty + model.height * p.scale;
        this.tmpP.set(p.x + 0.5, ty, p.y + 0.5);
        this.tmpQ.setFromAxisAngle(this.up, p.yaw);
        if (lying) {
          this.tmpV.set(n.x, n.y, n.z);
          this.tmpQ2.setFromUnitVectors(this.up, this.tmpV);
          this.tmpQ.premultiply(this.tmpQ2);
        }
        this.tmpS.setScalar(p.scale);
        this.tmpM.compose(this.tmpP, this.tmpQ, this.tmpS);
        this.tmpM.toArray(d.matrices, k * 16);
        // Take on the slope's light: Lambert of the terrain normal relative to
        // flat ground (fully for things lying on the ground, half for plants).
        let light = 1;
        const sun = this.opts.sunDir;
        if (sun && kind !== VegKind.Lily) {
          const flat = 0.55 + 0.45 * Math.max(0, sun.y);
          const here = 0.55 + 0.45 * Math.max(0, n.x * sun.x + n.y * sun.y + n.z * sun.z);
          light = Math.pow(here / flat, lying ? 1.6 : 0.6);
        }
        // Stone models are paler than the rocky ground; tone them down.
        const tint = p.tint * light * (lying && kind !== VegKind.Log ? 0.66 : 1);
        // Gentle per-instance variation; in autumn deciduous trees get warmer.
        if (autumn && kind === VegKind.Deciduous) this.tmpC.setRGB(tint * 1.04, tint, tint * 0.92);
        else this.tmpC.setRGB(tint, tint * (0.98 + (0.04 * ((k * 7919) % 13)) / 13), tint);
        this.tmpC.toArray(d.colors, k * 3);
        d.snow[k * 2] = snowCap(p.snow ?? 0) * (isTree || kind === VegKind.Bush || lying ? 0.95 : 0);
        d.snow[k * 2 + 1] = dull;
      }
      c.data.set(name, d);
    }
    if (c.data.size) c.bounds.set(new THREE.Vector3(x0 - 1, minY, y0 - 1), new THREE.Vector3(x1 + 2, maxY, y1 + 2));
    else c.bounds.makeEmpty();
    this.dataDirty = true;
  }
}
