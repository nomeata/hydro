/**
 * Power grid layer (M6): turbines' little powerhouses at the foot of their
 * wall with a penstock over the crest and foam in the tailrace, wooden
 * power poles with sagging wires, electric pumps (a pump house and a pipe
 * laid along the ground to a spout), and lit cottages: warm window panes,
 * a lamp by the door and a faint pool of light on the ground (always
 * daytime, so it is a subtle glow; a little stronger in winter). Houses the
 * grid cannot fully supply are dimmer, and flicker.
 *
 * Every piece is one InstancedMesh scaled per instance (as structures.ts),
 * so the draw calls do not grow with the grid.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BuildingInfo, PowerInfo } from '../../shared/protocol';
import { heightToY, type HeightSampler } from '../coords';
import { vertexColorMaterial } from '../objects/loader';
import { houseSpots, houseVariant } from '../village/houses';
import { hash01 } from '../village/cues';

function paint(g: THREE.BufferGeometry, hex: number, shade = 0): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.deleteAttribute('uv');
  ng.computeVertexNormals();
  const p = ng.getAttribute('position');
  const c = new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const k = 1 - shade * (1 - Math.min(1, Math.max(0, p.getY(i))));
    col.set([c.r * k, c.g * k, c.b * k], i * 3);
  }
  ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return ng;
}

/** Unit powerhouse (1×1×1 box body, base at 0, door towards +x) with a pitched roof and a mast for the wires. */
function powerhouseGeometry(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(1, 0.62, 0.82).translate(0, 0.31, 0);
  const quoins = [-0.48, 0.48].flatMap((x) => [-0.39, 0.39].map((z) => paint(new THREE.BoxGeometry(0.08, 0.62, 0.08).translate(x, 0.31, z), 0x9a958c)));
  const band = new THREE.BoxGeometry(1.04, 0.08, 0.86).translate(0, 0.04, 0);
  const roof = new THREE.CylinderGeometry(0.01, 0.62, 0.36, 4, 1).rotateY(Math.PI / 4).scale(1.25, 1, 1.05).translate(0, 0.8, 0);
  const door = new THREE.BoxGeometry(0.04, 0.34, 0.22).translate(0.5, 0.2, 0);
  const win = [-0.22, 0.22].map((z) => paint(new THREE.BoxGeometry(0.03, 0.14, 0.14).translate(0.5, 0.4, z), 0x4a6a80));
  const mast = new THREE.BoxGeometry(0.05, 0.42, 0.05).translate(-0.3, 0.98, 0);
  const arm = new THREE.BoxGeometry(0.05, 0.04, 0.42).translate(-0.3, 1.17, 0);
  return mergeGeometries(
    [paint(body, 0xd8cdb4, 0.25), ...quoins, paint(band, 0x9a958c), paint(roof, 0xb5523a, 0.2), paint(door, 0x6b4a2b), ...win, paint(mast, 0x6b4a2b), paint(arm, 0x6b4a2b)],
    false,
  )!;
}

/** Unit stone plinth (base at 0). */
function plinthGeometry(): THREE.BufferGeometry {
  return paint(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), 0x9a958c, 0.35);
}

/** Unit pipe along x (radius 0.5, length 1, centred). */
function pipeGeometry(): THREE.BufferGeometry {
  return paint(new THREE.CylinderGeometry(0.5, 0.5, 1, 7).rotateZ(Math.PI / 2), 0x5d6670);
}

/** A wooden power pole (fixed size, base at 0): pole, cross-arm along z, two insulators. */
function poleGeometry(): THREE.BufferGeometry {
  const pole = new THREE.CylinderGeometry(0.035, 0.05, 1.3, 6).translate(0, 0.65, 0);
  const arm = new THREE.BoxGeometry(0.05, 0.05, 0.5).translate(0, 1.2, 0);
  const ins = [-0.2, 0.2].map((z) => paint(new THREE.CylinderGeometry(0.018, 0.022, 0.06, 5).translate(0, 1.255, z), 0xe8e6e0));
  return mergeGeometries([paint(pole, 0x7a5532, 0.3), paint(arm, 0x6b4a2b), ...ins], false)!;
}

/** Unit wire segment along x (length 1, centred). */
function wireGeometry(): THREE.BufferGeometry {
  return paint(new THREE.BoxGeometry(1, 1, 1), 0x2e2a26);
}

/** A turbine's runner as seen on the powerhouse's side: an iron ring with three spokes, its axle along z. */
function runnerGeometry(): THREE.BufferGeometry {
  const ring = new THREE.TorusGeometry(0.15, 0.028, 4, 14);
  const spokes = [0, 1, 2].map((k) => paint(new THREE.BoxGeometry(0.3, 0.045, 0.03).rotateZ((k * Math.PI) / 3), 0xc9a14a));
  const hub = new THREE.CylinderGeometry(0.045, 0.045, 0.06, 8).rotateX(Math.PI / 2);
  return mergeGeometries([paint(ring, 0x3e6b8a), ...spokes, paint(hub, 0x2e2a26)], false)!;
}

/** Unit pump house (base at 0; corrugated grey-blue walls, a darker roof). */
function pumpHouseGeometry(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(0.62, 0.42, 0.52).translate(0, 0.21, 0);
  const roof = new THREE.BoxGeometry(0.7, 0.06, 0.6).translate(0, 0.45, 0);
  const motor = new THREE.CylinderGeometry(0.1, 0.1, 0.22, 8).rotateZ(Math.PI / 2).translate(0.38, 0.14, 0);
  const mast = new THREE.BoxGeometry(0.04, 0.6, 0.04).translate(-0.25, 0.75, 0);
  const arm = new THREE.BoxGeometry(0.04, 0.04, 0.36).translate(-0.25, 1.03, 0);
  return mergeGeometries([paint(body, 0x7f97a8, 0.25), paint(roof, 0x4f5d68), paint(motor, 0x3e6b8a), paint(mast, 0x6b4a2b), paint(arm, 0x6b4a2b)], false)!;
}

/** Unit block of water (lighter on top). */
function waterGeometry(): THREE.BufferGeometry {
  return paint(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), 0x8fd0f0, 0.25);
}

interface Piece {
  mesh: THREE.InstancedMesh;
  n: number;
}

/** Powerhouse size (three.js units). */
const HOUSE = 1;
/** Where a pole's wires hang (three.js units above its base) and the arm's half width. */
const POLE_TOP = 1.25;
const ARM = 0.2;
/** Wire sag (three.js units) per cell of span, and segments per span. */
const SAG = 0.012;
const SEGMENTS = 6;
/** Window pane size (tile units) and its height above the wall base. */
const PANE = { w: 0.2, h: 0.24, y: 0.5 };

interface Glow {
  house: number;
  level: number;
  /** Matrices of the house's panes and door lamp. */
  panes: THREE.Matrix4[];
  lamp: THREE.Matrix4;
}

export class PowerLayer {
  readonly group = new THREE.Group();
  private info: PowerInfo | null = null;
  private buildings: readonly BuildingInfo[] = [];
  private readonly pieces: Record<'house' | 'plinth' | 'pipe' | 'pole' | 'wire' | 'pump' | 'spout', Piece>;
  /** Foam in the tailraces (animated), window panes, door lamps and light pools (per frame while lit). */
  private foam: THREE.InstancedMesh;
  private panes: THREE.InstancedMesh;
  private lamps: THREE.InstancedMesh;
  private glows: Glow[] = [];
  private foams: { x: number; z: number; y: number; dx: number; dz: number; s: number; seed: number }[] = [];
  /** Turbine runners on the powerhouses' sides: where, facing, turning speed (rad/s; 0: idle) and angle. */
  private runnerMesh: THREE.InstancedMesh;
  private runners: { id: number; x: number; y: number; z: number; yaw: number; speed: number }[] = [];
  private readonly angles = new Map<number, number>();
  /** Where wires attach to each node ("x,y"), after the last layout (a ghost line hangs on these). */
  nodeTops = new Map<string, { y: number; yaw: number }>();
  /** A ghost layer: attachment points of the real grid's nodes its wires may end at. */
  anchors: ReadonlyMap<string, { y: number; yaw: number }> | null = null;
  private time = 0;
  /** Winter glows a little more (0..1 from the season). */
  private winter = 0;
  gameSpeed = 1;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly c = new THREE.Color();

  /** Wire thickness (three.js units; a ghost line draws them thicker). */
  private readonly wireThick: number;
  private readonly poleScale: number;

  constructor(
    scene: THREE.Object3D,
    private readonly heights: HeightSampler,
    /** One material for every piece (a ghost preview), or each its own vertex colours. */
    material?: THREE.Material,
  ) {
    this.group.name = material ? 'power-ghost' : 'power';
    this.wireThick = material ? 0.05 : 0.012;
    // (A ghost line's poles stand a little taller, so the line reads at a distance.)
    this.poleScale = material ? 1.6 : 1;
    scene.add(this.group);
    const make = (name: string, g: THREE.BufferGeometry, cap = 32): Piece => {
      const mesh = new THREE.InstancedMesh(g, material ?? vertexColorMaterial(), cap);
      mesh.name = `power-${name}`;
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      return { mesh, n: 0 };
    };
    this.pieces = {
      house: make('house', powerhouseGeometry()),
      plinth: make('plinth', plinthGeometry()),
      pipe: make('pipe', pipeGeometry(), 128),
      pole: make('pole', poleGeometry(), 64),
      wire: make('wire', wireGeometry(), 512),
      pump: make('pump', pumpHouseGeometry()),
      spout: make('spout', waterGeometry()),
    };
    const foamMat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, depthWrite: false });
    foamMat.emissive.setRGB(0.35, 0.37, 0.4);
    this.foam = this.dynamic('power-foam', new THREE.IcosahedronGeometry(1, 0), foamMat, 64);
    // Lit windows: unlit (basic) material, so they read as light whatever the sun does.
    const glass = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    this.panes = this.dynamic('power-panes', new THREE.PlaneGeometry(1, 1).rotateY(Math.PI / 2), glass, 128, true);
    const lamp = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    this.lamps = this.dynamic('power-lamps', new THREE.BoxGeometry(1, 1.2, 1), lamp, 64, true);
    this.runnerMesh = this.dynamic('power-runners', runnerGeometry(), vertexColorMaterial(), 16);
  }

  private dynamic(name: string, g: THREE.BufferGeometry, mat: THREE.Material, cap: number, colour = false): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(g, mat, cap);
    mesh.name = name;
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (colour) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.group.add(mesh);
    return mesh;
  }

  private grow(mesh: THREE.InstancedMesh, need: number, set: (m: THREE.InstancedMesh) => void): void {
    if (need <= mesh.instanceMatrix.count) return;
    const cap = Math.ceil(need * 1.5);
    const bigger = new THREE.InstancedMesh(mesh.geometry, mesh.material, cap);
    bigger.name = mesh.name;
    bigger.frustumCulled = false;
    bigger.renderOrder = mesh.renderOrder;
    bigger.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (mesh.instanceColor) bigger.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    mesh.removeFromParent();
    mesh.dispose();
    this.group.add(bigger);
    set(bigger);
  }

  /** Draw calls of the layer. */
  get drawCalls(): number {
    let n = 0;
    for (const p of Object.values(this.pieces)) if (p.mesh.count > 0) n++;
    for (const m of [this.foam, this.panes, this.lamps, this.runnerMesh]) if (m.count > 0) n++;
    return n;
  }

  /** The latest grid (tests). */
  get state(): PowerInfo | null {
    return this.info;
  }

  /** Turbine runners and how fast they turn (rad/s, 0 = idle), for tests. */
  get runnerSpeeds(): { id: number; speed: number }[] {
    return this.runners.map((r) => ({ id: r.id, speed: r.speed }));
  }

  /** Houses currently lit (tests). */
  get litHouses(): number {
    return this.glows.length;
  }

  setInfo(info: PowerInfo): void {
    this.info = info;
    this.layout();
  }

  setBuildings(list: readonly BuildingInfo[]): void {
    this.buildings = list;
    this.layoutGlows();
  }

  /** Season 0..4 (fractional): winter (3) glows a little more. */
  setSeason(season: number): void {
    const s = ((season % 4) + 4) % 4;
    this.winter = Math.max(0, 1 - Math.min(Math.abs(s - 3.2), 4 - Math.abs(s - 3.2)) / 1.4);
  }

  refreshHeights(): void {
    this.layout();
  }

  update(dt: number): void {
    this.time += Math.min(0.1, Math.max(0, dt)) * (this.gameSpeed > 0 ? 1 : 0.15);
    this.animateFoam();
    this.animateGlows();
    this.animateRunners(dt);
  }

  dispose(): void {
    for (const p of Object.values(this.pieces)) {
      p.mesh.geometry.dispose();
      p.mesh.dispose();
    }
    for (const m of [this.foam, this.panes, this.lamps, this.runnerMesh]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      m.dispose();
    }
    this.group.removeFromParent();
  }

  // ---------------------------------------------------------------------------

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

  /** An instance at world (x, y, z) (three.js units), turned by yaw about +y, scaled (sx, sy, sz). */
  private put(piece: Piece, x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number, roll = 0): void {
    this.ensure(piece, piece.n + 1);
    this.p.set(x, y, z);
    this.q.setFromEuler(new THREE.Euler(0, yaw, roll, 'YXZ'));
    this.s.set(sx, Math.max(1e-3, sy), sz);
    this.m.compose(this.p, this.q, this.s);
    piece.mesh.setMatrixAt(piece.n++, this.m);
  }

  private ground(cx: number, cy: number): number {
    return heightToY(this.heights.terrainAt(cx, cy));
  }

  private surface(cx: number, cy: number): number {
    return heightToY(this.heights.terrainAt(cx, cy) + this.heights.depthAt(cx, cy));
  }

  private layout(): void {
    for (const p of Object.values(this.pieces)) p.n = 0;
    this.foams = [];
    this.runners = [];
    const info = this.info;
    /** Where the wires attach, per node position "x,y". */
    const tops = new Map<string, { y: number; yaw: number }>();
    if (info) {
      for (const t of info.turbines) this.layoutTurbine(t, tops);
      for (const p of info.poles) {
        const g = this.ground(p.x, p.y);
        if (p.progress < 1) {
          this.put(this.pieces.pole, p.x + 0.5, g - 0.02, p.y + 0.5, 0, 1, Math.max(0.15, p.progress), 1);
          continue;
        }
        tops.set(`${p.x},${p.y}`, { y: g + POLE_TOP * this.poleScale, yaw: 0 });
      }
      for (const p of info.pumps) this.layoutPump(p, tops);
      // Poles turn their arms across the line (the mean direction of their wires).
      const dir = new Map<string, [number, number]>();
      const W = info.wires;
      for (let k = 0; k + 3 < W.length; k += 4) {
        const dx = W[k + 2]! - W[k]!;
        const dy = W[k + 3]! - W[k + 1]!;
        const l = Math.hypot(dx, dy) || 1;
        for (const key of [`${W[k]},${W[k + 1]}`, `${W[k + 2]},${W[k + 3]}`]) {
          const d = dir.get(key) ?? [0, 0];
          // Same sense for both ends, so a straight line's directions add up.
          const s = dx / l >= 0 ? 1 : -1;
          dir.set(key, [d[0] + (s * dx) / l, d[1] + (s * dy) / l]);
        }
      }
      for (const p of info.poles) {
        if (p.progress < 1) continue;
        const key = `${p.x},${p.y}`;
        const d = dir.get(key) ?? [1, 0];
        const yaw = -Math.atan2(d[1], d[0]);
        tops.set(key, { y: tops.get(key)!.y, yaw });
        this.put(this.pieces.pole, p.x + 0.5, this.ground(p.x, p.y) - 0.02, p.y + 0.5, yaw, this.poleScale, this.poleScale, this.poleScale);
      }
      if (this.anchors) for (const [k, v] of this.anchors) if (!tops.has(k)) tops.set(k, v);
      for (let k = 0; k + 3 < W.length; k += 4) {
        const a = tops.get(`${W[k]},${W[k + 1]}`);
        const b = tops.get(`${W[k + 2]},${W[k + 3]}`);
        if (a && b) this.layoutWire(W[k]!, W[k + 1]!, a, W[k + 2]!, W[k + 3]!, b);
      }
    }
    for (const p of Object.values(this.pieces)) {
      p.mesh.count = p.n;
      p.mesh.instanceMatrix.needsUpdate = true;
    }
    this.nodeTops = tops;
    this.layoutGlows();
  }

  private layoutTurbine(t: PowerInfo['turbines'][number], tops: Map<string, { y: number; yaw: number }>): void {
    const P = this.pieces;
    // Downstream: where the water goes now (standing still: the lower side).
    const toB = t.flow > 0 || (t.flow === 0 && this.surface(t.bx, t.by) <= this.surface(t.ax, t.ay));
    const ux = (toB ? t.bx - t.ax : t.ax - t.bx) / (Math.hypot(t.bx - t.ax, t.by - t.ay) || 1);
    const uy = (toB ? t.by - t.ay : t.ay - t.by) / (Math.hypot(t.bx - t.ax, t.by - t.ay) || 1);
    const dx = toB ? t.bx : t.ax;
    const dy = toB ? t.by : t.ay;
    const ix = toB ? t.ax : t.bx;
    const iy = toB ? t.ay : t.by;
    const yaw = -Math.atan2(uy, ux);
    const prog = Math.min(1, Math.max(0, t.progress));
    // The house stands at the foot of the wall, by the tailrace, on a stone plinth.
    const reach = Math.max(1, Math.hypot(dx - t.x, dy - t.y) - 0.55);
    const hx = t.x + ux * reach;
    const hy = t.y + uy * reach;
    const bed = this.ground(hx, hy);
    const water = this.surface(dx, dy);
    const base = Math.max(bed, water - 0.04);
    const crest = this.ground(t.x, t.y);
    if (base - bed > 0.01) this.put(P.plinth, hx + 0.5, bed - 0.05, hy + 0.5, yaw, 0.9, base - bed + 0.08, 0.8);
    this.put(P.house, hx + 0.5, base + 0.02, hy + 0.5, yaw, HOUSE, HOUSE * Math.max(0.12, prog), HOUSE);
    if (prog < 1) return;
    tops.set(`${t.x},${t.y}`, { y: base + 0.02 + 1.17 * HOUSE, yaw: yaw + Math.PI / 2 });
    // The penstock: from the intake's water over the crest, down to the house.
    const intake = Math.min(this.surface(ix, iy) - 0.08, crest);
    const sx = t.x - ux * 0.75;
    const sy = t.y - uy * 0.75;
    const len = Math.hypot(hx - ux * 0.3 - sx, hy - uy * 0.3 - sy);
    const y0 = intake;
    const y1 = base + 0.2;
    const midY = Math.max(crest + 0.06, (y0 + y1) / 2);
    // Two straight runs: up over the crest, and down to the house.
    const seg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
      const l = Math.hypot(bx - ax, by - ay, bz - az);
      const pitch = Math.atan2(by - ay, Math.hypot(bx - ax, bz - az));
      this.put(P.pipe, (ax + bx) / 2, (ay + by) / 2, (az + bz) / 2, yaw, l + 0.06, 0.15, 0.15, pitch);
    };
    const mx = t.x;
    const my = t.y;
    seg(sx + 0.5, y0, sy + 0.5, mx + 0.5, midY, my + 0.5);
    seg(mx + 0.5, midY, my + 0.5, hx - ux * 0.3 + 0.5, y1, hy - uy * 0.3 + 0.5);
    void len;
    // The runner on each side wall: it turns with the power, and stands still when the turbine idles.
    const speed = t.power > 0 ? Math.min(9, 1.5 + Math.sqrt(t.power / 1000) * 0.9) : 0;
    for (const side of [-1, 1]) {
      // Local z (across the house) in the world: (sin yaw, cos yaw).
      const ox = Math.sin(yaw) * 0.43 * HOUSE * side;
      const oz = Math.cos(yaw) * 0.43 * HOUSE * side;
      this.runners.push({ id: t.id, x: hx + 0.5 + ox, y: base + 0.02 + 0.3 * HOUSE, z: hy + 0.5 + oz, yaw, speed });
    }
    // Foam in the tailrace below the house while it runs.
    const q = Math.abs(t.flow);
    if (q > 0.05) {
      const s = Math.min(1.2, 0.35 + Math.sqrt(q) * 0.3);
      this.foams.push({ x: hx + ux * 0.5 + 0.5, z: hy + uy * 0.5 + 0.5, y: water, dx: ux, dz: uy, s, seed: t.id });
    }
  }

  private layoutPump(p: PowerInfo['pumps'][number], tops: Map<string, { y: number; yaw: number }>): void {
    const P = this.pieces;
    const prog = Math.min(1, Math.max(0, p.progress));
    const dx = p.ox - p.x;
    const dy = p.oy - p.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const yaw = -Math.atan2(uy, ux);
    const g = this.ground(p.hx, p.hy);
    this.put(P.pump, p.hx + 0.5, g - 0.02, p.hy + 0.5, yaw, 1, Math.max(0.12, prog), 1);
    if (prog < 1) return;
    tops.set(`${p.hx},${p.hy}`, { y: g + 1.03, yaw: yaw + Math.PI / 2 });
    // The pipe: from just under the inlet's surface, laid along the ground to the outlet.
    let prev: [number, number, number] = [p.x + 0.5, this.surface(p.x, p.y) - 0.06, p.y + 0.5];
    const steps = Math.max(2, Math.ceil(len * 1.5));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const cx = p.x + dx * t;
      const cy = p.y + dy * t;
      const y = Math.max(this.ground(cx, cy) + 0.06, k === steps ? this.ground(cx, cy) + 0.25 : -Infinity);
      const next: [number, number, number] = [cx + 0.5, y, cy + 0.5];
      const l = Math.hypot(next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]);
      const pitch = Math.atan2(next[1] - prev[1], Math.hypot(next[0] - prev[0], next[2] - prev[2]));
      this.put(P.pipe, (prev[0] + next[0]) / 2, (prev[1] + next[1]) / 2, (prev[2] + next[2]) / 2, yaw, l + 0.03, 0.07, 0.07, pitch);
      prev = next;
    }
    if (p.flow > 0.01) {
      // Water pouring from the spout.
      const gy = this.surface(p.ox, p.oy);
      this.put(P.spout, p.ox + 0.5 + ux * 0.05, gy - 0.02, p.oy + 0.5 + uy * 0.05, yaw, 0.06, prev[1] - gy + 0.02, 0.06);
      this.foams.push({ x: p.ox + 0.5 + ux * 0.1, z: p.oy + 0.5 + uy * 0.1, y: gy, dx: ux, dz: uy, s: 0.3, seed: p.id + 1000 });
    }
  }

  /** Two wires from arm end to arm end, sagging between the poles. */
  private layoutWire(ax: number, ay: number, a: { y: number; yaw: number }, bx: number, by: number, b: { y: number; yaw: number }): void {
    const P = this.pieces;
    const span = Math.hypot(bx - ax, by - ay);
    const sag = SAG * span + 0.03;
    for (const side of [-1, 1]) {
      // Arm ends: the arm runs along local z, i.e. across the wire for yaw = −atan2(dy, dx).
      const end = (x: number, y: number, t: { y: number; yaw: number }): THREE.Vector3 => {
        const nx = -Math.sin(-t.yaw);
        const nz = Math.cos(-t.yaw);
        return new THREE.Vector3(x + 0.5 + nx * ARM * side, t.y, y + 0.5 + nz * ARM * side);
      };
      const A = end(ax, ay, a);
      const B = end(bx, by, b);
      // Match the sides (the nearer arm ends pair up).
      const B2 = end(bx, by, b);
      const Bo = (() => {
        const nx = -Math.sin(-b.yaw);
        const nz = Math.cos(-b.yaw);
        return new THREE.Vector3(bx + 0.5 - nx * ARM * side, b.y, by + 0.5 - nz * ARM * side);
      })();
      const Bp = A.distanceTo(B2) <= A.distanceTo(Bo) ? B : Bo;
      let prev = A.clone();
      for (let k = 1; k <= SEGMENTS; k++) {
        const t = k / SEGMENTS;
        const cur = new THREE.Vector3().lerpVectors(A, Bp, t);
        cur.y -= 4 * sag * t * (1 - t);
        const l = prev.distanceTo(cur);
        const yaw = -Math.atan2(cur.z - prev.z, cur.x - prev.x);
        const pitch = Math.atan2(cur.y - prev.y, Math.hypot(cur.x - prev.x, cur.z - prev.z));
        this.put(P.wire, (prev.x + cur.x) / 2, (prev.y + cur.y) / 2, (prev.z + cur.z) / 2, yaw, l + 0.01, this.wireThick, this.wireThick, pitch);
        prev = cur;
      }
    }
  }

  /** Window panes, door lamps and light pools of the lit houses. */
  private layoutGlows(): void {
    this.glows = [];
    const lit = this.info?.lit ?? [];
    if (!lit.length) return;
    const level = new Map<number, number>();
    for (let k = 0; k + 1 < lit.length; k += 2) level.set(lit[k]!, lit[k + 1]!);
    for (const b of this.buildings) {
      if (b.kind !== 'house' || b.progress < 1) continue;
      const lv = level.get(b.id);
      if (lv === undefined || lv <= 0) continue;
      const sp = houseSpots(houseVariant(b.id));
      const foot = this.footHeight(b.x, b.y);
      const rot = b.rot;
      const c = Math.cos(rot);
      const s = Math.sin(rot);
      const toWorld = (lx: number, lz: number): [number, number] => [b.x + 0.5 + (lx * c + lz * s) * sp.scale, b.y + 0.5 + (-lx * s + lz * c) * sp.scale];
      const panes: THREE.Matrix4[] = [];
      for (const wdw of sp.windows) {
        const [wx, wz] = toWorld(wdw.x + wdw.ox * 0.035, wdw.z + wdw.oz * 0.035);
        // Facing out of the wall: the plane's normal is +x after rotateY(π/2)… i.e. its local +x.
        const yaw = Math.atan2(-wdw.oz, wdw.ox) + rot;
        this.q.setFromAxisAngle(this.up, yaw);
        this.p.set(wx, foot + (0.07 + PANE.y) * sp.vscale, wz);
        this.s.set(1, PANE.h * sp.vscale, PANE.w * sp.scale);
        panes.push(new THREE.Matrix4().compose(this.p, this.q, this.s));
      }
      // The lamp hangs on the wall beside the door; the pool of light lies in front.
      const d = sp.door;
      const [lx, lz] = toWorld(d.x + d.ox * 0.06 + d.oz * 0.3, d.z + d.oz * 0.06 - d.ox * 0.3);
      this.q.identity();
      this.p.set(lx, foot + 0.72 * sp.vscale, lz);
      this.s.setScalar(0.06);
      const lamp = new THREE.Matrix4().compose(this.p, this.q, this.s);
      this.glows.push({ house: b.id, level: lv, panes, lamp });
    }
  }

  private animateGlows(): void {
    const gl = this.glows;
    let np = 0;
    for (const g of gl) np += g.panes.length;
    this.grow(this.panes, np, (m) => (this.panes = m));
    this.grow(this.lamps, gl.length, (m) => (this.lamps = m));
    const t = this.time;
    const boost = 1 + 0.25 * this.winter;
    let k = 0;
    gl.forEach((g, j) => {
      // Short of power: dimmer, and now and then a flicker.
      let b = 0.35 + 0.65 * g.level;
      if (g.level < 0.95) {
        const n = Math.sin(t * 9.1 + g.house * 1.7) * Math.sin(t * 5.3 + g.house * 0.9);
        if (n > 0.55 - (1 - g.level) * 0.6) b *= 0.45;
      }
      b *= boost;
      // Warm light over the pane's own colour.
      this.c.setRGB(1.0 * b + 0.15, 0.78 * b + 0.12, 0.42 * b + 0.08);
      for (const m of g.panes) {
        this.panes.setMatrixAt(k, m);
        this.panes.setColorAt(k, this.c);
        k++;
      }
      this.lamps.setMatrixAt(j, g.lamp);
      this.c.setRGB(1.0 * b + 0.2, 0.86 * b + 0.15, 0.55 * b + 0.1);
      this.lamps.setColorAt(j, this.c);
    });
    for (const m of [this.panes, this.lamps]) {
      m.count = m === this.panes ? k : gl.length;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  private animateRunners(dt: number): void {
    const rs = this.runners;
    this.grow(this.runnerMesh, rs.length, (m) => (this.runnerMesh = m));
    const step = Math.min(0.1, Math.max(0, dt)) * (this.gameSpeed > 0 ? 1 : 0.15);
    const e = new THREE.Euler();
    rs.forEach((r, k) => {
      const a = ((this.angles.get(r.id) ?? 0) + r.speed * step) % (Math.PI * 2);
      // (Both sides of one turbine share an angle: advance it once.)
      if (k === 0 || rs[k - 1]!.id !== r.id) this.angles.set(r.id, a);
      e.set(0, r.yaw, a, 'YXZ');
      this.q.setFromEuler(e);
      this.p.set(r.x, r.y, r.z);
      this.s.setScalar(HOUSE);
      this.m.compose(this.p, this.q, this.s);
      this.runnerMesh.setMatrixAt(k, this.m);
    });
    this.runnerMesh.count = rs.length;
    this.runnerMesh.instanceMatrix.needsUpdate = true;
  }

  private animateFoam(): void {
    const n = this.foams.length * 5;
    this.grow(this.foam, n, (m) => (this.foam = m));
    const t = this.time;
    let k = 0;
    for (const f of this.foams) {
      for (let j = 0; j < 5; j++) {
        const u = (t * 0.9 + j / 5 + hash01(f.seed, j)) % 1;
        const along = u * 1.1 * f.s;
        const side = (hash01(f.seed * 13 + j, Math.floor(t * 0.9 + j / 5)) - 0.5) * 0.5 * f.s;
        this.p.set(f.x + f.dx * along - f.dz * side, f.y + 0.01, f.z + f.dz * along + f.dx * side);
        const sc = (0.12 + 0.14 * f.s) * Math.sin(Math.PI * Math.min(1, u * 1.15));
        this.s.set(sc * 1.3, sc * 0.35, sc);
        this.q.identity();
        this.m.compose(this.p, this.q, this.s);
        this.foam.setMatrixAt(k++, this.m);
      }
    }
    this.foam.count = k;
    this.foam.instanceMatrix.needsUpdate = true;
  }

  /** As BuildingsLayer: a bit below the footprint mean. */
  private footHeight(x: number, y: number): number {
    const h = this.heights;
    const c = h.terrainAt(x, y);
    let lo = c;
    for (const [dx, dy] of [
      [0.5, 0.5],
      [0.5, -0.5],
      [-0.5, 0.5],
      [-0.5, -0.5],
    ] as const)
      lo = Math.min(lo, h.terrainAt(x + dx, y + dy));
    return heightToY(c * 0.6 + lo * 0.4);
  }
}

