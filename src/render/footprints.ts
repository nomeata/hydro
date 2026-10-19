/**
 * Footprints in the snow: every walking figure (people, children, herds)
 * leaves small prints on snowy ground. They fade over a game day or two,
 * faster while fresh snow falls, and vanish where the snow melts. Busy
 * routes become desire paths, which the terrain shader draws as trodden
 * slush instead (no prints are laid there).
 *
 * Client-side only: a ring buffer of at most `FOOTPRINT_CAP` prints, drawn
 * as one instanced quad mesh with a tiny shader. Time is a "fade clock" in
 * game days, advanced on the game clock (render/gameClock.ts), so pausing
 * freezes the prints.
 */
import * as THREE from 'three';
import { EntityAnim, EntityKind } from '../shared/protocol';
import { heightToY, type HeightSampler } from './coords';
import { lookFor } from './crowd/clips';
import type { Track } from './crowd/tracks';

/** Most prints alive at once (the oldest are reused first). */
export const FOOTPRINT_CAP = 3000;
/** Game days a print lasts on undisturbed snow. */
export const FOOTPRINT_LIFE_DAYS = 1.6;
/** Real seconds per game day at 1× (sim constants: 600 steps at 20 steps/s). */
const SECONDS_PER_DAY_1X = 30;
/** Look-texture snow byte from which prints are laid (the ground is mostly white). */
const SNOW_MIN = 110;
/** LandUse.Path in the fields texture (sim/world.ts). */
const LANDUSE_PATH = 4;

/** Print shapes (shader `aMeta.y`). */
export const enum PrintKind {
  Boot = 0,
  Hoof = 1,
  Paw = 2,
}

/**
 * Ring buffer of prints (pure, no three.js): position (cells), yaw, kind,
 * size and birth time on the fade clock (game days).
 */
export class FootprintBuffer {
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly yaw: Float32Array;
  readonly size: Float32Array;
  readonly kind: Uint8Array;
  readonly birth: Float64Array;
  /** Next slot to write. */
  head = 0;
  /** Prints ever spawned (count = min(spawned, capacity)). */
  spawned = 0;

  constructor(
    readonly capacity: number,
    readonly life = FOOTPRINT_LIFE_DAYS,
  ) {
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.yaw = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.kind = new Uint8Array(capacity);
    this.birth = new Float64Array(capacity).fill(-Infinity);
  }

  get count(): number {
    return Math.min(this.spawned, this.capacity);
  }

  /** Add a print; returns its slot (overwriting the oldest when full). */
  spawn(x: number, y: number, yaw: number, kind: PrintKind, size: number, now: number): number {
    const i = this.head;
    this.x[i] = x;
    this.y[i] = y;
    this.yaw[i] = yaw;
    this.kind[i] = kind;
    this.size[i] = size;
    this.birth[i] = now;
    this.head = (i + 1) % this.capacity;
    this.spawned++;
    return i;
  }

  /** Opacity 0..1 of slot `i` at fade-clock time `now` (same curve as the shader). */
  alpha(i: number, now: number): number {
    const age = (now - this.birth[i]!) / this.life;
    if (!(age >= 0) || age >= 1) return 0;
    // Crisp for a while, then softening away.
    return 1 - smoothstep(0.35, 1, age);
  }

  /** Prints still visible at `now`. */
  live(now: number): number {
    let n = 0;
    for (let i = 0; i < this.count; i++) if (this.alpha(i, now) > 0) n++;
    return n;
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** How a kind of walker prints: shape, size (cells), stride between prints (cells), side offset. */
export function printStyle(kind: number, variant: number): { kind: PrintKind; size: number; stride: number; side: number } | null {
  const s = lookFor(kind, variant).scale;
  switch (kind) {
    case EntityKind.Person:
    case EntityKind.Child:
      return { kind: PrintKind.Boot, size: 0.075 * s, stride: 0.16 * s, side: 0.045 * s };
    case EntityKind.Cow:
      return { kind: PrintKind.Hoof, size: 0.1, stride: 0.17, side: 0.07 };
    case EntityKind.Sheep:
    case EntityKind.Pig:
      return { kind: PrintKind.Hoof, size: 0.07 * s, stride: 0.12, side: 0.05 };
    case EntityKind.Dog:
      return { kind: PrintKind.Paw, size: 0.06, stride: 0.12, side: 0.035 };
    case EntityKind.Chick:
      return { kind: PrintKind.Paw, size: 0.035, stride: 0.06, side: 0.015 };
    default:
      return null;
  }
}

/** Per-track footstep state. */
interface Step {
  x: number;
  y: number;
  left: boolean;
}


const VERTEX = /* glsl */ `
attribute vec4 aPrint;
attribute vec4 aMeta;
uniform float uNow;
uniform float uLife;
uniform sampler2D uLook;
uniform vec2 uGrid;
varying vec2 vUv;
varying float vAlpha;
varying float vKind;
void main() {
  // Snow under the print (look alpha): gone with the snow.
  ivec2 c = clamp(ivec2(floor(aPrint.xz + 0.5)), ivec2(0), ivec2(uGrid) - 1);
  float snow = texelFetch(uLook, c, 0).a;
  float age = (uNow - aMeta.x) / uLife;
  float a = (age >= 0.0 && age < 1.0 ? 1.0 - smoothstep(0.35, 1.0, age) : 0.0) * smoothstep(0.25, 0.55, snow);
  vAlpha = a;
  vKind = aMeta.y;
  vUv = position.xz * 2.0;
  if (a <= 0.003) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float s = sin(aPrint.w);
  float co = cos(aPrint.w);
  vec2 p = position.xz * aMeta.z * vec2(1.0, 1.0);
  vec2 r = vec2(p.x * co + p.y * s, -p.x * s + p.y * co);
  vec3 world = vec3(aPrint.x + 0.5 + r.x, aPrint.y, aPrint.z + 0.5 + r.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uColour;
varying vec2 vUv;
varying float vAlpha;
varying float vKind;
void main() {
  // vUv in [-1, 1]; y along the walking direction.
  vec2 u = vUv;
  float d;
  if (vKind < 0.5) {
    // Boot: a narrow sole with a heel.
    float sole = length(vec2(u.x / 0.42, (u.y - 0.18) / 0.62));
    float heel = length(vec2(u.x / 0.36, (u.y + 0.62) / 0.3));
    d = min(sole, heel);
  } else if (vKind < 1.5) {
    // Hoof: two halves of a cloven hoof.
    vec2 q = vec2(abs(u.x) - 0.32, u.y);
    d = length(vec2(q.x / 0.26, q.y / 0.55));
  } else {
    // Paw / bird foot: a pad and toes.
    float pad = length(vec2(u.x / 0.38, (u.y + 0.25) / 0.32));
    vec2 t = vec2(abs(u.x), u.y - 0.45);
    float toes = min(length(vec2(t.x - 0.36, t.y) / 0.18), length(vec2(t.x, t.y - 0.1) / 0.18));
    d = min(pad, toes);
  }
  float m = 1.0 - smoothstep(0.75, 1.0, d);
  if (m * vAlpha < 0.01) discard;
  gl_FragColor = vec4(uColour, m * vAlpha * 0.6);
  #include <colorspace_fragment>
}
`;

/**
 * The footprint mesh: feeds the buffer from walking figures (`update`) and
 * keeps one instanced draw call.
 */
export class FootprintLayer {
  readonly buffer: FootprintBuffer;
  readonly mesh: THREE.Mesh;
  /** Prints laid so far and still visible on the fade clock (tests, tools). */
  get stats(): { spawned: number; live: number } {
    return { spawned: this.buffer.spawned, live: this.buffer.live(this.now) };
  }
  /** Fade clock in game days (advanced only while the game runs). */
  now = 0;
  /** 0..1: how hard snow is falling (fresh snow covers prints quickly). */
  snowfall = 0;
  private readonly steps = new WeakMap<Track, Step>();
  private readonly aPrint: THREE.InstancedBufferAttribute;
  private readonly aMeta: THREE.InstancedBufferAttribute;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private dirtyLo = Infinity;
  private dirtyHi = -1;

  constructor(
    private readonly heights: HeightSampler & { depthAt(x: number, y: number): number; readonly width: number; readonly height: number },
    look: THREE.Texture,
    /** Ground look bytes (RGBA per cell, A = snow cover) and land use (fields RGBA, R = LandUse). */
    private readonly ground: () => { look: Uint8Array; fields: Uint8Array | null },
    capacity = FOOTPRINT_CAP,
  ) {
    this.buffer = new FootprintBuffer(capacity);
    const g = new THREE.InstancedBufferGeometry();
    // A unit quad in the xz plane (±0.5), facing up.
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5]), 3));
    g.setIndex([0, 2, 1, 0, 3, 2]);
    this.aPrint = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.aMeta = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4).fill(-1e9), 4);
    this.aPrint.setUsage(THREE.DynamicDrawUsage);
    this.aMeta.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aPrint', this.aPrint);
    g.setAttribute('aMeta', this.aMeta);
    g.instanceCount = 0;
    this.geometry = g;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uNow: { value: 0 },
        uLife: { value: this.buffer.life },
        uLook: { value: look },
        uGrid: { value: new THREE.Vector2(heights.width, heights.height) },
        // A shaded dent in the snow: cool blue-grey.
        uColour: { value: new THREE.Color(0x8796b4) },
      },
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.name = 'footprints';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
  }

  /**
   * Advance the fade clock by `playDt` play seconds at `gameSpeed`, and lay
   * prints behind every walking track.
   */
  update(playDt: number, gameSpeed: number, tracks: Iterable<Track>): void {
    if (playDt > 0) this.now += ((playDt * Math.max(0, gameSpeed)) / SECONDS_PER_DAY_1X) * (1 + 6 * this.snowfall);
    const b = this.buffer;
    const { look, fields } = this.ground();
    const W = this.heights.width;
    const H = this.heights.height;
    for (const t of tracks) {
      let st = this.steps.get(t);
      if (!st) {
        st = { x: t.x, y: t.y, left: false };
        this.steps.set(t, st);
        continue;
      }
      const dx = t.x - st.x;
      const dy = t.y - st.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > 4) {
        // Jumped (teleport, snapshot gap): start afresh.
        st.x = t.x;
        st.y = t.y;
        continue;
      }
      if (t.anim !== EntityAnim.Walk && t.anim !== EntityAnim.Run && t.anim !== EntityAnim.Carry) continue;
      const style = printStyle(t.kind, t.variant);
      if (!style || d2 < style.stride * style.stride) continue;
      st.x = t.x;
      st.y = t.y;
      st.left = !st.left;
      const cx = Math.round(t.x);
      const cy = Math.round(t.y);
      if (cx < 0 || cy < 0 || cx >= W || cy >= H) continue;
      const ci = cy * W + cx;
      if (look[ci * 4 + 3]! < SNOW_MIN) continue;
      if (fields && fields[ci * 4] === LANDUSE_PATH) continue;
      if (this.heights.depthAt(t.x, t.y) > 0.01) continue;
      // Step sideways from the line of walking (left/right foot).
      const len = Math.sqrt(d2);
      const nx = -dy / len;
      const ny = dx / len;
      const off = st.left ? style.side : -style.side;
      const px = t.x + nx * off;
      const py = t.y + ny * off;
      const yaw = Math.atan2(dx, dy);
      const i = b.spawn(px, py, yaw, style.kind, style.size, this.now);
      const pa = this.aPrint.array as Float32Array;
      pa[i * 4] = px;
      pa[i * 4 + 1] = heightToY(this.heights.terrainAt(px, py)) + 0.012;
      pa[i * 4 + 2] = py;
      pa[i * 4 + 3] = yaw;
      const ma = this.aMeta.array as Float32Array;
      ma[i * 4] = this.now;
      ma[i * 4 + 1] = style.kind;
      ma[i * 4 + 2] = style.size * 2;
      if (i < this.dirtyLo) this.dirtyLo = i;
      if (i > this.dirtyHi) this.dirtyHi = i;
    }
    this.flush();
    this.material.uniforms.uNow!.value = this.now;
    this.geometry.instanceCount = b.count;
    this.mesh.visible = b.count > 0 && this.anyLive();
  }

  /** Some print is still visible on the fade clock (the newest fades last). */
  private anyLive(): boolean {
    const b = this.buffer;
    return b.alpha((b.head + b.capacity - 1) % b.capacity, this.now) > 0;
  }

  private flush(): void {
    if (this.dirtyHi < 0) return;
    const lo = this.dirtyLo;
    const n = this.dirtyHi - lo + 1;
    for (const a of [this.aPrint, this.aMeta]) {
      a.clearUpdateRanges();
      a.addUpdateRange(lo * 4, n * 4);
      a.needsUpdate = true;
    }
    this.dirtyLo = Infinity;
    this.dirtyHi = -1;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
