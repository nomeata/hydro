/**
 * The gate tool's hover ghost (ui/tools.ts): a pale sluice gate standing in
 * the wall where a tap would put one (sim/structures/structures.ts
 * gateTapSite), so the player sees where it goes before clicking.
 */
import * as THREE from 'three';
import type { StructureInfo } from '../../shared/protocol';
import type { HeightSampler } from '../coords';
import { StructuresLayer } from './structures';

export interface GateGhost {
  x: number;
  y: number;
  rot: number;
  width: number;
  top: number;
  sill: number;
}

export class GatePreview {
  private readonly mat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false, color: 0xd8f0ff, emissive: 0x203040 });
  private readonly layer: StructuresLayer;
  private shown: GateGhost | null = null;

  constructor(scene: THREE.Object3D, heights: HeightSampler) {
    this.layer = new StructuresLayer(scene, heights, this.mat);
    this.layer.group.name = 'gate-ghost';
    this.layer.group.renderOrder = 12;
  }

  /** The ghost shown (tests). */
  get ghost(): GateGhost | null {
    return this.shown ? { ...this.shown } : null;
  }

  set(g: GateGhost | null): void {
    const s = this.shown;
    if (!g && !s) return;
    if (g && s && g.x === s.x && g.y === s.y && g.rot === s.rot && g.width === s.width && Math.abs(g.top - s.top) < 0.01) return;
    this.shown = g ? { ...g } : null;
    if (!g) {
      this.layer.setStructures([]);
      return;
    }
    const info: StructureInfo = { id: 1, kind: 'gate', x: g.x, y: g.y, rot: g.rot, width: g.width, top: g.top, sill: g.sill, open: false, progress: 1, lift: 0 };
    this.layer.setStructures([info]);
  }

  refreshHeights(): void {
    if (this.shown) this.layer.refreshHeights();
  }
}
