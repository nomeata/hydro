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
import type { Pt, SceneId } from '../shared/protocol';
import { perlin } from '../shared/noise';
import { STEPS_PER_DAY } from './constants';
import { Simulation } from './sim';
import { SCENE_LAYOUT } from './sceneLayout';
import { CellFlag, FIELD_SPECS, SOIL_PROPS, SoilType, World } from './world';

export type { SceneId };
export { SCENE_LAYOUT };
export const SCENE_IDS: readonly SceneId[] = ['water', 'shape', 'village'];

export const SCENE_SIZE = 64;
const SEED = 20251;
/** Scenes start on an early-summer day (lush meadows, growing crops). */
export const SCENE_START_STEP = Math.round((12 + 2 - 0.3 + 0.2) * STEPS_PER_DAY);
/** Steps run when a scene is built, so the river is flowing when it appears. */
const SPINUP = 360;

/** River centreline, from the inflow (left edge) to the outlet (bottom edge). */
const RIVER: readonly Pt[] = [
  [-3, 17],
  [8, 19],
  [17, 25],
  [24, 33],
  [33, 37],
  [42, 44],
  [47, 55],
  [50, 67],
];
/** Half width of the river channel (cells). */
const RIVER_HW = 2.3;
/** Bed height at the inflow (m) and its drop per cell along the river. */
const BED0 = 10;
const BED_SLOPE = 0.012;
/** Water depth of the river at the start (m). */
const RIVER_DEPTH = 0.9;
/** Inflow discharge (m³ per hydraulic second). */
const RIVER_Q = 22;

/** Floor of the dry hollow (m): a metre below the river surface next to it. */
const HOLLOW_FLOOR = BED0 - BED_SLOPE * 45 - 0.1;

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

/** The scene land: meadow, river, pond, hollow and hill, with soils and plants. */
export function buildSceneWorld(): World {
  const N = SCENE_SIZE;
  const w = new World(N, N, SEED);
  const river = riverSamples();
  const L = SCENE_LAYOUT;
  const z = new Float32Array(w.size);
  const dist = new Float32Array(w.size);
  const bedAt = new Float32Array(w.size);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = w.idx(x, y);
      let best = Infinity;
      let s = 0;
      for (const p of river) {
        const d = (p.x - x) ** 2 + (p.y - y) ** 2;
        if (d < best) {
          best = d;
          s = p.s;
        }
      }
      const d = Math.sqrt(best);
      const bed = BED0 - BED_SLOPE * s;
      dist[i] = d;
      bedAt[i] = bed;
      const roll = 0.45 * perlin(x / 11, y / 11, SEED) + 0.2 * perlin(x / 5, y / 5, SEED + 7);
      // Banks rise ~1.5 m over two cells, then the meadow slopes gently up.
      let h: number;
      if (d < RIVER_HW) h = bed - 0.45 * (1 - (d / RIVER_HW) ** 2);
      else h = bed + Math.min(1.5, (d - RIVER_HW) * 0.9) + Math.max(0, d - RIVER_HW - 1.7) * 0.05 + roll * smooth(RIVER_HW + 1, RIVER_HW + 5, d);
      // A wooded hill at the back.
      const hd2 = (x - L.hill.x) ** 2 + (y - L.hill.y) ** 2;
      h += 7 * Math.exp(-hd2 / (2 * 9 * 9)) * smooth(RIVER_HW, RIVER_HW + 8, d);
      // Pond and hollow: bowls carved into the meadow.
      const pd = Math.hypot(x - L.pond.x, y - L.pond.y) / L.pond.r;
      h = Math.min(h, bed - 0.9 + 2.6 * pd * pd);
      const hd = Math.hypot(x - L.hollow.x, y - L.hollow.y) / L.hollow.r;
      h = Math.min(h, HOLLOW_FLOOR + 2.6 * hd * hd);
      z[i] = h;
    }
  // Riverside levels: the pond fills to the river's surface.
  const pondLevel = BED0 - BED_SLOPE * 30 + RIVER_DEPTH;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = w.idx(x, y);
      const d = dist[i]!;
      const h = z[i]!;
      const nearPond = Math.hypot(x - L.pond.x, y - L.pond.y) < L.pond.r + 1;
      const level = nearPond ? pondLevel : bedAt[i]! + RIVER_DEPTH;
      if ((d < RIVER_HW + 1 || nearPond) && level > h) w.water[i] = level - h;
      // Soils: sand in the channel, silt on the banks, loam on the meadows.
      const st = d < RIVER_HW ? SoilType.Sand : d < RIVER_HW + 3 || nearPond ? SoilType.Silt : SoilType.Loam;
      const soil = st === SoilType.Sand ? 1.5 : 2.6;
      w.soilType[i] = st;
      w.soil[i] = soil;
      w.bedrock[i] = h - soil;
      const hollow = Math.hypot(x - L.hollow.x, y - L.hollow.y) < L.hollow.r + 1.5;
      w.ground[i] = soil * SOIL_PROPS[st]!.porosity * (hollow ? 0.3 : d < RIVER_HW + 4 ? 0.85 : 0.6);
      w.fertility[i] = st === SoilType.Silt ? 0.85 : 0.7;
      // Forest on the hill and in a few clumps, open meadows elsewhere.
      const hillF = Math.exp(-((x - L.hill.x) ** 2 + (y - L.hill.y) ** 2) / (2 * 8 * 8));
      const clump = perlin(x / 7, y / 7, SEED + 31);
      const village = Math.hypot(x - L.village.x, y - L.village.y) < 13;
      let veg = 0.5 + 0.1 * perlin(x / 4, y / 4, SEED + 5);
      veg = Math.max(veg, smooth(0.25, 0.6, hillF) * 0.95);
      if (!village && !hollow) veg = Math.max(veg, smooth(0.25, 0.45, clump) * 0.9);
      if (d < RIVER_HW + 3) veg = Math.max(veg, 0.6);
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
      { x: v.x - 2, y: v.y - 9, job: 'fisher' },
      { x: v.x + 2, y: v.y - 8, job: 'fisher' },
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
  if (id === 'village') stageVillage(sim);
  else sim.people!.stage(null);
  sim.run(SPINUP);
  if (id === 'water') {
    // A rain front drifting in from the left, over the land in a few seconds.
    sim.weather.addFront({ x: -26, y: 22, rx: 26, ry: 13, angle: 0.35 + Math.PI / 2, vx: 0.19, vy: 0.07, life: 640, peak: 1.1 });
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
