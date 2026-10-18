/**
 * Ghost structures (ui/tools.ts, ui/selection.ts): pale, see-through
 * copies drawn by the structures layer. The gate tool's hover ghost (a
 * sluice gate standing in the wall where a tap would put one:
 * sim/structures/structures.ts gateTapSite); a weir being drawn or edited
 * as it will stand; weirs the crew is still building, shown whole.
 */
import * as THREE from 'three';
import type { StructureInfo } from '../../shared/protocol';
import type { HeightSampler } from '../coords';
import { StructuresLayer, alignGates } from './structures';

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

  constructor(scene: THREE.Object3D, heights: HeightSampler, opacity = 0.6) {
    this.mat.opacity = opacity;
    this.layer = new StructuresLayer(scene, heights, this.mat);
    this.layer.group.name = 'gate-ghost';
    this.layer.group.renderOrder = 12;
  }

  /** The ghost shown (tests). */
  get ghost(): GateGhost | null {
    return this.shown ? { ...this.shown } : null;
  }

  /** Show a ghost gate (aligned with a weir it is set into, from `weirs`), or hide it. */
  set(g: GateGhost | null, weirs: readonly StructureInfo[] = []): void {
    const s = this.shown;
    if (!g && !s) return;
    if (g && s && g.x === s.x && g.y === s.y && g.rot === s.rot && g.width === s.width && Math.abs(g.top - s.top) < 0.01) return;
    this.shown = g ? { ...g } : null;
    if (!g) {
      this.layer.setStructures([]);
      return;
    }
    const info: StructureInfo = { id: 1, kind: 'gate', x: g.x, y: g.y, rot: g.rot, width: g.width, top: g.top, sill: g.sill, open: false, progress: 1, lift: 0 };
    this.layer.setStructures(alignGates([info], weirs));
  }

  /** Show these structures (whole, as ghosts), or none. */
  private list: readonly StructureInfo[] = [];
  get structures(): readonly StructureInfo[] {
    return this.list;
  }

  setStructures(list: readonly StructureInfo[]): void {
    if (list.length === 0 && this.list.length === 0) return;
    this.list = list;
    this.layer.setStructures(list);
  }

  refreshHeights(): void {
    if (this.list.length) this.layer.refreshHeights();
    if (this.shown) this.layer.refreshHeights();
  }
}
