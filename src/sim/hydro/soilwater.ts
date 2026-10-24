/**
 * Vertical water exchange per cell: precipitation (rain or snow), snow melt,
 * infiltration into the soil bucket, exfiltration of excess groundwater,
 * evaporation from open water and topsoil, and prescribed inflows.
 *
 * Runs every few hydro steps with `steps` as the multiplier. Lateral
 * groundwater flow comes in M1c.
 */
import type { ActiveSet } from '../active';
import { CELL_AREA, DT, STEPS_PER_DAY, TILE } from '../constants';
import { PARAMS } from '../params';
import { LandUse, SOIL_PROPS, type World } from '../world';

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
  /** Water moved uphill by water wheels (an internal transfer: river cell → head cell; absent in older saves). */
  lifted?: number;
  /**
   * Net snow gained on frozen land outside the active set (snowfall minus
   * melt there; m³). The frozen land keeps a cheap snowpack so that winter
   * looks the same everywhere; its meltwater leaves (frozen land does not
   * run off). Absent in older saves.
   */
  frozenSnow?: number;
}

export function newLedger(): Ledger {
  return { rain: 0, snowfall: 0, inflow: 0, outflow: 0, evaporation: 0, seepage: 0, earthworks: 0, lifted: 0, frozenSnow: 0 };
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
  /** Multiplier on every prescribed inflow (river seasons and wet/dry years; default 1). */
  inflowScale?: number;
  /** Only these tiles are updated (on frozen land only the snowpack is, see `FrozenSnow`). */
  active?: ActiveSet | null;
  /** Scratch for the frozen land's snowpack (with `active`; without it frozen land gets no snow). */
  frozen?: FrozenSnow | null;
}

/**
 * Per-tile bookkeeping for the snowpack on frozen tiles: which ones hold
 * snow, and their highest ground (the coldest cell), so that tiles that can
 * neither get nor lose snow are skipped. Frozen ground does not change, so
 * the heights are taken once per change of the active set.
 */
export class FrozenSnow {
  hasSnow = new Uint8Array(0);
  maxH = new Float32Array(0);
  private version = -1;

  refresh(world: World, act: ActiveSet): void {
    if (this.version === act.version && this.hasSnow.length === act.tw * act.th) return;
    this.version = act.version;
    const { tw, th } = act;
    if (this.hasSnow.length !== tw * th) {
      this.hasSnow = new Uint8Array(tw * th);
      this.maxH = new Float32Array(tw * th);
    }
    const { width: W, height: H, bedrock, soil, snow } = world;
    for (let ty = 0; ty < th; ty++)
      for (let tx = 0; tx < tw; tx++) {
        const t = ty * tw + tx;
        if (act.tile[t]) continue;
        let m = -Infinity;
        let has = 0;
        for (let y = ty * TILE; y < Math.min(H, (ty + 1) * TILE); y++)
          for (let x = tx * TILE, i = y * W + x; x < Math.min(W, (tx + 1) * TILE); x++, i++) {
            const h = bedrock[i]! + soil[i]!;
            if (h > m) m = h;
            if (snow[i]! > 0) has = 1;
          }
        this.maxH[t] = m;
        this.hasSnow[t] = has;
      }
  }
}

/**
 * Precipitation at cell (x, y): the tile field interpolated bilinearly
 * between tile centres, so that snow depth has no steps at tile edges.
 */
function cellPrecip(tileRain: Float32Array, tw: number, th: number, x: number, y: number): number {
  let fx = (x + 0.5) / TILE - 0.5;
  let fy = (y + 0.5) / TILE - 0.5;
  fx = fx < 0 ? 0 : fx > tw - 1 ? tw - 1 : fx;
  fy = fy < 0 ? 0 : fy > th - 1 ? th - 1 : fy;
  const x0 = Math.min(tw - 2, Math.floor(fx));
  const y0 = Math.min(th - 2, Math.floor(fy));
  if (x0 < 0 || y0 < 0) return tileRain[Math.max(0, y0) * tw + Math.max(0, x0)]!;
  const ax = fx - x0;
  const ay = fy - y0;
  const t = y0 * tw + x0;
  const a = tileRain[t]! + (tileRain[t + 1]! - tileRain[t]!) * ax;
  const b = tileRain[t + tw]! + (tileRain[t + tw + 1]! - tileRain[t + tw]!) * ax;
  return a + (b - a) * ay;
}

/**
 * Snow water equivalent (m) at which the ground is about two-thirds white.
 * Fresh snow is roughly ten times its water depth, so a few millimetres of
 * water already make a few centimetres of snow that hide the grass.
 */
export const SNOW_COVER_SWE = 0.005;

/** Snow cover as the look texture packs it (0..255): saturating in the snow's water depth. */
export function snowCoverByte(swe: number): number {
  return swe > 0 ? Math.round(255 * (1 - Math.exp(-swe / SNOW_COVER_SWE))) : 0;
}

export function soilWaterStep(world: World, inp: SoilWaterInput, ledger: Ledger): void {
  const { width: W, height: H, water, ground, soil, soilType, snow, inflow, vegetation, landuse, bedrock } = world;
  const vegInf = PARAMS.vegetationInfiltration;
  const { tileRain, tileElevation, tilesWide, seaLevelTemp, steps } = inp;
  const qScale = inp.inflowScale ?? 1;
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

  const act = inp.active && !inp.active.all ? inp.active : null;
  const frozen = act ? inp.frozen : null;
  if (frozen) frozen.refresh(world, act!);
  const tilesHigh = Math.ceil(H / TILE);
  let frozenNet = 0;
  for (let ty = 0; ty * TILE < H; ty++) {
    for (let tx = 0; tx * TILE < W; tx++) {
      if (act && !act.tile[ty * act.tw + tx]) {
        if (frozen) frozenNet += frozenSnowTile(world, inp, frozen, tx, ty, tilesHigh, meltK);
        continue;
      }
      const t = ty * tilesWide + tx;
      // Temperature for the tile.
      const temp = seaLevelTemp - PARAMS.lapseRate * tileElevation[t]!;
      const evapWater = PARAMS.evapPerDay * dayFrac * Math.max(0, (temp + 5) / 25);
      const evapSoil = PARAMS.soilEvapPerDay * dayFrac * Math.max(0, (temp + 5) / 25);
      // Snow or rain, and melt, follow each cell's own height (the snow
      // line is a contour, not the edge of a tile).
      const lapse = PARAMS.lapseRate;
      // Precipitation reaches a cell from this tile's and its neighbours' rain (bilinear): none there, none here.
      let rainy = false;
      for (let dy = -1; dy <= 1 && !rainy; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = tx + dx;
          const ny = ty + dy;
          if (nx >= 0 && ny >= 0 && nx < tilesWide && ny < tilesHigh && tileRain[ny * tilesWide + nx]! !== 0) {
            rainy = true;
            break;
          }
        }

      const x0 = tx * TILE;
      const y0 = ty * TILE;
      const x1 = Math.min(W, x0 + TILE);
      const y1 = Math.min(H, y0 + TILE);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * W + x;
          let h = water[i]!;

          // Inflow (m³/s → depth).
          const q = inflow[i]! * qScale;
          if (q > 0) {
            const add = (q * hydroSeconds) / CELL_AREA;
            h += add;
            inflowSum += add;
          }

          const precip = rainy ? cellPrecip(tileRain, tilesWide, tilesHigh, x, y) * steps : 0;
          const sn0 = snow[i]!;
          const cellTemp = precip > 0 || sn0 > 0 ? seaLevelTemp - lapse * (bedrock[i]! + soil[i]!) : temp;
          const isSnow = cellTemp < 0.5;
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
          // Trodden snow on paths goes first (packed, dirty, thin).
          const melt =
            landuse[i] === LandUse.Path
              ? meltK * PARAMS.pathMeltFactor * Math.max(0, cellTemp + PARAMS.pathMeltWarmth)
              : meltK * Math.max(0, cellTemp);
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
            // Roots open the soil; trodden paths seal it a little.
            const open = (1 + vegInf * vegetation[i]!) * (landuse[i] === LandUse.Path ? PARAMS.pathInfiltration : 1);
            const inf = Math.min(h, room, props.infiltration * infK * open * (1 - g / Math.max(cap, 1e-6)));
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
  if (frozenNet !== 0) ledger.frozenSnow = (ledger.frozenSnow ?? 0) + frozenNet * CELL_AREA;
}

/**
 * The snowpack on one frozen tile: snowfall where the cell is below
 * freezing, degree-day melt (the meltwater leaves). The same rules as on
 * active land, so the snow has no edge where the active set ends.
 * Returns the net snow added (m per cell area, summed).
 */
function frozenSnowTile(world: World, inp: SoilWaterInput, fz: FrozenSnow, tx: number, ty: number, th: number, meltK: number): number {
  const { width: W, height: H, snow, bedrock, soil } = world;
  const { tileRain, tilesWide: tw, seaLevelTemp, steps } = inp;
  const t = ty * tw + tx;
  const lapse = PARAMS.lapseRate;
  if (!fz.hasSnow[t]) {
    // No snow to melt: only fresh snow matters, which needs cold ground and precipitation nearby.
    if (seaLevelTemp - lapse * fz.maxH[t]! >= 0.5) return 0;
    let wet = false;
    for (let dy = -1; dy <= 1 && !wet; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = tx + dx;
        const ny = ty + dy;
        if (nx >= 0 && ny >= 0 && nx < tw && ny < th && tileRain[ny * tw + nx]! > 0) {
          wet = true;
          break;
        }
      }
    if (!wet) return 0;
  }
  let net = 0;
  let has = 0;
  const x0 = tx * TILE;
  const y0 = ty * TILE;
  const x1 = Math.min(W, x0 + TILE);
  const y1 = Math.min(H, y0 + TILE);
  for (let y = y0; y < y1; y++)
    for (let x = x0, i = y * W + x0; x < x1; x++, i++) {
      const cellTemp = seaLevelTemp - lapse * (bedrock[i]! + soil[i]!);
      let sn = snow[i]!;
      if (cellTemp < 0.5) {
        const p = cellPrecip(tileRain, tw, th, x, y) * steps;
        sn += p;
        net += p;
      }
      if (sn > 0 && cellTemp > 0) {
        const m = Math.min(sn, meltK * cellTemp);
        sn -= m;
        net -= m;
      }
      snow[i] = sn;
      if (sn > 0) has = 1;
    }
  fz.hasSnow[t] = has;
  return net;
}
