/**
 * Simulation constants. Two clocks exist:
 *  - hydraulic time: the physical seconds that the shallow-water model
 *    integrates (DT per step). Water visibly flows at roughly 10× real speed.
 *  - ecological time: days/seasons/years. A day is a fixed number of steps.
 * Rates for slow processes (rain, evaporation, growth) are tuned in "per game
 * day" terms and converted per step, since a realistic hydraulic-time rain
 * rate would produce a trickle (or a deluge) on a map this small.
 */

/** Horizontal size of one cell in metres. */
export const CELL = 5;
export const CELL_AREA = CELL * CELL;
export const GRAVITY = 9.81;
/** Hydraulic seconds per step. Stable for depths up to ~CELL²/(g·DT²) ≈ 10 m. */
export const DT = 0.5;

export const STEPS_PER_DAY = 600;
export const DAYS_PER_SEASON = 12;
export const SEASONS_PER_YEAR = 4;
export const DAYS_PER_YEAR = DAYS_PER_SEASON * SEASONS_PER_YEAR;
/** Target steps per real second at 1× speed (⇒ a day is 30 s). */
export const STEPS_PER_SECOND_1X = 20;

/** Tile size for activity tracking and dirty regions. */
export const TILE = 16;

/** Depth below which a cell is considered dry. */
export const DRY = 1e-3;
