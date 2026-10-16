/**
 * Coordinate conventions shared by render/, ui/ and sim/.
 *
 * - "Cell coordinates" are fractional: cell i's centre is at coordinate i, so
 *   Math.round(c) is the cell index. Picking, tool polylines (protocol Pt)
 *   and plan rasterisation all use this.
 * - Cell (cx, cy) has its centre at three.js (x, z) = (cx + 0.5, cy + 0.5).
 *   One three.js unit = one cell horizontally (CELL metres).
 * - three.js y (up) = height_in_metres / CELL * VERTICAL_EXAGGERATION.
 * - Terrain/water grid vertices sit at cell centres.
 */
export const CELL_METRES = 5;
export const VERTICAL_EXAGGERATION = 2.0;
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
  /** Normal of the drawn terrain triangle (three.js axes) for the given vertical scale. */
  normalAt?(cx: number, cy: number, out: { x: number; y: number; z: number }, heightScale: number): void;
}
