/**
 * Fluvial erosion and deposition (ARCHITECTURE §3.3), bank erosion and
 * bedrock weathering.
 *
 * Suspended sediment (world.sediment, m³ per cell) is carried by the flow
 * kernel. Here it is exchanged with the bed: water below its transport
 * capacity picks up soil, water above it lets sediment settle. All exchanges
 * are exactly conservative (bedrock + soil + sediment/area); the only
 * sources and sinks are boundary inflows, outlets and weathering (which turns
 * bedrock into soil without changing the surface). MORFAC scales capacity
 * and bank erosion, so morphology runs faster than hydraulic time.
 *
 * Safeguards: no pickup in shallow or slow water; at most a fraction of the
 * local soil per pass; never below the lowest neighbour; deposits never rise
 * more than a little above the neighbours; bare bedrock is ~1000× harder;
 * lined cells, outlets and inflow cells never change their bed.
 */
import { CELL, CELL_AREA, DAYS_PER_YEAR } from '../constants';
import { PARAMS } from '../params';
import { CellFlag, SOIL_PROPS, SoilType, type World } from '../world';

/** The tunables used by erosion, talus and weathering (a mutable copy of PARAMS' geomorphology part). */
export interface GeoParams {
  morfac: number;
  capacityK: number;
  criticalVelocity: number;
  erosionMinDepth: number;
  erosionFullDepth: number;
  capacityMaxDepth: number;
  pickupRate: number;
  settlingVelocity: number;
  maxSoilFraction: number;
  bedrockErodibility: number;
  depositSlack: number;
  bankK: number;
  bankCriticalVelocity: number;
  bankBase: number;
  bedSlopeK: number;
  siltVelocity: number;
  siltThreshold: number;
  fertilityPerMetre: number;
  talusPerDay: number;
  reposeWet: number[];
  wetSaturation: number;
  weatheringPerYear: number;
  weatheringDepth: number;
  maxSoil: number;
}

export function defaultGeoParams(): GeoParams {
  const p = PARAMS;
  return {
    morfac: p.morfac,
    capacityK: p.capacityK,
    criticalVelocity: p.criticalVelocity,
    erosionMinDepth: p.erosionMinDepth,
    erosionFullDepth: p.erosionFullDepth,
    capacityMaxDepth: p.capacityMaxDepth,
    pickupRate: p.pickupRate,
    settlingVelocity: p.settlingVelocity,
    maxSoilFraction: p.maxSoilFraction,
    bedrockErodibility: p.bedrockErodibility,
    depositSlack: p.depositSlack,
    bankK: p.bankK,
    bankCriticalVelocity: p.bankCriticalVelocity,
    bankBase: p.bankBase,
    bedSlopeK: p.bedSlopeK,
    siltVelocity: p.siltVelocity,
    siltThreshold: p.siltThreshold,
    fertilityPerMetre: p.fertilityPerMetre,
    talusPerDay: p.talusPerDay,
    reposeWet: [...p.reposeWet],
    wetSaturation: p.wetSaturation,
    weatheringPerYear: p.weatheringPerYear,
    weatheringDepth: p.weatheringDepth,
    maxSoil: p.maxSoil,
  };
}

/** Running sediment totals (m³), in f64. */
export interface SedimentLedger {
  /** Added with boundary/spring inflows. */
  inflow: number;
  /** Removed through outlets. */
  outflow: number;
  /** Picked up from the bed (incl. banks). */
  eroded: number;
  /** Of which from banks. */
  bank: number;
  /** Settled onto the bed. */
  deposited: number;
  /** Bedrock turned into soil (no surface change). */
  weathered: number;
  /** Soil moved by talus (gross, one direction). */
  talus: number;
}

export function newSedimentLedger(): SedimentLedger {
  return { inflow: 0, outflow: 0, eroded: 0, bank: 0, deposited: 0, weathered: 0, talus: 0 };
}

/** Inclusive row range of changed terrain; y1 < y0 means none. */
export interface RowRange {
  y0: number;
  y1: number;
}

/** Per-cell state that is not saved (silt accumulation since the last reset). */
export class ErosionScratch {
  /** Slow-water deposit accumulated per cell (m), drives conversion to silt. */
  readonly siltAcc: Float32Array;
  /** Sediment transport rate per unit width (capacity × speed, m²/s) of the last pass. */
  readonly transport: Float32Array;
  /**
   * Sediment concentration carried by each inflow cell's water: a slow
   * moving average of the flux-weighted capacity concentration of the flow
   * just downstream, so the reach below an inflow neither starves nor chokes.
   */
  readonly inflowConc: Float32Array;
  /** Hydraulic seconds seen so far. */
  time = 0;
  constructor(size: number) {
    this.siltAcc = new Float32Array(size);
    this.inflowConc = new Float32Array(size);
    this.transport = new Float32Array(size);
  }
}

const NO_EXCHANGE = CellFlag.Lined | CellFlag.Outlet;

/** Equilibrium suspended sediment for a cell, as a height (m) over the cell. */
export function capacity(h: number, speed: number, p: GeoParams): number {
  if (h <= p.erosionMinDepth) return 0;
  const ex = speed - p.criticalVelocity;
  if (ex <= 0) return 0;
  const ramp = h >= p.erosionFullDepth ? 1 : (h - p.erosionMinDepth) / (p.erosionFullDepth - p.erosionMinDepth);
  const hc = h < p.capacityMaxDepth ? h : p.capacityMaxDepth;
  return p.morfac * p.capacityK * ex * Math.sqrt(ex) * hc * ramp;
}

/**
 * Lower bedrock by up to `dz` and return the change actually stored: bedrock
 * values are large, so tiny changes round in f32 and must be accounted exactly.
 */
function lowerBedrock(bedrock: Float32Array, i: number, dz: number): number {
  const b = bedrock[i]!;
  const nb = Math.fround(b - dz);
  bedrock[i] = nb;
  return b - nb;
}

/** Radius (cells) searched for the equilibrium concentration of an inflow. */
const INFLOW_REACH = 4;
/** Inflow concentrations start learning after a game day of spin-up (hydraulic s)... */
const INFLOW_SPINUP = 300;
/** ...and then follow the flow with this time constant (hydraulic s, 10 game days). */
const INFLOW_TAU = 3000;

/** Flux-weighted capacity concentration of the flow near an inflow cell. */
function inflowConcentration(world: World, x: number, y: number, p: GeoParams): number {
  const { width: W, height: H, water, velX, velY } = world;
  let sed = 0;
  let flux = 0;
  for (let yy = Math.max(0, y - INFLOW_REACH); yy <= Math.min(H - 1, y + INFLOW_REACH); yy++)
    for (let xx = Math.max(0, x - INFLOW_REACH); xx <= Math.min(W - 1, x + INFLOW_REACH); xx++) {
      const j = yy * W + xx;
      const h = water[j]!;
      if (h <= p.erosionMinDepth) continue;
      const v = Math.hypot(velX[j]!, velY[j]!);
      sed += capacity(h, v, p) * v;
      flux += h * v;
    }
  return flux > 0 ? sed / flux : 0;
}

/** Remove `dz` metres of soil from a cell, squeezing out groundwater that no longer fits. */
function takeSoil(world: World, i: number, dz: number): void {
  const s = world.soil[i]! - dz;
  world.soil[i] = s;
  const cap = s * SOIL_PROPS[world.soilType[i]!]!.porosity;
  const g = world.ground[i]!;
  if (g > cap) {
    world.water[i]! += g - cap;
    world.ground[i] = cap;
  }
}

/**
 * One erosion/deposition pass over the whole grid, standing for `dt`
 * hydraulic seconds. Updates `dirty` with the rows whose terrain changed.
 */
export function erosionStep(
  world: World,
  scratch: ErosionScratch,
  dt: number,
  p: GeoParams,
  ledger: SedimentLedger,
  dirty: RowRange,
): void {
  const { width: W, height: H, bedrock, soil, soilType, water, sediment, velX, velY, flags, inflow, fertility } = world;
  const { siltAcc, transport, inflowConc } = scratch;
  const t0 = scratch.time;
  scratch.time = t0 + dt;
  // Inflow concentration: a running mean at first, then an exponential average.
  const learn = t0 < INFLOW_SPINUP ? 0 : Math.max(dt / (t0 - INFLOW_SPINUP + dt), dt / INFLOW_TAU);
  const A = CELL_AREA;
  const hMin = p.erosionMinDepth;
  const pickup = Math.min(1, p.pickupRate * dt);
  const settle = p.settlingVelocity * dt;
  const maxFrac = p.maxSoilFraction;
  const bedK = p.bedrockErodibility;
  const slack = p.depositSlack;
  const bankK = p.bankK * p.morfac * dt;
  const vcBank = p.bankCriticalVelocity;
  const bankBase = p.bankBase;
  const vSilt = p.siltVelocity;
  const siltT = p.siltThreshold;
  const fertK = p.fertilityPerMetre;

  let eroded = 0;
  let bank = 0;
  let deposited = 0;
  let sedIn = 0;
  let y0 = dirty.y0;
  let y1 = dirty.y1;

  for (let y = 0; y < H; y++) {
    const row = y * W;
    let changed = false;
    for (let x = 0; x < W; x++) {
      const i = row + x;
      const h = water[i]!;
      let s = sediment[i]!;
      transport[i] = 0;
      if (h <= hMin && s <= 0) continue;
      const f = flags[i]!;
      const vx = velX[i]!;
      const vy = velY[i]!;
      const speed = Math.sqrt(vx * vx + vy * vy);

      // Inflow cells: water arrives carrying sediment at the equilibrium
      // concentration of the river just downstream. Their bed is pinned.
      if (inflow[i]! > 0) {
        if (learn > 0) inflowConc[i]! += learn * (inflowConcentration(world, x, y, p) - inflowConc[i]!);
        const want = inflowConc[i]! * h * A;
        if (s < want) {
          sedIn += want - s;
          sediment[i] = want;
        }
        continue;
      }
      if ((f & NO_EXCHANGE) !== 0) continue;

      const zi = bedrock[i]! + soil[i]!;
      // Neighbour terrain extremes and mean.
      let zmin = Infinity;
      let zmax = -Infinity;
      let zsum = 0;
      let nn = 0;
      if (x > 0) {
        const z = bedrock[i - 1]! + soil[i - 1]!;
        zmin = Math.min(zmin, z);
        zmax = Math.max(zmax, z);
        zsum += z;
        nn++;
      }
      if (x < W - 1) {
        const z = bedrock[i + 1]! + soil[i + 1]!;
        zmin = Math.min(zmin, z);
        zmax = Math.max(zmax, z);
        zsum += z;
        nn++;
      }
      if (y > 0) {
        const z = bedrock[i - W]! + soil[i - W]!;
        zmin = Math.min(zmin, z);
        zmax = Math.max(zmax, z);
        zsum += z;
        nn++;
      }
      if (y < H - 1) {
        const z = bedrock[i + W]! + soil[i + W]!;
        zmin = Math.min(zmin, z);
        zmax = Math.max(zmax, z);
        zsum += z;
        nn++;
      }

      const kh = capacity(h, speed, p);
      const kap = kh * A;
      transport[i] = kh * speed;
      if (kap > s) {
        // Pickup.
        const props = SOIL_PROPS[soilType[i]!]!;
        const room = 0.5 * (zi - zmin);
        if (room > 0) {
          const demand = ((kap - s) * pickup) / A;
          const so = soil[i]!;
          let e = Math.min(demand * props.erodibility, maxFrac * so, room);
          if (e < 0) e = 0;
          let eb = 0;
          if (e < demand * props.erodibility && so * maxFrac < 1e-3) {
            // Soil exhausted: bare bedrock, much harder.
            eb = Math.min(demand * bedK, room - e);
            if (eb < 0) eb = 0;
          }
          if (e > 0) takeSoil(world, i, e);
          if (eb > 0) eb = lowerBedrock(bedrock, i, eb);
          const tot = e + eb;
          if (tot > 0) {
            s += tot * A;
            eroded += tot * A;
            siltAcc[i] = Math.max(0, siltAcc[i]! - tot);
            changed = true;
          }
        }
      } else if (s > 0) {
        // Settling.
        const rate = h > hMin ? Math.min(1, settle / h) : 1;
        let d = ((s - kap) * rate) / A;
        const top = Math.max(zmax, zsum / nn + slack) - zi;
        if (d > top) d = top > 0 ? top : 0;
        if (d > 0) {
          soil[i]! += d;
          s -= d * A;
          if (s < 0) s = 0;
          deposited += d * A;
          if (speed < vSilt) {
            const acc = siltAcc[i]! + d;
            siltAcc[i] = acc;
            const st = soilType[i]!;
            if (acc > siltT && st !== SoilType.Silt && st !== SoilType.Peat) soilType[i] = SoilType.Silt;
            const fe = fertility[i]! + d * fertK;
            fertility[i] = fe > 1 ? 1 : fe;
          }
          changed = true;
        }
      }

      // Bank erosion: fast flow wears down a neighbour that stands above the
      // water surface, most where the flow runs into it (outer banks of
      // bends). Rivers widen until the flow along their banks is too slow.
      if (h > hMin && speed > vcBank) {
        const eta = zi + h;
        const drive = speed - vcBank;
        const ux = vx / speed;
        const uy = vy / speed;
        let b = 0;
        if (x < W - 1) b += bankErode(world, zi, i + 1, drive * (bankBase + (ux > 0 ? ux : 0)), eta, bankK, maxFrac, bedK);
        if (x > 0) b += bankErode(world, zi, i - 1, drive * (bankBase + (ux < 0 ? -ux : 0)), eta, bankK, maxFrac, bedK);
        if (y < H - 1) b += bankErode(world, zi, i + W, drive * (bankBase + (uy > 0 ? uy : 0)), eta, bankK, maxFrac, bedK);
        if (y > 0) b += bankErode(world, zi, i - W, drive * (bankBase + (uy < 0 ? -uy : 0)), eta, bankK, maxFrac, bedK);
        if (b > 0) {
          s += b;
          bank += b;
          if (y - 1 < y0) y0 = Math.max(0, y - 1);
          if (y + 1 > y1) y1 = Math.min(H - 1, y + 1);
        }
      }
      sediment[i] = s;
      if (changed) {
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  dirty.y0 = y0;
  dirty.y1 = y1;
  if (p.bedSlopeK > 0) bedSlope(world, transport, dt, p, dirty);
  ledger.eroded += eroded + bank;
  ledger.bank += bank;
  ledger.deposited += deposited;
  ledger.inflow += sedIn;
}

/**
 * Bed-slope effect: moving sediment is deflected down transverse bed slopes,
 * which acts as a diffusion of the submerged bed with a diffusivity
 * proportional to the local transport rate. It keeps channels from cutting
 * one-cell-wide slots, and is inactive where nothing moves (lakes, slow
 * rivers), so it never fills quiet channels. Conservative: soil moves
 * between wet neighbours.
 */
function bedSlope(world: World, transport: Float32Array, dt: number, p: GeoParams, dirty: RowRange): void {
  const { width: W, height: H, bedrock, soil, water, flags, inflow } = world;
  const hMin = p.erosionMinDepth;
  const k = (p.bedSlopeK * dt) / (CELL * CELL);
  const maxFrac = p.maxSoilFraction;
  let y0 = dirty.y0;
  let y1 = dirty.y1;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const i = row + x;
      const ti = transport[i]!;
      if (water[i]! <= hMin || (flags[i]! & NO_EXCHANGE) !== 0 || inflow[i]! > 0) continue;
      // Right and down faces (each face once).
      for (let f = 0; f < 2; f++) {
        let j: number;
        if (f === 0) {
          if (x === W - 1) continue;
          j = i + 1;
        } else {
          if (y === H - 1) continue;
          j = i + W;
        }
        const tj = transport[j]!;
        if (ti + tj <= 0 || water[j]! <= hMin || (flags[j]! & NO_EXCHANGE) !== 0 || inflow[j]! > 0) continue;
        const dz = bedrock[i]! + soil[i]! - (bedrock[j]! + soil[j]!);
        let m = k * 0.5 * (ti + tj) * dz;
        const lim = 0.25 * Math.abs(dz);
        if (m > lim) m = lim;
        else if (m < -lim) m = -lim;
        if (m > 0) {
          const c = maxFrac * soil[i]!;
          if (m > c) m = c;
        } else {
          const c = maxFrac * soil[j]!;
          if (-m > c) m = -c;
        }
        if (m === 0) continue;
        if (m > 0) {
          takeSoil(world, i, m);
          soil[j]! += m;
        } else {
          takeSoil(world, j, -m);
          soil[i]! -= m;
        }
        if (y < y0) y0 = y;
        if (y + f > y1) y1 = y + f;
      }
    }
  }
  dirty.y0 = y0;
  dirty.y1 = y1;
}

/** Lower bank cell j next to a channel cell with terrain zi; returns the volume taken (m³). */
function bankErode(world: World, zi: number, j: number, un: number, eta: number, k: number, maxFrac: number, bedK: number): number {
  if ((world.flags[j]! & NO_EXCHANGE) !== 0 || world.inflow[j]! > 0) return 0;
  const zj = world.bedrock[j]! + world.soil[j]!;
  if (zj <= eta) return 0;
  const room = 0.5 * (zj - zi);
  const so = world.soil[j]!;
  let e = Math.min(k * un * SOIL_PROPS[world.soilType[j]!]!.erodibility, maxFrac * so, room);
  if (e < 0) e = 0;
  let eb = 0;
  if (so * maxFrac < 1e-3) eb = Math.max(0, Math.min(k * un * bedK, room - e));
  if (e + eb <= 0) return 0;
  if (e > 0) takeSoil(world, j, e);
  if (eb > 0) eb = lowerBedrock(world.bedrock, j, eb);
  return (e + eb) * CELL_AREA;
}

/**
 * Bedrock weathering for `days` game days: bedrock turns into soil at a rate
 * that decays with soil depth, so bare rock regains a thin regolith over
 * years. The surface does not move.
 */
export function weatherStep(world: World, days: number, p: GeoParams, ledger: SedimentLedger): void {
  const { size, bedrock, soil, flags } = world;
  const rate = (p.weatheringPerYear * days) / DAYS_PER_YEAR;
  const inv = 1 / p.weatheringDepth;
  const maxS = p.maxSoil;
  let sum = 0;
  for (let i = 0; i < size; i++) {
    if ((flags[i]! & CellFlag.Lined) !== 0) continue;
    const s = soil[i]!;
    if (s >= maxS) continue;
    let w = rate * Math.exp(-s * inv);
    if (s + w > maxS) w = maxS - s;
    w = lowerBedrock(bedrock, i, w);
    soil[i] = s + w;
    sum += w;
  }
  ledger.weathered += sum * CELL_AREA;
}

