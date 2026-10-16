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

  // --- Geomorphology (M1b): erosion, deposition, talus, weathering ---------
  // See hydro/erosion.ts and hydro/talus.ts. Hydraulic-time rates are per
  // hydraulic second; MORFAC speeds up all bed changes (it scales the
  // transport capacity, so sediment stays exactly conserved).

  /** Morphological acceleration factor. */
  morfac: 60,
  /** Transport capacity coefficient: equilibrium concentration per (m/s)^1.5 of excess speed (×MORFAC). */
  capacityK: 4e-5,
  /** Critical flow speed below which water picks up nothing (m/s). */
  criticalVelocity: 0.4,
  /** Water depth below which there is no pickup, and at which capacity ramps in fully (m). */
  erosionMinDepth: 0.03,
  erosionFullDepth: 0.15,
  /** Depth beyond which capacity no longer grows (m). */
  capacityMaxDepth: 2,
  /** Pickup rate: fraction of the capacity deficit taken up per hydraulic second (× erodibility). */
  pickupRate: 0.05,
  /** Settling velocity (m/s): deposition fraction per second is settling / depth. */
  settlingVelocity: 0.01,
  /** Max fraction of local soil eroded in one pass. */
  maxSoilFraction: 0.1,
  /** Erodibility of bare bedrock (soil erodibility is ~1). */
  bedrockErodibility: 1e-3,
  /** Deposits may rise this far above the mean of the 4 neighbours (m). */
  depositSlack: 0.05,
  /**
   * Bank erosion: bank lowering per hydraulic second per m/s of excess flow
   * speed (×MORFAC), times how directly the flow runs into the bank. The
   * material builds a point bar on the far side of the channel.
   */
  bankK: 3e-6,
  /** Flow speed needed for bank erosion (m/s). */
  bankCriticalVelocity: 0.4,
  /** Bank erosion weight for flow along a bank (flow straight into it counts 1). */
  bankAlong: 0,
  /** Bed-slope diffusion of the submerged bed per unit transport rate (dimensionless). */
  bedSlopeK: 1,
  /** Deposits from water slower than this count towards silt (m/s). */
  siltVelocity: 0.35,
  /** Accumulated deposit that turns a cell's topsoil to silt (slow water) or sand (bars on gravel) (m). */
  siltThreshold: 0.15,
  /**
   * Critical speed for pickup from the bed, as a multiple of criticalVelocity,
   * per soil type (rock, gravel, sand, loam, clay, silt, peat): coarse or
   * cohesive beds resist. Sediment already in the water uses the plain value.
   */
  bedCriticalFactor: [3, 2.5, 1, 1.2, 1.6, 1, 1.2],
  /** Net scour (m) after which a loose bed is armoured: its fines wash out, leaving gravel. */
  armourDepth: 0.3,
  /** Freshly dug or heaped soil: fraction by which looseness lowers the angle of repose... */
  looseRepose: 0.7,
  /** ...extra erodibility per unit looseness... */
  looseErodibility: 2,
  /** ...and the e-folding time (game days) in which it settles. */
  looseDays: 48,
  /** Fertility gained per metre of deposit. */
  fertilityPerMetre: 3,

  /** Talus: fraction of the excess over the repose slope moved per game day. */
  talusPerDay: 0.2,
  /** Repose multiplier when wet (saturated ground, or the slope's toe under water), per soil type. */
  reposeWet: [1, 0.85, 0.4, 0.75, 0.8, 0.5, 0.6],
  /** Ground saturation above which soil counts as wet for talus. */
  wetSaturation: 0.95,

  /** Bedrock weathering into soil under bare rock (m per game year); decays with soil depth. */
  weatheringPerYear: 0.03,
  /** e-folding soil depth for weathering (m). */
  weatheringDepth: 0.5,
  /** No weathering beyond this soil depth (m). */
  maxSoil: 5,
} as const;

/** Convert a per-day amount to a per-step amount. */
export function perStep(perDay: number): number {
  return perDay / STEPS_PER_DAY;
}
