/**
 * Instanced crop models on field cells, shown only when zoomed in (the
 * terrain shader paints fields at every zoom). Instances are rebuilt for the
 * cells around the camera target when the fields change (at most every
 * `rebuildMs`) or the view leaves the built region; each crop model is one
 * InstancedMesh (≤ ~8 draw calls, usually 2–4), with a per-model cap.
 */
import * as THREE from 'three';
import { heightToY, type HeightSampler } from '../coords';
import { modelLibrary, type StaticModel } from '../objects/loader';
import type { ModelName } from '../objects/manifest';
import type { StaticModelSource } from '../objects/vegetation';
import { FIELD_BYTES, FieldCrop } from '../../shared/protocol';
import { CROP_RIPE, CROP_SOWN, CropKind, ROWS_PER_CELL, cropKind, decodeStress, furrowsAlongX } from './fields';

/** LandUse.Field (see sim/world.ts). */
const FIELD = 1;

export const CROP_MODELS: readonly ModelName[] = [
  'crops_wheatStageA',
  'crops_wheatStageB',
  'crops_cornStageA',
  'crops_cornStageB',
  'crops_cornStageC',
  'crops_cornStageD',
  'crops_leafsStageA',
  'crops_leafsStageB',
  'crop_pumpkin',
  'grass',
];

export interface CropPlacement {
  model: ModelName;
  /** Cell coordinates (cell i centre at i). */
  x: number;
  y: number;
  yaw: number;
  scale: number;
  /** Linear colour tint. */
  r: number;
  g: number;
  b: number;
  /** Stand on the water surface where there is water (paddies), not on the ground below. */
  lift?: boolean;
}

function hash3(x: number, y: number, k: number): number {
  let h = (Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(k, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return h / 4294967296;
}

/** Model, scale and tint for a crop kind at growth fraction g (0 sown .. 1 ripe). */
function cropLook(kind: CropKind, crop: number): { model: ModelName; scale: number; tint: [number, number, number] } {
  const g = Math.min(1, Math.max(0, (crop - CROP_SOWN) / (CROP_RIPE - CROP_SOWN)));
  const ripe = crop >= CROP_RIPE;
  switch (kind) {
    case CropKind.Wheat:
      if (g < 0.45) return { model: 'crops_wheatStageA', scale: 0.45 + 0.75 * (g / 0.45), tint: [1.15, 1.1, 1] };
      if (ripe) return { model: 'crops_wheatStageB', scale: 1.25, tint: [1.0, 0.78, 0.3] };
      {
        // Green ears turning golden as harvest nears.
        const k = Math.max(0, (g - 0.75) / 0.25);
        return { model: 'crops_wheatStageB', scale: 1.1 + 0.15 * g, tint: [0.32 + 0.5 * k, 0.62 + 0.1 * k, 0.12 + 0.1 * k] };
      }
    case CropKind.Corn:
      if (g < 0.3) return { model: 'crops_cornStageA', scale: 0.4 + 0.5 * (g / 0.3), tint: [1, 1, 1] };
      if (g < 0.6) return { model: 'crops_cornStageB', scale: 0.62, tint: [1, 1, 1] };
      if (!ripe) return { model: 'crops_cornStageC', scale: 0.62, tint: [1, 1, 1] };
      return { model: 'crops_cornStageD', scale: 0.62, tint: [1.15, 1.0, 0.7] };
    case CropKind.Cabbage:
      if (g < 0.5) return { model: 'crops_leafsStageA', scale: 0.5 + 0.6 * (g / 0.5), tint: [1.1, 1.15, 1] };
      return { model: 'crops_leafsStageB', scale: 1.1, tint: ripe ? [1.35, 1.25, 0.8] : [1, 1.1, 1] };
    default:
      if (g < 0.55) return { model: 'crops_leafsStageA', scale: 0.4 + 0.6 * (g / 0.55), tint: [1, 1, 1] };
      return { model: 'crop_pumpkin', scale: ripe ? 1.25 : 0.7 + 0.5 * ((g - 0.55) / 0.45), tint: ripe ? [1, 1, 1] : [0.85, 1.0, 0.6] };
  }
}

/** Millet: short, sparse ears, olive green ripening to bronze. */
function milletLook(crop: number): { model: ModelName; scale: number; tint: [number, number, number] } {
  const g = Math.min(1, Math.max(0, (crop - CROP_SOWN) / (CROP_RIPE - CROP_SOWN)));
  if (g < 0.5) return { model: 'crops_wheatStageA', scale: 0.4 + 0.45 * (g / 0.5), tint: [0.85, 1.0, 0.6] };
  const k = Math.max(0, (g - 0.7) / 0.3);
  return { model: 'crops_wheatStageB', scale: 0.72 + 0.08 * g, tint: [0.5 + 0.45 * k, 0.6 - 0.05 * k, 0.18 + 0.02 * k] };
}

/** Rice: bright green tufts, yellowing when ripe. */
function riceLook(crop: number): { model: ModelName; scale: number; tint: [number, number, number] } {
  const g = Math.min(1, Math.max(0, (crop - CROP_SOWN) / (CROP_RIPE - CROP_SOWN)));
  const k = Math.max(0, (g - 0.75) / 0.25);
  return { model: 'grass', scale: 0.35 + 0.4 * Math.min(1, g / 0.6), tint: [0.62 + 0.6 * k, 1.05 - 0.05 * k, 0.4 - 0.05 * k] };
}

/**
 * Crop models for the field cells in [x0,x1)×[y0,y1). `fields` is the
 * snapshot layout (FIELD_BYTES per cell: LandUse, crop, stress). Plants sit
 * on the shader's crop rows (two of the four rows per cell, two plants
 * each). Stressed crops are patchy, smaller and discoloured: yellow-brown
 * when dry, dull brown when waterlogged.
 */
export function cropPlacements(
  fields: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  out: CropPlacement[] = [],
): CropPlacement[] {
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(width, Math.ceil(x1));
  y1 = Math.min(height, Math.ceil(y1));
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = y * width + x;
      if (fields[FIELD_BYTES * i] !== FIELD) continue;
      const crop = fields[FIELD_BYTES * i + 1]!;
      if (crop < CROP_SOWN) continue;
      const hardy = fields[FIELD_BYTES * i + 3]!;
      const kind = hardy === FieldCrop.Common ? cropKind(x, y) : CropKind.Wheat;
      const look = hardy === FieldCrop.Millet ? milletLook(crop) : hardy === FieldCrop.Paddy ? riceLook(crop) : cropLook(kind, crop);
      const { dry, wet } = decodeStress(fields[FIELD_BYTES * i + 2]!);
      if (hardy === FieldCrop.Paddy) {
        // Rice in clumps on a grid, standing in the water (the terrain shader draws the basins).
        for (let k = 0; k < 4; k++) {
          if (dry > 0 && hash3(x, y, k + 32) < dry * 0.5) continue;
          const v = 0.92 + 0.16 * hash3(x, y, k + 16);
          out.push({
            model: look.model,
            x: x + ((k & 1) - 0.5) * 0.5 + (hash3(x, y, k) - 0.5) * 0.08,
            y: y + ((k >> 1) - 0.5) * 0.5 + (hash3(x, y, k + 4) - 0.5) * 0.08,
            yaw: hash3(x, y, k + 24) * Math.PI * 2,
            scale: look.scale * (1 - 0.3 * dry) * (0.85 + 0.3 * hash3(x, y, k + 8)),
            r: look.tint[0] * v,
            g: look.tint[1] * v,
            b: look.tint[2] * v,
            lift: true,
          });
        }
        continue;
      }
      // Millet stands sparse, with gaps.
      const gap = dry * 0.55 + wet * 0.35 + (hardy === FieldCrop.Millet ? 0.4 : 0);
      const shrink = 1 - 0.3 * dry - 0.15 * wet;
      let [tr, tg, tb] = look.tint;
      if (dry > 0) {
        const k = dry * 0.85;
        tr += (1.05 - tr) * k;
        tg += (0.8 - tg) * k;
        tb += (0.4 - tb) * k;
      } else if (wet > 0) {
        const k = wet * 0.8;
        tr += (0.62 - tr) * k;
        tg += (0.5 - tg) * k;
        tb += (0.32 - tb) * k;
      }
      const alongX = furrowsAlongX(x, y);
      // The shader's ridges lie at world k / ROWS_PER_CELL, i.e. cell offsets −0.5, −0.25, 0, 0.25: use ±0.25.
      for (let r = 0; r < 2; r++) {
        const across = (r ? 1 : -1) / ROWS_PER_CELL;
        for (let p = 0; p < 2; p++) {
          const k = r * 2 + p;
          if (gap > 0 && hash3(x, y, k + 32) < gap) continue;
          const along = (p + 0.5) / 2 - 0.5 + (hash3(x, y, k) - 0.5) * 0.18 + (r ? 0.12 : -0.12);
          const s = look.scale * shrink * (0.85 + 0.3 * hash3(x, y, k + 8));
          const v = 0.92 + 0.16 * hash3(x, y, k + 16);
          out.push({
            model: look.model,
            x: x + (alongX ? along : across),
            y: y + (alongX ? across : along),
            yaw: kind === CropKind.Wheat ? (alongX ? 0 : Math.PI / 2) + (hash3(x, y, k + 24) - 0.5) * 0.6 : hash3(x, y, k + 24) * Math.PI * 2,
            scale: s,
            r: tr * v,
            g: tg * v,
            b: tb * v,
          });
        }
      }
    }
  return out;
}

export interface CropLayerOptions {
  library?: StaticModelSource;
  /** Hide the models above this view height (cells). */
  maxViewHeight?: number;
  /** Minimum time between rebuilds caused by field changes. */
  rebuildMs?: number;
  /** Instance cap per model. */
  maxPerModel?: number;
}

interface CropBatch {
  mesh: THREE.InstancedMesh;
  capacity: number;
}

export class CropLayer {
  readonly group = new THREE.Group();
  readonly ready: Promise<void>;
  private models = new Map<ModelName, StaticModel>();
  private readonly batches = new Map<ModelName, CropBatch>();
  private fields: Uint8Array | null = null;
  private dirty = false;
  private lastBuildMs = -Infinity;
  /** Built region (cell coords). */
  private region = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private loaded = false;
  private readonly maxViewHeight: number;
  private readonly rebuildMs: number;
  private readonly maxPerModel: number;
  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpP = new THREE.Vector3();
  private readonly tmpS = new THREE.Vector3();
  private readonly tmpC = new THREE.Color();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(
    scene: THREE.Object3D,
    private readonly heights: HeightSampler,
    opts: CropLayerOptions = {},
  ) {
    this.group.name = 'crops';
    scene.add(this.group);
    this.maxViewHeight = opts.maxViewHeight ?? 25;
    this.rebuildMs = opts.rebuildMs ?? 3000;
    this.maxPerModel = opts.maxPerModel ?? 1200;
    const lib = opts.library ?? modelLibrary();
    this.ready = lib.preloadStatic(CROP_MODELS).then((ms) => {
      for (const m of ms) this.models.set(m.name, m);
      this.loaded = true;
      this.dirty = true;
    });
  }

  setFields(fields: Uint8Array): void {
    this.fields = fields;
    this.dirty = true;
  }

  /** Terrain changed: re-place on the next update. */
  invalidate(): void {
    this.dirty = true;
    this.lastBuildMs = -Infinity;
  }

  /** Total instances currently shown. */
  get instanceCount(): number {
    let n = 0;
    for (const b of this.batches.values()) if (b.mesh.visible) n += b.mesh.count;
    return n;
  }

  get meshCount(): number {
    let n = 0;
    for (const b of this.batches.values()) if (b.mesh.visible && b.mesh.count > 0) n++;
    return n;
  }

  /** Per frame: camera target (cell coords) and view height. */
  update(nowMs: number, cx: number, cy: number, viewHeight: number): void {
    const show = viewHeight < this.maxViewHeight && this.fields !== null && this.loaded;
    this.group.visible = show;
    if (!show) return;
    const R = Math.min(60, viewHeight * 1.5 + 4);
    const reg = this.region;
    const outside = cx - R < reg.x0 || cy - R < reg.y0 || cx + R > reg.x1 || cy + R > reg.y1;
    if (!outside && !(this.dirty && nowMs - this.lastBuildMs >= this.rebuildMs)) return;
    // Build a margin around the view so small pans need no rebuild.
    const M = R + 8;
    this.region = { x0: cx - M, y0: cy - M, x1: cx + M, y1: cy + M };
    this.rebuild(this.region);
    this.dirty = false;
    this.lastBuildMs = nowMs;
  }

  dispose(): void {
    for (const b of this.batches.values()) b.mesh.dispose();
    this.batches.clear();
    this.group.removeFromParent();
  }

  private rebuild(reg: { x0: number; y0: number; x1: number; y1: number }): void {
    const f = this.fields!;
    const h = this.heights;
    const ps = cropPlacements(f, h.width, h.height, reg.x0, reg.y0, reg.x1, reg.y1);
    const byModel = new Map<ModelName, CropPlacement[]>();
    for (const p of ps) {
      let arr = byModel.get(p.model);
      if (!arr) byModel.set(p.model, (arr = []));
      if (arr.length < this.maxPerModel) arr.push(p);
    }
    for (const [name, b] of this.batches)
      if (!byModel.has(name)) {
        b.mesh.count = 0;
        b.mesh.visible = false;
      }
    for (const [name, arr] of byModel) {
      const model = this.models.get(name);
      if (!model) continue;
      let b = this.batches.get(name);
      if (!b || b.capacity < arr.length) {
        if (b) {
          b.mesh.removeFromParent();
          b.mesh.dispose();
        }
        const capacity = Math.min(this.maxPerModel, Math.max(64, Math.ceil(arr.length * 1.5)));
        const mesh = new THREE.InstancedMesh(model.geometry, model.material, capacity);
        mesh.name = `crop-${name}`;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.setColorAt(0, this.tmpC.setRGB(1, 1, 1));
        mesh.receiveShadow = true;
        this.group.add(mesh);
        b = { mesh, capacity };
        this.batches.set(name, b);
      }
      const mesh = b.mesh;
      arr.forEach((p, i) => {
        const ground = h.terrainAt(p.x, p.y);
        this.tmpP.set(p.x + 0.5, heightToY(ground + (p.lift ? 0.6 * h.depthAt(p.x, p.y) : 0)) - 0.01, p.y + 0.5);
        this.tmpQ.setFromAxisAngle(this.up, p.yaw);
        this.tmpS.setScalar(p.scale);
        this.tmpM.compose(this.tmpP, this.tmpQ, this.tmpS);
        mesh.setMatrixAt(i, this.tmpM);
        mesh.setColorAt(i, this.tmpC.setRGB(p.r, p.g, p.b));
      });
      mesh.count = arr.length;
      mesh.visible = true;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor!.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }
}
