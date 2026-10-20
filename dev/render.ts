/**
 * Renderer harness: a synthetic world (no sim) with hills, a mountain, a
 * meandering river, a lake, a bog, plan cells and animated fake water.
 *
 * URL params: size=256, shadows=1, sun=0.6 (time of day), season=1,
 * cam=x,y,yawDeg,pitchDeg,viewHeight, pr=pixelRatio, still=1 (no animation).
 * Keys: t toggles "tool mode" (left drag/one finger paints a dig preview).
 */
import { GameRenderer, type InitialData } from '../src/render/renderer';
import { attachCameraInput } from '../src/render/camera';
import { fbm, ridged } from '../src/shared/noise';
import type { Snapshot } from '../src/shared/protocol';
import { VEL_SCALE } from '../src/shared/protocol';

const params = new URLSearchParams(location.search);
const N = Number(params.get('size') ?? 256);
const W = N;
const H = N;
const S = N / 256; // feature scale

// ---------------------------------------------------------------------------
// Synthetic terrain.

const terrain = new Float32Array(W * H);
const look = new Uint8Array(W * H * 4);
const plan = new Float32Array(W * H).fill(NaN);
const riverSurf = new Float32Array(W * H).fill(-Infinity);
const flowDir = new Float32Array(W * H * 2);
const lakeMask = new Uint8Array(W * H);

const riverZ = (x: number): number => H * 0.55 + Math.sin(x / (34 * S)) * 22 * S + Math.sin(x / (13 * S)) * 5 * S;
const lakeX = W * 0.3;
const lakeY = H * 0.3;
const lakeR = 22 * S;
let LAKE_LEVEL = 14;

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const nx = x / (90 * S);
    const ny = y / (90 * S);
    let h = 30 - (x / W) * 12 + fbm(nx * 1.3, ny * 1.3, 11, 5) * 30 + fbm(nx * 5, ny * 5, 12, 3) * 4;
    // Mountain in the far corner.
    const md = Math.hypot(x - W * 0.82, y - H * 0.16) / (60 * S);
    h += Math.max(0, 1 - md) ** 1.3 * 110 + ridged(nx * 1.6, ny * 1.6, 5, 4) * 30 * Math.max(0, 1 - md * 0.7);
    // Lake basin.
    const ld = Math.hypot(x - lakeX, (y - lakeY) * 1.3) / lakeR;
    if (ld < 1.6) h = Math.min(h, h * smooth(0.6, 1.6, ld) + (LAKE_LEVEL - 5 + ld * 4) * (1 - smooth(0.6, 1.6, ld)));
    // River channel, flowing +x and downhill.
    const rz = riverZ(x);
    const dist = Math.abs(y - rz);
    const bed = 12 - (x / W) * 9;
    const width = (3.2 + 1.5 * Math.sin(x / (21 * S))) * S;
    if (dist < width * 4) {
      const bank = bed + Math.max(0, dist - width) * 1.3 + (dist < width ? -0.6 * (1 - (dist / width) ** 2) : 0);
      const blend = smooth(width * 2.5, width * 4, dist);
      h = Math.min(h, bank * (1 - blend) + h * blend);
      riverSurf[i] = bed + 1.6;
      // Rapids: steeper section.
      const fast = x > W * 0.62 && x < W * 0.72 ? 1.6 : 1;
      const dzdx = (riverZ(x + 1) - riverZ(x - 1)) / 2;
      const l = Math.hypot(1, dzdx);
      flowDir[i * 2] = (1.4 * fast) / l;
      flowDir[i * 2 + 1] = (1.4 * fast * dzdx) / l;
    }
    terrain[i] = h;
  }
}
// Lake mask; the level sits just below the lowest point of the basin rim.
let rim = Infinity;
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const ld = Math.hypot(x - lakeX, (y - lakeY) * 1.3) / lakeR;
    if (ld < 1.6) lakeMask[y * W + x] = 1;
    if (ld > 1.45 && ld < 1.6) rim = Math.min(rim, terrain[y * W + x]!);
  }
LAKE_LEVEL = Math.min(rim - 0.6, LAKE_LEVEL + 6);

// Bog: a shallow peat hollow.
const bogX = W * 0.18;
const bogY = H * 0.78;

// Look: soil type, moisture, vegetation, snow.
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const h = terrain[i]!;
    const gx = (terrain[i + (x < W - 1 ? 1 : 0)]! - terrain[i - (x > 0 ? 1 : 0)]!) / 10;
    const gy = (terrain[i + (y < H - 1 ? W : 0)]! - terrain[i - (y > 0 ? W : 0)]!) / 10;
    const slope = Math.hypot(gx, gy);
    const rd = Math.abs(y - riverZ(x));
    const ld = Math.hypot(x - lakeX, (y - lakeY) * 1.3) / lakeR;
    const bd = Math.hypot(x - bogX, y - bogY) / (18 * S);
    const n = fbm(x / (25 * S), y / (25 * S), 77, 3);
    const n2 = fbm(x / (40 * S), y / (40 * S), 99, 3);
    let soil = 3; // loam
    let moist = 0.25 + 0.15 * n;
    let veg = 0.6 + 0.3 * n2;
    if (n2 > 0.35) veg = 0.85 + 0.1 * n; // forest
    if (rd < 9 * S) {
      soil = 5; // silt floodplain
      moist = 0.6;
      veg = 0.55;
    }
    if (rd < 4.5 * S) {
      soil = rd < 2.5 * S ? 1 : 2; // gravel bed, sandy banks
      moist = 0.8;
      veg = 0.05;
    }
    if (ld < 1.25) {
      soil = ld < 1.05 ? 2 : 3;
      moist = 0.7;
      veg = ld < 1.05 ? 0.1 : 0.5;
    }
    if (bd < 1) {
      soil = 6; // peat
      moist = 0.9;
      veg = 0.5 + 0.2 * n;
    }
    if (n < -0.45 && rd > 12) {
      soil = 4; // clay patch
      veg = 0.15;
    }
    if (n > 0.55 && rd > 12 && ld > 1.4) {
      soil = 2; // dry sandy heath
      moist = 0.08;
      veg = 0.3;
    }
    if (h > 80 || slope > 0.9) {
      soil = 0; // rock
      veg = Math.max(0, 0.3 - (h - 80) / 20);
      moist = 0.15;
    } else if (h > 70) {
      soil = 1;
      veg *= 0.5;
    }
    const snow = smooth(105, 115, h + n * 6);
    look[i * 4] = soil;
    look[i * 4 + 1] = clamp255(moist);
    look[i * 4 + 2] = clamp255(veg);
    look[i * 4 + 3] = clamp255(snow);
  }
}

// Plans: a trench from the lake towards the river (dig), a dike (raise), a levelled pad.
for (let k = 0; k <= 60 * S; k++) {
  const px = lakeX + lakeR * 0.9 + k;
  const py = lakeY + k * 0.9;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const x = Math.round(px + dx);
      const y = Math.round(py + dy);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      plan[y * W + x] = terrain[y * W + x]! - 2.5;
    }
}
for (let k = 0; k < 40 * S; k++) {
  const x = Math.round(W * 0.5 + k);
  const y = Math.round(riverZ(W * 0.5) - 10 * S);
  for (let d = 0; d < 2; d++) if (y + d < H) plan[(y + d) * W + x] = terrain[(y + d) * W + x]! + 3;
}
for (let y = Math.round(H * 0.8); y < H * 0.8 + 10 * S; y++)
  for (let x = Math.round(W * 0.55); x < W * 0.55 + 14 * S; x++) plan[y * W + x] = terrain[Math.round(H * 0.8) * W + Math.round(W * 0.55)]!;

// ---------------------------------------------------------------------------
// Fake water.

const depth = new Float32Array(W * H);
const vel = new Int8Array(W * H * 2);
function computeWater(t: number): void {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const h = terrain[i]!;
      let d = 0;
      let vx = 0;
      let vy = 0;
      const rs = riverSurf[i]!;
      if (rs > -Infinity) {
        const wave = 0.35 * Math.sin(t * 0.8 - x / (15 * S));
        d = Math.max(0, rs + wave - h);
        if (d > 0) {
          vx = flowDir[i * 2]! * (0.8 + 0.25 * Math.sin(t + x * 0.1));
          vy = flowDir[i * 2 + 1]!;
        }
      }
      if (lakeMask[i]) {
        const lvl = LAKE_LEVEL + 0.25 * Math.sin(t * 0.3);
        const dl = lvl - h;
        if (dl > d) {
          d = dl;
          vx = 0.15 * Math.sin(y * 0.1 + t * 0.2);
          vy = 0.15 * Math.cos(x * 0.1 + t * 0.2);
        }
      }
      // Bog puddles.
      const bd = Math.hypot(x - bogX, y - bogY) / (18 * S);
      if (bd < 0.8) d = Math.max(d, 0.18 * (0.5 + 0.5 * Math.sin(x * 0.7) * Math.cos(y * 0.6)) - 0.06);
      depth[i] = Math.max(0, d);
      vel[i * 2] = Math.max(-127, Math.min(127, Math.round((vx / VEL_SCALE) * 127)));
      vel[i * 2 + 1] = Math.max(-127, Math.min(127, Math.round((vy / VEL_SCALE) * 127)));
    }
  }
}

// Fake builders: every snapshot, lower one trench cell a little towards its plan,
// sending the changed row band (exercises the row-upload path).
const planCells: number[] = [];
for (let i = 0; i < W * H; i++) if (plan[i]! < terrain[i]! - 0.05) planCells.push(i);
let buildIdx = 0;
function buildStep(): Snapshot['terrain'] {
  if (planCells.length === 0) return undefined;
  let y0 = H;
  let y1 = 0;
  for (let k = 0; k < 40; k++) {
    const i = planCells[buildIdx++ % planCells.length]!;
    terrain[i] = Math.max(plan[i]!, terrain[i]! - 0.4);
    const y = Math.floor(i / W);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y + 1);
  }
  return { y0, y1, data: terrain.slice(y0 * W, y1 * W) };
}

function snapshot(t: number): Snapshot {
  computeWater(t);
  const tr = still ? undefined : buildStep();
  return {
    ...(tr ? { terrain: tr } : {}),
    time: { step: 0, day: 0, year: 0, season: 1, dayOfSeason: 0, yearFrac: 0.3, timeOfDay: 0.6 },
    climate: { temperature: 18, windDir: 0, windSpeed: 1, fronts: [] },
    stats: { speedRequested: 1, speedAchieved: 1, msPerStep: 0, surfaceWater: 0, outflowPerDay: 0 },
    poolId: 0,
    depth,
    vel,
  };
}

// ---------------------------------------------------------------------------

const canvas = document.getElementById('view') as HTMLCanvasElement;
const data: InitialData = {
  info: { seed: 1, width: W, height: H, cellSize: 5, startX: W * 0.42, startY: H * 0.48 },
  terrain,
  look,
  plan,
};
const pr = params.get('pr');
const renderer = new GameRenderer(canvas, data, {
  shadows: params.get('shadows') === '1',
  smoothTerrain: params.get('smooth') === '1',
  ...(pr ? { pixelRatio: Number(pr) } : {}),
});
renderer.setSun(Number(params.get('sun') ?? 0.6), Number(params.get('season') ?? 1));
const cam = params.get('cam');
if (cam) {
  const [x, y, yaw, pitch, vh] = cam.split(',').map(Number);
  renderer.camera.setState({
    ...(Number.isFinite(x) ? { x } : {}),
    ...(Number.isFinite(y) ? { y } : {}),
    ...(Number.isFinite(yaw) ? { yaw: (yaw! * Math.PI) / 180 } : {}),
    ...(Number.isFinite(pitch) ? { pitch: (pitch! * Math.PI) / 180 } : {}),
    ...(Number.isFinite(vh) ? { viewHeight: vh } : {}),
  });
}
const input = attachCameraInput(canvas, renderer.camera, {
  onGestureStart: () => {
    painting = false;
  },
});
addEventListener('resize', () => renderer.resize());

// Tool mode: paint a dig preview with left mouse / one finger.
const preview = new Float32Array(W * H).fill(NaN);
let toolMode = false;
let painting = false;
const paint = (e: PointerEvent): void => {
  const p = renderer.pick(e.clientX, e.clientY);
  if (!p) return;
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) {
      const x = Math.round(p.x) + dx;
      const y = Math.round(p.y) + dy;
      if (x >= 0 && y >= 0 && x < W && y < H && dx * dx + dy * dy <= 5) preview[y * W + x] = terrain[y * W + x]! - 2;
    }
  renderer.setPreviewPlan(preview);
};
canvas.addEventListener('pointerdown', (e) => {
  if (!toolMode || (e.pointerType === 'mouse' && e.button !== 0)) return;
  painting = true;
  paint(e);
});
canvas.addEventListener('pointermove', (e) => {
  if (painting) paint(e);
  const p = renderer.pick(e.clientX, e.clientY);
  lastPick = p ? `${p.x.toFixed(1)}, ${p.y.toFixed(1)}` : '–';
});
canvas.addEventListener('pointerup', () => (painting = false));
addEventListener('keydown', (e) => {
  if (e.key === 't') {
    toolMode = !toolMode;
    input.setPrimaryPointerEnabled(!toolMode);
  }
  if (e.key === 'c') {
    preview.fill(NaN);
    renderer.setPreviewPlan(null);
  }
});

const still = params.get('still') === '1';
const t0 = performance.now();
let simT = 0;
renderer.applySnapshot(snapshot(0));
setInterval(() => {
  if (still) return;
  simT = (performance.now() - t0) / 1000;
  renderer.applySnapshot(snapshot(simT));
}, 100);

const hud = document.getElementById('hud')!;
let lastPick = '–';
let frames = 0;
let fpsT = performance.now();
let fps = 0;
let frameCount = 0;
function loop(now: number): void {
  renderer.frame(now);
  frames++;
  frameCount++;
  if (now - fpsT > 500) {
    fps = (frames * 1000) / (now - fpsT);
    frames = 0;
    fpsT = now;
    const info = renderer.gl.info.render;
    hud.textContent = `${fps.toFixed(0)} fps · ${info.calls} calls · ${(info.triangles / 1000).toFixed(0)}k tris · pick ${lastPick}${toolMode ? ' · TOOL' : ''}`;
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

(window as unknown as { __hydro: unknown }).__hydro = {
  renderer,
  get frames() {
    return frameCount;
  },
};

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function clamp255(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}
