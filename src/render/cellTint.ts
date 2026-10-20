/**
 * Tinted cells draped over the ground, for the brushes (ui/tools.ts): the
 * villagers' fields a brush would bury (warm red, before the stroke), the
 * ground a stroke raised or dug (warm for raised, cool for dug, fading a
 * few seconds after). Several named
 * channels, each a list of cells with a colour and an opacity, optionally
 * fading out over a time; rebuilt into one small mesh when they change and
 * while something fades.
 */
import * as THREE from 'three';
import { heightToY, type HeightSampler } from './coords';

export interface TintCell {
  i: number;
  /** Colour (hex) and opacity 0..1. */
  c: number;
  a: number;
}

interface Channel {
  cells: readonly TintCell[];
  /** Fading: start (ms, performance.now) and length; absent = steady. */
  start?: number;
  fade?: number;
}

export class CellTint {
  private readonly mesh: THREE.Mesh;
  private readonly geo = new THREE.BufferGeometry();
  private readonly channels = new Map<string, Channel>();
  private dirty = false;
  private cap = 0;
  private readonly col = new THREE.Color();

  constructor(
    scene: THREE.Object3D,
    private readonly heights: HeightSampler,
  ) {
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.name = 'cell-tint';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 11;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /** Cells tinted per channel (tests). */
  count(key: string): number {
    return this.channels.get(key)?.cells.length ?? 0;
  }

  /** Show `cells` on channel `key` (steady, or fading out over `fadeMs`), or clear it (null). */
  set(key: string, cells: readonly TintCell[] | null, fadeMs?: number): void {
    if (!cells || cells.length === 0) {
      if (this.channels.delete(key)) this.dirty = true;
      return;
    }
    this.channels.set(key, fadeMs ? { cells, start: performance.now(), fade: fadeMs } : { cells });
    this.dirty = true;
  }

  /** The ground moved (re-drape). */
  refreshHeights(): void {
    if (this.channels.size) this.dirty = true;
  }

  /** Every frame. */
  update(now = performance.now()): void {
    let fading = false;
    for (const [k, ch] of this.channels) {
      if (ch.fade === undefined) continue;
      if (now - ch.start! >= ch.fade) {
        this.channels.delete(k);
        this.dirty = true;
      } else fading = true;
    }
    if (!this.dirty && !fading) return;
    this.dirty = false;
    this.rebuild(now);
  }

  private rebuild(now: number): void {
    let n = 0;
    for (const ch of this.channels.values()) n += ch.cells.length;
    this.mesh.visible = n > 0;
    if (!n) return;
    if (n > this.cap) {
      this.cap = Math.ceil(n * 1.5);
      this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.cap * 4 * 3), 3).setUsage(THREE.DynamicDrawUsage));
      this.geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.cap * 4 * 4), 4).setUsage(THREE.DynamicDrawUsage));
      const idx = new Uint32Array(this.cap * 6);
      for (let k = 0; k < this.cap; k++) idx.set([k * 4, k * 4 + 2, k * 4 + 1, k * 4 + 1, k * 4 + 2, k * 4 + 3], k * 6);
      this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    const pos = this.geo.getAttribute('position') as THREE.BufferAttribute;
    const colA = this.geo.getAttribute('color') as THREE.BufferAttribute;
    const P = pos.array as Float32Array;
    const C = colA.array as Float32Array;
    const h = this.heights;
    const W = h.width;
    const H = h.height;
    const y = (cx: number, cy: number) => {
      const x = Math.max(0, Math.min(W - 1, cx));
      const z = Math.max(0, Math.min(H - 1, cy));
      return heightToY(h.terrainAt(x, z) + h.depthAt(x, z)) + 0.03;
    };
    let k = 0;
    for (const ch of this.channels.values()) {
      const f = ch.fade !== undefined ? Math.max(0, 1 - (now - ch.start!) / ch.fade) : 1;
      for (const t of ch.cells) {
        const cx = t.i % W;
        const cy = (t.i / W) | 0;
        this.col.setHex(t.c, THREE.SRGBColorSpace);
        const a = t.a * f;
        let v = 0;
        for (const dy of [-0.5, 0.5])
          for (const dx of [-0.5, 0.5]) {
            P.set([cx + dx + 0.5, y(cx + dx, cy + dy), cy + dy + 0.5], (k * 4 + v) * 3);
            C.set([this.col.r, this.col.g, this.col.b, a], (k * 4 + v) * 4);
            v++;
          }
        k++;
      }
    }
    this.geo.setDrawRange(0, k * 6);
    pos.needsUpdate = true;
    colA.needsUpdate = true;
  }
}
