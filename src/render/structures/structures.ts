/**
 * Water structures layer: sluice gates (two stone posts, a wooden beam with
 * a little hand wheel, and a planked leaf that lifts when the gate opens),
 * weirs (a wooden plank cap along the crest with stone end posts), the
 * villagers' jetties (a planked deck on piles) and quays (a dressed-stone
 * edge where lined banks by the houses meet the water, with now and then a
 * few steps, a bollard, a bench or a lantern), and water wheels (a
 * spoked wooden noria with buckets on its rim, turning with the current
 * between two posts, and a trough on stilts to the bank that runs with
 * water while the wheel lifts).
 *
 * Built from a few procedural, vertex-coloured unit pieces; every piece is
 * one InstancedMesh scaled per instance, so the layer's draw calls do not
 * grow with the number of structures. Gate leaves animate towards their
 * state; wheels spin (only their own instances are rewritten per frame).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LINING_QUAY, type StructureInfo } from '../../shared/protocol';
import { heightToY, type HeightSampler } from '../coords';
import { vertexColorMaterial } from '../objects/loader';

function srgb(hex: number): THREE.Color {
  return new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
}

function paint(g: THREE.BufferGeometry, hex: number, shade = 0): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.deleteAttribute('uv');
  ng.computeVertexNormals();
  const p = ng.getAttribute('position');
  const c = srgb(hex);
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    // Darker towards the bottom (unit pieces span y 0..1).
    const k = 1 - shade * (1 - Math.min(1, Math.max(0, p.getY(i))));
    col.set([c.r * k, c.g * k, c.b * k], i * 3);
  }
  ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return ng;
}

/** Unit stone post (1×1×1, base at y = 0) with a chunky cap. */
function postGeometry(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(0.86, 0.9, 0.86).translate(0, 0.45, 0);
  const cap = new THREE.BoxGeometry(1, 0.12, 1).translate(0, 0.94, 0);
  // A couple of offset blocks so it reads as masonry.
  const b1 = new THREE.BoxGeometry(0.9, 0.18, 0.9).translate(0.01, 0.28, -0.01);
  const b2 = new THREE.BoxGeometry(0.9, 0.18, 0.9).translate(-0.01, 0.62, 0.01);
  return mergeGeometries([paint(body, 0x9a958c, 0.3), paint(b1, 0x8c877e, 0.2), paint(b2, 0xa7a297, 0.2), paint(cap, 0xb8b3a8)], false)!;
}

/** Unit leaf: vertical planks with two battens; x across the opening, z thickness. */
function leafGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const n = 4;
  for (let k = 0; k < n; k++) {
    const w = 1 / n;
    const plank = new THREE.BoxGeometry(w * 0.9, 1, 0.8).translate(-0.5 + w * (k + 0.5), 0.5, 0);
    parts.push(paint(plank, k % 2 ? 0xa8794a : 0xb98a56, 0.15));
  }
  for (const y of [0.22, 0.78]) parts.push(paint(new THREE.BoxGeometry(1, 0.1, 1).translate(0, y, 0), 0x7a5532));
  return mergeGeometries(parts, false)!;
}

/** Unit wooden beam along x. */
function beamGeometry(): THREE.BufferGeometry {
  return paint(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), 0x8d6438, 0.25);
}

/** Hand wheel on a little spindle (fixed size). */
function wheelGeometry(): THREE.BufferGeometry {
  const rim = new THREE.TorusGeometry(0.2, 0.04, 4, 10).rotateY(Math.PI / 2).translate(0, 0.32, 0);
  const spoke1 = new THREE.BoxGeometry(0.04, 0.4, 0.04).translate(0, 0.32, 0);
  const spoke2 = new THREE.BoxGeometry(0.04, 0.04, 0.4).translate(0, 0.32, 0);
  const spindle = new THREE.CylinderGeometry(0.05, 0.06, 0.3, 6).translate(0, 0.15, 0);
  return mergeGeometries([paint(rim, 0xc0392b), paint(spoke1, 0x7a5532), paint(spoke2, 0x7a5532), paint(spindle, 0x5a5a5a)], false)!;
}

/** Unit dressed-stone block (base at y = 0), pale with a darker bottom. */
function ashlarGeometry(): THREE.BufferGeometry {
  return paint(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), 0xc9c2b4, 0.35);
}

/** Mooring bollard (fixed size, base at 0). */
function bollardGeometry(): THREE.BufferGeometry {
  const body = new THREE.CylinderGeometry(0.07, 0.09, 0.22, 7).translate(0, 0.11, 0);
  const cap = new THREE.CylinderGeometry(0.11, 0.08, 0.06, 7).translate(0, 0.24, 0);
  return mergeGeometries([paint(body, 0x4a4743, 0.2), paint(cap, 0x5d5953)], false)!;
}

/** Lantern on a post (fixed size, base at 0). */
function lanternGeometry(): THREE.BufferGeometry {
  const post = new THREE.BoxGeometry(0.06, 0.62, 0.06).translate(0, 0.31, 0);
  const lamp = new THREE.BoxGeometry(0.14, 0.15, 0.14).translate(0, 0.69, 0);
  const roof = new THREE.ConeGeometry(0.13, 0.09, 4).rotateY(Math.PI / 4).translate(0, 0.81, 0);
  return mergeGeometries([paint(post, 0x3f3a35), paint(lamp, 0xffd27a), paint(roof, 0x3f3a35)], false)!;
}

/** Wooden bench (fixed size, base at 0; the seat runs along x, faces +z). */
function benchGeometry(): THREE.BufferGeometry {
  const seat = new THREE.BoxGeometry(0.62, 0.05, 0.18).translate(0, 0.17, 0);
  const back = new THREE.BoxGeometry(0.62, 0.14, 0.04).translate(0, 0.3, -0.08);
  const legs = [-0.25, 0.25].map((x) => paint(new THREE.BoxGeometry(0.05, 0.17, 0.16).translate(x, 0.085, 0), 0x5e4024));
  return mergeGeometries([paint(seat, 0xa8794a), paint(back, 0x9a6c40), ...legs], false)!;
}

/** Unit wooden pile (radius 0.5, base at 0, height 1). */
function pileGeometry(): THREE.BufferGeometry {
  return paint(new THREE.CylinderGeometry(0.5, 0.5, 1, 6).translate(0, 0.5, 0), 0x6b4a2b, 0.4);
}

/** Unit deck plank (base at 0), warm weathered wood. */
function deckGeometry(): THREE.BufferGeometry {
  return paint(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), 0xc39a66, 0.3);
}

/**
 * Unit noria (diameter 1, axle along x, wheel in the y-z plane, centred on
 * the origin): a rim of planks, spokes, a hub and buckets on the rim,
 * open towards +x where the trough is.
 */
function noriaGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const n = 12;
  const r = 0.47;
  const seg = ((2 * Math.PI * r) / n) * 1.08;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const rim = new THREE.BoxGeometry(0.16, 0.05, seg).translate(0, r, 0).rotateX(a);
    parts.push(paint(rim, k % 2 ? 0x9a6c40 : 0xa8794a));
    if (k % 2 === 0) {
      // A bucket hanging off the rim, on the trough side.
      const b = new THREE.BoxGeometry(0.14, 0.08, 0.09).translate(0.1, r + 0.03, 0).rotateX(a + Math.PI / n);
      parts.push(paint(b, 0x6b4a2b));
    }
  }
  for (let k = 0; k < 4; k++) parts.push(paint(new THREE.BoxGeometry(0.05, 0.92, 0.035).rotateX((k * Math.PI) / 4), 0x7a5532));
  parts.push(paint(new THREE.CylinderGeometry(0.07, 0.07, 0.24, 8).rotateZ(Math.PI / 2), 0x5e4024));
  return mergeGeometries(parts, false)!;
}

/** Unit trough (length 1 along x, base at y = 0): a planked U channel. */
function troughGeometry(): THREE.BufferGeometry {
  const floor = new THREE.BoxGeometry(1, 0.3, 1).translate(0, 0.15, 0);
  const sides = [-0.42, 0.42].map((z) => paint(new THREE.BoxGeometry(1, 1, 0.16).translate(0, 0.5, z), 0x9a6c40, 0.2));
  return mergeGeometries([paint(floor, 0x8d6438), ...sides], false)!;
}

/** Unit block of running water (lighter on top). */
function waterGeometry(): THREE.BufferGeometry {
  return paint(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), 0x7cc8ee, 0.25);
}

/** Small integer hash → 0..1 (stable prop choice per quay cell). */
function hash01(i: number): number {
  let h = Math.imul(i ^ 0x5bd1e995, 0x27d4eb2d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x165667b1);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

interface Piece {
  mesh: THREE.InstancedMesh;
  n: number;
}

/** Leaf lift (fraction of the gate height) when open. */
const OPEN_LIFT = 0.92;
/** Wheel spin (rad per real second at 1×) per m/s of current. */
const WHEEL_SPIN = 1.1;
/** The trough's lip above the head cell's ground (three.js units). */
const TROUGH_LIP = 0.1;

export class StructuresLayer {
  readonly group = new THREE.Group();
  private list: StructureInfo[] = [];
  /** Current leaf lift 0..1 per gate id (animated). */
  private lift = new Map<number, number>();
  private readonly pieces: Record<
    'post' | 'leaf' | 'beam' | 'wheel' | 'plank' | 'ashlar' | 'bollard' | 'lantern' | 'bench' | 'pile' | 'deck' | 'noria' | 'trough' | 'flow',
    Piece
  >;
  /** Spin angle per water wheel id (radians), and the game speed (0 = paused; set from snapshots). */
  private spin = new Map<number, number>();
  gameSpeed = 1;
  private readonly spinQ = new THREE.Quaternion();
  private readonly xAxis = new THREE.Vector3(1, 0, 0);
  /** Quay cells (from the lining snapshot) and the grid width. */
  private quays: number[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly local = new THREE.Vector3();

  constructor(
    scene: THREE.Object3D,
    private readonly heights: HeightSampler,
  ) {
    this.group.name = 'structures';
    scene.add(this.group);
    const make = (name: string, g: THREE.BufferGeometry, cap = 64): Piece => {
      const mesh = new THREE.InstancedMesh(g, vertexColorMaterial(), cap);
      mesh.name = `structure-${name}`;
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      return { mesh, n: 0 };
    };
    this.pieces = {
      post: make('post', postGeometry()),
      leaf: make('leaf', leafGeometry()),
      beam: make('beam', beamGeometry()),
      wheel: make('wheel', wheelGeometry()),
      plank: make('plank', beamGeometry()),
      ashlar: make('ashlar', ashlarGeometry(), 256),
      bollard: make('bollard', bollardGeometry()),
      lantern: make('lantern', lanternGeometry()),
      bench: make('bench', benchGeometry()),
      pile: make('pile', pileGeometry()),
      deck: make('deck', deckGeometry(), 128),
      noria: make('noria', noriaGeometry(), 8),
      trough: make('trough', troughGeometry(), 8),
      flow: make('flow', waterGeometry(), 16),
    };
  }

  get structures(): readonly StructureInfo[] {
    return this.list;
  }

  /** Number of InstancedMeshes drawn. */
  get meshCount(): number {
    return Object.values(this.pieces).filter((p) => p.mesh.count > 0).length;
  }

  setStructures(list: readonly StructureInfo[]): void {
    this.list = list.map((s) => ({ ...s }));
    for (const s of this.list) if (s.kind === 'gate' && !this.lift.has(s.id)) this.lift.set(s.id, s.lift ?? (s.open ? 1 : 0));
    this.layout();
  }

  refreshHeights(): void {
    this.layout();
  }

  /** Lining per cell (snapshot): quay cells get a dressed edge and props. */
  setLining(lining: Uint8Array): void {
    const q: number[] = [];
    const n = this.heights.width * this.heights.height;
    for (let i = 0; i < n; i++) if (lining[i] === LINING_QUAY) q.push(i);
    if (q.length === this.quays.length && q.every((v, k) => v === this.quays[k])) return;
    this.quays = q;
    this.layout();
  }

  /** Nearest gate within `radius` cells of (x, y). */
  gateNear(x: number, y: number, radius = 1.6): StructureInfo | null {
    let best: StructureInfo | null = null;
    let bd = radius;
    for (const s of this.list) {
      if (s.kind !== 'gate') continue;
      // Distance to the gate's line segment.
      const c = Math.cos(s.rot);
      const sn = Math.sin(s.rot);
      const dx = x - s.x;
      const dy = y - s.y;
      const along = Math.max(-s.width / 2 - 0.5, Math.min(s.width / 2 + 0.5, dx * c + dy * sn));
      const d = Math.hypot(dx - along * c, dy - along * sn);
      if (d <= bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  }

  /** Animate gate leaves. */
  update(dt: number): void {
    let moved = false;
    for (const s of this.list) {
      if (s.kind !== 'gate') continue;
      const cur = this.lift.get(s.id) ?? 0;
      // The sim's leaf position (it travels over a few game hours), eased between snapshots.
      const target = s.lift ?? (s.open ? 1 : 0);
      if (cur === target) continue;
      const next = cur < target ? Math.min(target, cur + dt * 0.8) : Math.max(target, cur - dt * 0.8);
      this.lift.set(s.id, next);
      moved = true;
    }
    if (moved) this.layout();
    // Wheels turn with the current: ω ∝ its speed, the bottom moving with the water.
    let spun = false;
    const g = Math.min(3, this.gameSpeed);
    for (const s of this.list) {
      if (s.kind !== 'wheel' || !s.speed || s.progress < 1 || g <= 0) continue;
      this.spin.set(s.id, ((this.spin.get(s.id) ?? 0) - dt * g * WHEEL_SPIN * s.speed) % (Math.PI * 2));
      spun = true;
    }
    if (spun && !moved) this.layoutNorias();
  }

  dispose(): void {
    for (const p of Object.values(this.pieces)) {
      p.mesh.geometry.dispose();
      p.mesh.dispose();
    }
    this.group.removeFromParent();
  }

  private begin(): void {
    for (const p of Object.values(this.pieces)) p.n = 0;
  }

  private ensure(piece: Piece, need: number): void {
    const mesh = piece.mesh;
    if (need <= mesh.instanceMatrix.count) return;
    const bigger = new THREE.InstancedMesh(mesh.geometry, mesh.material, need * 2);
    bigger.name = mesh.name;
    bigger.frustumCulled = false;
    bigger.receiveShadow = true;
    for (let i = 0; i < piece.n; i++) {
      mesh.getMatrixAt(i, this.m);
      bigger.setMatrixAt(i, this.m);
    }
    mesh.removeFromParent();
    mesh.dispose();
    this.group.add(bigger);
    piece.mesh = bigger;
  }

  /**
   * Add an instance: centre (cx, cy) in cell coords, along-line offset `u`
   * (cells), base height y0 (three units), size (sx along, sy up, sz across).
   */
  private put(piece: Piece, cx: number, cy: number, rot: number, u: number, y0: number, sx: number, sy: number, sz: number): void {
    this.ensure(piece, piece.n + 1);
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    this.p.set(cx + u * c + 0.5, y0, cy + u * s + 0.5);
    this.q.setFromAxisAngle(this.up, -rot);
    this.s.set(sx, Math.max(1e-3, sy), sz);
    this.m.compose(this.p, this.q, this.s);
    piece.mesh.setMatrixAt(piece.n++, this.m);
  }

  private layout(): void {
    this.begin();
    const P = this.pieces;
    for (const st of this.list) {
      if (st.kind === 'gate') this.layoutGate(st);
      else if (st.kind === 'jetty') this.layoutJetty(st);
      else if (st.kind === 'wheel') this.layoutWheel(st);
      else this.layoutWeir(st);
    }
    this.layoutQuays();
    for (const p of Object.values(P)) {
      if (p === P.noria) continue;
      p.mesh.count = p.n;
      p.mesh.instanceMatrix.needsUpdate = true;
    }
    this.layoutNorias();
    void this.local;
  }

  /** Where a wheel's parts go (three.js units): its centre height and diameter, the trough's height. */
  private wheelFrame(wh: StructureInfo): { yc: number; d: number; yTrough: number } {
    const bed = heightToY(wh.sill);
    const surface = heightToY(wh.sill + this.heights.depthAt(wh.x, wh.y));
    const yTrough = heightToY(wh.top) + TROUGH_LIP;
    // The buckets dip below the surface and tip out just above the trough.
    const bottom = Math.max(bed + 0.04, surface - 0.18);
    const top = yTrough + 0.14;
    const d = Math.max(0.45, top - bottom);
    return { yc: top - d / 2, d, yTrough };
  }

  /** The turning wheels (rewritten every frame while any turns). */
  private layoutNorias(): void {
    const piece = this.pieces.noria;
    piece.n = 0;
    for (const wh of this.list) {
      if (wh.kind !== 'wheel' || wh.progress < 1) continue;
      const { yc, d } = this.wheelFrame(wh);
      this.ensure(piece, piece.n + 1);
      this.p.set(wh.x + 0.5, yc, wh.y + 0.5);
      this.q.setFromAxisAngle(this.up, -wh.rot);
      this.spinQ.setFromAxisAngle(this.xAxis, this.spin.get(wh.id) ?? 0);
      this.q.multiply(this.spinQ);
      this.s.set(1, d, d);
      this.m.compose(this.p, this.q, this.s);
      piece.mesh.setMatrixAt(piece.n++, this.m);
    }
    piece.mesh.count = piece.n;
    piece.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * A water wheel: two posts in the river carrying the axle, the wheel
   * (layoutNorias), and a trough on stilts from beside the wheel's top to
   * the head cell, with water running in it and spilling out at the end.
   */
  private layoutWheel(wh: StructureInfo): void {
    const P = this.pieces;
    const { yc, d, yTrough } = this.wheelFrame(wh);
    const bed = heightToY(wh.sill);
    const prog = Math.min(1, Math.max(0, wh.progress));
    const c = Math.cos(wh.rot);
    const sn = Math.sin(wh.rot);
    // Posts either side of the wheel, rising with the work.
    for (const u of [-0.17, 0.17]) this.put(P.beam, wh.x, wh.y, wh.rot, u, bed - 0.05, 0.08, (yc + 0.06 - bed + 0.05) * Math.max(0.15, prog), 0.1);
    if (prog < 0.5) return;
    this.put(P.beam, wh.x, wh.y, wh.rot, 0, yc - 0.03, 0.46, 0.06, 0.06);
    // The trough: from beside the wheel's top to over the head cell.
    const u0 = 0.1;
    const u1 = Math.max(u0 + 0.3, Math.hypot((wh.x2 ?? wh.x) - wh.x, (wh.y2 ?? wh.y) - wh.y) + 0.05);
    const tH = 0.09;
    const tFrom = prog >= 1 ? u1 : u0 + (u1 - u0) * (prog - 0.5) * 2;
    this.put(P.trough, wh.x, wh.y, wh.rot, (u0 + tFrom) / 2, yTrough, tFrom - u0, tH, 0.2);
    // Stilts under it, down to the ground (or the river bed).
    for (let u = u0 + 0.25; u < tFrom; u += 0.6) {
      const g = heightToY(this.heights.terrainAt(wh.x + c * u, wh.y + sn * u));
      if (yTrough - g > 0.04) this.put(P.beam, wh.x, wh.y, wh.rot, u, g - 0.03, 0.05, yTrough - g + 0.03, 0.05);
    }
    if (prog < 1 || !wh.open) return;
    // Running water in the trough, and a little fall into the head cell.
    this.put(P.flow, wh.x, wh.y, wh.rot, (u0 + u1) / 2, yTrough + 0.025, u1 - u0 - 0.04, 0.035, 0.13);
    const ground = heightToY(this.heights.terrainAt(wh.x + c * u1, wh.y + sn * u1));
    this.put(P.flow, wh.x, wh.y, wh.rot, u1 + 0.03, ground, 0.05, yTrough + 0.06 - ground, 0.11);
    // Water tipping from the top bucket into the trough.
    this.put(P.flow, wh.x, wh.y, wh.rot, 0.05, yTrough + 0.03, 0.05, yc + d / 2 - yTrough - 0.03, 0.08);
  }

  private layoutGate(g: StructureInfo): void {
    const P = this.pieces;
    const ySill = heightToY(g.sill);
    const yTop = heightToY(g.top);
    const H = Math.max(0.2, yTop - ySill);
    const half = g.width / 2;
    const prog = Math.min(1, Math.max(0, g.progress));
    // Posts on the flank cells, rising with construction.
    const postH = (H + 0.35) * Math.max(0.12, prog);
    for (const side of [-1, 1]) {
      const u = side * (half + 0.3);
      const ground = Math.min(heightToY(this.heights.terrainAt(g.x + Math.cos(g.rot) * u, g.y + Math.sin(g.rot) * u)), ySill);
      this.put(P.post, g.x, g.y, g.rot, u, ground, 0.55, postH + (ySill - ground), 0.75);
    }
    if (prog < 1) return;
    // Beam across the posts, a hand wheel on top.
    const yBeam = ySill + H + 0.2;
    this.put(P.beam, g.x, g.y, g.rot, 0, yBeam, g.width + 1.2, 0.16, 0.32);
    this.put(P.wheel, g.x, g.y, g.rot, 0, yBeam + 0.16, 1, 1, 1);
    // The leaf: from the sill to the top when closed, lifted when open.
    const lift = this.lift.get(g.id) ?? (g.open ? 1 : 0);
    // (A closed leaf stands a little proud of the crest so it shows above a full reservoir.)
    this.put(P.leaf, g.x, g.y, g.rot, 0, ySill + lift * H * OPEN_LIFT, g.width + 0.1, H + 0.15, 0.2);
  }

  private layoutWeir(w: StructureInfo): void {
    if (w.progress < 0.999 || w.x2 === undefined || w.y2 === undefined) return;
    const P = this.pieces;
    const y = heightToY(w.top);
    const len = w.width;
    const c = Math.cos(w.rot);
    const sn = Math.sin(w.rot);
    // The overflow section: where the line is not higher than the crest.
    let u0 = Infinity;
    let u1 = -Infinity;
    for (let u = 0; u <= len; u += 0.25) {
      if (this.heights.terrainAt(w.x + c * u, w.y + sn * u) <= w.top + 0.05) {
        u0 = Math.min(u0, u);
        u1 = Math.max(u1, u);
      }
    }
    if (!(u1 > u0)) return;
    u0 -= 0.3;
    u1 += 0.3;
    // A pale dressed-stone crest (the body is the lined terrain) with a plank cap.
    this.put(P.ashlar, w.x, w.y, w.rot, (u0 + u1) / 2, y - 0.3, u1 - u0, 0.3, 1.0);
    this.put(P.plank, w.x, w.y, w.rot, (u0 + u1) / 2, y - 0.05, u1 - u0, 0.13, 0.4);
    // Little stone posts at either end of the crest.
    for (const u of [u0, u1]) this.put(P.post, w.x, w.y, w.rot, u, y - 0.25, 0.45, 0.55, 0.55);
  }

  /** A planked deck on piles from the shore cell out over the water; piles go in first. */
  private layoutJetty(j: StructureInfo): void {
    if (j.x2 === undefined || j.y2 === undefined) return;
    const P = this.pieces;
    const len = Math.hypot(j.x2 - j.x, j.y2 - j.y);
    const c = Math.cos(j.rot);
    const sn = Math.sin(j.rot);
    const done = j.progress >= 1;
    const yDeck = done ? heightToY(j.top) : heightToY(this.heights.terrainAt(j.x, j.y)) + 0.05;
    // Piles: pairs along the jetty, as many as the work so far.
    const pairs = Math.max(1, Math.round(len * 1.5));
    const built = done ? pairs : Math.floor(pairs * j.progress * 1.5);
    for (let k = 1; k <= Math.min(pairs, built); k++) {
      const u = 0.5 + ((len - 0.1) * k) / pairs;
      const bed = heightToY(this.heights.terrainAt(j.x + c * u, j.y + sn * u));
      for (const side of [-0.32, 0.32]) {
        const px = j.x + c * u - sn * side;
        const py = j.y + sn * u + c * side;
        this.put(P.pile, px, py, j.rot, 0, bed - 0.05, 0.11, yDeck + 0.12 - bed, 0.11);
      }
    }
    if (!done && j.progress < 0.6) return;
    // Deck: cross planks with small gaps, two stringers below.
    const u0 = 0.15;
    const u1 = len + 0.45;
    const deckTo = done ? u1 : u0 + (u1 - u0) * Math.min(1, (j.progress - 0.6) / 0.4);
    this.put(P.deck, j.x, j.y, j.rot, (u0 + deckTo) / 2, yDeck - 0.09, deckTo - u0, 0.05, 0.08);
    for (const side of [-0.28, 0.28]) {
      this.put(P.deck, j.x - sn * side, j.y + c * side, j.rot, (u0 + deckTo) / 2, yDeck - 0.09, deckTo - u0, 0.06, 0.07);
    }
    for (let u = u0 + 0.09; u < deckTo; u += 0.19) this.put(P.deck, j.x, j.y, j.rot, u, yDeck - 0.04, 0.16, 0.05, 0.78);
    // A bollard at the end for the boats.
    if (done) this.put(P.bollard, j.x + c * (u1 - 0.12) - sn * 0.3, j.y + sn * (u1 - 0.12) + c * 0.3, j.rot, 0, yDeck, 0.8, 0.8, 0.8);
  }

  /**
   * Quays: a dressed-stone edge along every side of a quay cell that faces
   * water, from below the water line up to the ground; and, chosen by a
   * stable hash per cell, a few steps down to the water, a bollard, a
   * bench facing the water or a lantern.
   */
  private layoutQuays(): void {
    if (!this.quays.length) return;
    const P = this.pieces;
    const hs = this.heights;
    const W = hs.width;
    const dirs: [number, number][] = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    const isQuay = new Set(this.quays);
    for (const i of this.quays) {
      const x = i % W;
      const y = (i / W) | 0;
      const top = heightToY(hs.terrainAt(x, y));
      let props = false;
      for (const [dx, dy] of dirs) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= hs.height) continue;
        if (isQuay.has(ny * W + nx) || hs.depthAt(nx, ny) < 0.2) continue;
        const rot = Math.atan2(dy, dx);
        const bed = heightToY(hs.terrainAt(nx, ny));
        // Along the edge: the wall's "along" axis is perpendicular to (dx, dy).
        const wallRot = rot + Math.PI / 2;
        const ex = x + dx * 0.44;
        const ey = y + dy * 0.44;
        const base = Math.min(top - 0.05, bed + 0.02);
        this.put(P.ashlar, ex, ey, wallRot, 0, base, 1.02, top + 0.06 - base, 0.16);
        if (props) continue;
        props = true;
        const h = hash01(i * 4 + (dx + 1) * 2 + (dy + 1));
        const sideX = -dy;
        const sideY = dx;
        if (h < 0.1) {
          // Steps down to the water, set into the edge.
          for (let k = 0; k < 3; k++) {
            const o = 0.52 + k * 0.14;
            const sy = top - (k + 1) * 0.07;
            this.put(P.ashlar, x + dx * o + sideX * 0.15, y + dy * o + sideY * 0.15, wallRot, 0, Math.max(bed, sy - 0.12), 0.42, sy + 0.12 - Math.max(bed, sy - 0.12), 0.14);
          }
        } else if (h < 0.22) {
          this.put(P.bollard, x + dx * 0.3 + sideX * 0.25, y + dy * 0.3 + sideY * 0.25, rot, 0, top, 1, 1, 1);
        } else if (h < 0.3) {
          // A bench a little back from the edge, looking out over the water.
          this.put(P.bench, x - dx * 0.05, y - dy * 0.05, rot - Math.PI / 2, 0, top, 1, 1, 1);
        } else if (h < 0.38) {
          this.put(P.lantern, x + dx * 0.3 - sideX * 0.35, y + dy * 0.3 - sideY * 0.35, rot, 0, top, 1, 1, 1);
        }
      }
    }
  }
}
