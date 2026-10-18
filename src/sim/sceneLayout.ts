/**
 * Landmarks of the welcome-scene world (sim/scenes.ts), in cells. A module
 * of its own so the UI can point cameras and the scripted trench at them
 * without pulling the simulation into the main bundle.
 */
import type { Pt } from '../shared/protocol';

export const SCENE_LAYOUT = {
  /** River centreline (Catmull-Rom through these), from the left edge to the bottom edge. */
  river: [
    [-3, 30],
    [12, 32],
    [24, 38],
    [33, 46],
    [44, 50],
    [52, 56],
    [58, 66],
    [62, 78],
    [66, 99],
  ] as Pt[],
  /** A pond near the village (fish, the fishers' spot). */
  pond: { x: 33, y: 63, r: 5 },
  /** A dry hollow across the river, lower than the river's water surface. */
  hollow: { x: 62, y: 46, r: 5.5 },
  /** The trench the intro draws: from the river bank into the hollow. */
  trench: [
    [55.5, 56.5],
    [57.5, 52.5],
    [60, 49.5],
    [62, 47],
  ] as Pt[],
  /** The village store. */
  village: { x: 34, y: 74 },
  /** The wooded hill. */
  hill: { x: 53, y: 21 },
  hill2: { x: 16, y: 12 },
  /** The weir card: a weir across the river, from bank to bank (low summer water). */
  weir: [
    [24.4, 45.6],
    [31.6, 38.4],
  ] as Pt[],
  /**
   * The gate card, east of the river: a walled reservoir (`pond`, inclusive
   * cell rectangle) with a gate in its west wall at `gate`, a canal from the
   * gate down to the river along y = gate.y, dry fields on either side and
   * a small village to the south.
   */
  gate: {
    pond: { x0: 80, y0: 58, x1: 94, y1: 74 },
    gate: { x: 80, y: 66 },
    canalEnd: 64,
    village: { x: 74, y: 80 },
  },
  /**
   * The water wheel card, east of the river's lower straight reach: a
   * terrace `lift` m above the river's surface from the bank on, a wheel in
   * the river on row `y`, a shallow trench from its head cell east along
   * that row to x = trenchEnd, dry fields either side, a small village.
   */
  wheel: {
    y: 84,
    lift: 3,
    trenchEnd: 85,
    village: { x: 85, y: 75 },
  },
  /**
   * The turbine card: a turbine tapped onto the weir card's weir, and a
   * hamlet (store at `village`, cottages at `houses`) on the bank beside it.
   */
  turbine: {
    turbine: [28, 42] as Pt,
    village: { x: 34, y: 38 },
    houses: [
      [31, 35],
      [33, 36],
      [35, 40],
      [34, 43],
    ] as Pt[],
  },
  /** The rain front of the 'water' scene: start, velocity (cells per step), size, lifetime (steps). */
  front: { x: 14, y: 116, vx: 0.11, vy: -0.11, rx: 20, ry: 22, life: 760 },
};
