/**
 * Snow piles beside the fields (sim/people/village.ts clearSnow): the snow
 * the farmers shovelled off a field before sowing, heaped on the open land
 * at its edge. Drawn as small low-poly mounds of old, crusted snow (grey,
 * dirtier towards the foot) sitting on the ground, sized by the snow the
 * cell holds above the snow around it, so they shrink as they melt. The
 * terrain shader paints the snow cover beneath them as everywhere. One
 * merged mesh (one draw call), rebuilt only when the piles change visibly.
 */
import * as THREE from 'three';
import { CELL_METRES, heightToY, type HeightSampler } from '../coords';

/** Density of shovelled, settled snow relative to water: snow volume = water depth × area / this. */
const PILE_DENSITY = 0.45;
/** Mound height / footprint radius. */
const ASPECT = 0.42;
/** Largest footprint radius (cells). */
const MAX_RADIUS = 0.62;
/** Segments around, rings up. */
const SEG = 9;
const RINGS = 3;

type V3 = [number, number, number];

export interface SnowPile {
  x: number;
  y: number;
  /** Snow water above the snow around it (m). */
  swe: number;
}

/** Footprint radius (cells) and height (m) of a pile of `swe` metres of water over one cell. */
export function pileSize(swe: number): { radius: number; height: number } {
  const vol = (Math.max(0, swe) * CELL_METRES * CELL_METRES) / PILE_DENSITY;
  // A paraboloid mound: volume = π/2 · r² · h with h = ASPECT · r.
  const r = Math.cbrt((2 * vol) / (Math.PI * ASPECT));
  const radius = Math.min(MAX_RADIUS, r / CELL_METRES);
  // A capped footprint grows taller instead (same volume).
  const rm = radius * CELL_METRES;
  return { radius, height: rm > 0 ? (2 * vol) / (Math.PI * rm * rm) : 0 };
}

/** Small deterministic hash in [0, 1). */
function hash(a: number, b: number): number {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class SnowPileLayer {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private key = '';
  private piles: SnowPile[] = [];
  private readonly material = new THREE.MeshLambertMaterial({ vertexColors: true });

  constructor(
    scene: THREE.Object3D,
    private readonly heights: HeightSampler,
    private readonly maxViewHeight = 160,
  ) {
    this.group.name = 'snow-piles';
    scene.add(this.group);
  }

  get count(): number {
    return this.piles.length;
  }

  /** Flat [x, y, swe] (Snapshot.snowPiles). */
  setPiles(flat: Float32Array): void {
    const piles: SnowPile[] = [];
    let key = '';
    for (let k = 0; k + 2 < flat.length; k += 3) {
      const p = { x: flat[k]!, y: flat[k + 1]!, swe: flat[k + 2]! };
      piles.push(p);
      // Rebuild only when a pile changed by a few millimetres of water.
      key += `${p.x},${p.y},${Math.round(p.swe * 400)};`;
    }
    this.piles = piles;
    if (key === this.key) return;
    this.key = key;
    this.rebuild();
  }

  /** Terrain changed: the piles follow the ground. */
  invalidate(): void {
    if (this.piles.length) this.rebuild();
  }

  update(viewHeight: number): void {
    this.group.visible = viewHeight < this.maxViewHeight;
  }

  dispose(): void {
    this.mesh?.geometry.dispose();
    this.material.dispose();
    this.group.removeFromParent();
  }

  private rebuild(): void {
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh.removeFromParent();
      this.mesh = null;
    }
    if (!this.piles.length) return;
    const pos: number[] = [];
    const col: number[] = [];
    const crust = new THREE.Color(0xd9dcdc);
    const top = new THREE.Color(0xeef1f2);
    const dirt = new THREE.Color(0x9a958b);
    const c = new THREE.Color();
    const ring: [number, number, number][][] = [];
    for (const p of this.piles) {
      const { radius, height } = pileSize(p.swe);
      if (radius < 0.08) continue;
      const hY = heightToY(height);
      const seed = p.y * 4099 + p.x;
      // A little off the cell centre, stretched along a random direction.
      const cx = p.x + 0.5 + (hash(seed, 1) - 0.5) * 0.3;
      const cz = p.y + 0.5 + (hash(seed, 2) - 0.5) * 0.3;
      const ang = hash(seed, 3) * Math.PI;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const sx = 1.25;
      const sz = 0.8;
      // Rings from the foot (t = 0) to just below the top; the apex closes it.
      ring.length = 0;
      for (let r = 0; r <= RINGS; r++) {
        const t = r / (RINGS + 1);
        const rho = Math.sqrt(1 - t);
        const pts: [number, number, number][] = [];
        for (let s = 0; s < SEG; s++) {
          const a = (s / SEG) * Math.PI * 2;
          const jit = 1 + (hash(seed, 10 + r * SEG + s) - 0.5) * 0.3;
          const lx = Math.cos(a) * rho * radius * sx * jit;
          const lz = Math.sin(a) * rho * radius * sz * jit;
          const wx = cx + lx * ca - lz * sa;
          const wz = cz + lx * sa + lz * ca;
          const g = heightToY(this.heights.terrainAt(wx - 0.5, wz - 0.5));
          const lift = r === 0 ? -0.015 : hY * t * (1 + (hash(seed, 50 + r * SEG + s) - 0.5) * 0.25);
          pts.push([wx, g + lift, wz]);
        }
        ring.push(pts);
      }
      const apexG = heightToY(this.heights.terrainAt(cx - 0.5, cz - 0.5));
      const apex: [number, number, number] = [cx, apexG + hY, cz];
      const tri = (a: V3, b: V3, d: V3, shade: number) => {
        // Upward faces: light crust; steep faces and the foot: greyer, dirtier.
        const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
        const e2x = d[0] - a[0], e2y = d[1] - a[1], e2z = d[2] - a[2];
        const nx = e1y * e2z - e1z * e2y;
        const ny = e1z * e2x - e1x * e2z;
        const nz = e1x * e2y - e1y * e2x;
        // Wind the face outwards (away from the mound's axis, or up).
        const ox = (a[0] + b[0] + d[0]) / 3 - cx;
        const oz = (a[2] + b[2] + d[2]) / 3 - cz;
        if (nx * ox + nz * oz + ny * 0.05 < 0) [b, d] = [d, b];
        const up = Math.abs(ny) / (Math.hypot(nx, ny, nz) || 1);
        c.copy(crust).lerp(top, Math.max(0, (up - 0.75) * 4) * (1 - shade)).lerp(dirt, shade * 0.55 + (1 - up) * 0.25);
        const v = 0.96 + hash(seed, Math.round(a[0] * 977 + a[2] * 613)) * 0.06;
        for (const q of [a, b, d]) {
          pos.push(q[0], q[1], q[2]);
          col.push(c.r * v, c.g * v, c.b * v);
        }
      };
      for (let r = 0; r < RINGS; r++) {
        const lo = ring[r]!;
        const hi = ring[r + 1]!;
        const shade = r === 0 ? 1 : r === 1 ? 0.35 : 0;
        for (let s = 0; s < SEG; s++) {
          const s1 = (s + 1) % SEG;
          tri(lo[s]!, hi[s]!, lo[s1]!, shade);
          tri(lo[s1]!, hi[s]!, hi[s1]!, shade);
        }
      }
      const last = ring[RINGS]!;
      for (let s = 0; s < SEG; s++) tri(last[s]!, apex, last[(s + 1) % SEG]!, 0);
    }
    if (!pos.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = 'snow-piles';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.mesh = mesh;
    this.group.add(mesh);
  }
}
