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
  /** The power grid (M6; absent before the first turbine, pole or pump). */
  power?: PowerStats;
}

/** Power grid totals (W, on the hydraulic clock) as of the latest step. */
export interface PowerStats {
  /** Made by all turbines, wanted and received by the houses on the grid, drawn by the pumps. */
  produced: number;
  demand: number;
  supplied: number;
  pumping: number;
  /** Houses on the grid. */
  houses: number;
  /** Mean power produced over the last full game day (kW). */
  dayMean: number;
}

/**
 * The power grid for the renderer (sent when it changes). Cell coordinates.
 * - turbines: on the crest (x, y) of a wall along `rot`, the penstock from
 *   (ax, ay) to (bx, by); `flow` > 0 runs from a to b (< 0: b to a), m³/s.
 * - wires: flat [x1, y1, x2, y2, …] between poles, turbines and pumps.
 * - pumps: inlet (x, y) in the water, pump house (hx, hy), outlet (ox, oy).
 * - lit: flat [houseId, level, …], level 0..1 the share of the house's
 *   demand the grid meets now (only houses on the grid are listed).
 */
export interface PowerInfo {
  turbines: { id: number; x: number; y: number; rot: number; ax: number; ay: number; bx: number; by: number; progress: number; flow: number; power: number }[];
  poles: { id: number; x: number; y: number; progress: number }[];
  wires: number[];
  pumps: { id: number; x: number; y: number; hx: number; hy: number; ox: number; oy: number; progress: number; flow: number; power: number }[];
  lit: number[];
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

/** Bytes per cell in Snapshot.fields: LandUse, crop stage, crop stress, field crop (FieldCrop). */
export const FIELD_BYTES = 4;
/**
 * Fourth byte of Snapshot.fields (docs/PEOPLE.md §3.1, "hardy crops and
 * pegged plots"): what a field cell grows. `Common` is the ordinary crop of
 * good land (the renderer picks wheat, corn, cabbage or pumpkin per patch);
 * millet and paddies are the hardy crops of a village short of good land;
 * `Pegged` marks good land staked out for a farmer still to come (LandUse
 * None: not ploughed).
 */
export const enum FieldCrop {
  Common = 0,
  Millet = 1,
  Paddy = 2,
  Pegged = 3,
}
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
  /** Ruins: how overgrown, 0 (fresh mud) .. 2 (a year or more). */
  weeds?: number;
}

/**
 * A water structure (sent when the set changes). Heights in metres.
 * - gate: a sluice gate across the line through (x, y) along `rot`
 *   (`width` cells wide); the leaf rises to `top` when closed and lifts
 *   clear when open; water passes down to `sill` when open.
 * - weir: a lined overflow wall from (x, y) to (x2, y2) with its crest at
 *   `top`; `sill` is the lowest ground under the crest.
 * - jetty: a villagers' wooden jetty from the shore cell (x, y) out over
 *   the water to (x2, y2), its deck at `top`.
 * - wheel: a water wheel standing in the river cell (x, y) on its bed
 *   `sill`, lifting into a trough that runs to the head cell (x2, y2),
 *   whose ground is at `top`; `open` while water runs in the trough.
 * - bridge: a villagers' footbridge from the bank cell (x, y) over `width`
 *   wet cells to the bank cell (x2, y2), its deck at `top` (`broken`
 *   after a flood swept the planks away).
 */
/** Things the player can select and edit or remove (ui/selection.ts). */
export type SelectableKind = 'weir' | 'gate' | 'wheel' | 'turbine' | 'pole' | 'pump';

export interface StructureInfo {
  id: number;
  kind: 'gate' | 'weir' | 'jetty' | 'wheel' | 'bridge';
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
  /** Weirs: the far end of the line (wheels: the head cell). */
  x2?: number;
  y2?: number;
  /** Wheels: speed of the current turning it (m/s, 0 = standing still; the sign says which way it passes across the axle x→x2) and the water lifted (m³/s). */
  speed?: number;
  flow?: number;
  /** Footbridges (x, y and x2, y2 are the banks at either end): swept away by a flood, the piles left. */
  broken?: boolean;
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
  /** Full plan target heights (NaN = none; the crew's structure work), when changed. Not pooled. */
  plan?: Float32Array;
  /** The last sculpt command (its `seq`) applied before this snapshot. */
  sculptSeq?: number;
  /** Sculpt strokes that can be undone. */
  undoable?: number;
  /**
   * Cells the brushes leave alone (1): houses, mills, wells, stores, ruins,
   * footbridges, structures and their works in progress. When changed.
   */
  fixed?: Uint8Array;
  /** People and animals. Not pooled (small). */
  entities?: EntityFrame;
  /** All buildings, when changed. */
  buildings?: BuildingInfo[];
  /**
   * Land use, crop stage, crop stress and field crop per cell (FIELD_BYTES
   * each: LandUse, crop 0..255, stress — see STRESS_WET, FieldCrop), when changed.
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
  /** The power grid, when it changed (M6). */
  power?: PowerInfo;
  /** Ideas for this valley, when changed (see the Ideas section; sim/ideas.ts). */
  ideas?: IdeaInfo[];
}

// ---------------------------------------------------------------------------
// Commands (player actions), main → worker.

/** The sculpting brushes (DESIGN.md §4). */
export type BrushTool = 'raise' | 'dig' | 'even';

export type Command =
  /**
   * Sculpting brushes (sim/plans/sculpt.ts): samples of stroke `stroke`
   * (a new id starts a new stroke for undo), flat [x, y, dt, …] — the brush
   * of `radius` cells held at (x, y) for dt real seconds. Applied at once,
   * also while paused. `seq` (increasing) is echoed in Snapshot.sculptSeq so
   * the client's prediction knows when the sim has caught up.
   */
  | { type: 'sculpt'; tool: BrushTool; radius: number; stroke: number; seq?: number; samples: number[] }
  /** Undo the last sculpt stroke (or shaped line). */
  | { type: 'undoSculpt' }
  /**
   * A whole line shaped at once (scripted strokes: tests, scenes): dig grades
   * a floor evenly from `amount` below the ground at the start to `amount`
   * below it at the end; raise heaps a level bank `amount` above the lowest
   * ground on the line; even flattens to the height at the start. `width`
   * in cells; banks slope over 1.5 cells. Applied at once, one undo stroke.
   * `floor` (dig only): the floor's absolute height (m) at the start and the
   * end instead, for a canal graded to a water level (playtest bots).
   */
  | { type: 'shapeLine'; tool: BrushTool; points: Pt[]; width: number; amount?: number; floor?: [number, number] }
  /** Stone lining on the cells brushed by a path (built after any earthworks there). */
  | { type: 'planLining'; points: Pt[]; width: number }
  /**
   * Weir: a lined stone wall along the straight line from the first to the
   * last point, crest `height` above the lowest ground; its faces and apron
   * follow from the height (`width` is ignored; older callers pass it).
   */
  | { type: 'planWeir'; points: Pt[]; width?: number; height: number }
  /**
   * Edit a weir (selection handles): its line now runs from points[0] to
   * points[1], its crest at `top` (absolute, m). The crew rebuilds it.
   */
  | { type: 'editWeir'; id: number; points: Pt[]; top: number }
  /**
   * Take a structure down (the selection's Remove): a weir is lowered back
   * to its ground, a gate's opening plugged up to the dam's crest.
   */
  | { type: 'removeStructure'; kind: SelectableKind; id: number }
  /**
   * Sluice gate. A tap (or a very short stroke) on a dike or weir puts a
   * gate into it; a stroke across a channel builds a dike of crest `height`
   * with a gate (`width` 1–3 cells) at its lowest point.
   */
  | { type: 'placeGate'; points: Pt[]; width: number; height: number }
  /**
   * Water wheel: a stroke from the river onto the bank. The wheel stands in
   * the water where it starts; its trough runs to the first dry cell along
   * the stroke (at most 3 cells, up to 5 m above the river). A tap picks
   * the lowest dry cell beside the water (sim/structures/wheel.ts).
   */
  | { type: 'placeWheel'; points: Pt[] }
  /**
   * Turbine (M6): a tap on the crest of a weir, dike or dam; its penstock
   * runs through the wall from the high side to the low side
   * (sim/power/power.ts turbineSite).
   */
  | { type: 'placeTurbine'; points: Pt[] }
  /**
   * Power poles along a stroke, every 6 cells; a stroke starting or ending
   * at a turbine or pole joins it (wires between consecutive poles).
   */
  | { type: 'placePoles'; points: Pt[] }
  /** Electric pump: a stroke from the water (inlet) to the outlet cell, up to 24 cells and 30 m up. */
  | { type: 'placePump'; points: Pt[] }
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
/** Staged scenes: the welcome panels, and the tool cards shown when a tool unlocks (weir, gate, wheel). */
export type SceneId = 'water' | 'shape' | 'village' | 'weir' | 'gate' | 'wheel' | 'turbine' | 'poles' | 'pump';

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
      /** Cells the brushes leave alone (see Snapshot.fixed). */
      fixed?: Uint8Array;
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
  /** Power produced, kW (mean over the period; absent before M6 and without turbines). */
  e?: number;
  /** Houses lit at the end of the period (absent before M6). */
  l?: number;
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

// ---------------------------------------------------------------------------
// Ideas for this valley (docs/GAMEPLAY.md §3.3; sim/ideas.ts).

export type IdeaKind = 'dry' | 'flood' | 'marsh' | 'mill' | 'turbine' | 'poles';

/** A gentle suggestion from the world's current problems, shown in the Achievements card. */
export interface IdeaInfo {
  /** Stable id (kind and village), e.g. 'dry:0'. */
  id: string;
  kind: IdeaKind;
  /** The tool that would help (the UI shows only ideas for unlocked tools). */
  tool: string;
  /** One sentence, an invitation. */
  text: string;
  /** Where (cell coordinates) and how big (radius in cells) the problem is. */
  x: number;
  y: number;
  r: number;
  /** The achievement it may lead to, if any. */
  achievement?: string;
}
