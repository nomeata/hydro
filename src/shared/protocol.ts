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

/** Velocity packed as two signed bytes per cell; 127 ≙ VEL_SCALE m/s. */
export const VEL_SCALE = 4;

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
}

// ---------------------------------------------------------------------------
// Commands (player actions), main → worker.

export type Command =
  /** Dig a trench along a polyline; floor grades evenly from start to end. */
  | { type: 'planTrench'; points: Pt[]; width: number; depth: number }
  /** Raise a dike along a polyline to a level crest `height` above the lowest ground on the path. */
  | { type: 'planDike'; points: Pt[]; width: number; height: number }
  /** Remove plans within a radius. */
  | { type: 'cancelPlan'; x: number; y: number; radius: number }
  /** Debug: pour water. */
  | { type: 'debugWater'; x: number; y: number; radius: number; depth: number };

// ---------------------------------------------------------------------------
// Messages.

export type ToWorker =
  | { type: 'init'; seed: number; size: number }
  | { type: 'load'; bytes: ArrayBuffer }
  | { type: 'setSpeed'; speed: number }
  | { type: 'command'; command: Command }
  | { type: 'ack'; poolId: number; depth: Float32Array; vel: Int8Array }
  | { type: 'save' }
  /** Test hook: run n days as fast as possible, then reply `ranDays`. */
  | { type: 'runDays'; days: number }
  | { type: 'hash' };

export type FromWorker =
  | {
      type: 'ready';
      info: WorldInfo;
      terrain: Float32Array;
      look: Uint8Array;
      plan: Float32Array;
    }
  | ({ type: 'snapshot' } & Snapshot)
  | { type: 'saved'; bytes: ArrayBuffer }
  | { type: 'ranDays'; days: number }
  | { type: 'hash'; hash: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };
