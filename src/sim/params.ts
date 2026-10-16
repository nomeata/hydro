/**
 * Tunable rates of slow processes, in "per game day" units, plus helpers to
 * convert them to per-step amounts. See constants.ts for the two clocks.
 */
import { STEPS_PER_DAY } from './constants';

export const PARAMS = {
  /** Rain depth per game day under a front of intensity 1 (m/day). */
  rainPerDay: 0.03,
  /** Extra rain factor per 100 m of elevation (orographic effect). */
  orographicPer100m: 0.12,
  /** Expected number of new rain fronts per game day, by season (spring, summer, autumn, winter). */
  frontsPerDay: [0.7, 0.35, 0.6, 0.45],

  /** Open-water evaporation at 20 °C (m/day). */
  evapPerDay: 0.006,
  /** Topsoil (groundwater) evaporation at 20 °C and full saturation (m/day). */
  soilEvapPerDay: 0.003,
  /** Infiltration scale applied to SOIL_PROPS.infiltration (m per hydro second). */
  infiltrationScale: 1.0,

  /** Snow melt per °C above zero (m/day/°C). */
  meltPerDegreeDay: 0.004,

  /** Seasonal temperature at sea level: mean and amplitude (°C). */
  tempMean: 9,
  tempAmplitude: 12,
  /** Lapse rate (°C per metre). */
  lapseRate: 0.0065,

  /** Spirit-crew earthworks: vertical change per plan cell per day (m), and cells worked in parallel. */
  builderRatePerDay: 1.5,
  builderCells: 160,
} as const;

/** Convert a per-day amount to a per-step amount. */
export function perStep(perDay: number): number {
  return perDay / STEPS_PER_DAY;
}
