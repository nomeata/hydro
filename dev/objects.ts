/**
 * Dev check for render/objects: a procedural landscape with a lake, forest,
 * rocks and a bog, showing VegetationLayer + WandererLayer under an
 * orthographic isometric camera.
 *
 *   npx vite --port 5174   →   http://localhost:5174/dev/objects.html
 *   ?size=128|256  ?zoom=40 (visible cells across)  ?yaw=45  ?cx=&cy= (focus)
 *   ?lineup=1      all models side by side (scale/orientation check)
 *   ?season=2      autumn palette   ?detail=0|1|2
 */
import * as THREE from 'three';
import { heightToY, type HeightSampler } from '../src/render/coords';
import { fbm, perlin } from '../src/shared/noise';
import { SoilType } from '../src/sim/world';
import { VegetationLayer } from '../src/render/objects/vegetation';
import { WandererLayer } from '../src/render/objects/wanderers';
import { MODELS, type ModelName } from '../src/render/objects/manifest';
import { instantiateAnimated, modelLibrary } from '../src/render/objects/loader';

const params = new URLSearchParams(location.search);
if (params.has('raw')) (globalThis as { __hydroRawModels?: boolean }).__hydroRawModels = true;
const N = Number(params.get('size') ?? 128);
const SEED = Number(params.get('seed') ?? 7);

class FakeHeights implements HeightSampler {
  readonly terrain: Float32Array;
  readonly depth: Float32Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.terrain = new Float32Array(width * height);
    this.depth = new Float32Array(width * height);
  }
  terrainAt(cx: number, cy: number): number {
    const w = this.width;
    const x = Math.min(Math.max(cx, 0), w - 1);
    const y = Math.min(Math.max(cy, 0), this.height - 1);
    const x0 = Math.min(Math.floor(x), w - 2);
    const y0 = Math.min(Math.floor(y), this.height - 2);
    const fx = x - x0;
    const fy = y - y0;
    const t = this.terrain;
    const a = t[y0 * w + x0]!;
    const b = t[y0 * w + x0 + 1]!;
    const c = t[(y0 + 1) * w + x0]!;
    const d = t[(y0 + 1) * w + x0 + 1]!;
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }
  depthAt(cx: number, cy: number): number {
    const x = Math.min(Math.max(Math.round(cx), 0), this.width - 1);
    const y = Math.min(Math.max(Math.round(cy), 0), this.height - 1);
    return this.depth[y * this.width + x]!;
  }
}

function makeWorld(n: number): { heights: FakeHeights; look: Uint8Array } {
  const hs = new FakeHeights(n, n);
  const look = new Uint8Array(n * n * 4);
  const lakeX = n * 0.32;
  const lakeY = n * 0.62;
  const lakeR = n * 0.11;
  const lakeLevel = 4.0;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      let h = 8 + fbm(x / 40, y / 40, SEED, 4) * 9 + Math.max(0, (x + y) / n - 1.1) * 14;
      const dl = Math.hypot(x - lakeX, y - lakeY) / lakeR;
      if (dl < 1.6) h = h * smoothstep(0.6, 1.6, dl) + (2.0 + dl * 2.2) * (1 - smoothstep(0.6, 1.6, dl));
      hs.terrain[i] = h;
      hs.depth[i] = dl < 1.7 ? Math.max(0, lakeLevel - h) : 0;
    }
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const h = hs.terrain[i]!;
      const dl = Math.hypot(x - lakeX, y - lakeY) / lakeR;
      const forest = fbm(x / 22 + 5, y / 22, SEED + 1, 3);
      let soil = SoilType.Loam;
      if (h > 15.5) soil = SoilType.Rock;
      else if (h > 14) soil = SoilType.Gravel;
      else if (dl < 1.25 && dl > 0.9 && x < lakeX) soil = SoilType.Sand;
      else if (dl < 1.9 && x > lakeX + 4) soil = SoilType.Peat;
      else if (perlin(x / 18, y / 18, SEED + 3) > 0.25) soil = SoilType.Clay;
      let veg = 0.35 + 0.25 * fbm(x / 9, y / 9, SEED + 2, 2);
      if (forest > 0.05) veg = 0.6 + 0.5 * Math.min(1, (forest - 0.05) * 4);
      if (soil === SoilType.Rock) veg = 0.05;
      if (soil === SoilType.Gravel) veg = Math.min(veg, 0.3);
      if (soil === SoilType.Sand) veg = 0.15;
      const moist = Math.min(1, 0.35 + 0.6 * Math.max(0, 1 - (dl - 1) / 1.5));
      look[i * 4] = soil;
      look[i * 4 + 1] = Math.round(moist * 255);
      look[i * 4 + 2] = Math.round(Math.min(1, veg) * 255);
      look[i * 4 + 3] = 0;
    }
  return { heights: hs, look };
}

/** A spot near (px, py) with open meadow around it (for the village). */
function findMeadow(hs: FakeHeights, look: Uint8Array, px: number, py: number): [number, number] {
  const n = hs.width;
  let best: [number, number] = [px, py];
  let bestScore = -Infinity;
  for (let y = 10; y < n - 10; y += 3)
    for (let x = 10; x < n - 10; x += 3) {
      let open = 0;
      for (let dy = -8; dy <= 8; dy += 2)
        for (let dx = -8; dx <= 8; dx += 2) {
          const i = (y + dy) * n + x + dx;
          const v = look[i * 4 + 2]! / 255;
          if (v > 0.2 && v < 0.55 && hs.depth[i] === 0 && look[i * 4] !== SoilType.Rock) open++;
        }
      const score = open - Math.hypot(x - px, y - py) * 0.3;
      if (score > bestScore) {
        bestScore = score;
        best = [x, y];
      }
    }
  return best;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const SOIL_COLORS: Record<number, [number, number, number]> = {
  [SoilType.Rock]: [0.62, 0.62, 0.64],
  [SoilType.Gravel]: [0.66, 0.62, 0.54],
  [SoilType.Sand]: [0.88, 0.8, 0.58],
  [SoilType.Loam]: [0.56, 0.44, 0.3],
  [SoilType.Clay]: [0.62, 0.45, 0.33],
  [SoilType.Silt]: [0.55, 0.5, 0.38],
  [SoilType.Peat]: [0.36, 0.3, 0.2],
};

function groundMesh(hs: FakeHeights, look: Uint8Array): THREE.Mesh {
  const n = hs.width;
  const pos: number[] = [];
  const col: number[] = [];
  const c = new THREE.Color();
  const vtx = (x: number, y: number) => {
    pos.push(x + 0.5, heightToY(hs.terrain[y * n + x]!), y + 0.5);
    const i = (y * n + x) * 4;
    const base = SOIL_COLORS[look[i]!]!;
    const v = look[i + 2]! / 255;
    const g: [number, number, number] = v > 0.6 ? [0.36, 0.6, 0.3] : [0.52, 0.72, 0.36];
    const k = Math.min(1, v * 1.4);
    c.setRGB(base[0] * (1 - k) + g[0] * k, base[1] * (1 - k) + g[1] * k, base[2] * (1 - k) + g[2] * k, THREE.SRGBColorSpace);
    col.push(c.r, c.g, c.b);
  };
  for (let y = 0; y < n - 1; y++)
    for (let x = 0; x < n - 1; x++) {
      vtx(x, y);
      vtx(x, y + 1);
      vtx(x + 1, y);
      vtx(x + 1, y);
      vtx(x, y + 1);
      vtx(x + 1, y + 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
}

function waterMesh(hs: FakeHeights): THREE.Mesh {
  const n = hs.width;
  const pos: number[] = [];
  for (let y = 0; y < n - 1; y++)
    for (let x = 0; x < n - 1; x++) {
      const d = hs.depth[y * n + x]!;
      if (d <= 0) continue;
      const s = heightToY(hs.terrain[y * n + x]! + d);
      pos.push(x, s, y, x, s, y + 1, x + 1, s, y, x + 1, s, y, x, s, y + 1, x + 1, s, y + 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0x4aa3d8, transparent: true, opacity: 0.75 }));
}

async function lineup(scene: THREE.Scene): Promise<THREE.Vector3> {
  const lib = modelLibrary();
  const filter = params.get('lineup')!.split(',').filter((c) => c && c !== '1');
  const names = (Object.keys(MODELS) as ModelName[]).filter((n) => !filter.length || filter.includes(MODELS[n].category));
  const cols = Math.ceil(Math.sqrt(names.length));
  let i = 0;
  for (const name of names) {
    const e = MODELS[name];
    const x = (i % cols) * 1.2;
    const z = Math.floor(i / cols) * 1.2;
    i++;
    if ('animated' in e && e.animated) {
      const m = await lib.loadAnimated(name);
      const o = instantiateAnimated(m);
      o.position.set(x, 0, z);
      scene.add(o);
      const mixer = new THREE.AnimationMixer(o);
      const clip = m.clips.find((c) => c.name === (params.get('clip') ?? 'idle'));
      if (clip && !params.has('noanim')) mixer.clipAction(clip).play();
      mixer.update(0.3);
    } else {
      const m = await lib.loadStatic(name);
      const mesh = new THREE.Mesh(m.geometry, m.material);
      mesh.position.set(x, 0, z);
      scene.add(mesh);
    }
  }
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x8fbf6a }));
  floor.position.set(12, -0.001, 8);
  scene.add(floor);
  return new THREE.Vector3(((cols - 1) * 1.2) / 2, 0.3, (Math.floor((i - 1) / cols) * 1.2) / 2);
}

async function main(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.shadowMap.enabled = params.has('shadows');
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9cc7e0);
  scene.add(new THREE.HemisphereLight(0xe8f4ff, 0x7a6a4a, 1.7));
  const sun = new THREE.DirectionalLight(0xfff0dc, 2.4);
  sun.position.set(-40, 80, 30);
  scene.add(sun);
  scene.add(sun.target);

  const aspect = window.innerWidth / window.innerHeight;
  const zoom = Number(params.get('zoom') ?? 40);
  const camera = new THREE.OrthographicCamera((-zoom / 2) * aspect, (zoom / 2) * aspect, zoom / 2, -zoom / 2, -500, 500);
  const yaw = (Number(params.get('yaw') ?? 45) * Math.PI) / 180;
  const pitch = (Number(params.get('pitch') ?? 35) * Math.PI) / 180;

  let focus: THREE.Vector3;
  let wanderers: WandererLayer | null = null;
  let veg: VegetationLayer | null = null;
  if (params.has('lineup')) {
    focus = await lineup(scene);
  } else {
    const { heights, look } = makeWorld(N);
    scene.add(groundMesh(heights, look));
    scene.add(waterMesh(heights));
    veg = new VegetationLayer(scene, heights, look, N, N, SEED, { season: Number(params.get('season') ?? 1) });
    const meadow = findMeadow(heights, look, N * 0.45, N * 0.5);
    const cx = Number(params.get('cx') ?? meadow[0]);
    const cy = Number(params.get('cy') ?? meadow[1]);
    wanderers = new WandererLayer(scene, heights, { count: 10, seed: SEED, centerX: cx, centerY: cy, radius: 14, look });
    await Promise.all([veg.ready, wanderers.ready]);
    if (params.has('detail')) veg.setDetail(Number(params.get('detail')));
    focus = new THREE.Vector3(cx + 0.5, heightToY(heights.terrainAt(cx, cy)), cy + 0.5);
  }
  const dir = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
  camera.position.copy(focus).addScaledVector(dir, 100);
  camera.lookAt(focus);
  sun.target.position.copy(focus);
  sun.position.copy(focus).add(new THREE.Vector3(-40, 80, 30));

  const info = document.getElementById('info')!;
  let last = performance.now();
  const state = { ready: false, calls: 0, triangles: 0, meshes: veg?.meshCount ?? 0, instances: veg?.instanceCount ?? 0, agents: wanderers?.count ?? 0 };
  (window as unknown as { __objects: unknown }).__objects = state;
  // Optional fixed simulated time step for deterministic screenshots.
  const advance = Number(params.get('advance') ?? 0);
  if (advance > 0 && wanderers) for (let t = 0; t < advance; t += 1 / 30) wanderers.update(1 / 30);
  let frames = 0;
  const loop = (now: number) => {
    const dt = (now - last) / 1000;
    last = now;
    wanderers?.update(dt);
    renderer.render(scene, camera);
    state.calls = renderer.info.render.calls;
    state.triangles = renderer.info.render.triangles;
    state.meshes = veg?.meshCount ?? 0;
    info.textContent = `calls ${state.calls}  tris ${state.triangles}  veg meshes ${veg?.meshCount ?? 0}  instances ${veg?.instanceCount ?? 0}  agents ${wanderers?.count ?? 0}`;
    if (++frames > 3) state.ready = true;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

main().catch((e) => {
  console.error(e);
  document.getElementById('info')!.textContent = String(e);
});
