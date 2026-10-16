/**
 * Vertical water exchange per cell: precipitation (rain or snow), snow melt,
 * infiltration into the soil bucket, exfiltration of excess groundwater,
 * evaporation from open water and topsoil, and prescribed inflows.
 *
 * Runs every few hydro steps with `steps` as the multiplier. Lateral
 * groundwater flow comes in M1c.
 */
import { CELL_AREA, DT, STEPS_PER_DAY, TILE } from '../constants';
import { PARAMS } from '../params';
import { SOIL_PROPS, type World } from '../world';

/** Running totals of every source and sink (m³), in f64. */
export interface Ledger {
  rain: number;
  snowfall: number;
  inflow: number;
  outflow: number;
  evaporation: number;
  /** Deep percolation from the soil into the regional aquifer (leaves the map). */
  seepage: number;
  /** Net water added by earthworks (water displaced when raising ground, etc). */
  earthworks: number;
}

export function newLedger(): Ledger {
  return { rain: 0, snowfall: 0, inflow: 0, outflow: 0, evaporation: 0, seepage: 0, earthworks: 0 };
}

export interface SoilWaterInput {
  /** Precipitation per tile, metres per step. */
  tileRain: Float32Array;
  /** Mean elevation per tile (m). */
  tileElevation: Float32Array;
  tilesWide: number;
  /** Sea-level temperature (°C). */
  seaLevelTemp: number;
  /** Number of hydro steps this update stands for. */
  steps: number;
}

export function soilWaterStep(world: World, inp: SoilWaterInput, ledger: Ledger): void {
  const { width: W, height: H, water, ground, soil, soilType, snow, inflow } = world;
  const { tileRain, tileElevation, tilesWide, seaLevelTemp, steps } = inp;
  const dayFrac = steps / STEPS_PER_DAY;
  const hydroSeconds = steps * DT;
  const meltK = PARAMS.meltPerDegreeDay * dayFrac;
  const infK = PARAMS.infiltrationScale * hydroSeconds;

  let rain = 0;
  let snowfall = 0;
  let inflowSum = 0;
  let evap = 0;
  let seep = 0;
  const deepK = PARAMS.deepDrainPerDay * dayFrac;

  for (let ty = 0; ty * TILE < H; ty++) {
    for (let tx = 0; tx * TILE < W; tx++) {
      const t = ty * tilesWide + tx;
      const precip = tileRain[t]! * steps;
      // Temperature for the tile.
      const temp = seaLevelTemp - PARAMS.lapseRate * tileElevation[t]!;
      const warm = Math.max(0, temp);
      const evapWater = PARAMS.evapPerDay * dayFrac * Math.max(0, (temp + 5) / 25);
      const evapSoil = PARAMS.soilEvapPerDay * dayFrac * Math.max(0, (temp + 5) / 25);
      const isSnow = temp < 0.5;
      const melt = meltK * warm;

      const x0 = tx * TILE;
      const y0 = ty * TILE;
      const x1 = Math.min(W, x0 + TILE);
      const y1 = Math.min(H, y0 + TILE);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * W + x;
          let h = water[i]!;

          // Inflow (m³/s → depth).
          const q = inflow[i]!;
          if (q > 0) {
            const add = (q * hydroSeconds) / CELL_AREA;
            h += add;
            inflowSum += add;
          }

          // Precipitation.
          if (precip > 0) {
            if (isSnow) {
              snow[i]! += precip;
              snowfall += precip;
            } else {
              h += precip;
              rain += precip;
            }
          }

          // Snow melt.
          const sn = snow[i]!;
          if (sn > 0 && melt > 0) {
            const m = Math.min(sn, melt);
            snow[i] = sn - m;
            h += m;
          }

          // Infiltration into the soil bucket.
          const props = SOIL_PROPS[soilType[i]!]!;
          const cap = soil[i]! * props.porosity;
          let g = ground[i]!;
          if (h > 0 && g < cap) {
            const room = cap - g;
            const inf = Math.min(h, room, props.infiltration * infK * (1 - g / Math.max(cap, 1e-6)));
            h -= inf;
            g += inf;
          }

          // Evaporation: open water first, then topsoil moisture.
          if (h > 0) {
            const e = Math.min(h, evapWater);
            h -= e;
            evap += e;
          } else if (g > 0 && cap > 0) {
            const e = Math.min(g, evapSoil * (g / cap));
            g -= e;
            evap += e;
          }

          // Deep percolation: wet soil slowly drains to the regional aquifer.
          if (g > 0 && cap > 0) {
            const d = Math.min(g, deepK * (g / cap) * Math.max(0.15, props.conductivity));
            g -= d;
            seep += d;
          }

          // Exfiltration: an overfull bucket overflows to the surface (springs, bogs).
          if (g > cap) {
            h += g - cap;
            g = cap;
          }

          water[i] = h;
          ground[i] = g;
        }
      }
    }
  }
  ledger.rain += rain * CELL_AREA;
  ledger.snowfall += snowfall * CELL_AREA;
  ledger.inflow += inflowSum * CELL_AREA;
  ledger.evaporation += evap * CELL_AREA;
  ledger.seepage += seep * CELL_AREA;
}
