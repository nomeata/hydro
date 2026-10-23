/**
 * The water-wheel tool's view (ui/tools.ts): a ghost wheel with its trough
 * where the wheel would go (turning, its trough running, when the site is
 * good; red and still when not), and golden rings standing in the river
 * where a wheel would turn well (sim/structures/wheel.ts wheelSites), each
 * facing the bank it would lift to, with a flat halo on the water round it;
 * they pulse gently so they catch the eye at any zoom.
 */
import * as THREE from 'three';
import type { StructureInfo } from '../../shared/protocol';
import { heightToY, type HeightSampler } from '../coords';
import { StructuresLayer } from './structures';

/** A wheel site as the tool sees it: wheel cell and head cell. */
export interface WheelGhost {
  x: number;
  y: number;
  hx: number;
  hy: number;
}

const RING_R = 0.5;

export class WheelPreview {
  readonly group = new THREE.Group();
  private readonly ghostMat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false });
  private readonly ghost: StructuresLayer;
  private readonly ringMat = new THREE.MeshBasicMaterial({ color: 0xffd36e, transparent: true, opacity: 0.7, depthWrite: false });
  private rings: THREE.InstancedMesh;
  private readonly haloMat = new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });
  private halos: THREE.InstancedMesh;
  private t = 0;
  private shown: WheelGhost | null = null;
  private shownOk = false;

  constructor(
    scene: THREE.Object3D,
    private readonly heights: HeightSampler,
  ) {
    this.group.name = 'wheel-preview';
    scene.add(this.group);
    this.ghost = new StructuresLayer(this.group, heights, this.ghostMat);
    this.ghost.group.name = 'wheel-ghost';
    this.ghost.group.renderOrder = 12;
    // An upright ring (a little wheel), its axle along x.
    const g = new THREE.TorusGeometry(RING_R, 0.09, 6, 24).rotateY(Math.PI / 2);
    this.rings = new THREE.InstancedMesh(g, this.ringMat, 1);
    this.rings.name = 'wheel-sites';
    this.rings.count = 0;
    this.rings.frustumCulled = false;
    this.rings.renderOrder = 12;
    this.group.add(this.rings);
    this.halos = new THREE.InstancedMesh(new THREE.RingGeometry(RING_R * 0.9, RING_R * 1.6, 28).rotateX(-Math.PI / 2), this.haloMat, 1);
    this.halos.name = 'wheel-site-halos';
    this.halos.count = 0;
    this.halos.frustumCulled = false;
    this.halos.renderOrder = 11;
    this.group.add(this.halos);
  }

  /** The marked sites (tests, screenshots). */
  sites: readonly WheelGhost[] = [];

  /** Number of site marks shown. */
  get siteCount(): number {
    return this.rings.count;
  }

  /** The ghost shown (and whether it is a good site), for tests. */
  get ghostState(): { site: WheelGhost; ok: boolean } | null {
    return this.shown ? { site: { ...this.shown }, ok: this.shownOk } : null;
  }

  /** Show the ghost wheel at `site` (good or not), or hide it. */
  setGhost(site: WheelGhost | null, ok = false): void {
    const same = site && this.shown && site.x === this.shown.x && site.y === this.shown.y && site.hx === this.shown.hx && site.hy === this.shown.hy;
    if ((same && ok === this.shownOk) || (!site && !this.shown)) return;
    this.shown = site ? { ...site } : null;
    this.shownOk = ok;
    if (!site) {
      this.ghost.setStructures([]);
      return;
    }
    this.ghostMat.color.set(ok ? 0xd8f0ff : 0xff4a3a);
    this.ghostMat.emissive.set(ok ? 0x203040 : 0x400800);
    this.ghostMat.opacity = ok ? 0.55 : 0.5;
    const t = (x: number, y: number) => this.heights.terrainAt(x, y);
    const info: StructureInfo = {
      id: 1,
      kind: 'wheel',
      x: site.x,
      y: site.y,
      x2: site.hx,
      y2: site.hy,
      rot: Math.atan2(site.hy - site.y, site.hx - site.x),
      width: Math.hypot(site.hx - site.x, site.hy - site.y),
      top: t(site.hx, site.hy),
      sill: t(site.x, site.y),
      open: ok,
      progress: 1,
      speed: ok ? 1 : 0,
      flow: ok ? 1 : 0,
    };
    this.ghost.setStructures([info]);
  }

  /** Mark the good sites (wheel and head cells), or none. */
  setSites(sites: readonly WheelGhost[] | null): void {
    const n = sites?.length ?? 0;
    this.sites = sites ? sites.map((o) => ({ x: o.x, y: o.y, hx: o.hx, hy: o.hy })) : [];
    const grow = (mesh: THREE.InstancedMesh): THREE.InstancedMesh => {
      if (n <= mesh.instanceMatrix.count) return mesh;
      const bigger = new THREE.InstancedMesh(mesh.geometry, mesh.material, n * 2);
      bigger.name = mesh.name;
      bigger.frustumCulled = false;
      bigger.renderOrder = mesh.renderOrder;
      mesh.removeFromParent();
      mesh.dispose();
      this.group.add(bigger);
      return bigger;
    };
    this.rings = grow(this.rings);
    this.halos = grow(this.halos);
    this.placeSites(1);
  }

  /** Put the site marks, scaled by `k` (the pulse). */
  private placeSites(k: number): void {
    const n = this.sites.length;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3(k, k, k);
    const up = new THREE.Vector3(0, 1, 0);
    for (let j = 0; j < n; j++) {
      const st = this.sites[j]!;
      const cx = st.x + 0.5;
      const cy = st.y + 0.5;
      const surf = heightToY(this.heights.terrainAt(st.x, st.y) + this.heights.depthAt(st.x, st.y));
      // Half out of the water, like a wheel's top.
      p.set(cx, surf + RING_R * 0.35 * k, cy);
      q.setFromAxisAngle(up, -Math.atan2(st.hy - st.y, st.hx - st.x));
      m.compose(p, q, s);
      this.rings.setMatrixAt(j, m);
      p.set(cx, surf + 0.03, cy);
      m.compose(p, q, s);
      this.halos.setMatrixAt(j, m);
    }
    for (const mesh of [this.rings, this.halos]) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** Water velocity at a cell, so the ghost turns the way the real wheel would. */
  setFlow(f: (x: number, y: number, out: [number, number]) => [number, number]): void {
    this.ghost.flowAt = f;
  }

  /** Animating on wall time (pulsing site marks, a turning ghost). */
  get busy(): boolean {
    return this.rings.count > 0 || (this.shown !== null && this.shownOk);
  }

  /** The ghost turns; the marks glow softly. */
  update(dt: number): void {
    this.t += dt;
    if (this.rings.count) {
      const w = Math.sin(this.t * 2.4);
      this.ringMat.opacity = 0.75 + 0.2 * w;
      this.haloMat.opacity = 0.25 + 0.15 * w;
      this.placeSites(1 + 0.12 * w);
    }
    if (this.shown && this.shownOk) this.ghost.update(dt);
  }

  /** Ground heights changed. */
  refreshHeights(): void {
    this.ghost.refreshHeights();
  }
}
