/**
 * Snow piles beside the fields (sim/people/village.ts clearSnow): the snow
 * the farmers shovelled off a field before sowing, heaped on the open land
 * at its edge. Drawn as small rounded low-poly mounds of old, crusted snow
 * (greyer and dirtier towards the foot) sitting on the ground, sized by the
 * snow the cell holds above the snow around it, so they shrink as they
 * melt. The ground beneath shows only the snow around (sim/worker.ts lowers
 * the look's snow cover on pile cells), so a pile left on bare spring
 * ground is a heap, not a flat white blot. One merged mesh (one draw call),
 * rebuilt only when the piles change visibly.
 */
import * as THREE from 'three';
import { CELL_METRES, heightToY, type HeightSampler } from '../coords';

/** Density of shovelled, settled snow relative to water: snow volume = water depth × area / this. */
const PILE_DENSITY = 0.45;
/** Mound height / footprint radius. */
const ASPECT = 0.26;
/** Largest footprint radius (cells). */
const MAX_RADIUS = 0.75;
/** Segments around, rings up. */
const SEG = 12;
const RINGS = 4;

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
  private readonly material = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x2a2e33 });

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
    const idx: number[] = [];
    const top = new THREE.Color(0xeceeee);
    const crust = new THREE.Color(0xd3d6d6);
    const dirt = new THREE.Color(0xa49d91);
    const c = new THREE.Color();
    for (const p of this.piles) {
      const { radius, height } = pileSize(p.swe);
      if (radius < 0.08) continue;
      const hY = heightToY(height);
      const seed = p.y * 4099 + p.x;
      // A little off the cell centre, stretched along a random direction,
      // its outline lumpy (two low harmonics, as shovelled heaps are).
      const cx = p.x + 0.5 + (hash(seed, 1) - 0.5) * 0.3;
      const cz = p.y + 0.5 + (hash(seed, 2) - 0.5) * 0.3;
      const ang = hash(seed, 3) * Math.PI;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const sx = 1.4;
      const sz = 0.75;
      const ph2 = hash(seed, 4) * Math.PI * 2;
      const ph3 = hash(seed, 5) * Math.PI * 2;
      const base = pos.length / 3;
      // Rings from the foot (r = 0) up; the apex closes it.
      for (let r = 0; r <= RINGS; r++) {
        const t = r / (RINGS + 1);
        const rho = Math.sqrt(1 - t);
        for (let s = 0; s < SEG; s++) {
          const a = (s / SEG) * Math.PI * 2;
          const lump = 1 + 0.1 * Math.sin(2 * a + ph2) + 0.07 * Math.sin(3 * a + ph3) + (hash(seed, 10 + r * SEG + s) - 0.5) * 0.08;
          const lx = Math.cos(a) * rho * radius * sx * lump;
          const lz = Math.sin(a) * rho * radius * sz * lump;
          const wx = cx + lx * ca - lz * sa;
          const wz = cz + lx * sa + lz * ca;
          const g = heightToY(this.heights.terrainAt(wx - 0.5, wz - 0.5));
          pos.push(wx, g + (r === 0 ? -0.01 : hY * t * (1 + (hash(seed, 50 + r * SEG + s) - 0.5) * 0.4)), wz);
          // Clean crust on top, greyer and dirtier towards the foot (old, settled snow).
          const k = hash(seed, 90 + r * SEG + s);
          c.copy(crust).lerp(top, t * 1.3 * (0.6 + 0.4 * k)).lerp(dirt, r === 0 ? 0.7 : r === 1 ? 0.35 * k : 0.25 * k * k * k);
          col.push(c.r, c.g, c.b);
        }
      }
      const apexG = heightToY(this.heights.terrainAt(cx - 0.5, cz - 0.5));
      pos.push(cx, apexG + hY, cz);
      col.push(top.r, top.g, top.b);
      const apex = base + (RINGS + 1) * SEG;
      // Counter-clockwise seen from above/outside.
      for (let r = 0; r < RINGS; r++)
        for (let s = 0; s < SEG; s++) {
          const s1 = (s + 1) % SEG;
          const a0 = base + r * SEG + s;
          const a1 = base + r * SEG + s1;
          const b0 = a0 + SEG;
          const b1 = a1 + SEG;
          idx.push(a0, b0, a1, a1, b0, b1);
        }
      for (let s = 0; s < SEG; s++) idx.push(base + RINGS * SEG + s, apex, base + RINGS * SEG + ((s + 1) % SEG));
    }
    if (!pos.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
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
