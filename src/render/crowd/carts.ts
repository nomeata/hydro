/**
 * Founding parties' handcarts (EntityKind.Cart; sim people/village.ts
 * `carts`, docs/PLAYTEST.md round 6): a small wooden cart loaded with sacks
 * and bundles, its two spoked wheels turning with the distance it rolls on
 * the game clock, the shafts reaching forward to the ox walking ahead (a
 * crowd Cow). Parked by a new store it stands unloaded. There are only ever
 * a few, so each is a small group of shared geometries (no instancing).
 */
import * as THREE from 'three';
import { CarryKind, EntityKind } from '../../shared/protocol';
import { heightToY } from '../coords';
import { headingToYaw } from './clips';
import type { Track } from './tracks';

interface HeightSource {
  terrainAt(x: number, y: number): number;
}

/** Sizes in cells (a person is about 0.35 tall). */
const WHEEL_R = 0.18;
const BED = { w: 0.44, l: 0.66, h: 0.06, y: 0.23 };

interface CartView {
  root: THREE.Group;
  wheels: THREE.Object3D[];
  load: THREE.Object3D;
  spin: number;
  yM: number;
  seen: number;
}

export class CartLayer {
  readonly group = new THREE.Group();
  private readonly views = new Map<number, CartView>();
  private readonly mats = {
    wood: new THREE.MeshLambertMaterial({ color: 0x8a5a32, name: 'cart-wood' }),
    dark: new THREE.MeshLambertMaterial({ color: 0x5a3a20, name: 'cart-dark' }),
    sack: new THREE.MeshLambertMaterial({ color: 0xd8c49a, name: 'cart-sack' }),
    cloth: new THREE.MeshLambertMaterial({ color: 0x9a4a3a, name: 'cart-cloth' }),
  };
  private readonly geo = {
    box: new THREE.BoxGeometry(1, 1, 1),
    rim: new THREE.TorusGeometry(WHEEL_R, 0.024, 5, 14),
    hub: new THREE.CylinderGeometry(0.03, 0.03, 0.05, 8),
    sack: new THREE.SphereGeometry(1, 8, 6),
  };
  private gen = 0;

  constructor(
    scene: THREE.Object3D,
    private readonly heights: HeightSource,
  ) {
    this.group.name = 'carts';
    scene.add(this.group);
  }

  get count(): number {
    return this.views.size;
  }

  /** Place the carts among `tracks` (crowd tracks, the play clock's `dt`). */
  update(tracks: Iterable<Track>, dt: number): void {
    const gen = ++this.gen;
    const kY = 1 - Math.exp(-10 * dt);
    for (const t of tracks) {
      if (t.kind !== EntityKind.Cart) continue;
      let v = this.views.get(t.id);
      if (!v) {
        v = this.build();
        this.views.set(t.id, v);
        this.group.add(v.root);
      }
      v.seen = gen;
      const ground = this.heights.terrainAt(t.x, t.y);
      v.yM = Number.isNaN(v.yM) ? ground : v.yM + (ground - v.yM) * kY;
      v.root.position.set(t.x + 0.5, heightToY(v.yM), t.y + 0.5);
      v.root.rotation.y = headingToYaw(t.heading);
      // Wheels roll with the ground speed (forward is +z, the axle along x).
      v.spin = (v.spin + (t.speed * dt) / WHEEL_R) % (Math.PI * 2);
      for (const w of v.wheels) w.rotation.x = v.spin;
      v.load.visible = t.carry !== CarryKind.None;
    }
    for (const [id, v] of this.views)
      if (v.seen !== gen) {
        this.group.remove(v.root);
        this.views.delete(id);
      }
  }

  private part(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    m.castShadow = true;
    return m;
  }

  private build(): CartView {
    const { wood, dark, sack, cloth } = this.mats;
    const g = this.geo;
    const root = new THREE.Group();
    // Bed with low side boards, a tail board, and two shafts reaching forward to the ox.
    root.add(this.part(g.box, wood, 0, BED.y, 0, BED.w, BED.h, BED.l));
    for (const sx of [-1, 1]) {
      root.add(this.part(g.box, wood, (sx * BED.w) / 2, BED.y + 0.05, 0, 0.02, 0.08, BED.l));
      const shaft = this.part(g.box, dark, sx * 0.13, BED.y + 0.01, BED.l / 2 + 0.25, 0.03, 0.03, 0.55);
      shaft.rotation.x = 0.12;
      root.add(shaft);
    }
    root.add(this.part(g.box, wood, 0, BED.y + 0.05, -BED.l / 2, BED.w, 0.08, 0.02));
    // Axle and two spoked wheels.
    root.add(this.part(g.box, dark, 0, WHEEL_R, 0, BED.w + 0.1, 0.025, 0.025));
    const wheels: THREE.Object3D[] = [];
    for (const sx of [-1, 1]) {
      const w = new THREE.Group();
      w.position.set(sx * (BED.w / 2 + 0.04), WHEEL_R, 0);
      const rim = new THREE.Mesh(g.rim, dark);
      rim.rotation.y = Math.PI / 2;
      w.add(rim);
      const hub = new THREE.Mesh(g.hub, dark);
      hub.rotation.z = Math.PI / 2;
      w.add(hub);
      for (let k = 0; k < 3; k++) {
        const spoke = this.part(g.box, wood, 0, 0, 0, 0.015, WHEEL_R * 2, 0.018);
        spoke.rotation.x = (k * Math.PI) / 3;
        w.add(spoke);
      }
      root.add(w);
      wheels.push(w);
    }
    // The load: sacks, a rolled bundle under a red cloth.
    const load = new THREE.Group();
    load.add(this.part(g.sack, sack, -0.1, BED.y + 0.12, -0.13, 0.11, 0.1, 0.13));
    load.add(this.part(g.sack, sack, 0.1, BED.y + 0.12, -0.16, 0.11, 0.1, 0.12));
    load.add(this.part(g.sack, sack, 0.0, BED.y + 0.2, -0.1, 0.09, 0.08, 0.1));
    load.add(this.part(g.box, cloth, 0, BED.y + 0.1, 0.15, 0.34, 0.12, 0.22));
    root.add(load);
    return { root, wheels, load, spin: 0, yM: NaN, seen: 0 };
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const g of Object.values(this.geo)) g.dispose();
    for (const m of Object.values(this.mats)) m.dispose();
    this.views.clear();
  }
}
