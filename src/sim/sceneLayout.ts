/**
 * Landmarks of the welcome-scene world (sim/scenes.ts), in cells. A module
 * of its own so the UI can point cameras and the scripted trench at them
 * without pulling the simulation into the main bundle.
 */
import type { Pt } from '../shared/protocol';

export const SCENE_LAYOUT = {
  /** A side pond, open to the river (fish, the fisher's spot). */
  pond: { x: 20, y: 41, r: 4.8 },
  /** A dry hollow across the river, lower than the river's water surface. */
  hollow: { x: 40, y: 25, r: 4.2 },
  /** The trench the intro draws: from the river bank into the hollow. */
  trench: [
    [33.5, 33.5],
    [35.5, 30],
    [38, 27.5],
    [40, 25.5],
  ] as Pt[],
  /** The village store. */
  village: { x: 21, y: 50 },
  /** The wooded hill. */
  hill: { x: 47, y: 10 },
};
