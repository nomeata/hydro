/**
 * Staged scenes for the welcome panels (ui/intro.ts): one small hand-built
 * world, independent of worldgen tuning, simulated by the real engine.
 *
 *  - 'water':   the river runs, a rain front drifts over.
 *  - 'shape':   the same land; the intro draws a trench from the river to a
 *               dry hollow (a real planTrench command) and the water follows.
 *  - 'village': a ready-made village by the pond (PeopleSystem.stage).
 *
 * Everything here is deterministic (no Math.random / Date). Coordinates are
 * cells; see SCENE_LAYOUT for the landmarks the UI points the camera at.
 */
import type { SceneId } from '../shared/protocol';
import { perlin } from '../shared/noise';
import { STEPS_PER_DAY } from './constants';
import { Simulation } from './sim';
import { SCENE_LAYOUT } from './sceneLayout';
import { CellFlag, FIELD_SPECS, SOIL_PROPS, SoilType, World } from './world';

export type { SceneId };
export { SCENE_LAYOUT };
export const SCENE_IDS: readonly SceneId[] = ['water', 'shape', 'village'];

export const SCENE_SIZE = 96;
const SEED = 20251;
/** Scenes start on an early-summer day (lush meadows, growing crops). */
export const SCENE_START_STEP = Math.round((12 + 2 - 0.3 + 0.2) * STEPS_PER_DAY);
/** Steps run when a scene is built, so the river is flowing when it appears. */
const SPINUP = 360;

/** River centreline, from the inflow (left edge) to the outlet (bottom edge). */
const RIVER = SCENE_LAYOUT.river;
/** Half width of the river channel (cells). */
const RIVER_HW = 2.3;
/** Bed height at the inflow (m) and its drop per cell along the river. */
const BED0 = 10;
const BED_SLOPE = 0.012;
/** Water depth of the river at the start (m). */
const RIVER_DEPTH = 0.9;
/** Inflow discharge (m³ per hydraulic second). */
const RIVER_Q = 22;

interface RiverSample {
  x: number;
  y: number;
  s: number;
}

function riverSamples(): RiverSample[] {
  const out: RiverSample[] = [];
  let s = 0;
  const P = RIVER;
  for (let k = 0; k + 1 < P.length; k++) {
    const p0 = P[Math.max(0, k - 1)]!;
    const p1 = P[k]!;
    const p2 = P[k + 1]!;
    const p3 = P[Math.min(P.length - 1, k + 2)]!;
    for (let t = 0; t < 1; t += 0.05) {
      // Catmull-Rom.
      const t2 = t * t;
      const t3 = t2 * t;
      const cr = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      const x = cr(p0[0], p1[0], p2[0], p3[0]);
      const y = cr(p0[1], p1[1], p2[1], p3[1]);
      const prev = out[out.length - 1];
      if (prev) s += Math.hypot(x - prev.x, y - prev.y);
      out.push({ x, y, s });
    }
  }
  return out;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Nearest river sample to a point: distance (cells) and position along the river. */
function nearestRiver(river: readonly RiverSample[], x: number, y: number): { d: number; s: number } {
  let best = Infinity;
  let s = 0;
  for (const p of river) {
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d < best) {
      best = d;
      s = p.s;
    }
  }
  return { d: Math.sqrt(best), s };
}

/** The scene land: meadow, river, pond, hollow and hill, with soils and plants. */
export function buildSceneWorld(): World {
  const N = SCENE_SIZE;
  const w = new World(N, N, SEED);
  const river = riverSamples();
  const L = SCENE_LAYOUT;
  const bed = (s: number) => BED0 - BED_SLOPE * s;
  // The hollow's floor is a metre below the river surface next to it; the
  // pond (not connected to the river) stands a little lower than the meadow.
  const hollowFloor = bed(nearestRiver(river, L.hollow.x, L.hollow.y).s) + RIVER_DEPTH - 1;
  const pondBed = bed(nearestRiver(river, L.pond.x, L.pond.y).s);
  const pondLevel = pondBed + 1.2;
  const z = new Float32Array(w.size);
  const dist = new Float32Array(w.size);
  const bedAt = new Float32Array(w.size);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = w.idx(x, y);
      const near = nearestRiver(river, x, y);
      const d = near.d;
      const b = bed(near.s);
      dist[i] = d;
      bedAt[i] = b;
      const vd = Math.hypot(x - L.village.x, y - L.village.y);
      // Rolling meadow, gentler where the village stands.
      const roll = (1.7 * perlin(x / 14, y / 14, SEED) + 0.3 * perlin(x / 5, y / 5, SEED + 7)) * (0.3 + 0.7 * smooth(8, 18, vd));
      // Banks rise ~1.5 m over two cells, then the meadow slopes gently up.
      let h: number;
      if (d < RIVER_HW) h = b - 0.45 * (1 - (d / RIVER_HW) ** 2);
      else h = b + Math.min(1.5, (d - RIVER_HW) * 0.9) + Math.max(0, d - RIVER_HW - 1.7) * 0.11 + roll * smooth(RIVER_HW + 1, RIVER_HW + 6, d);
      // Wooded hills at the back.
      const hd2 = (x - L.hill.x) ** 2 + (y - L.hill.y) ** 2;
      const hd3 = (x - L.hill2.x) ** 2 + (y - L.hill2.y) ** 2;
      h += (28 * Math.exp(-hd2 / (2 * 12 * 12)) + 20 * Math.exp(-hd3 / (2 * 10 * 10))) * smooth(RIVER_HW, RIVER_HW + 8, d);
      // Pond and hollow: bowls carved into the meadow.
      const pd = Math.hypot(x - L.pond.x, y - L.pond.y) / L.pond.r;
      h = Math.min(h, pondBed + 2.4 * pd ** 4);
      const hd = Math.hypot(x - L.hollow.x, y - L.hollow.y) / L.hollow.r;
      h = Math.min(h, hollowFloor + 2.6 * hd * hd);
      z[i] = h;
    }
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = w.idx(x, y);
      const d = dist[i]!;
      const h = z[i]!;
      const pd = Math.hypot(x - L.pond.x, y - L.pond.y);
      const nearPond = pd < L.pond.r + 1;
      const level = nearPond ? pondLevel : bedAt[i]! + RIVER_DEPTH;
      if ((d < RIVER_HW + 1 || nearPond) && level > h) w.water[i] = level - h;
      // Soils: sand in the channel, silt on the banks and by the pond, loam on the meadows.
      const st = d < RIVER_HW ? SoilType.Sand : d < RIVER_HW + 3 || pd < L.pond.r + 2.5 ? SoilType.Silt : SoilType.Loam;
      const soil = st === SoilType.Sand ? 1.5 : 2.6;
      w.soilType[i] = st;
      w.soil[i] = soil;
      w.bedrock[i] = h - soil;
      const hollow = Math.hypot(x - L.hollow.x, y - L.hollow.y) < L.hollow.r + 2;
      w.ground[i] = soil * SOIL_PROPS[st]!.porosity * (hollow ? 0.45 : d < RIVER_HW + 4 || pd < L.pond.r + 3 ? 0.85 : 0.6);
      w.fertility[i] = st === SoilType.Silt ? 0.85 : 0.7;
      // Forest on the hill, copses here and there, open meadows elsewhere.
      const hillF = Math.max(
        Math.exp(-((x - L.hill.x) ** 2 + (y - L.hill.y) ** 2) / (2 * 12 * 12)),
        Math.exp(-((x - L.hill2.x) ** 2 + (y - L.hill2.y) ** 2) / (2 * 10 * 10)),
      );
      const clump = perlin(x / 8, y / 8, SEED + 31);
      const open = Math.hypot(x - L.village.x, y - L.village.y) < 12 || hollow || Math.hypot(x - L.hollow.x, y - L.hollow.y) < 9;
      let veg = 0.42 + 0.12 * perlin(x / 4, y / 4, SEED + 5);
      veg = Math.max(veg, smooth(0.2, 0.55, hillF) * 0.95);
      if (!open) veg = Math.max(veg, smooth(0.12, 0.38, clump) * 0.92);
      if (d < RIVER_HW + 3 || (pd > L.pond.r && pd < L.pond.r + 2.5)) veg = Math.max(veg, 0.62);
      w.vegetation[i] = Math.min(1, veg);
      w.revealed[i] = 255;
    }
  // Boundaries: the river enters at x = 0 and leaves at the bottom edge.
  const inflowCells: number[] = [];
  for (let y = 0; y < N; y++) if (dist[w.idx(0, y)]! < RIVER_HW) inflowCells.push(w.idx(0, y));
  for (const i of inflowCells) w.inflow[i] = RIVER_Q / inflowCells.length;
  for (let x = 0; x < N; x++) {
    const i = w.idx(x, N - 1);
    if (dist[i]! < RIVER_HW + 1) w.flags[i] = w.flags[i]! | CellFlag.Outlet;
  }
  return w;
}

/** Dry cells on the pond's village-side shore next to water deep enough to fish, a few cells apart. */
function shoreSpots(w: World, n: number): [number, number][] {
  const P = SCENE_LAYOUT.pond;
  const cands: [number, number][] = [];
  for (let y = Math.floor(P.y - P.r - 2); y <= P.y + P.r + 2; y++)
    for (let x = Math.floor(P.x - P.r - 2); x <= P.x + P.r + 2; x++) {
      const i = w.idx(x, y);
      if (w.water[i]! > 0.05) continue;
      if ([i - 1, i + 1, i - w.width, i + w.width].some((j) => w.water[j]! >= 0.5)) cands.push([x, y]);
    }
  // Towards the village first (larger y), then left to right.
  cands.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const out: [number, number][] = [];
  for (const c of cands) if (out.length < n && out.every((o) => Math.hypot(o[0] - c[0], o[1] - c[1]) >= 4)) out.push(c);
  return out;
}

/** The village of the 'village' scene: a store, five houses, fields, ten people. */
function stageVillage(sim: Simulation): void {
  const v = SCENE_LAYOUT.village;
  const p = sim.people!;
  const R = Math.PI / 2;
  p.stage({
    x: v.x,
    y: v.y,
    food: 260,
    houses: [
      { x: v.x - 3, y: v.y - 2, rot: 0 },
      { x: v.x + 3, y: v.y - 3, rot: R },
      { x: v.x - 4, y: v.y + 2, rot: 2 * R },
      { x: v.x + 1, y: v.y + 4, rot: 3 * R },
      { x: v.x + 4, y: v.y + 1, rot: R },
      // Still being built: it rises while the panel is shown.
      { x: v.x - 1, y: v.y + 1, rot: 0, progress: 0.35 },
    ],
    fields: [
      { x0: v.x + 7, y0: v.y - 6, x1: v.x + 11, y1: v.y - 2, crop: 245 },
      { x0: v.x + 7, y0: v.y, x1: v.x + 11, y1: v.y + 3, crop: 160 },
      { x0: v.x + 2, y0: v.y + 7, x1: v.x + 7, y1: v.y + 10, crop: 236 },
      { x0: v.x - 9, y0: v.y - 1, x1: v.x - 7, y1: v.y + 6, crop: 90 },
      { x0: v.x - 5, y0: v.y + 7, x1: v.x - 1, y1: v.y + 10, crop: 200 },
    ],
    people: [
      { x: v.x + 8, y: v.y - 4, job: 'farmer' },
      { x: v.x + 10, y: v.y - 3, job: 'farmer' },
      { x: v.x + 9, y: v.y + 1, job: 'farmer' },
      { x: v.x + 4, y: v.y + 8, job: 'farmer' },
      { x: v.x + 6, y: v.y + 9, job: 'farmer' },
      { x: v.x - 8, y: v.y + 2, job: 'farmer' },
      { x: v.x - 3, y: v.y + 8, job: 'farmer' },
      { x: v.x - 1, y: v.y - 3, job: 'builder' },
      { x: v.x + 1, y: v.y - 4, job: 'builder' },
      ...shoreSpots(sim.world, 2).map(([x, y]) => ({ x, y, job: 'fisher' as const, fishing: 700 })),
    ],
  });
}

/**
 * Build a scene's simulation, spun up so the river flows. Deterministic:
 * the same id always gives the same state.
 */
export function buildScene(id: SceneId): Simulation {
  const w = buildSceneWorld();
  const v = SCENE_LAYOUT.village;
  const sim = new Simulation(w, SEED, { people: { startX: v.x, startY: v.y } });
  // Everything is known in the scenes.
  sim.fog = false;
  w.revealed.fill(255);
  sim.weather.autoFronts = false;
  sim.weather.state.windDir = 0.35;
  sim.step = SCENE_START_STEP;
  sim.people!.stage(null);
  sim.run(SPINUP);
  // The village appears on the flowing land, everyone at their place.
  if (id === 'village') stageVillage(sim);
  if (id === 'water') {
    // A rain front drifting in from the left, over the land in a few seconds.
    const f = SCENE_LAYOUT.front;
    sim.weather.addFront({ ...f, angle: Math.atan2(f.vy, f.vx) + Math.PI / 2, peak: 1.2 });
  }
  return sim;
}

/** An independent copy of a scene simulation (restarting a scene without rebuilding it). */
export function cloneScene(src: Simulation): Simulation {
  const w0 = src.world;
  const w = new World(w0.width, w0.height, w0.seed);
  for (const spec of FIELD_SPECS) w.field(spec.name).set(w0.field(spec.name) as never);
  const sim = new Simulation(w, src.seed);
  sim.setState(src.getState());
  sim.fog = src.fog;
  sim.weather.autoFronts = src.weather.autoFronts;
  return sim;
}
