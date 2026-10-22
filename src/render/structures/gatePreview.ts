/**
 * Ghost structures (ui/tools.ts, ui/selection.ts): pale, see-through
 * copies drawn by the structures layer. The gate tool's hover ghost (a
 * sluice gate standing in the wall where a tap would put one, red where
 * none fits: sim/structures/gateSite.ts) and its site marks (`GateSites`:
 * golden rings on the crest of every bank or weir cell a gate fits in,
 * pulsing gently, as the wheel's); a weir being drawn or edited as it will
 * stand; weirs the crew is still building, shown whole.
 */
import * as THREE from 'three';
import type { StructureInfo } from '../../shared/protocol';
import { heightToY, type HeightSampler } from '../coords';
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
  private shownOk = true;

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

  /** The ghost shown and whether it is a good site (tests). */
  get ghostState(): { site: GateGhost; ok: boolean } | null {
    return this.shown ? { site: { ...this.shown }, ok: this.shownOk } : null;
  }

  /** Show a ghost gate (aligned with a weir it is set into, from `weirs`; red when `ok` is false), or hide it. */
  set(g: GateGhost | null, weirs: readonly StructureInfo[] = [], ok = true): void {
    const s = this.shown;
    if (!g && !s) return;
    if (g && s && ok === this.shownOk && g.x === s.x && g.y === s.y && g.rot === s.rot && g.width === s.width && Math.abs(g.top - s.top) < 0.01) return;
    this.shown = g ? { ...g } : null;
    if (!g) {
      this.layer.setStructures([]);
      return;
    }
    if (ok !== this.shownOk) {
      this.mat.color.set(ok ? 0xd8f0ff : 0xff4a3a);
      this.mat.emissive.set(ok ? 0x203040 : 0x400800);
    }
    this.shownOk = ok;
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

const MARK_R = 0.32;

/** The gate tool's site marks: a golden ring on the crest of each cell a gate fits in, with a soft halo; they pulse gently. */
export class GateSites {
  readonly group = new THREE.Group();
  private readonly ringMat = new THREE.MeshBasicMaterial({ color: 0xffd36e, transparent: true, opacity: 0.8, depthWrite: false });
  private readonly haloMat = new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide });
  private rings: THREE.InstancedMesh;
  private halos: THREE.InstancedMesh;
  private t = 0;
  /** The marked sites (tests, screenshots). */
  sites: readonly GateGhost[] = [];

  constructor(
    scene: THREE.Object3D,
    private readonly heights: HeightSampler,
  ) {
    this.group.name = 'gate-sites';
    scene.add(this.group);
    this.rings = this.mesh(new THREE.TorusGeometry(MARK_R, 0.07, 6, 20).rotateX(-Math.PI / 2), this.ringMat, 'gate-site-rings', 12);
    this.halos = this.mesh(new THREE.CircleGeometry(MARK_R * 1.4, 20).rotateX(-Math.PI / 2), this.haloMat, 'gate-site-halos', 11);
  }

  private mesh(g: THREE.BufferGeometry, m: THREE.Material, name: string, order: number, n = 1): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(g, m, n);
    mesh.name = name;
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = order;
    this.group.add(mesh);
    return mesh;
  }

  /** Number of site marks shown. */
  get siteCount(): number {
    return this.rings.count;
  }

  /** Mark these sites, or none. */
  setSites(sites: readonly GateGhost[] | null): void {
    this.sites = sites ? sites.map((o) => ({ ...o })) : [];
    const n = this.sites.length;
    if (n > this.rings.instanceMatrix.count) {
      for (const old of [this.rings, this.halos]) {
        old.removeFromParent();
        old.dispose();
      }
      this.rings = this.mesh(this.rings.geometry, this.ringMat, 'gate-site-rings', 12, n * 2);
      this.halos = this.mesh(this.halos.geometry, this.haloMat, 'gate-site-halos', 11, n * 2);
    }
    this.place(1);
  }

  /** Put the marks, scaled by `k` (the pulse). */
  private place(k: number): void {
    const n = this.sites.length;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3(k, k, k);
    for (let j = 0; j < n; j++) {
      const st = this.sites[j]!;
      const y = heightToY(Math.max(this.heights.terrainAt(st.x, st.y), st.top));
      p.set(st.x + 0.5, y + 0.08, st.y + 0.5);
      m.compose(p, q, s);
      this.rings.setMatrixAt(j, m);
      p.y = y + 0.04;
      m.compose(p, q, s);
      this.halos.setMatrixAt(j, m);
    }
    for (const mesh of [this.rings, this.halos]) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** The marks glow softly. */
  update(dt: number): void {
    this.t += dt;
    if (!this.rings.count) return;
    const w = Math.sin(this.t * 2.4);
    this.ringMat.opacity = 0.75 + 0.2 * w;
    this.haloMat.opacity = 0.22 + 0.12 * w;
    this.place(1 + 0.1 * w);
  }

  /** Ground heights changed. */
  refreshHeights(): void {
    if (this.sites.length) this.place(1);
  }
}
