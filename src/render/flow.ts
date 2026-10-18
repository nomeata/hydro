/**
 * Flow particles: little foam flecks (comet-shaped: bright head, fading
 * tail, so the direction reads even in a still frame) and the occasional
 * leaf, drifting on the water surface along the snapshot velocity field.
 *
 * Advection runs on the CPU against a decoded copy of the velocity field;
 * particles spawn in flowing water inside (and a little around) the camera
 * view and die when the water gets shallow or still, or when their lifetime
 * ends. Rendering is one instanced draw of flat quads with per-instance
 * position / direction / params, so the GPU cost is a few thousand tiny
 * quads at most.
 */
import * as THREE from 'three';
import { VEL_SCALE } from '../shared/protocol';
import type { CameraController } from './camera';
import { shortSideCells } from './weather';
import { heightToY } from './coords';
import type { HeightField } from './heights';

export const MAX_FLOW_PARTICLES = 2600;

/** Speed (m/s) below which water counts as still (no flecks spawn). */
const MIN_SPEED = 0.18;
/** Depth (m) below which flecks fade out. */
const MIN_DEPTH = 0.04;
/**
 * Visual advection at 1× game speed: cells/s = VISUAL_K · v^VISUAL_EXP (v in
 * m/s). Sub-linear so that slow lowland rivers still visibly move.
 */
const VISUAL_K = 2.2;
const VISUAL_EXP = 0.7;
/** Target flecks per flowing cell at default zoom. */
const DENSITY = 0.8;

const VERT = /* glsl */ `
attribute vec2 corner;
attribute vec3 iPos;
attribute vec3 iDir;
attribute vec4 iParams;
varying vec2 vCorner;
varying vec4 vParams;
void main() {
  // iDir.xy = unit flow direction (world x/z), iDir.z = length; iParams = alpha, width, kind, seed.
  vec2 d = iDir.xy;
  vec2 n = vec2(-d.y, d.x);
  vec2 off = d * corner.x * iDir.z + n * corner.y * iParams.y;
  vec3 pos = iPos + vec3(off.x, 0.0, off.y);
  vCorner = corner;
  vParams = iParams;
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform vec3 uFoam;
uniform vec3 uLeafA;
uniform vec3 uLeafB;
varying vec2 vCorner;
varying vec4 vParams;
void main() {
  float a;
  vec3 col;
  float t = vCorner.x + 0.5;          // 0 tail .. 1 head
  float r = abs(vCorner.y) * 2.0;     // 0 centre .. 1 side
  if (vParams.z < 0.5) {
    // Foam comet: round head, tapering, fading tail.
    float w = mix(0.25, 1.0, smoothstep(0.0, 0.8, t));
    if (t > 0.8) w *= sqrt(max(0.0, 1.0 - pow((t - 0.8) / 0.2, 2.0)));
    a = (1.0 - smoothstep(w - 0.3, w, r)) * mix(0.1, 1.0, t * t);
    col = uFoam;
  } else {
    // Leaf: pointed ellipse with a darker midrib.
    float x = vCorner.x * 2.0;
    float w = 1.0 - x * x;
    a = 1.0 - smoothstep(w - 0.15, w, r);
    col = mix(uLeafA, uLeafB, fract(vParams.w * 7.31));
    col *= mix(0.75, 1.0, smoothstep(0.0, 0.18, r));
  }
  a *= vParams.x;
  if (a < 0.02) discard;
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export class FlowParticles {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly W: number;
  private readonly H: number;
  /** Decoded velocity (m/s), interleaved x/y. */
  private readonly vel: Float32Array;
  // Particle state (struct of arrays).
  private readonly px = new Float32Array(MAX_FLOW_PARTICLES);
  private readonly py = new Float32Array(MAX_FLOW_PARTICLES);
  private readonly age = new Float32Array(MAX_FLOW_PARTICLES);
  private readonly life = new Float32Array(MAX_FLOW_PARTICLES);
  private readonly kind = new Uint8Array(MAX_FLOW_PARTICLES);
  private readonly seed = new Float32Array(MAX_FLOW_PARTICLES);
  private readonly sdx = new Float32Array(MAX_FLOW_PARTICLES);
  private readonly sdy = new Float32Array(MAX_FLOW_PARTICLES);
  private n = 0;
  // Instance buffers.
  private readonly aPos: THREE.InstancedBufferAttribute;
  private readonly aDir: THREE.InstancedBufferAttribute;
  private readonly aParams: THREE.InstancedBufferAttribute;
  // Spawn candidates: flowing cells in the view box.
  private cand = new Int32Array(0);
  private candN = 0;
  private candDirty = true;
  private candTimer = 0;
  private box = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private rngState = 12345;
  private readonly lastCam = { x: 0, y: 0, vh: 0, yaw: 0 };
  private readonly tmp = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  /** Game speed (0 = paused); set from snapshot stats. */
  gameSpeed = 1;
  private renewUntil = -1;
  /** Fog of war (revealed 0..255 per cell, live): no flecks on unknown water. */
  revealed: Uint8Array | null = null;
  /** Particle size multiplier (zoom-dependent). */
  private sizeScale = 1;
  /** Desired particle count for the current view (for stats/tests). */
  target = 0;
  /** Live particle count (for stats/tests). */
  get count(): number {
    return this.n;
  }

  constructor(private readonly heights: HeightField) {
    this.W = heights.width;
    this.H = heights.height;
    this.vel = new Float32Array(this.W * this.H * 2);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    g.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5]), 2));
    g.setIndex([0, 2, 1, 0, 3, 2]); // facing up (+y)
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(MAX_FLOW_PARTICLES * 3), 3);
    this.aDir = new THREE.InstancedBufferAttribute(new Float32Array(MAX_FLOW_PARTICLES * 3), 3);
    this.aParams = new THREE.InstancedBufferAttribute(new Float32Array(MAX_FLOW_PARTICLES * 4), 4);
    for (const a of [this.aPos, this.aDir, this.aParams]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.aPos);
    g.setAttribute('iDir', this.aDir);
    g.setAttribute('iParams', this.aParams);
    g.instanceCount = 0;
    this.geo = g;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uFoam: { value: new THREE.Color(0.97, 0.99, 1.0) },
        uLeafA: { value: new THREE.Color(0x6aa83e) },
        uLeafB: { value: new THREE.Color(0x9cc24a) },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.name = 'flow-particles';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 11;
  }

  /** Decode a snapshot's velocity bytes. */
  setVelocity(v: Int8Array): void {
    const k = VEL_SCALE / 127;
    const out = this.vel;
    const n = Math.min(v.length, out.length);
    for (let i = 0; i < n; i++) out[i] = v[i]! * k;
    this.candDirty = true;
  }

  /** Speed of the water (m/s) at cell i of the latest snapshot. */
  speed(i: number): number {
    return Math.hypot(this.vel[2 * i] ?? 0, this.vel[2 * i + 1] ?? 0);
  }

  /** Leaf colours (season). */
  setLeafColours(a: THREE.ColorRepresentation, b: THREE.ColorRepresentation): void {
    (this.material.uniforms.uLeafA!.value as THREE.Color).set(a);
    (this.material.uniforms.uLeafB!.value as THREE.Color).set(b);
  }

  /** Foam colour (lighting). */
  setFoamColour(c: THREE.Color): void {
    (this.material.uniforms.uFoam!.value as THREE.Color).copy(c);
  }

  private rand(): number {
    let t = (this.rngState = (this.rngState + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Bilinear velocity (m/s) at fractional cell coords, ignoring dry cells. */
  private sampleVel(x: number, y: number, out: [number, number]): void {
    const W = this.W;
    const H = this.H;
    const xc = Math.min(Math.max(x, 0), W - 1.001);
    const yc = Math.min(Math.max(y, 0), H - 1.001);
    const x0 = Math.floor(xc);
    const y0 = Math.floor(yc);
    const fx = xc - x0;
    const fy = yc - y0;
    const v = this.vel;
    const i00 = y0 * W + x0;
    const i10 = i00 + 1;
    const i01 = i00 + W;
    const i11 = i01 + 1;
    const w00 = (1 - fx) * (1 - fy);
    const w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;
    out[0] = v[2 * i00]! * w00 + v[2 * i10]! * w10 + v[2 * i01]! * w01 + v[2 * i11]! * w11;
    out[1] = v[2 * i00 + 1]! * w00 + v[2 * i10 + 1]! * w10 + v[2 * i01 + 1]! * w01 + v[2 * i11 + 1]! * w11;
  }

  /** Water surface (m) at fractional cell coords: bilinear over wet corners. */
  private surfaceAt(x: number, y: number): number {
    const W = this.W;
    const H = this.H;
    const xc = Math.min(Math.max(x, 0), W - 1.001);
    const yc = Math.min(Math.max(y, 0), H - 1.001);
    const x0 = Math.floor(xc);
    const y0 = Math.floor(yc);
    const fx = xc - x0;
    const fy = yc - y0;
    const t = this.heights.terrain;
    const d = this.heights.depth;
    let s = 0;
    let ws = 0;
    let dry = 0;
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        const k = (y0 + j) * W + x0 + i;
        const w = (i ? fx : 1 - fx) * (j ? fy : 1 - fy) + 1e-4;
        if (d[k]! > 0.01) {
          s += (t[k]! + d[k]!) * w;
          ws += w;
        } else dry = Math.max(dry, t[k]!);
      }
    }
    return ws > 0 ? s / ws : dry;
  }

  /** Visible ground box (cells) from the camera frustum, intersected with the plane at the target height. */
  private viewBox(camera: CameraController): void {
    const cam = camera.camera;
    cam.updateMatrixWorld();
    const yPlane = camera.targetWorld(this.tmp).y;
    cam.getWorldDirection(this.dir);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const o = new THREE.Vector3();
    for (const [nx, ny] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      o.set(nx, ny, -1).unproject(cam);
      const dy = this.dir.y;
      const t = Math.abs(dy) > 1e-4 ? (yPlane - o.y) / dy : 0;
      const wx = o.x + this.dir.x * t - 0.5;
      const wz = o.z + this.dir.z * t - 0.5;
      x0 = Math.min(x0, wx);
      x1 = Math.max(x1, wx);
      y0 = Math.min(y0, wz);
      y1 = Math.max(y1, wz);
    }
    const m = 3;
    this.box.x0 = Math.max(0, Math.floor(x0 - m));
    this.box.y0 = Math.max(0, Math.floor(y0 - m));
    this.box.x1 = Math.min(this.W - 1, Math.ceil(x1 + m));
    this.box.y1 = Math.min(this.H - 1, Math.ceil(y1 + m));
  }

  private rebuildCandidates(): void {
    const { x0, y0, x1, y1 } = this.box;
    const W = this.W;
    const need = Math.max(0, (x1 - x0 + 1) * (y1 - y0 + 1));
    if (this.cand.length < need) this.cand = new Int32Array(need);
    const d = this.heights.depth;
    const v = this.vel;
    const rev = this.revealed;
    const min2 = MIN_SPEED * MIN_SPEED;
    // Zoomed far out the box is large: sample every other cell.
    const step = need > 40000 ? 2 : 1;
    let n = 0;
    for (let y = y0; y <= y1; y += step) {
      for (let x = x0; x <= x1; x += step) {
        const i = y * W + x;
        if (d[i]! < MIN_DEPTH * 2) continue;
        if (rev && rev[i]! < 200) continue;
        const vx = v[2 * i]!;
        const vy = v[2 * i + 1]!;
        if (vx * vx + vy * vy < min2) continue;
        this.cand[n++] = i;
      }
    }
    this.candN = n * step * step;
    this.candStep = step;
    this.candCount = n;
  }
  private candStep = 1;
  private candCount = 0;

  private spawn(i: number, warm: boolean): boolean {
    if (this.candCount === 0) return false;
    const W = this.W;
    // Pick a candidate cell; prefer faster water (rejection on speed).
    for (let tries = 0; tries < 4; tries++) {
      const c = this.cand[Math.floor(this.rand() * this.candCount)]!;
      const vx = this.vel[2 * c]!;
      const vy = this.vel[2 * c + 1]!;
      const sp = Math.hypot(vx, vy);
      if (this.rand() > 0.15 + 0.85 * smooth(MIN_SPEED, 0.8, sp)) continue;
      const x = (c % W) + (this.rand() - 0.5) * this.candStep;
      const y = Math.floor(c / W) + (this.rand() - 0.5) * this.candStep;
      this.px[i] = x;
      this.py[i] = y;
      this.life[i] = 3 + this.rand() * 4;
      this.age[i] = warm ? this.rand() * this.life[i]! * 0.8 : 0;
      this.kind[i] = this.rand() < 0.04 ? 1 : 0;
      this.seed[i] = this.rand();
      this.sdx[i] = vx / (sp || 1);
      this.sdy[i] = vy / (sp || 1);
      return true;
    }
    return false;
  }

  /** Advance and upload. `dt` is real seconds. */
  update(dt: number, camera: CameraController): void {
    const vh = shortSideCells(camera);
    this.sizeScale = Math.max(0.8, vh / 36) ** 0.75;
    // Rebuild spawn candidates on new snapshots, camera moves and periodically.
    const st = camera.getCurrentState();
    const moved =
      Math.abs(st.x - this.lastCam.x) + Math.abs(st.y - this.lastCam.y) > vh * 0.1 ||
      Math.abs(st.viewHeight - this.lastCam.vh) > vh * 0.1 ||
      Math.abs(st.yaw - this.lastCam.yaw) > 0.1;
    this.candTimer -= dt;
    if (this.candDirty || moved || this.candTimer <= 0) {
      this.lastCam.x = st.x;
      this.lastCam.y = st.y;
      this.lastCam.vh = st.viewHeight;
      this.lastCam.yaw = st.yaw;
      this.viewBox(camera);
      this.rebuildCandidates();
      this.candDirty = false;
      this.candTimer = 0.25;
    }
    const s = this.sizeScale;
    const target = Math.min(MAX_FLOW_PARTICLES, Math.round((this.candN * DENSITY) / (s * s)));
    this.target = target;

    // Motion scale: paused ⇒ frozen; faster game ⇒ somewhat faster drift.
    const gs = this.gameSpeed;
    const motion = gs <= 0 ? 0 : Math.min(2.5, Math.max(0.5, gs) ** 0.4);
    const adv = dt * motion * VISUAL_K;
    // While paused the picture holds still, but for a few seconds after a
    // camera move flecks renew slowly so the newly shown water fills in.
    // (Wall time: slow frames cap `dt`.)
    const wall = performance.now();
    if (moved || this.renewUntil < 0) this.renewUntil = wall + 3000;
    const ageRate = gs <= 0 ? (wall < this.renewUntil ? 0.25 : 0) : motion;
    const vtmp: [number, number] = [0, 0];
    const d = this.heights.depth;
    const W = this.W;
    const { x0, y0, x1, y1 } = this.box;
    const margin = 6;

    // Update and compact.
    let j = 0;
    for (let i = 0; i < this.n; i++) {
      let x = this.px[i]!;
      let y = this.py[i]!;
      this.sampleVel(x, y, vtmp);
      // Midpoint step for smoother curves.
      if (adv > 0) {
        const s0 = Math.hypot(vtmp[0], vtmp[1]);
        const g0 = s0 > 1e-4 ? adv * s0 ** (VISUAL_EXP - 1) : 0;
        const mx = x + vtmp[0] * g0 * 0.5;
        const my = y + vtmp[1] * g0 * 0.5;
        this.sampleVel(mx, my, vtmp);
        const s1 = Math.hypot(vtmp[0], vtmp[1]);
        const g1 = s1 > 1e-4 ? adv * s1 ** (VISUAL_EXP - 1) : 0;
        x += vtmp[0] * g1;
        y += vtmp[1] * g1;
      }
      const sp = Math.hypot(vtmp[0], vtmp[1]);
      let a = this.age[i]! + dt * ageRate;
      const ci = Math.min(this.H - 1, Math.max(0, Math.round(y))) * W + Math.min(W - 1, Math.max(0, Math.round(x)));
      const depth = d[ci]!;
      // Stranded or still (or drifting into the fog): shorten the life to fade out quickly.
      const fogged = this.revealed !== null && this.revealed[ci]! < 170;
      if ((depth < MIN_DEPTH || sp < MIN_SPEED * 0.5 || fogged) && this.life[i]! - a > 0.5) this.life[i] = a + 0.5;
      const outside = x < x0 - margin || x > x1 + margin || y < y0 - margin || y > y1 + margin;
      if (a >= this.life[i]! || outside || x < 0 || y < 0 || x > W - 1 || y > this.H - 1 || (j >= target && i >= target)) continue;
      // Smoothed direction (avoid jitter on noisy cells).
      if (sp > 1e-3) {
        const k = Math.min(1, dt * 6 + (adv === 0 ? 1 : 0));
        let dx = this.sdx[i]! + (vtmp[0] / sp - this.sdx[i]!) * k;
        let dy = this.sdy[i]! + (vtmp[1] / sp - this.sdy[i]!) * k;
        const l = Math.hypot(dx, dy) || 1;
        dx /= l;
        dy /= l;
        this.sdx[i] = dx;
        this.sdy[i] = dy;
      }
      this.px[j] = x;
      this.py[j] = y;
      this.age[j] = a;
      this.life[j] = this.life[i]!;
      this.kind[j] = this.kind[i]!;
      this.seed[j] = this.seed[i]!;
      this.sdx[j] = this.sdx[i]!;
      this.sdy[j] = this.sdy[i]!;
      j++;
    }
    this.n = j;

    // Spawn towards the target count (fast fill on first frames, warm ages).
    const warm = this.n < target * 0.5;
    let budget = Math.min(target - this.n, warm ? 600 : 80);
    let fails = 0;
    while (budget > 0 && this.n < MAX_FLOW_PARTICLES && fails < 50 && this.candCount > 0) {
      if (this.spawn(this.n, warm)) {
        this.n++;
        budget--;
      } else fails++;
    }

    // Upload.
    const P = this.aPos.array as Float32Array;
    const D = this.aDir.array as Float32Array;
    const Q = this.aParams.array as Float32Array;
    for (let i = 0; i < this.n; i++) {
      const x = this.px[i]!;
      const y = this.py[i]!;
      this.sampleVel(x, y, vtmp);
      const sp = Math.hypot(vtmp[0], vtmp[1]);
      const a = this.age[i]!;
      const life = this.life[i]!;
      const fade = smooth(0, 0.6, a) * (1 - smooth(life - 0.8, life, a));
      const leaf = this.kind[i] === 1;
      P[3 * i] = x + 0.5;
      P[3 * i + 1] = heightToY(this.surfaceAt(x, y)) + 0.14;
      P[3 * i + 2] = y + 0.5;
      D[3 * i] = this.sdx[i]!;
      D[3 * i + 1] = this.sdy[i]!;
      // Comet length grows with speed; leaves keep their size.
      D[3 * i + 2] = leaf ? 0.42 * s : s * Math.min(2.0, 0.5 + 0.5 * sp);
      Q[4 * i] = leaf ? fade : fade * (0.55 + 0.45 * smooth(MIN_SPEED, 0.9, sp));
      Q[4 * i + 1] = leaf ? 0.24 * s : 0.27 * s;
      Q[4 * i + 2] = leaf ? 1 : 0;
      Q[4 * i + 3] = this.seed[i]!;
    }
    this.geo.instanceCount = this.n;
    for (const at of [this.aPos, this.aDir, this.aParams]) {
      at.clearUpdateRanges();
      at.addUpdateRange(0, this.n * at.itemSize);
      at.needsUpdate = true;
    }
    this.mesh.visible = this.n > 0;
  }

  dispose(): void {
    this.geo.dispose();
    this.material.dispose();
  }
}
