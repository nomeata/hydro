/**
 * Staged scenes for the welcome panels (ui/intro.ts): one small hand-built
 * world, independent of worldgen tuning, simulated by the real engine.
 *
 *  - 'water':   the river runs, a rain front drifts over.
 *  - 'shape':   the same land; the intro digs a channel from the river to a
 *               dry hollow with the Dig brush (real sculpt commands) and the
 *               water follows.
 *  - 'village': a ready-made village by the pond (PeopleSystem.stage).
 *  - 'weir':    the tool card for the weir: low summer water; a weir across
 *               the river (built at once) holds a pool behind it.
 *  - 'gate':    the tool card for the sluice gate: a full reservoir above
 *               dry fields; a villager walks over and opens the gate, the
 *               canal fills and the fields green (structures/gatekeeper.ts).
 *  - 'wheel':   the tool card for the water wheel: dry fields on a terrace
 *               high above a fast river; a wheel (built) lifts water into a
 *               trench across the terrace (structures/wheel.ts).
 *  - 'turbine': the tool card for the turbine: the weir card's weir with a
 *               turbine in it (built), a hamlet on the bank whose cottages
 *               light up (power/grid.ts).
 *  - 'poles':   the tool card for the power line: the turbine card's weir
 *               and turbine, and the village by the pond far from it; a
 *               line of poles goes up from the turbine to the village and
 *               its cottages light up.
 *  - 'pump':    the tool card for the electric pump: the gate card's walled
 *               basin above the river, a turbine on a low weir in the river,
 *               an electric pump lifting river water into the basin on the
 *               spare power, and a turbine in the basin's wall that gives it
 *               back when the cottages want more (pumped storage).
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
export const SCENE_IDS: readonly SceneId[] = ['water', 'shape', 'village', 'weir', 'gate', 'wheel', 'turbine', 'poles', 'pump'];

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
function nearestRiver(river: readonly RiverSample[], x: number, y: number): { d: number; s: number; x: number } {
  let best = Infinity;
  let s = 0;
  let px = 0;
  for (const p of river) {
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d < best) {
      best = d;
      s = p.s;
      px = p.x;
    }
  }
  return { d: Math.sqrt(best), s, x: px };
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

/** Let the spirit crew finish every plan and structure at once (staging). */
function buildNow(sim: Simulation): void {
  for (let k = 0; k < 200 && (sim.crew.pending > 0 || sim.structures.pending || sim.power.pending); k++) {
    sim.crew.work(sim.world, 100, 1e9, (i) => sim.markTerrainDirty(i));
    sim.structures.crewWork(1, 1e9);
    sim.power.crewWork(1);
  }
  sim.lookDirty = true;
  sim.planDirty = true;
}

/** The weir card: low water, and a finished weir holding a pool. */
function stageWeir(sim: Simulation): void {
  sim.command({ type: 'planWeir', points: SCENE_LAYOUT.weir, width: 2, height: 1.6 });
  buildNow(sim);
}

/** The turbine card: the weir (built) with a turbine in it, and a hamlet on the bank. */
function stageTurbine(sim: Simulation): void {
  const T = SCENE_LAYOUT.turbine;
  sim.command({ type: 'planWeir', points: SCENE_LAYOUT.weir, width: 2, height: 2.4 });
  buildNow(sim);
  sim.command({ type: 'placeTurbine', points: [T.turbine] });
  buildNow(sim);
  const R = Math.PI / 2;
  sim.people!.stage({
    x: T.village.x,
    y: T.village.y,
    food: 260,
    houses: T.houses.map(([x, y], k) => ({ x, y, rot: (k % 4) * R })),
    fields: [],
    people: [
      { x: T.village.x + 1, y: T.village.y + 1, job: 'builder' },
      { x: T.village.x - 2, y: T.village.y, job: 'builder' },
    ],
  });
}

/** The power line card: the weir and its turbine (built), the village by the pond, and a line of poles (going up). */
function stagePoles(sim: Simulation): void {
  sim.command({ type: 'planWeir', points: SCENE_LAYOUT.weir, width: 2, height: 2.4 });
  buildNow(sim);
  sim.command({ type: 'placeTurbine', points: [SCENE_LAYOUT.turbine.turbine] });
  buildNow(sim);
  stageVillage(sim);
  sim.command({ type: 'placePoles', points: SCENE_LAYOUT.poles });
}

/** The pump card: weir and turbine in the river, the pump up into the basin, the basin's turbine, poles, a village. */
function stagePump(sim: Simulation): void {
  const P = SCENE_LAYOUT.pump;
  sim.command({ type: 'planWeir', points: P.weir, width: 2, height: P.weirHeight });
  buildNow(sim);
  sim.command({ type: 'placeTurbine', points: [P.turbine] });
  sim.command({ type: 'placeTurbine', points: [P.storage] });
  sim.command({ type: 'placePump', points: P.pump });
  buildNow(sim);
  const v = P.village;
  const R = Math.PI / 2;
  sim.people!.stage({
    x: v.x,
    y: v.y,
    food: 260,
    houses: P.houses.map(([x, y], k) => ({ x, y, rot: (k % 4) * R })),
    fields: [],
    people: [
      { x: v.x + 1, y: v.y - 2, job: 'builder' },
      { x: v.x - 1, y: v.y + 2, job: 'builder' },
    ],
  });
  for (const line of P.poles) sim.command({ type: 'placePoles', points: line });
  buildNow(sim);
}

/** The gate card's land: a walled reservoir, a canal to the river, dry fields (before the simulation starts). */
function carveGate(w: World): void {
  const G = SCENE_LAYOUT.gate;
  const { x0, y0, x1, y1 } = G.pond;
  const ring = 14.8;
  const floor = 12.4;
  const level = 13.7;
  const set = (i: number, h: number) => {
    w.bedrock[i] = h - w.soil[i]!;
  };
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const i = w.idx(x, y);
      const edge = x === x0 || x === x1 || y === y0 || y === y1;
      if (edge) set(i, Math.max(w.terrain(i), ring));
      else {
        set(i, Math.min(w.terrain(i), floor));
        w.water[i] = level - w.terrain(i);
      }
      w.vegetation[i] = Math.min(w.vegetation[i]!, edge ? 0.5 : 0.1);
    }
  // The canal: from the gate down to the river, its floor falling evenly
  // and at least 1.7 m below the land beside it.
  const gy = G.gate.y;
  const top = 12.3;
  for (let x = G.canalEnd; x < x0; x++) {
    const t = (x0 - 1 - x) / (x0 - 1 - G.canalEnd);
    let bank = Infinity;
    for (const y of [gy - 2, gy + 2]) bank = Math.min(bank, w.terrain(w.idx(x, y)));
    for (let y = gy - 1; y <= gy + 1; y++) {
      const i = w.idx(x, y);
      const h = Math.min(top - t * 2.6, bank - 1.7);
      if (w.terrain(i) > h) set(i, h);
      w.vegetation[i] = Math.min(w.vegetation[i]!, 0.25);
    }
    // Low banks along it, so the release stays in the canal.
    const floor = Math.min(top - t * 2.6, bank - 1.7);
    if (x < x0 - 1 && x > G.canalEnd + 1)
      for (const y of [gy - 2, gy + 2]) {
        const i = w.idx(x, y);
        set(i, Math.max(w.terrain(i), floor + 2.3));
      }
  }
  // Dry land around (a dry summer on the terrace).
  for (let y = y0 - 8; y <= y1 + 14; y++)
    for (let x = G.canalEnd + 3; x < x0; x++) {
      const i = w.idx(x, y);
      if (w.water[i]! > 0) continue;
      w.ground[i] = w.soil[i]! * SOIL_PROPS[w.soilType[i]!]!.porosity * 0.12;
      w.soilType[i] = SoilType.Loam;
      w.vegetation[i] = Math.min(w.vegetation[i]!, 0.3);
    }
}

/** The gate card: the gate (built), and a small village with dry fields below it. */
function stageGate(sim: Simulation): void {
  const G = SCENE_LAYOUT.gate;
  const v = G.village;
  const gy = G.gate.y;
  sim.command({ type: 'placeGate', points: [[G.gate.x, gy]], width: 1, height: 0 });
  buildNow(sim);
  const R = Math.PI / 2;
  sim.people!.stage({
    x: v.x,
    y: v.y,
    food: 260,
    houses: [
      { x: v.x - 3, y: v.y - 1, rot: 0 },
      { x: v.x + 3, y: v.y - 2, rot: R },
      { x: v.x + 1, y: v.y + 3, rot: 2 * R },
      { x: v.x - 4, y: v.y + 3, rot: 3 * R },
    ],
    fields: [
      { x0: 68, y0: gy - 5, x1: 78, y1: gy - 2, crop: 120 },
      { x0: 68, y0: gy + 2, x1: 78, y1: gy + 6, crop: 120 },
    ],
    people: [
      { x: v.x + 1, y: v.y - 4, job: 'builder' },
      { x: v.x - 1, y: v.y + 1, job: 'builder' },
      { x: 70, y: gy - 3, job: 'farmer' },
      { x: 75, y: gy + 4, job: 'farmer' },
      { x: 72, y: gy + 5, job: 'farmer' },
    ],
  });
}

/** The wheel card's cells: the wheel in the river on row L.wheel.y, and its head cell on the bank. */
export function wheelCells(w: World): { x: number; hx: number } {
  const y = SCENE_LAYOUT.wheel.y;
  const river = riverSamples();
  let c = 0;
  let best = Infinity;
  for (const p of river)
    if (Math.abs(p.y - y) < best) {
      best = Math.abs(p.y - y);
      c = p.x;
    }
  const x = Math.round(c + 1.2);
  let hx = x + 1;
  while (hx < w.width - 1 && nearestRiver(river, hx, y).d < RIVER_HW + 0.7) hx++;
  return { x, hx };
}

/** The wheel card's land: a dry terrace above the river's east bank, a trench across it (before the simulation starts). */
function carveWheel(w: World): void {
  const L = SCENE_LAYOUT.wheel;
  const river = riverSamples();
  const { hx } = wheelCells(w);
  const near = nearestRiver(river, hx, L.y);
  const terrace = BED0 - BED_SLOPE * near.s + RIVER_DEPTH + L.lift;
  const set = (i: number, h: number) => {
    w.bedrock[i] = h - w.soil[i]!;
  };
  for (let y = 66; y < w.height; y++)
    for (let x = 0; x < w.width; x++) {
      const i = w.idx(x, y);
      const r = nearestRiver(river, x, y);
      if (r.d < RIVER_HW + 0.7 || x < r.x) continue;
      // The terrace rises out of the river bank and falls gently away from it (and into the meadow at its north end).
      const t = terrace - 0.006 * (x - hx) - Math.max(0, 70 - y) * 1.2;
      set(i, Math.max(w.terrain(i), t));
      w.water[i] = 0;
      w.soilType[i] = SoilType.Loam;
      w.ground[i] = w.soil[i]! * SOIL_PROPS[SoilType.Loam]!.porosity * (y === L.y ? 0.7 : 0.12);
      w.vegetation[i] = Math.min(w.vegetation[i]!, 0.3);
    }
  // The trench: half a metre deep, falling evenly to its end.
  for (let x = hx + 1; x <= L.trenchEnd; x++) {
    const i = w.idx(x, L.y);
    set(i, w.terrain(i) - 0.55 - 0.004 * (x - hx));
    w.vegetation[i] = 0.1;
    w.flags[i] = w.flags[i]! | CellFlag.Canal;
  }
}

/** The wheel card: the wheel (built) and a small village whose fields are dry. */
function stageWheel(sim: Simulation): void {
  const L = SCENE_LAYOUT.wheel;
  const v = L.village;
  const { x, hx } = wheelCells(sim.world);
  sim.command({ type: 'placeWheel', points: [[x, L.y], [hx, L.y]] });
  buildNow(sim);
  const R = Math.PI / 2;
  sim.people!.stage({
    x: v.x,
    y: v.y,
    food: 260,
    houses: [
      { x: v.x - 3, y: v.y - 1, rot: 0 },
      { x: v.x + 3, y: v.y - 2, rot: R },
      { x: v.x + 1, y: v.y + 3, rot: 2 * R },
    ],
    fields: [
      { x0: hx + 3, y0: L.y - 4, x1: L.trenchEnd - 1, y1: L.y - 2, crop: 110 },
      { x0: hx + 3, y0: L.y + 2, x1: L.trenchEnd - 1, y1: L.y + 5, crop: 110 },
    ],
    people: [
      { x: v.x - 1, y: v.y + 1, job: 'builder' },
      { x: hx + 5, y: L.y - 3, job: 'farmer' },
      { x: hx + 9, y: L.y + 3, job: 'farmer' },
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
  if (id === 'gate' || id === 'pump') carveGate(w);
  if (id === 'wheel') carveWheel(w);
  // The weir and turbine cards show the low water of a dry summer.
  if (id === 'weir' || id === 'turbine' || id === 'poles') for (let i = 0; i < w.size; i++) w.inflow[i]! *= 0.35;
  const sim = new Simulation(w, SEED, { people: { startX: v.x, startY: v.y } });
  // Everything is known in the scenes.
  sim.fog = false;
  w.revealed.fill(255);
  sim.weather.autoFronts = false;
  // A steady river: the staged scenes don't follow the river seasons.
  sim.climate.seasonal = false;
  sim.weather.state.windDir = 0.35;
  sim.step = SCENE_START_STEP;
  sim.people!.stage(null);
  sim.run(SPINUP);
  // The village appears on the flowing land, everyone at their place.
  if (id === 'village') stageVillage(sim);
  if (id === 'weir') stageWeir(sim);
  if (id === 'wheel') stageWheel(sim);
  if (id === 'pump') {
    stagePump(sim);
    sim.run(300);
  }
  if (id === 'poles') {
    stagePoles(sim);
    sim.run(600);
    // The line goes up while the card is open.
    for (const p of sim.power.poles) p.progress = 0;
  }
  if (id === 'turbine') {
    stageTurbine(sim);
    // The pool behind the new weir fills before the card opens.
    sim.run(900);
  }
  if (id === 'gate') {
    stageGate(sim);
    // Start a few game hours before the day's end: the fields show the water soon after it arrives.
    sim.step = Math.ceil(sim.step / STEPS_PER_DAY) * STEPS_PER_DAY - 440;
  }
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
