/**
 * Messages between the main thread (SimClient) and the simulation worker.
 * This file is the contract between sim/ and client/render/ui. Keep it
 * free of imports from sim/ or render/.
 */

/** A point in fractional cell coordinates; cell i's centre is at i. */
export type Pt = readonly [number, number];

export interface SimTime {
  /** Total hydro steps since world creation. */
  step: number;
  /** Whole days since world creation. */
  day: number;
  year: number;
  /** 0 = spring, 1 = summer, 2 = autumn, 3 = winter. */
  season: number;
  /** Day within the season, 0-based. */
  dayOfSeason: number;
  /** 0..1 fraction of the year. */
  yearFrac: number;
  /** 0..1, 0 = midnight, 0.5 = noon. */
  timeOfDay: number;
}

export interface RainFront {
  /** Centre in cell coordinates. */
  x: number;
  y: number;
  /** Semi-axes in cells. */
  rx: number;
  ry: number;
  /** Orientation in radians. */
  angle: number;
  /** Intensity 0..1 (rendering only). */
  intensity: number;
  /** True when it falls as snow. */
  snow: boolean;
}

export interface ClimateState {
  /** Temperature at sea level, °C. */
  temperature: number;
  /** Wind direction (radians) and speed (cells per game hour, rendering). */
  windDir: number;
  windSpeed: number;
  fronts: RainFront[];
}

export interface SimStats {
  /** Game speed requested (0 = paused) and actually achieved, in "×". */
  speedRequested: number;
  speedAchieved: number;
  /** Milliseconds per hydro step, smoothed. */
  msPerStep: number;
  /** Total surface water volume (m³). */
  surfaceWater: number;
  /** Outflow through outlets in the last game day (m³). */
  outflowPerDay: number;
  /** All villages together (centre: the first village). */
  village?: VillageStats;
  /** Each village on its own (M3-γ: more settlements). */
  villages?: VillageStats[];
}

/** Static information sent once when the world is ready. */
export interface WorldInfo {
  seed: number;
  width: number;
  height: number;
  /** Cell size in metres. */
  cellSize: number;
  /** Suggested camera focus (cell coordinates). */
  startX: number;
  startY: number;
}

/**
 * Per-cell "ground look" packed as RGBA8:
 *  R = soil type (SoilType enum)
 *  G = moisture 0..255
 *  B = vegetation 0..255
 *  A = snow cover 0..255
 */
export const LOOK_CHANNELS = 4;

/** Bytes per cell in Snapshot.fields: LandUse, crop stage, crop stress. */
export const FIELD_BYTES = 3;
/**
 * Crop stress byte: 0 healthy (or nothing growing), 1..127 dry (127: too dry
 * to grow), STRESS_WET..255 waterlogged (255: under water, drowning).
 */
export const STRESS_WET = 128;

/** Side length (cells) of the blocks fish stocks are tracked in. */
export const FISH_BLOCK = 8;

/** Velocity packed as two signed bytes per cell; 127 ≙ VEL_SCALE m/s. */
export const VEL_SCALE = 4;

// ---------------------------------------------------------------------------
// Entities (people and animals), sent with every snapshot.

/** What an entity is. Appearance variants are chosen by `variant`. */
export const enum EntityKind {
  Person = 0,
  Child = 1,
  Cow = 2,
  Pig = 3,
  Chick = 4,
  Dog = 5,
  Sheep = 6,
}

/** What an entity is doing (drives the animation clip). */
export const enum EntityAnim {
  Idle = 0,
  Walk = 1,
  Run = 2,
  /** Walking with a load (see `carry`). */
  Carry = 3,
  /** Digging / hoeing / chopping: a repeated swing. */
  Work = 4,
  /** Hammering / interacting with something at hand height. */
  Build = 5,
  Sit = 6,
  /** Sitting at the shore with a rod. */
  Fish = 7,
  /** Animals: grazing / pecking. */
  Eat = 8,
  /** Felling a tree with an axe. */
  Chop = 9,
}

/** What a person carries (rendered as a small prop). */
export const enum CarryKind {
  None = 0,
  Earth = 1,
  Sack = 2,
  Fish = 3,
  Log = 4,
  Bundle = 5,
  Bucket = 6,
  /** A dressed stone for lining a bank. */
  Stone = 7,
}

/**
 * All entities, structure-of-arrays. Positions in fractional cell coords;
 * velocity in cells per real second at the current speed (for
 * extrapolation between snapshots).
 */
export interface EntityFrame {
  count: number;
  id: Uint16Array;
  /** kind, variant, anim, carry per entity (4 bytes each). */
  info: Uint8Array;
  /**
   * x, y, vx, vy, heading per entity (5 floats each). Heading is in radians
   * in cell coordinates: direction (cos h, sin h), i.e. atan2(vy, vx).
   */
  pos: Float32Array;
}

/** A building (rarely changes; sent when the set changes). */
export interface BuildingInfo {
  id: number;
  /**
   * A ruin is a house destroyed by a flood (or abandoned); it may be rebuilt.
   * A well is the village's (GAMEPLAY §1.1); a mill stands on the bank by
   * a head of water, its wheel on the side facing `rot` (§1.2).
   */
  kind: 'house' | 'store' | 'ruin' | 'well' | 'mill';
  /** Cell coordinates of the footprint centre. */
  x: number;
  y: number;
  /** Rotation in radians (multiples of π/2). */
  rot: number;
  /** Construction progress 0..1. */
  progress: number;
  /** Wells: no water comes up (the table fell too deep). */
  dry?: boolean;
  /** Mills: speed of the water at the wheel (m/s; 0 = standing still). */
  spin?: number;
  /** Mills: grain waiting to be ground (sacks shown by the door, 0..3). */
  sacks?: number;
}

/**
 * A water structure (sent when the set changes). Heights in metres.
 * - gate: a sluice gate across the line through (x, y) along `rot`
 *   (`width` cells wide); the leaf rises to `top` when closed and lifts
 *   clear when open; water passes down to `sill` when open.
 * - weir: a lined overflow wall from (x, y) to (x2, y2) with its crest at `top`.
 * - jetty: a villagers' wooden jetty from the shore cell (x, y) out over
 *   the water to (x2, y2), its deck at `top`.
 */
export interface StructureInfo {
  id: number;
  kind: 'gate' | 'weir' | 'jetty';
  x: number;
  y: number;
  /** Direction of the structure's line in cell coordinates: (cos rot, sin rot). */
  rot: number;
  /** Length along the line (cells). */
  width: number;
  top: number;
  sill: number;
  open: boolean;
  /** Construction progress 0..1. */
  progress: number;
  /** Gates: how far the leaf is up now, 0..1 (it follows `open` over a few game hours). */
  lift?: number;
  /** Weirs: the far end of the line. */
  x2?: number;
  y2?: number;
}

/**
 * Lining state per cell in Snapshot.lining: 0 none, 1..253 planned
 * (progress), 254 lined as a quay (a lake front by the houses), 255 lined.
 */
export const LINING_DONE = 255;
export const LINING_QUAY = 254;

/** Village statistics (hidden from players; shown with ?stats=1; population drives tool unlocks). */
export interface VillageStats {
  /** Centre of the village in cell coordinates (the first one for the aggregate). */
  x: number;
  y: number;
  population: number;
  houses: number;
  food: number;
  wellbeing: number;
  /**
   * Visible mood from wellbeing with hysteresis (per village; docs/PEOPLE.md
   * §7): 1 prosperous (chimney smoke, laundry, flowers, children), 0
   * ordinary, −1 struggling (no smoke, people idle by the store).
   */
  mood?: number;
  /** Fishers (per village): the store gets a fish-drying rack. */
  fishers?: number;
  /** Logs on the woodpile by the store (per village, 0..10). */
  wood?: number;
  /** Number of villages (aggregate only). */
  count?: number;
  /** Highest total population so far (aggregate only; tool unlocks). */
  peak?: number;
}

export interface Snapshot {
  time: SimTime;
  climate: ClimateState;
  stats: SimStats;
  /** Identifies the buffer set, to be returned with an `ack`. */
  poolId: number;
  /** Surface water depth (m), width × height. Pooled. */
  depth: Float32Array;
  /** Velocity, interleaved (vx, vy) signed bytes. Pooled. */
  vel: Int8Array;
  /** Terrain height (m) for rows [y0, y1), when changed. Not pooled. */
  terrain?: { y0: number; y1: number; data: Float32Array };
  /** Full ground look (RGBA8), when changed. Not pooled. */
  look?: Uint8Array;
  /** Full plan target heights (NaN = none), when changed. Not pooled. */
  plan?: Float32Array;
  /** People and animals. Not pooled (small). */
  entities?: EntityFrame;
  /** All buildings, when changed. */
  buildings?: BuildingInfo[];
  /**
   * Land use, crop stage and crop stress per cell (FIELD_BYTES each:
   * LandUse, crop 0..255, stress — see STRESS_WET), when changed.
   */
  fields?: Uint8Array;
  /** Water structures (gates, weirs), when changed. */
  structures?: StructureInfo[];
  /** Stone lining per cell (see LINING_DONE), when changed. Not pooled. */
  lining?: Uint8Array;
  /** Fog of war: revealed 0..255 per cell (≥ 128 is known land), when changed. */
  revealed?: Uint8Array;
  /**
   * Fish per block of FISH_BLOCK² cells (row-major, ceil(width/FISH_BLOCK)
   * wide): 0 = no fish habitat, 1..255 = habitat, from empty to fully
   * stocked. Sent about daily.
   */
  fish?: Uint8Array;
  /** Staged scenes: the `run` of the scene message this state belongs to. */
  sceneRun?: number;
  /** Achievements, when changed (see the Achievements section). */
  achievements?: AchievementsUpdate;
}

// ---------------------------------------------------------------------------
// Commands (player actions), main → worker.

export type Command =
  /** Dig a trench along a polyline; floor grades evenly from start to end. */
  | { type: 'planTrench'; points: Pt[]; width: number; depth: number }
  /** Raise a dike along a polyline to a level crest `height` above the lowest ground on the path. */
  | { type: 'planDike'; points: Pt[]; width: number; height: number }
  /** Flatten the brushed area to the ground height at the stroke's start. */
  | { type: 'planLevel'; points: Pt[]; width: number }
  /** Stone lining on the cells brushed by a path (built after any earthworks there). */
  | { type: 'planLining'; points: Pt[]; width: number }
  /** Weir: a lined wall along the straight line from the first to the last point, crest `height` above the lowest ground. */
  | { type: 'planWeir'; points: Pt[]; width: number; height: number }
  /**
   * Sluice gate. A tap (or a very short stroke) on a dike or weir puts a
   * gate into it; a stroke across a channel builds a dike of crest `height`
   * with a gate (`width` 1–3 cells) at its lowest point.
   */
  | { type: 'placeGate'; points: Pt[]; width: number; height: number }
  /**
   * Open or close a gate by hand (open = !open when omitted) and hold it
   * there: tests, scenes and debugging. In the game, villagers work the
   * gates (sim/structures/gatekeeper.ts).
   */
  | { type: 'toggleGate'; id: number; open?: boolean }
  /** Remove plans within a radius. */
  | { type: 'cancelPlan'; x: number; y: number; radius: number }
  /** Debug: pour water. */
  | { type: 'debugWater'; x: number; y: number; radius: number; depth: number }
  /** Debug/screenshots: force village `index`'s wellbeing (and mood) or food, or dry out its fields' soil. */
  | { type: 'debugVillage'; index: number; wellbeing?: number; food?: number; dry?: boolean };

// ---------------------------------------------------------------------------
// Messages.

/** Staged scenes of the welcome panels (sim/scenes.ts). */
/** Staged scenes: the welcome panels, and the tool cards shown when a tool unlocks (weir, gate). */
export type SceneId = 'water' | 'shape' | 'village' | 'weir' | 'gate';

export type ToWorker =
  | { type: 'init'; seed: number; size: number; speed?: number; duty?: number }
  | { type: 'load'; bytes: ArrayBuffer; speed?: number; duty?: number }
  /** Start (or restart, or switch to) a staged scene; later scenes reuse the first one's buffers. */
  | { type: 'scene'; scene: SceneId; run: number; speed?: number; duty?: number }
  | { type: 'setSpeed'; speed: number }
  | { type: 'command'; command: Command }
  | { type: 'ack'; poolId: number; depth: Float32Array; vel: Int8Array }
  | { type: 'save' }
  /** Test hook: run n days as fast as possible, then reply `ranDays`. */
  | { type: 'runDays'; days: number }
  | { type: 'hash' }
  /** Ask for the game's history (stats bar chart); replied with `history`. */
  | { type: 'history' };

export type FromWorker =
  | {
      type: 'ready';
      info: WorldInfo;
      terrain: Float32Array;
      look: Uint8Array;
      plan: Float32Array;
      /** Fog of war (absent: everything is revealed). */
      revealed?: Uint8Array;
    }
  | ({ type: 'snapshot' } & Snapshot)
  | { type: 'saved'; bytes: ArrayBuffer }
  | { type: 'loadFailed'; message: string }
  | { type: 'ranDays'; days: number }
  | { type: 'hash'; hash: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'history'; history: HistoryData };

// ---------------------------------------------------------------------------
// History (stats bar & history chart). One sample per game day; older
// samples are merged into bins of several days (`n` > 1).

export interface HistorySample {
  /** First game day covered. */
  d: number;
  /** Days covered (1 for a daily sample). */
  n: number;
  /** Total population (end of the period). */
  p: number;
  /** Prosperity: population-weighted wellbeing, 0..100 (mean over the period). */
  w: number;
  /** Precipitation (rain + snow water), map mean in mm per day (mean over the period). */
  r: number;
  /** Daily mean sea-level temperature, °C (mean over the period). */
  t: number;
  /** Land cells newly flooded (sum over the period). */
  f: number;
  /** Houses ruined by floods (sum over the period). */
  h: number;
  /** Number of villages (end of the period). */
  v: number;
}

export interface HistoryMilestone {
  /** Population milestone (src/shared/unlocks.ts). */
  population: number;
  /** Game day it was first reached. */
  day: number;
}

export interface HistoryData {
  samples: HistorySample[];
  milestones: HistoryMilestone[];
  /** Achievements earned so far (chart medals). */
  achievements?: AchievementEarned[];
}

// ---------------------------------------------------------------------------
// Achievements (per world; static table in src/shared/achievements.ts).

export interface AchievementEarned {
  /** Achievement id (src/shared/achievements.ts). */
  id: string;
  /** Game day it was earned. */
  day: number;
}

/** Sent with a snapshot whenever the set changes (and once after start or load). */
export interface AchievementsUpdate {
  /** All achievements earned so far, in the order earned. */
  earned: AchievementEarned[];
  /** Ids earned since the previous update (empty after loading a save: no fanfare). */
  fresh: string[];
}
