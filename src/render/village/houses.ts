/**
 * Building designs: cottages assembled from Kenney fantasy-town parts plus a
 * few procedural pieces (plinth, stakes, scaffolding, sacks), per
 * construction stage. Pure data and functions (no three.js), so tests can
 * check them; `buildings.ts` turns them into merged geometries.
 *
 * Part coordinates are in fantasy-town tile units (a tile is 1 × 1, a wall
 * is 1 high, wall pieces sit on the tile's +x edge) relative to the
 * building's footprint centre; `rot` is in quarter turns about +y
 * (three.js convention: +x turns towards −z). The design's `scale` and
 * `vscale` map tile units to world units (1 = one cell).
 */
import type { ModelName } from '../objects/manifest';

export const enum Stage {
  /** 0 ≤ progress < 0.3: plinth, corner stakes, a pile of planks. */
  Foundation = 0,
  /** 0.3 ≤ progress < 0.7: walls inside scaffolding. */
  Walls = 1,
  /** 0.7 ≤ progress < 1: roof on, scaffolding still up on one side. */
  Roof = 2,
  /** Finished: chimney, a barrel by the door. */
  Done = 3,
}
export const STAGE_COUNT = 4;

export function buildStage(progress: number): Stage {
  if (progress >= 1) return Stage.Done;
  if (progress >= 0.7) return Stage.Roof;
  if (progress >= 0.3) return Stage.Walls;
  return Stage.Foundation;
}

/** Procedural pieces (boxes and blobs with a flat colour). */
export type ProcKind = 'plinth' | 'stake' | 'pole' | 'beam' | 'board' | 'sack' | 'hay' | 'soil' | 'fish';

export interface Part {
  /** A static model, or a procedural piece. */
  readonly m: ModelName | ProcKind;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Quarter turns about +y. */
  readonly rot?: number;
  /** Size of a procedural piece (tile units), or a scale for models (default 1). */
  readonly s?: readonly [number, number, number];
  /** Bit mask of stages (1 << Stage) in which the part is present. */
  readonly stages: number;
  /** Repaint blue-grey as stone instead of the design's plaster colour. */
  readonly stone?: boolean;
}

export interface Design {
  readonly name: string;
  /** Horizontal tile → world scale. */
  readonly scale: number;
  /** Vertical tile → world scale. */
  readonly vscale: number;
  /** Repaint colours (sRGB) for the kit's teal roof tiles and blue-grey plaster/stone. */
  readonly roof?: number;
  readonly plaster?: number;
  readonly parts: readonly Part[];
}

/** Roof colours: terracotta, thatch, dark red-brown shingles. */
export const ROOF_TERRACOTTA = 0xc0583a;
export const ROOF_THATCH = 0xc99a4e;
export const ROOF_SHINGLE = 0x8a4a3a;
export const PLASTER_CREAM = 0xf0e2c4;
/** Chimneys and plinths: warm grey stone. */
export const STONE = 0xd8d0c4;
/** Gable triangles on timber houses. */
export const GABLE_WOOD = 0xa0704a;

const F = 1 << Stage.Foundation;
const W = 1 << Stage.Walls;
const R = 1 << Stage.Roof;
const D = 1 << Stage.Done;
const ALL = F | W | R | D;
const BUILT = W | R | D;
const TOPPED = R | D;

/** Directions in quarter turns: 0 = +x, 1 = −z, 2 = −x, 3 = +z. */
type Dir = 0 | 1 | 2 | 3;

interface Shell {
  /** Footprint in tiles along x and z (1 or 2). */
  nx: number;
  nz: number;
  wall: ModelName;
  door: ModelName;
  window: ModelName;
  /** Wall slots with a window: [tile index along the wall, side]. */
  windows: readonly (readonly [number, Dir])[];
  /** Door slot (tile index, side). */
  doorAt: readonly [number, Dir];
}

/** Tiles' centres for an nx × nz footprint centred at the origin. */
function tiles(nx: number, nz: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) out.push([i - (nx - 1) / 2, k - (nz - 1) / 2]);
  return out;
}

/** Perimeter wall slots: [tile index along that side, side, tile x, tile z]. */
function wallSlots(nx: number, nz: number): [number, Dir, number, number][] {
  const out: [number, Dir, number, number][] = [];
  const hx = (nx - 1) / 2;
  const hz = (nz - 1) / 2;
  for (let k = 0; k < nz; k++) {
    out.push([k, 0, hx, k - hz]);
    out.push([k, 2, -hx, k - hz]);
  }
  for (let i = 0; i < nx; i++) {
    out.push([i, 1, i - hx, -hz]);
    out.push([i, 3, i - hx, hz]);
  }
  return out;
}

function shellParts(sh: Shell): Part[] {
  const parts: Part[] = [];
  const hx = sh.nx / 2;
  const hz = sh.nz / 2;
  // Stone plinth (reaches below ground to hide slopes) and floor boards.
  parts.push({ m: 'plinth', x: 0, y: -0.35, z: 0, s: [sh.nx + 0.16, 0.42, sh.nz + 0.16], stages: ALL });
  parts.push({ m: 'board', x: 0, y: 0.07, z: 0, s: [sh.nx - 0.1, 0.03, sh.nz - 0.1], stages: F });
  // Corner stakes during the foundation stage.
  for (const [sx, sz] of [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ] as const)
    parts.push({ m: 'stake', x: sx * (hx - 0.04), y: 0.07, z: sz * (hz - 0.04), s: [0.07, 0.45, 0.07], stages: F });
  // Walls.
  for (const [idx, dir, tx, tz] of wallSlots(sh.nx, sh.nz)) {
    let m = sh.wall;
    if (sh.doorAt[0] === idx && sh.doorAt[1] === dir) m = sh.door;
    else if (sh.windows.some(([i, d]) => i === idx && d === dir)) m = sh.window;
    parts.push({ m, x: tx, y: 0.07, z: tz, rot: dir, stages: BUILT });
  }
  // Scaffolding: four tall poles, two rails (walls stage); one side stays for the roof stage.
  const px = hx + 0.12;
  const pz = hz + 0.12;
  for (const [sx, sz] of [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ] as const)
    parts.push({ m: 'pole', x: sx * px, y: 0, z: sz * pz, s: [0.05, 1.45, 0.05], stages: sx > 0 ? W | R : W });
  parts.push({ m: 'beam', x: px, y: 0.62, z: 0, s: [0.05, 0.05, 2 * pz + 0.1], stages: W | R });
  parts.push({ m: 'beam', x: px, y: 1.2, z: 0, s: [0.05, 0.05, 2 * pz + 0.1], stages: W | R });
  parts.push({ m: 'beam', x: -px, y: 1.2, z: 0, s: [0.05, 0.05, 2 * pz + 0.1], stages: W });
  parts.push({ m: 'board', x: px + 0.02, y: 0.66, z: 0, s: [0.2, 0.03, 2 * pz - 0.1], stages: W | R });
  // Building material by the site.
  parts.push({ m: 'survival_resource_planks', x: hx + 0.55, y: 0, z: hz * 0.4, rot: 1, s: [1.1, 1.1, 1.1], stages: F | W | R });
  parts.push({ m: 'survival_resource_wood', x: -hx - 0.45, y: 0, z: -hz * 0.5, s: [1.3, 1.3, 1.3], stages: F | W });
  return parts;
}

function doorDir(sh: Shell): Dir {
  return sh.doorAt[1];
}

/** Barrel or crate next to the door (finished houses). */
function doorProp(sh: Shell, model: ModelName): Part {
  const d = doorDir(sh);
  const hx = sh.nx / 2;
  const hz = sh.nz / 2;
  // Door wall offset, then a bit to the side.
  const off = [
    [hx + 0.22, 0.35],
    [0.35, -hz - 0.22],
    [-hx - 0.22, -0.35],
    [-0.35, hz + 0.22],
  ][d]!;
  return { m: model, x: off[0]!, y: 0, z: off[1]!, s: [1.1, 1.1, 1.1], stages: D };
}

const COTTAGE: Shell = {
  nx: 1,
  nz: 1,
  wall: 'town_wall',
  door: 'town_wall_door',
  window: 'town_wall_window',
  windows: [
    [0, 1],
    [0, 3],
  ],
  doorAt: [0, 0],
};

const LONG_WOOD: Shell = {
  nx: 1,
  nz: 2,
  wall: 'town_wall_wood',
  door: 'town_wall_wood_door',
  window: 'town_wall_wood_window',
  windows: [
    [1, 0],
    [0, 2],
    [0, 1],
  ],
  doorAt: [0, 0],
};

const LONG_PLASTER: Shell = {
  nx: 1,
  nz: 2,
  wall: 'town_wall',
  door: 'town_wall_door',
  window: 'town_wall_window',
  windows: [
    [0, 0],
    [1, 2],
    [0, 3],
  ],
  doorAt: [1, 0],
};

const COTTAGE_WOOD: Shell = { ...COTTAGE, wall: 'town_wall_wood', door: 'town_wall_wood_door', window: 'town_wall_wood_window' };

/** Gable roof tiles; the ridge runs along the longer side. */
function gableRoof(sh: Shell): Part[] {
  const rot = sh.nz > sh.nx ? 1 : 0;
  return tiles(sh.nx, sh.nz).map(([x, z]) => ({ m: 'town_roof_gable' as const, x, y: 1.07, z, rot, stages: TOPPED }));
}

function pointRoof(): Part[] {
  return [{ m: 'town_roof_point', x: 0, y: 1.07, z: 0, stages: TOPPED }];
}

/** Chimney whose stack is centred at (x, z) (the model sits at +0.21..+0.43 in x). */
function chimney(x: number, z: number): Part {
  return { m: 'town_chimney', x: x - 0.32, y: 0.75, z, stages: D, stone: true };
}

/** House designs; the variant is chosen by a hash of the building id. */
export const HOUSE_DESIGNS: readonly Design[] = [
  {
    name: 'cottage',
    scale: 1.25,
    vscale: 0.92,
    roof: ROOF_TERRACOTTA,
    plaster: PLASTER_CREAM,
    parts: [...shellParts(COTTAGE), ...pointRoof(), chimney(-0.22, 0.18), doorProp(COTTAGE, 'survival_barrel')],
  },
  {
    name: 'longhouse-wood',
    scale: 0.88,
    vscale: 0.95,
    roof: ROOF_THATCH,
    plaster: GABLE_WOOD,
    parts: [...shellParts(LONG_WOOD), ...gableRoof(LONG_WOOD), chimney(-0.24, -0.6), doorProp(LONG_WOOD, 'survival_box')],
  },
  {
    name: 'longhouse',
    scale: 0.88,
    vscale: 0.95,
    roof: ROOF_SHINGLE,
    plaster: PLASTER_CREAM,
    parts: [...shellParts(LONG_PLASTER), ...gableRoof(LONG_PLASTER), chimney(-0.24, 0.6), doorProp(LONG_PLASTER, 'survival_barrel')],
  },
  {
    name: 'cottage-wood',
    scale: 1.2,
    vscale: 0.95,
    roof: ROOF_TERRACOTTA,
    plaster: GABLE_WOOD,
    parts: [...shellParts(COTTAGE_WOOD), ...gableRoof(COTTAGE_WOOD), chimney(-0.24, 0.22), doorProp(COTTAGE_WOOD, 'survival_box')],
  },
];

/** Shells of the house designs (same order as HOUSE_DESIGNS). */
const HOUSE_SHELLS: readonly Shell[] = [COTTAGE, LONG_WOOD, LONG_PLASTER, COTTAGE_WOOD];

export interface HouseSpots {
  /** The chimney part's origin (tile units; the model's own extent is added by the caller). */
  chimney: { x: number; y: number; z: number };
  /** In front of the door (tile units), with the outward direction (ox, oz). */
  door: { x: number; z: number; ox: number; oz: number };
  scale: number;
  vscale: number;
}

/** Where a house design's chimney and door are (for smoke, flowers; village/cues.ts). */
export function houseSpots(variant: number): HouseSpots {
  const d = HOUSE_DESIGNS[variant % HOUSE_DESIGNS.length]!;
  const sh = HOUSE_SHELLS[variant % HOUSE_SHELLS.length]!;
  const c = d.parts.find((p) => p.m === 'town_chimney')!;
  const [idx, dir] = sh.doorAt;
  const hx = (sh.nx - 1) / 2;
  const hz = (sh.nz - 1) / 2;
  // Wall pieces sit on the tile's edge facing `dir` (0 = +x, 1 = −z, 2 = −x, 3 = +z).
  const o = [
    [1, 0],
    [0, -1],
    [-1, 0],
    [0, 1],
  ][dir]!;
  const tx = dir === 0 ? hx : dir === 2 ? -hx : idx - hx;
  const tz = dir === 1 ? -hz : dir === 3 ? hz : idx - hz;
  return {
    chimney: { x: c.x, y: c.y, z: c.z },
    door: { x: tx + o[0]! * 0.5, z: tz + o[1]! * 0.5, ox: o[0]!, oz: o[1]! },
    scale: d.scale,
    vscale: d.vscale,
  };
}

/** Deterministic variant for a building id. */
export function houseVariant(id: number): number {
  let h = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) % HOUSE_DESIGNS.length;
}

/** Max sacks shown at the store. */
export const MAX_FOOD_PROPS = 6;

/** Number of sacks (0..6) for a food stock (person-days): one per 20 days of food per head. */
export function foodLevel(food: number, population: number): number {
  if (!(food > 0)) return 0;
  const sacks = food / (Math.max(1, population) * 20);
  return Math.max(0, Math.min(MAX_FOOD_PROPS, Math.round(sacks)));
}

/** Sack positions on the store floor (pyramid: 3 + 2 + 1). */
const SACK_SPOTS: readonly (readonly [number, number, number])[] = [
  [-0.22, 0.07, -0.25],
  [-0.22, 0.07, 0.02],
  [-0.22, 0.07, 0.29],
  [-0.24, 0.27, -0.12],
  [-0.24, 0.27, 0.16],
  [-0.25, 0.47, 0.02],
];

/** Food level from which round hay bales stand by the store (one, then two at the maximum). */
export const HAY_LEVEL = 4;

/**
 * The village store: an open shed on posts with barrels, a cart and `level`
 * sacks of food; hay bales beside it when full. A village with fishers has
 * a fish-drying rack, hung with fish unless the store is empty.
 */
export function storeDesign(level: number, fish = false): Design {
  const parts: Part[] = [
    { m: 'plinth', x: 0, y: -0.35, z: 0, s: [1.12, 0.42, 1.12], stages: ALL },
    { m: 'board', x: 0, y: 0.07, z: 0, s: [1.0, 0.03, 1.0], stages: ALL },
    ...[
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ].map(([sx, sz]) => ({ m: 'town_pillar_wood' as const, x: sx! * 0.44, y: 0.07, z: sz! * 0.44, s: [1, 0.95, 1] as const, stages: ALL })),
    { m: 'town_roof_gable', x: 0, y: 1.0, z: 0, stages: ALL },
    // Back wall half-height planks.
    { m: 'board', x: -0.47, y: 0.1, z: 0, s: [0.04, 0.45, 0.9], stages: ALL },
    { m: 'survival_barrel', x: 0.25, y: 0.07, z: -0.3, s: [1.2, 1.2, 1.2], stages: ALL },
    { m: 'survival_barrel', x: 0.12, y: 0.07, z: 0.32, s: [1.1, 1.1, 1.1], stages: ALL },
    { m: 'town_cart', x: 0.95, y: 0, z: 0.1, rot: 1, s: [0.55, 0.55, 0.55], stages: ALL },
  ];
  const n = Math.max(0, Math.min(MAX_FOOD_PROPS, level | 0));
  for (let k = 0; k < n; k++) {
    const [x, y, z] = SACK_SPOTS[k]!;
    parts.push({ m: 'sack', x, y, z, rot: k % 4, s: [0.24, 0.26, 0.22], stages: ALL });
  }
  if (n >= HAY_LEVEL) parts.push({ m: 'hay', x: -0.2, y: 0, z: 0.9, s: [0.36, 0.3, 0.36], stages: ALL });
  if (n >= MAX_FOOD_PROPS) parts.push({ m: 'hay', x: 0.22, y: 0, z: 0.98, s: [0.32, 0.27, 0.32], stages: ALL });
  if (fish) {
    // Drying rack: two posts and a pole, fish hanging from it.
    const z = -0.92;
    parts.push({ m: 'pole', x: -0.32, y: 0, z, s: [0.04, 0.62, 0.04], stages: ALL });
    parts.push({ m: 'pole', x: 0.32, y: 0, z, s: [0.04, 0.62, 0.04], stages: ALL });
    parts.push({ m: 'beam', x: 0, y: 0.58, z, s: [0.72, 0.035, 0.035], stages: ALL });
    const hung = n === 0 ? 0 : Math.min(5, 2 + n);
    for (let k = 0; k < hung; k++) parts.push({ m: 'fish', x: -0.24 + (0.48 * k) / 4, y: 0.57, z, s: [0.05, 0.24, 0.1], stages: ALL });
  }
  return { name: `store-${n}${fish ? '-fish' : ''}`, scale: 1.3, vscale: 1.0, roof: ROOF_THATCH, plaster: GABLE_WOOD, parts };
}

/** Parts of a design present at a stage. */
export function partsAt(d: Design, stage: Stage): Part[] {
  return d.parts.filter((p) => (p.stages & (1 << stage)) !== 0);
}

/** All static models any design may use (for preloading). */
export function villageModels(): ModelName[] {
  const s = new Set<ModelName>();
  const add = (d: Design) => {
    for (const p of d.parts) if (!isProc(p.m)) s.add(p.m);
  };
  HOUSE_DESIGNS.forEach(add);
  add(storeDesign(MAX_FOOD_PROPS, true));
  return [...s];
}

const PROC: ReadonlySet<string> = new Set<ProcKind>(['plinth', 'stake', 'pole', 'beam', 'board', 'sack', 'hay', 'soil', 'fish']);
export function isProc(m: string): m is ProcKind {
  return PROC.has(m);
}
