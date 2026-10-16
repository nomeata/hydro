/**
 * Coordinate conventions shared by everything in render/.
 *
 * - Sim cell (cx, cy) has its centre at three.js (x, z) = (cx + 0.5, cy + 0.5).
 *   One three.js unit = one cell horizontally (CELL metres).
 * - three.js y (up) = height_in_metres / CELL * VERTICAL_EXAGGERATION.
 * - Terrain/water grid vertices sit at cell centres.
 */
export const CELL_METRES = 5;
export const VERTICAL_EXAGGERATION = 1.0;
export const HEIGHT_SCALE = VERTICAL_EXAGGERATION / CELL_METRES;

export function heightToY(metres: number): number {
  return metres * HEIGHT_SCALE;
}

export function yToHeight(y: number): number {
  return y / HEIGHT_SCALE;
}

/** Sampler of terrain height (metres) at fractional cell coordinates. */
export interface HeightSampler {
  readonly width: number;
  readonly height: number;
  /** Bilinear terrain height in metres at fractional cell coords. */
  terrainAt(cx: number, cy: number): number;
  /** Water depth in metres at the nearest cell. */
  depthAt(cx: number, cy: number): number;
}
