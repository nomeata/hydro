/**
 * Snow banks beside the fields (sim/people/village.ts clearSnow): the snow
 * the farmers shovelled off a field before sowing, thrown onto the open land
 * at its edge. Adjacent bank cells form one bank; each bank is drawn as a
 * few low, broad, overlapping mounds strung along it (so it reads as one
 * continuous ridge, not separate blobs), white with a cool blue shade and a
 * little grey only at the foot, sunk slightly into the ground. Sized by the
 * snow the cells hold above the snow around them, so they shrink as they
 * melt; banks holding too little are not drawn at all, and flooded ones are
 * left out by the sim (they melt into the water). The ground beneath shows
 * only the snow around (sim/worker.ts lowers the look's snow cover on pile
 * cells). Instanced: two mound shapes, one draw call each, matrices rebuilt
 * only when the piles change visibly.
 */
import * as THREE from 'three';
import { CELL_METRES, heightToY, type HeightSampler } from '../coords';

/** Density of shovelled, settled snow relative to water: snow volume = water depth × area / this. */
const PILE_DENSITY = 0.3;
/** A bank holding less snow water than this (m × cells) is not drawn. */
const MIN_BANK = 0.04;
/** Roughly one mound per this many bank cells. */
const CELLS_PER_MOUND = 3.5;
/** Mound half-width across the bank (cells), and least half-length along it. */
const HALF_WIDTH = 0.65;
const MIN_HALF_LENGTH = 1.0;
/** Tallest mound (m): more snow makes it broader instead. */
const MAX_HEIGHT = 0.4;
/** Mounds below this height (m) are not drawn. */
const MIN_HEIGHT = 0.04;
/** Depth (m) the foot is sunk below the lowest ground under the mound. */
const SINK = 0.02;
/** Water depth (m) over which a mound is hidden (it melts into the water). */
const FLOODED = 0.03;
const SEG = 14;
const RINGS = 5;
const VARIANTS = 2;
const MAX_INSTANCES = 4096;

export interface SnowPile {
  x: number;
  y: number;
  /** Snow water above the snow around it (m). */
  swe: number;
}

/** One drawn mound: centre (three.js x, z), half-length along / half-width across (cells), height (m), heading. */
export interface Mound {
  x: number;
  z: number;
  a: number;
  b: number;
  h: number;
  ang: number;
  seed: number;
}

/** Small deterministic hash in [0, 1). */
function hash(a: number, b: number): number {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Group the pile cells into banks (8-connected) and string a few overlapping
 * mounds along each, holding the bank's snow (a paraboloid of half-axes a, b
 * and height h holds π/2 · a · b · h).
 */
export function mounds(piles: readonly SnowPile[]): Mound[] {
  const at = new Map<number, number>();
  piles.forEach((p, k) => at.set(p.y * 65536 + p.x, k));
  const seen = new Uint8Array(piles.length);
  const out: Mound[] = [];
  for (let k0 = 0; k0 < piles.length; k0++) {
    if (seen[k0]) continue;
    const bank: SnowPile[] = [];
    const stack = [k0];
    seen[k0] = 1;
    while (stack.length) {
      const p = piles[stack.pop()!]!;
      bank.push(p);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const k = at.get((p.y + dy) * 65536 + p.x + dx);
          if (k !== undefined && !seen[k]) {
            seen[k] = 1;
            stack.push(k);
          }
        }
    }
    const total = bank.reduce((t, p) => t + p.swe, 0);
    if (total < MIN_BANK) continue;
    // The bank's long axis (principal axis of its cells, weighted by snow).
    let mx = 0;
    let my = 0;
    for (const p of bank) {
      mx += p.x * p.swe;
      my += p.y * p.swe;
    }
    mx /= total;
    my /= total;
    let cxx = 0;
    let cyy = 0;
    let cxy = 0;
    for (const p of bank) {
      cxx += (p.x - mx) ** 2 * p.swe;
      cyy += (p.y - my) ** 2 * p.swe;
      cxy += (p.x - mx) * (p.y - my) * p.swe;
    }
    const ang = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    const ux = Math.cos(ang);
    const uy = Math.sin(ang);
    bank.sort((p, q) => p.x * ux + p.y * uy - (q.x * ux + q.y * uy) || p.y - q.y || p.x - q.x);
    const n = Math.max(1, Math.round(bank.length / CELLS_PER_MOUND));
    for (let m = 0; m < n; m++) {
      const chunk = bank.slice(Math.floor((m * bank.length) / n), Math.floor(((m + 1) * bank.length) / n));
      const swe = chunk.reduce((t, p) => t + p.swe, 0);
      let cx = 0;
      let cy = 0;
      let lo = Infinity;
      let hi = -Infinity;
      for (const p of chunk) {
        cx += p.x * p.swe;
        cy += p.y * p.swe;
        const s = p.x * ux + p.y * uy;
        lo = Math.min(lo, s);
        hi = Math.max(hi, s);
      }
      cx /= swe;
      cy /= swe;
      const seed = chunk[0]!.y * 4099 + chunk[0]!.x;
      const vol = (swe * CELL_METRES * CELL_METRES) / PILE_DENSITY;
      // Long enough to reach into the next mound (one continuous bank), a little varied.
      let a = Math.max(MIN_HALF_LENGTH, (hi - lo) / 2 + 0.6) * (0.9 + 0.25 * hash(seed, 1));
      const b = HALF_WIDTH * (0.85 + 0.3 * hash(seed, 2));
      let h = (2 * vol) / (Math.PI * a * b * CELL_METRES * CELL_METRES);
      if (h > MAX_HEIGHT) {
        a *= h / MAX_HEIGHT;
        h = MAX_HEIGHT;
      }
      if (h < MIN_HEIGHT) continue;
      out.push({
        x: cx + 0.5 + (hash(seed, 3) - 0.5) * 0.25,
        z: cy + 0.5 + (hash(seed, 4) - 0.5) * 0.25,
        a,
        b,
        h,
        ang: ang + (hash(seed, 5) - 0.5) * 0.35,
        seed,
      });
    }
  }
  return out;
}

/** A unit mound (radius 1, height 1, foot sunk to y = -0.25), lumpy, with vertex colours. */
function moundGeometry(variant: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const top = new THREE.Color(0xf6f8fb);
  const shade = new THREE.Color(0xdbe5f0);
  const foot = new THREE.Color(0xb9bbb6);
  const c = new THREE.Color();
  const ph2 = hash(variant, 7) * Math.PI * 2;
  const ph3 = hash(variant, 8) * Math.PI * 2;
  for (let r = 0; r <= RINGS; r++) {
    // r = 0: the sunk foot; then rings up the flank to near the crest.
    const t = r / (RINGS + 1);
    const rho = r === 0 ? 1.05 : Math.sqrt(1 - t);
    for (let s = 0; s < SEG; s++) {
      const a = (s / SEG) * Math.PI * 2;
      const lump = 1 + 0.08 * Math.sin(2 * a + ph2) + 0.06 * Math.sin(3 * a + ph3) + (hash(variant * 997 + r, s) - 0.5) * 0.08;
      const y = r === 0 ? -0.25 : t * (1 + (hash(variant * 991 + r, s + 50) - 0.5) * 0.25);
      pos.push(Math.cos(a) * rho * lump, y, Math.sin(a) * rho * lump);
      // White on top, a cool blue on the flanks, a little grey only at the foot.
      c.copy(shade).lerp(top, Math.min(1, t * 1.6));
      if (r <= 1) c.lerp(foot, r === 0 ? 0.55 : 0.18 * hash(variant, s + 90));
      col.push(c.r, c.g, c.b);
    }
  }
  pos.push(0, 1, 0);
  col.push(top.r, top.g, top.b);
  const apex = (RINGS + 1) * SEG;
  for (let r = 0; r < RINGS; r++)
    for (let s = 0; s < SEG; s++) {
      const s1 = (s + 1) % SEG;
      const a0 = r * SEG + s;
      const a1 = r * SEG + s1;
      idx.push(a0, a0 + SEG, a1, a1, a0 + SEG, a1 + SEG);
    }
  for (let s = 0; s < SEG; s++) idx.push(RINGS * SEG + s, apex, RINGS * SEG + ((s + 1) % SEG));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

export class SnowPileLayer {
  readonly group = new THREE.Group();
  private readonly meshes: THREE.InstancedMesh[] = [];
  private key = '';
  private piles: SnowPile[] = [];
  private drawn = 0;
  private readonly material = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x1d2633 });

  constructor(
    scene: THREE.Object3D,
    private readonly heights: HeightSampler,
    private readonly maxViewHeight = 160,
  ) {
    this.group.name = 'snow-piles';
    scene.add(this.group);
    for (let v = 0; v < VARIANTS; v++) {
      const mesh = new THREE.InstancedMesh(moundGeometry(v + 1), this.material, MAX_INSTANCES);
      mesh.name = 'snow-piles';
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
  }

  /** Bank cells known. */
  get count(): number {
    return this.piles.length;
  }

  /** Mounds drawn. */
  get mounds(): number {
    return this.drawn;
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
    this.rebuild();
  }

  update(viewHeight: number): void {
    this.group.visible = viewHeight < this.maxViewHeight;
  }

  dispose(): void {
    for (const m of this.meshes) {
      m.geometry.dispose();
      m.dispose();
    }
    this.material.dispose();
    this.group.removeFromParent();
  }

  private rebuild(): void {
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const counts = this.meshes.map(() => 0);
    this.drawn = 0;
    for (const m of mounds(this.piles)) {
      const ca = Math.cos(m.ang);
      const sa = Math.sin(m.ang);
      // Rest on the lowest ground under the mound, sunk a little (no hovering on a slope).
      let g = Infinity;
      for (const [u, v] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const wx = m.x + u * m.a * ca * 0.8 - v * m.b * sa * 0.8;
        const wz = m.z + u * m.a * sa * 0.8 + v * m.b * ca * 0.8;
        g = Math.min(g, this.heights.terrainAt(wx - 0.5, wz - 0.5));
      }
      if (this.heights.depthAt(m.x - 0.5, m.z - 0.5) > FLOODED) continue;
      const v = Math.floor(hash(m.seed, 9) * VARIANTS);
      if (counts[v]! >= MAX_INSTANCES) continue;
      // Three.js rotation about y is clockwise in (x, z); the mound's long axis is its local x.
      q.setFromAxisAngle(up, -m.ang);
      p.set(m.x, heightToY(g - SINK), m.z);
      s.set(m.a, heightToY(m.h), m.b);
      m4.compose(p, q, s);
      this.meshes[v]!.setMatrixAt(counts[v]!++, m4);
      this.drawn++;
    }
    this.meshes.forEach((mesh, v) => {
      mesh.count = counts[v]!;
      mesh.instanceMatrix.needsUpdate = true;
    });
  }
}
