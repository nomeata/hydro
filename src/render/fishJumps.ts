/**
 * Fish jumping out of stocked water, with splash rings: how often they jump
 * follows the fish stock (Snapshot.fish), so a well-stocked reservoir is
 * lively and an over-fished pond goes quiet. Watch and learn.
 */
import * as THREE from 'three';
import { FISH_BLOCK } from '../shared/protocol';
import { heightToY, type HeightSampler } from './coords';

const MAX_JUMPS = 12;
const JUMP_TIME = 0.9;
const RING_TIME = 0.9;
/** Jumps per second per block at full stock. */
const RATE = 0.06;

interface Jump {
  t: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  surface: number;
  height: number;
  splashed: boolean;
}

interface Ring {
  mesh: THREE.Mesh;
  t: number;
}

function fishGeometry(): THREE.BufferGeometry {
  // A chubby low-poly fish: an elongated octahedron body with a tail fin.
  const body = new THREE.OctahedronGeometry(0.5, 0);
  body.scale(0.22, 0.09, 0.07);
  const tail = new THREE.ConeGeometry(0.06, 0.1, 3);
  tail.rotateZ(Math.PI / 2);
  tail.translate(-0.13, 0, 0);
  const merged = new THREE.BufferGeometry();
  const parts = [body.toNonIndexed(), tail.toNonIndexed()];
  const pos: number[] = [];
  for (const p of parts) pos.push(...(p.getAttribute('position').array as Float32Array));
  merged.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  merged.computeVertexNormals();
  return merged;
}

export class FishJumps {
  private fish: Uint8Array | null = null;
  /** Fog of war: whether a cell position is known land (no jumps in the fog). */
  known: ((x: number, y: number) => boolean) | null = null;
  private readonly bw: number;
  private readonly jumps: Jump[] = [];
  private readonly mesh: THREE.InstancedMesh;
  private readonly rings: Ring[] = [];
  private readonly ringGeo = new THREE.RingGeometry(0.7, 1, 20);
  private seed = 1;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3(1, 1, 1);

  constructor(
    private readonly scene: THREE.Object3D,
    private readonly heights: HeightSampler,
  ) {
    this.bw = Math.ceil(heights.width / FISH_BLOCK);
    this.mesh = new THREE.InstancedMesh(fishGeometry(), new THREE.MeshLambertMaterial({ color: 0xb9c7d6 }), MAX_JUMPS);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.ringGeo.rotateX(-Math.PI / 2);
  }

  setFish(data: Uint8Array): void {
    this.fish = data.slice();
  }

  private rand(): number {
    // Visual-only randomness (xorshift), independent of the simulation.
    let x = this.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x >>> 0 || 1;
    return this.seed / 4294967296;
  }

  /** Advance; spawn jumps in blocks within `radius` cells of (cx, cy). */
  update(dt: number, cx: number, cy: number, radius: number): void {
    const fish = this.fish;
    if (fish && dt > 0) {
      const b0x = Math.max(0, Math.floor((cx - radius) / FISH_BLOCK));
      const b1x = Math.min(this.bw - 1, Math.floor((cx + radius) / FISH_BLOCK));
      const bh = Math.ceil(this.heights.height / FISH_BLOCK);
      const b0y = Math.max(0, Math.floor((cy - radius) / FISH_BLOCK));
      const b1y = Math.min(bh - 1, Math.floor((cy + radius) / FISH_BLOCK));
      for (let by = b0y; by <= b1y; by++) {
        for (let bx = b0x; bx <= b1x; bx++) {
          const v = fish[by * this.bw + bx]!;
          if (v <= 1 || this.jumps.length >= MAX_JUMPS) continue;
          const full = (v - 1) / 254;
          if (this.rand() > RATE * full * full * dt) continue;
          this.spawn(bx, by);
        }
      }
    }
    // Animate jumps.
    let n = 0;
    for (let k = this.jumps.length - 1; k >= 0; k--) {
      const j = this.jumps[k]!;
      j.t += dt / JUMP_TIME;
      if (j.t >= 1) {
        this.splash(j.x + j.dx, j.y + j.dy, j.surface);
        this.jumps.splice(k, 1);
        continue;
      }
      if (!j.splashed) {
        this.splash(j.x, j.y, j.surface);
        j.splashed = true;
      }
      const h = 4 * j.height * j.t * (1 - j.t);
      const slope = 4 * j.height * (1 - 2 * j.t);
      this.p.set(j.x + 0.5 + j.dx * j.t, j.surface + h, j.y + 0.5 + j.dy * j.t);
      const yaw = Math.atan2(-j.dy, j.dx);
      this.e.set(0, yaw, Math.atan2(slope, Math.hypot(j.dx, j.dy)), 'YZX');
      this.q.setFromEuler(this.e);
      this.m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(n++, this.m);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    // Animate splash rings.
    for (let k = this.rings.length - 1; k >= 0; k--) {
      const r = this.rings[k]!;
      r.t += dt / RING_TIME;
      if (r.t >= 1) {
        this.scene.remove(r.mesh);
        (r.mesh.material as THREE.Material).dispose();
        this.rings.splice(k, 1);
        continue;
      }
      r.mesh.scale.setScalar(0.08 + 0.35 * r.t);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - r.t);
    }
  }

  private spawn(bx: number, by: number): void {
    const hs = this.heights;
    for (let tries = 0; tries < 6; tries++) {
      const x = bx * FISH_BLOCK + this.rand() * FISH_BLOCK;
      const y = by * FISH_BLOCK + this.rand() * FISH_BLOCK;
      if (hs.depthAt(x, y) < 0.6) continue;
      if (this.known && !this.known(x, y)) continue;
      const ang = this.rand() * Math.PI * 2;
      const len = 0.4 + this.rand() * 0.4;
      const dx = Math.cos(ang) * len;
      const dy = Math.sin(ang) * len;
      if (hs.depthAt(x + dx, y + dy) < 0.3) continue;
      this.jumps.push({
        t: 0,
        x,
        y,
        dx,
        dy,
        surface: heightToY(hs.terrainAt(x, y) + hs.depthAt(x, y)) + 0.02,
        height: 0.25 + this.rand() * 0.25,
        splashed: false,
      });
      return;
    }
  }

  private splash(x: number, y: number, surface: number): void {
    const mesh = new THREE.Mesh(
      this.ringGeo,
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, depthWrite: false }),
    );
    mesh.position.set(x + 0.5, surface + 0.01, y + 0.5);
    mesh.scale.setScalar(0.08);
    this.scene.add(mesh);
    this.rings.push({ mesh, t: 0 });
  }
}
