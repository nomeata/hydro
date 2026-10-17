/**
 * Weather layer: soft low-poly clouds following the rain fronts, their
 * shadows on the ground (via shared uniforms read by the terrain and water
 * shaders), and rain streaks / snow flakes under intense fronts.
 *
 * Cost: clouds are one InstancedMesh drawn twice (depth pre-pass + colour
 * pass, so overlapping translucent puffs read as one soft shape); rain/snow
 * is one instanced draw whose positions are computed entirely on the GPU
 * (world-anchored tiling around the camera target, visible only inside
 * fronts). CPU work per frame is a few hundred instance matrices at most.
 */
import * as THREE from 'three';
import type { RainFront } from '../shared/protocol';
import type { CameraController } from './camera';

/** Max fronts passed to shaders (the sim rarely has more than 2–3 at once). */
export const MAX_FRONTS = 6;

export interface FrontUniforms {
  [k: string]: THREE.IUniform;
  /** Per front: centre x, z (three.js world), rx, ry (cells). */
  uFrontA: { value: THREE.Vector4[] };
  /** Per front: cos(angle), sin(angle), intensity, snow (0/1). */
  uFrontB: { value: THREE.Vector4[] };
  uFrontN: { value: number };
  /** Max darkening of the ground under a front. */
  uShadowStrength: { value: number };
}

export function createFrontUniforms(): FrontUniforms {
  return {
    uFrontA: { value: Array.from({ length: MAX_FRONTS }, () => new THREE.Vector4(0, 0, 1, 1)) },
    uFrontB: { value: Array.from({ length: MAX_FRONTS }, () => new THREE.Vector4(1, 0, 0, 0)) },
    uFrontN: { value: 0 },
    uShadowStrength: { value: 0.26 },
  };
}

const FRONT_PARS_GLSL = /* glsl */ `
#define MAX_FRONTS ${MAX_FRONTS}
uniform vec4 uFrontA[MAX_FRONTS];
uniform vec4 uFrontB[MAX_FRONTS];
uniform float uFrontN;
uniform float uShadowStrength;

// 1 at the front centre, 0 at and outside its ellipse.
float frontShape(int k, vec2 p) {
  vec4 A = uFrontA[k];
  vec4 B = uFrontB[k];
  vec2 d = p - A.xy;
  float u = (d.x * B.x + d.y * B.y) / A.z;
  float v = (-d.x * B.y + d.y * B.x) / A.w;
  return max(0.0, 1.0 - (u * u + v * v));
}
`;

/** GLSL: `float cloudShadow(vec2 worldXZ)` → multiplier ≤ 1 for ground colour. */
export const CLOUD_SHADOW_GLSL = /* glsl */ `
${FRONT_PARS_GLSL}
float cloudShadow(vec2 p) {
  float s = 0.0;
  for (int k = 0; k < MAX_FRONTS; k++) {
    if (float(k) >= uFrontN) break;
    float sh = frontShape(k, p);
    if (sh <= 0.0) continue;
    s += smoothstep(0.0, 0.45, sh) * min(uFrontB[k].z, 1.0);
  }
  // Dappled: broken cloud cover rather than a flat ellipse.
  float dap = 0.65 + 0.35 * sin(p.x * 0.09 + sin(p.y * 0.07) * 2.0) * sin(p.y * 0.11 + sin(p.x * 0.05) * 2.0);
  return 1.0 - uShadowStrength * min(s, 1.0) * dap;
}
`;

// ---------------------------------------------------------------------------
// Rain / snow.

const PRECIP_VERT = /* glsl */ `
${FRONT_PARS_GLSL}
uniform highp sampler2D uTerrain;
uniform vec2 uGrid;
uniform float uHeightScale;
uniform float uTime;
uniform vec2 uBoxOrigin;
uniform float uBoxSize;
uniform float uScale;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
attribute vec2 corner;
attribute vec4 aSeed;
varying vec2 vCorner;
varying float vAlpha;
varying float vSnow;

void main() {
  vec2 base = uBoxOrigin / uBoxSize;
  vec2 p = (floor(base - aSeed.xy) + 1.0 + aSeed.xy) * uBoxSize;
  float w = 0.0;
  float snow = 0.0;
  for (int k = 0; k < MAX_FRONTS; k++) {
    if (float(k) >= uFrontN) break;
    float s = frontShape(k, p);
    float d = smoothstep(0.0, 0.5, s) * clamp((uFrontB[k].z - 0.25) / 0.7, 0.0, 1.0);
    if (d > w) { w = d; snow = uFrontB[k].w; }
  }
  if (aSeed.w >= w * 0.6) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlpha = 0.0;
    return;
  }
  float fall = mix(6.0, 4.5, snow) * uScale;
  float speed = mix(16.0, 1.6, snow) * uScale;
  float t = fract(uTime * speed / fall + aSeed.z);
  if (snow > 0.5) p += 0.35 * uScale * vec2(sin(uTime * 1.3 + aSeed.z * 40.0), cos(uTime * 1.1 + aSeed.w * 30.0));
  ivec2 c = clamp(ivec2(floor(p - 0.5 + 0.5)), ivec2(0), ivec2(uGrid) - 1);
  float ground = texelFetch(uTerrain, c, 0).r * uHeightScale;
  vec3 pos = vec3(p.x, ground + fall * (1.0 - t), p.y);
  vec2 size = snow > 0.5 ? vec2(0.22, 0.22) * uScale : vec2(0.06, 0.9) * uScale;
  vec3 up = snow > 0.5 ? uCamUp : vec3(0.0, 1.0, 0.0);
  pos += uCamRight * corner.x * size.x + up * corner.y * size.y;
  vCorner = corner;
  vSnow = snow;
  vAlpha = smoothstep(0.0, 0.15, t) * (1.0 - smoothstep(0.85, 1.0, t));
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}
`;

const PRECIP_FRAG = /* glsl */ `
uniform float uOpacity;
varying vec2 vCorner;
varying float vAlpha;
varying float vSnow;
void main() {
  float a;
  vec3 col;
  if (vSnow > 0.5) {
    float r = length(vCorner) * 2.0;
    a = 1.0 - smoothstep(0.55, 1.0, r);
    col = vec3(1.0);
  } else {
    a = (1.0 - smoothstep(0.2, 0.5, abs(vCorner.x))) * smoothstep(-0.5, 0.3, vCorner.y);
    a *= 0.32;
    col = vec3(0.86, 0.92, 1.0);
  }
  a *= vAlpha * uOpacity;
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------

interface TrackedFront {
  key: string;
  seed: number;
  x: number;
  y: number;
  tx: number;
  ty: number;
  rx: number;
  ry: number;
  angle: number;
  intensity: number;
  targetIntensity: number;
  snow: boolean;
  seen: boolean;
}

/** One puff of a cloud, in front-local unit coordinates. */
interface Puff {
  u: number;
  v: number;
  /** Radius, vertical and along-`dir` offset relative to the front's puff size. */
  r: number;
  dy: number;
  off: number;
  /** Cluster orientation (radians). */
  dir: number;
}

const MAX_PUFFS = 420;
const DROPS = 1400;

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Visible extent (cells) along the shorter screen side: the zoom measure for weather and flow detail. */
export function shortSideCells(camera: CameraController): number {
  const c = camera.camera;
  const vh = camera.getCurrentState().viewHeight;
  const w = c.right - c.left;
  const h = c.top - c.bottom;
  return h > 0 && w > 0 ? vh * Math.min(1, w / h) : vh;
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export class WeatherLayer {
  readonly group = new THREE.Group();
  readonly uniforms: FrontUniforms;
  private readonly fronts = new Map<string, TrackedFront>();
  private readonly layouts = new Map<number, Puff[]>();
  private readonly puffGeo: THREE.BufferGeometry;
  private readonly puffMat: THREE.MeshLambertMaterial;
  private readonly puffDepthMat: THREE.MeshBasicMaterial;
  private readonly clouds: THREE.InstancedMesh;
  private readonly cloudsDepth: THREE.InstancedMesh;
  private readonly precipGeo: THREE.InstancedBufferGeometry;
  private readonly precipMat: THREE.ShaderMaterial;
  private readonly precip: THREE.Mesh;
  private cloudY = 30;
  private cloudScale = 1;
  private readonly cloudUniforms = {
    uCentreFade: { value: 1 },
    uViewport: { value: new THREE.Vector4(0, 0, 1, 1) },
    uCloudBase: { value: 30 },
  };
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly v = new THREE.Vector3();
  private readonly sc = new THREE.Vector3();
  private readonly col = new THREE.Color();
  /** Number of cloud puffs drawn last frame (for stats). */
  puffCount = 0;

  constructor(
    uniforms: FrontUniforms,
    terrainTex: THREE.Texture,
    private readonly width: number,
    private readonly height: number,
    heightScale: number,
  ) {
    this.uniforms = uniforms;
    this.group.name = 'weather';

    // Clouds.
    this.puffGeo = new THREE.IcosahedronGeometry(1, 1);
    this.puffMat = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      flatShading: true,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      depthFunc: THREE.LessEqualDepth,
      emissive: new THREE.Color(0x9aa6b8),
    });
    // Clouds thin out towards the middle of the screen (where the player is
    // looking) when zoomed in, so they frame the view instead of hiding it.
    const cu = this.cloudUniforms;
    this.puffMat.onBeforeCompile = (shader) => {
      shader.uniforms.uCentreFade = cu.uCentreFade;
      shader.uniforms.uViewport = cu.uViewport;
      shader.uniforms.uCloudBase = cu.uCloudBase;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vCloudY;')
        .replace(
          '#include <worldpos_vertex>',
          '#include <worldpos_vertex>\n  vCloudY = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).y;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uCentreFade;\nuniform vec4 uViewport;\nuniform float uCloudBase;\nvarying float vCloudY;',
        )
        // Flat-bottomed cartoon clouds.
        .replace('void main() {', 'void main() {\n  if (vCloudY < uCloudBase) discard;')
        .replace(
          '#include <opaque_fragment>',
          `#include <opaque_fragment>
  vec2 ndc = (gl_FragCoord.xy - uViewport.xy) / uViewport.zw * 2.0 - 1.0;
  float rc = length(ndc * vec2(1.0, 0.8));
  gl_FragColor.a *= mix(1.0, smoothstep(0.35, 1.05, rc), uCentreFade);`,
        );
    };
    this.puffMat.customProgramCacheKey = () => 'hydro-cloud-v2';
    this.puffDepthMat = new THREE.MeshBasicMaterial({ colorWrite: false, transparent: true });
    this.puffDepthMat.onBeforeCompile = (shader) => {
      shader.uniforms.uCloudBase = cu.uCloudBase;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vCloudY;')
        .replace(
          '#include <worldpos_vertex>',
          '#include <worldpos_vertex>\n  vCloudY = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).y;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uCloudBase;\nvarying float vCloudY;')
        .replace('void main() {', 'void main() {\n  if (vCloudY < uCloudBase) discard;');
    };
    this.puffDepthMat.customProgramCacheKey = () => 'hydro-cloud-depth-v2';
    this.clouds = new THREE.InstancedMesh(this.puffGeo, this.puffMat, MAX_PUFFS);
    this.clouds.name = 'clouds';
    this.clouds.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.clouds.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PUFFS * 3), 3);
    this.clouds.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.clouds.count = 0;
    this.clouds.frustumCulled = false;
    this.clouds.renderOrder = 41;
    this.cloudsDepth = new THREE.InstancedMesh(this.puffGeo, this.puffDepthMat, MAX_PUFFS);
    this.cloudsDepth.name = 'clouds-depth';
    this.cloudsDepth.instanceMatrix = this.clouds.instanceMatrix;
    this.cloudsDepth.count = 0;
    this.cloudsDepth.frustumCulled = false;
    this.cloudsDepth.renderOrder = 40;
    this.group.add(this.cloudsDepth, this.clouds);

    // Rain / snow.
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    g.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5]), 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = new Float32Array(DROPS * 4);
    const rnd = mulberry(4242);
    for (let i = 0; i < seeds.length; i++) seeds[i] = rnd();
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    g.instanceCount = DROPS;
    this.precipGeo = g;
    this.precipMat = new THREE.ShaderMaterial({
      uniforms: {
        ...uniforms,
        uTerrain: { value: terrainTex },
        uGrid: { value: new THREE.Vector2(width, height) },
        uHeightScale: { value: heightScale },
        uTime: { value: 0 },
        uBoxOrigin: { value: new THREE.Vector2() },
        uBoxSize: { value: 80 },
        uScale: { value: 1 },
        uCamRight: { value: new THREE.Vector3(1, 0, 0) },
        uCamUp: { value: new THREE.Vector3(0, 1, 0) },
        uOpacity: { value: 1 },
      },
      vertexShader: PRECIP_VERT,
      fragmentShader: PRECIP_FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.precip = new THREE.Mesh(g, this.precipMat);
    this.precip.name = 'precipitation';
    this.precip.frustumCulled = false;
    this.precip.renderOrder = 30;
    this.precip.visible = false;
    this.group.add(this.precip);
  }

  /** Height (three.js y) at which clouds float. */
  setCloudBase(y: number): void {
    this.cloudY = y;
    this.cloudUniforms.uCloudBase.value = y;
  }

  /** New fronts from a snapshot. Fronts are matched across snapshots by their (constant) size. */
  setFronts(fronts: readonly RainFront[]): void {
    for (const f of this.fronts.values()) f.seen = false;
    for (const f of fronts) {
      const key = `${f.rx.toFixed(4)}:${f.ry.toFixed(4)}`;
      let t = this.fronts.get(key);
      if (!t) {
        let h = 2166136261;
        for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
        t = {
          key,
          seed: h >>> 0,
          x: f.x,
          y: f.y,
          tx: f.x,
          ty: f.y,
          rx: f.rx,
          ry: f.ry,
          angle: f.angle,
          intensity: 0,
          targetIntensity: f.intensity,
          snow: f.snow,
          seen: true,
        };
        this.fronts.set(key, t);
      }
      t.tx = f.x;
      t.ty = f.y;
      t.angle = f.angle;
      t.targetIntensity = f.intensity;
      t.snow = f.snow;
      t.seen = true;
    }
    for (const t of this.fronts.values()) if (!t.seen) t.targetIntensity = 0;
  }

  /** Per-frame: smooth fronts, place clouds, update shader uniforms. */
  /** Drawing-buffer viewport in pixels (for the screen-centre fade). */
  setViewport(width: number, height: number): void {
    this.cloudUniforms.uViewport.value.set(0, 0, width, height);
  }

  update(dt: number, timeSec: number, camera: CameraController): void {
    const k = 1 - Math.exp(-dt * 3);
    const list: TrackedFront[] = [];
    for (const [key, t] of this.fronts) {
      // Large jumps (e.g. after runDays) snap; small ones glide.
      if (Math.hypot(t.tx - t.x, t.ty - t.y) > 20) {
        t.x = t.tx;
        t.y = t.ty;
      } else {
        t.x += (t.tx - t.x) * k;
        t.y += (t.ty - t.y) * k;
      }
      t.intensity += (t.targetIntensity - t.intensity) * (1 - Math.exp(-dt * 1.5));
      if (dt === 0) t.intensity = t.targetIntensity;
      if (!t.seen && t.intensity < 0.01) {
        this.fronts.delete(key);
        continue;
      }
      list.push(t);
    }
    list.sort((a, b) => b.intensity - a.intensity);

    // Shader uniforms (shadows, precipitation).
    const u = this.uniforms;
    const n = Math.min(MAX_FRONTS, list.length);
    for (let i = 0; i < n; i++) {
      const f = list[i]!;
      u.uFrontA.value[i]!.set(f.x + 0.5, f.y + 0.5, f.rx, f.ry);
      u.uFrontB.value[i]!.set(Math.cos(f.angle), Math.sin(f.angle), f.intensity, f.snow ? 1 : 0);
    }
    u.uFrontN.value = n;

    // Zoom-dependent visibility: clouds read as weather passing when zoomed
    // out and almost vanish when zoomed in so they never block the view.
    const st = camera.getCurrentState();
    const vh = shortSideCells(camera);
    // Zooming in, clouds dissolve into smaller, fainter puffs and then vanish.
    this.cloudScale = smooth(30, 95, vh);
    this.puffMat.opacity = 0.62 + 0.28 * smooth(50, 120, vh);
    this.cloudUniforms.uCentreFade.value = 1 - smooth(60, 120, vh);
    this.placeClouds(list.slice(0, n));

    // Precipitation box around the camera target.
    const pu = this.precipMat.uniforms;
    // Flakes live on a lattice anchored in world coordinates. The box size
    // and the flake scale are snapped to powers of two, so panning and
    // zooming within a level leave every flake where it is in the world
    // (continuous scaling made them drift and jump while zooming).
    const cw = camera.camera.right - camera.camera.left;
    const box = 2 ** Math.ceil(Math.log2(Math.max(st.viewHeight, cw) * 2.2));
    const scale = Math.max(1, box / 128) ** 0.8;
    pu.uBoxSize!.value = box;
    (pu.uBoxOrigin!.value as THREE.Vector2).set(st.x + 0.5 - box / 2, st.y + 0.5 - box / 2);
    pu.uScale!.value = scale;
    pu.uTime!.value = timeSec;
    pu.uOpacity!.value = 1 - 0.5 * smooth(60, 200, vh);
    const cam = camera.camera;
    (pu.uCamRight!.value as THREE.Vector3).setFromMatrixColumn(cam.matrixWorld, 0);
    (pu.uCamUp!.value as THREE.Vector3).setFromMatrixColumn(cam.matrixWorld, 1);
    let anyPrecip = false;
    for (let i = 0; i < n; i++) if (list[i]!.intensity > 0.25) anyPrecip = true;
    this.precip.visible = anyPrecip;
  }

  private layout(f: TrackedFront): Puff[] {
    let l = this.layouts.get(f.seed);
    if (l) return l;
    const rnd = mulberry(f.seed);
    l = [];
    const area = Math.PI * f.rx * f.ry;
    const clusters = Math.round(Math.min(16, Math.max(5, area / 900)));
    for (let c = 0; c < clusters; c++) {
      // Clusters spread over the ellipse, denser towards the middle.
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * 0.78;
      const cu = Math.cos(a) * r;
      const cv = Math.sin(a) * r;
      const big = 0.8 + rnd() * 0.5;
      const puffs = 3 + Math.floor(rnd() * 3);
      const dir = rnd() * Math.PI;
      for (let p = 0; p < puffs; p++) {
        const side = p === 0 ? 0 : (p % 2 === 1 ? 1 : -1) * (0.55 + 0.35 * Math.floor((p + 1) / 2) + rnd() * 0.2);
        l.push({
          u: cu,
          v: cv,
          r: big * (p === 0 ? 1 : 0.62 + rnd() * 0.2),
          dy: p === 0 ? 0.15 : -0.1 * rnd(),
          off: side * big,
          dir,
        });
      }
    }
    this.layouts.set(f.seed, l);
    if (this.layouts.size > 64) this.layouts.delete(this.layouts.keys().next().value!);
    return l;
  }

  private placeClouds(fronts: TrackedFront[]): void {
    let count = 0;
    const m = this.m;
    for (const f of fronts) {
      const grow = smooth(0.02, 0.35, f.intensity) * this.cloudScale;
      if (grow <= 0) continue;
      const ca = Math.cos(f.angle);
      const sa = Math.sin(f.angle);
      const puffSize = Math.min(10, Math.max(5, Math.sqrt(f.rx * f.ry) * 0.11));
      // Rain clouds are greyer; snow clouds pale.
      const grey = smooth(0.5, 1.2, f.intensity) * (f.snow ? 0.4 : 1);
      for (const p of this.layout(f)) {
        if (count >= MAX_PUFFS) break;
        const lu = p.u * f.rx;
        const lv = p.v * f.ry;
        const r = p.r * puffSize * grow;
        const ox = Math.cos(p.dir) * p.off * puffSize;
        const oz = Math.sin(p.dir) * p.off * puffSize;
        const wx = f.x + 0.5 + lu * ca - lv * sa + ox;
        const wz = f.y + 0.5 + lu * sa + lv * ca + oz;
        this.v.set(wx, this.cloudY + (0.12 + p.dy) * r, wz);
        this.e.set(0, p.dir + p.off, 0);
        this.q.setFromEuler(this.e);
        this.sc.set(r * 1.15, r * 0.7, r);
        m.compose(this.v, this.q, this.sc);
        this.clouds.setMatrixAt(count, m);
        this.col.setRGB(1 - 0.28 * grey, 1 - 0.25 * grey, 1 - 0.2 * grey);
        this.clouds.setColorAt(count, this.col);
        count++;
      }
    }
    this.clouds.count = count;
    this.cloudsDepth.count = count;
    this.puffCount = count;
    this.clouds.visible = this.cloudsDepth.visible = count > 0 && this.cloudScale > 0.02;
    this.clouds.instanceMatrix.needsUpdate = true;
    if (this.clouds.instanceColor) this.clouds.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.puffGeo.dispose();
    this.puffMat.dispose();
    this.puffDepthMat.dispose();
    this.precipGeo.dispose();
    this.precipMat.dispose();
    void this.width;
    void this.height;
  }
}
