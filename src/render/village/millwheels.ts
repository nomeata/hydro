/**
 * The turning wheels of the village mills (GAMEPLAY §1.2): one low-poly
 * timber wheel (rim, spokes, paddles, hub) per finished mill, on the mill
 * house's water side, its paddles dipping into the water there. It turns at
 * a speed proportional to the water's speed at the wheel (`BuildingInfo.spin`),
 * so a mill stops visibly when the canal runs dry and races in a flood.
 * One InstancedMesh (one draw call); the mill house itself is drawn by
 * BuildingsLayer.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BuildingInfo } from '../../shared/protocol';
import { heightToY, type HeightSampler } from '../coords';
import { vertexColorMaterial } from '../objects/loader';
import { MILL_WHEEL } from './houses';

/** Angular speed (rad/s at 1×) per m/s of water, and the most it turns. */
const SPIN_PER_MPS = 1.4;
const MAX_SPIN = 5;
/** Seconds between re-reading the water level under the wheels. */
const RELAYOUT = 0.5;

function paint(g: THREE.BufferGeometry, hex: number, vary = 0): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.deleteAttribute('uv');
  ng.computeVertexNormals();
  const n = ng.getAttribute('position').count;
  const c = new THREE.Color(hex);
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const k = 1 - vary * (((Math.floor(i / 6) * 2654435761) >>> 0) / 4294967296);
    col[i * 3] = c.r * k;
    col[i * 3 + 1] = c.g * k;
    col[i * 3 + 2] = c.b * k;
  }
  ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return ng;
}

/** The wheel, axle along x, centred at the origin (world units). */
export function wheelGeometry(): THREE.BufferGeometry {
  const r = MILL_WHEEL.radius;
  const wd = MILL_WHEEL.width;
  const parts: THREE.BufferGeometry[] = [];
  const n = 12;
  const seg = 2 * r * Math.sin(Math.PI / n) * 1.08;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    // Two rims (one each side) and a paddle between them.
    for (const x of [-wd / 2, wd / 2]) parts.push(paint(new THREE.BoxGeometry(0.035, 0.05, seg).translate(x, r * 0.86, 0).rotateX(a), 0x8a5f36, 0.25));
    parts.push(paint(new THREE.BoxGeometry(wd + 0.04, 0.14, 0.03).translate(0, r * 0.93, 0).rotateX(a + Math.PI / n), 0xb08455, 0.3));
  }
  for (let k = 0; k < 6; k++)
    for (const x of [-wd / 2, wd / 2]) parts.push(paint(new THREE.BoxGeometry(0.03, r * 1.72, 0.035).translate(x, 0, 0).rotateX((k * Math.PI) / 6), 0x6f4a2a));
  parts.push(paint(new THREE.CylinderGeometry(0.06, 0.06, wd + 0.12, 8).rotateZ(Math.PI / 2), 0x4f3520));
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  g.computeBoundingSphere();
  return g;
}

interface Wheel {
  id: number;
  x: number;
  y: number;
  rot: number;
  spin: number;
  angle: number;
}

export class MillWheelsLayer {
  readonly mesh: THREE.InstancedMesh;
  private capacity = 0;
  private wheels: Wheel[] = [];
  private sinceLayout = 0;
  private readonly centres: THREE.Vector3[] = [];
  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpQ2 = new THREE.Quaternion();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly axle = new THREE.Vector3(1, 0, 0);
  private readonly geometry = wheelGeometry();

  constructor(
    private readonly scene: THREE.Object3D,
    private readonly heights: HeightSampler,
  ) {
    this.mesh = this.make(4);
  }

  private make(capacity: number): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(this.geometry, vertexColorMaterial(), capacity);
    m.name = 'mill-wheels';
    m.count = 0;
    m.frustumCulled = false;
    m.receiveShadow = true;
    this.capacity = capacity;
    this.scene.add(m);
    return m;
  }

  /** Number of wheels drawn. */
  get count(): number {
    return this.wheels.length;
  }

  /** Current speed of each wheel (rad/s at 1×), by mill id (tests). */
  spins(): Map<number, number> {
    return new Map(this.wheels.map((w) => [w.id, Math.min(MAX_SPIN, w.spin * SPIN_PER_MPS)]));
  }

  setBuildings(list: readonly BuildingInfo[]): void {
    const old = new Map(this.wheels.map((w) => [w.id, w.angle]));
    this.wheels = list
      .filter((b) => b.kind === 'mill' && b.progress >= 1)
      .map((b) => ({ id: b.id, x: b.x, y: b.y, rot: b.rot, spin: b.spin ?? 0, angle: old.get(b.id) ?? (b.id % 7) * 0.4 }));
    if (this.wheels.length > this.capacity) {
      const m = this.mesh;
      m.removeFromParent();
      m.dispose();
      (this as { mesh: THREE.InstancedMesh }).mesh = this.make(this.wheels.length * 2);
    }
    this.layout();
  }

  /** Terrain or water changed under the wheels. */
  refreshHeights(): void {
    this.layout();
  }

  /** Wheel centres: by the house's water-side wall, the paddles dipping into the water there. */
  private layout(): void {
    const h = this.heights;
    this.centres.length = 0;
    for (const w of this.wheels) {
      const dx = Math.cos(w.rot);
      const dz = -Math.sin(w.rot);
      const off = MILL_WHEEL.x;
      const wx = w.x + 0.5 + dx * off;
      const wz = w.y + 0.5 + dz * off;
      // The water cell beside the house, and the ground the house stands on.
      const cx = Math.round(w.x + dx);
      const cy = Math.round(w.y + dz);
      const ground = heightToY(h.terrainAt(w.x, w.y));
      const surface = heightToY(h.terrainAt(cx, cy) + h.depthAt(cx, cy));
      const y = Math.min(ground + 0.75, Math.max(surface + MILL_WHEEL.radius * 0.6, ground - 1.5));
      this.centres.push(new THREE.Vector3(wx, y, wz));
    }
    this.sinceLayout = 0;
    this.place();
  }

  private place(): void {
    const m = this.mesh;
    this.wheels.forEach((w, i) => {
      this.tmpQ.setFromAxisAngle(this.up, w.rot);
      this.tmpQ2.setFromAxisAngle(this.axle, w.angle);
      this.tmpQ.multiply(this.tmpQ2);
      this.tmpM.compose(this.centres[i]!, this.tmpQ, this.one);
      m.setMatrixAt(i, this.tmpM);
    });
    m.count = this.wheels.length;
    m.instanceMatrix.needsUpdate = true;
  }

  /** Turn the wheels (`gameSpeed` 0 = paused). */
  update(dt: number, gameSpeed: number): void {
    if (!this.wheels.length) return;
    const k = Math.min(3, Math.max(0, gameSpeed));
    for (const w of this.wheels) w.angle = (w.angle + Math.min(MAX_SPIN, w.spin * SPIN_PER_MPS) * k * dt) % (Math.PI * 2);
    this.sinceLayout += dt;
    if (this.sinceLayout >= RELAYOUT) this.layout();
    else this.place();
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
  }
}
