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
import { rowsOf, type ActiveSet } from '../active';
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
  bankAlong: number;
  bedSlopeK: number;
  siltVelocity: number;
  siltThreshold: number;
  fertilityPerMetre: number;
  bedCriticalVelocity: number[];
  armourDepth: number;
  looseRepose: number;
  looseErodibility: number;
  looseDays: number;
  /** Vegetation holds the soil: pickup erodibility × (1 − vegetationHold · vegetation). */
  vegetationHold: number;
  overtopK: number;
  overtopMinDrop: number;
  overtopMaxDrop: number;
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
    bankAlong: p.bankAlong,
    bedSlopeK: p.bedSlopeK,
    siltVelocity: p.siltVelocity,
    siltThreshold: p.siltThreshold,
    fertilityPerMetre: p.fertilityPerMetre,
    bedCriticalVelocity: p.bedCriticalFactor.map((f) => f * p.criticalVelocity),
    armourDepth: p.armourDepth,
    looseRepose: p.looseRepose,
    looseErodibility: p.looseErodibility,
    looseDays: p.looseDays,
    vegetationHold: p.vegetationHold,
    overtopK: p.overtopK,
    overtopMinDrop: p.overtopMinDrop,
    overtopMaxDrop: p.overtopMaxDrop,
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

/** One river entering the map: a connected group of inflow cells and the reach below it. */
interface InflowSource {
  cells: number[];
  /** Water discharge (m³/s). */
  q: number;
  /** Sediment concentration (m³ per m³ of water) carried by the inflow. */
  conc: number;
  /** Net volume eroded (+) or deposited (−) in the reach during the current pass (m³). */
  net: number;
}

/** Per-cell erosion state (saved sparsely via Simulation.getState). */
export class ErosionScratch {
  /**
   * Net deposit (+) or erosion (−) per cell since its soil type last changed
   * (m). Deposits turn the topsoil into silt (slow water) or sand (bars on
   * gravel); sustained scour washes out the fines and leaves gravel armour.
   */
  readonly bedAcc: Float32Array;
  /** Sediment transport rate per unit width (capacity × speed, m²/s) of the last pass. */
  readonly transport: Float32Array;
  /**
   * Sediment concentration carried by each inflow cell's water (the same
   * value for all cells of one source). It is what the river can carry:
   * a slow controller adjusts it so that the reach just below the inflow
   * neither degrades nor aggrades on average (see updateInflows).
   */
  readonly inflowConc: Float32Array;
  /**
   * Looseness of freshly worked soil (0..1): set by earthworks, it lowers
   * the angle of repose and raises erodibility, and decays as the soil
   * settles (looseDays), so new unlined trenches and dikes slump and wash
   * out during their first year.
   */
  readonly loose: Float32Array;
  /** Index of the inflow source whose reach a cell belongs to, or -1. */
  readonly reach: Int16Array;
  sources: InflowSource[] | null = null;
  /** Hydraulic seconds seen so far. */
  time = 0;
  constructor(size: number) {
    this.bedAcc = new Float32Array(size);
    this.inflowConc = new Float32Array(size);
    this.transport = new Float32Array(size);
    this.reach = new Int16Array(size).fill(-1);
    this.loose = new Float32Array(size);
  }
}

/**
 * Cells that neither give nor take sediment: stone lining, the open
 * boundary, and the ground under structures (a weir's wall is laid in
 * stone course by course, so the river cannot wash its last gap away while
 * the crew closes it; gates' sills, wheels' beds and poles stay put too).
 */
const NO_EXCHANGE = CellFlag.Lined | CellFlag.Outlet | CellFlag.Structure;
/** Max cells walked across a channel to find the point-bar side. */
const BAR_REACH = 8;

/**
 * Equilibrium suspended sediment for a cell, as a height (m) over the cell.
 * With the default critical speed and no depth ramp this is what the water
 * can keep in suspension (excess settles); pickup from the bed uses the
 * bed's own critical speed (coarser beds need faster water) and ramps in
 * with depth, so thin sheet flow does not scour hillsides. Between the two
 * the water neither erodes nor deposits.
 */
export function capacity(h: number, speed: number, p: GeoParams, vc = p.criticalVelocity, ramped = false): number {
  if (h <= p.erosionMinDepth) return 0;
  const ex = speed - vc;
  if (ex <= 0) return 0;
  const ramp = !ramped || h >= p.erosionFullDepth ? 1 : (h - p.erosionMinDepth) / (p.erosionFullDepth - p.erosionMinDepth);
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

/** Radius (cells) of the reach below an inflow whose bed the inflow's sediment load holds steady. */
const REACH_RADIUS = 8;
/** Inflow concentrations start from an estimate after a game day of spin-up (hydraulic s)... */
const INFLOW_SPINUP = 300;
/** ...and then follow the reach's sediment budget with this time constant (hydraulic s). */
const INFLOW_TAU = 600;
/** Upper bound on an inflow's sediment concentration (×MORFAC). */
const INFLOW_MAX_CONC = 0.05;

/** Group inflow cells into sources (8-connected) and label the reach around each. */
function buildSources(world: World, scratch: ErosionScratch): InflowSource[] {
  const { width: W, height: H, inflow } = world;
  const seen = new Uint8Array(world.size);
  const sources: InflowSource[] = [];
  const reach = scratch.reach;
  reach.fill(-1);
  for (let i0 = 0; i0 < world.size; i0++) {
    if (inflow[i0]! <= 0 || seen[i0]) continue;
    const cells: number[] = [];
    const stack = [i0];
    seen[i0] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      cells.push(i);
      const x = i % W;
      const y = (i - x) / W;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const j = yy * W + xx;
          if (inflow[j]! > 0 && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
    }
    cells.sort((a, b) => a - b);
    let q = 0;
    for (const c of cells) q += inflow[c]!;
    sources.push({ cells, q, conc: scratch.inflowConc[cells[0]!]!, net: 0 });
  }
  // Reaches: cells within REACH_RADIUS of a source (the first source wins).
  sources.forEach((src, k) => {
    for (const c of src.cells) {
      const x = c % W;
      const y = (c - x) / W;
      for (let yy = Math.max(0, y - REACH_RADIUS); yy <= Math.min(H - 1, y + REACH_RADIUS); yy++)
        for (let xx = Math.max(0, x - REACH_RADIUS); xx <= Math.min(W - 1, x + REACH_RADIUS); xx++) {
          const j = yy * W + xx;
          if (reach[j] === -1 && inflow[j]! <= 0) reach[j] = k;
        }
    }
  });
  return sources;
}

/** Flux-weighted capacity concentration of the flow in a source's reach (the initial estimate). */
function reachCapacity(world: World, scratch: ErosionScratch, k: number, p: GeoParams): number {
  const { water, velX, velY } = world;
  let sed = 0;
  let flux = 0;
  for (let j = 0; j < world.size; j++) {
    if (scratch.reach[j] !== k) continue;
    const h = water[j]!;
    if (h <= p.erosionMinDepth) continue;
    const v = Math.hypot(velX[j]!, velY[j]!);
    sed += capacity(h, v, p) * v;
    flux += h * v;
  }
  return flux > 0 ? sed / flux : 0;
}

/**
 * Inflow sediment controller: an inflow carries what its river can
 * transport. The reach below each inflow keeps a sediment budget; when it
 * erodes on balance the inflow brings more, when it silts up, less. In
 * equilibrium the bed just inside the map is held, the upstream analogue of
 * the outlets' pinned base level.
 */
function updateInflows(world: World, scratch: ErosionScratch, dt: number, p: GeoParams, t0: number): void {
  const sources = scratch.sources!;
  const conc = scratch.inflowConc;
  const start = t0 < INFLOW_SPINUP && t0 + dt >= INFLOW_SPINUP;
  for (let k = 0; k < sources.length; k++) {
    const src = sources[k]!;
    let c = src.conc;
    if (start) c = reachCapacity(world, scratch, k, p);
    else if (t0 >= INFLOW_SPINUP && src.q > 0) c += ((dt / INFLOW_TAU) * src.net) / (src.q * dt);
    if (!(c > 0)) c = 0;
    else if (c > INFLOW_MAX_CONC) c = INFLOW_MAX_CONC;
    // Kept at f32 precision so that inflowConc (saved) is the complete state.
    src.conc = Math.fround(c);
    src.net = 0;
    for (const i of src.cells) conc[i] = c;
  }
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
 * Overtopping: an unlined earthen bank (CellFlag.Fill, heaped by a plan)
 * that water pours over is scoured where it pours off its edge, i.e. where
 * water flows out of the cell into a neighbour whose ground is lower and
 * whose water surface stands clearly lower (the water falls; a submerged
 * toe beside a river does not scour this way). The cut deepens where most water goes, so an overtopped
 * dike notches and breaches, back from its downstream face. The soil goes
 * into the water as sediment (conserved; it settles downstream). Lined
 * cells (weirs, gates) do not scour. Standing for `dt` hydraulic seconds.
 */
export function overtopStep(world: World, scratch: ErosionScratch, dt: number, p: GeoParams, ledger: SedimentLedger, dirty: RowRange, active?: ActiveSet | null): void {
  const { width: W, height: H, bedrock, soil, soilType, water, sediment, qx, qy, flags, vegetation } = world;
  const rows = rowsOf(active, W, H);
  const k = p.overtopK * p.morfac * dt;
  const minDrop = p.overtopMinDrop;
  const maxDrop = p.overtopMaxDrop;
  /** The water must fall this much (m): a submerged toe beside a river does not scour this way. */
  const minFall = 0.1;
  const maxFrac = p.maxSoilFraction;
  const loose = scratch.loose;
  let eroded = 0;
  let y0 = dirty.y0;
  let y1 = dirty.y1;
  for (let r = 0; r < rows.length; r += 3) {
    const y = rows[r]!;
    const row = y * W;
    for (let x = rows[r + 1]!; x < rows[r + 2]!; x++) {
      const i = row + x;
      const f = flags[i]!;
      if ((f & CellFlag.Fill) === 0 || (f & NO_EXCHANGE) !== 0 || water[i]! < 0.01) continue;
      const zi = bedrock[i]! + soil[i]!;
      const si = zi + water[i]!;
      let drive = 0;
      let floor = -Infinity;
      const face = (j: number, q: number) => {
        if (q <= 0) return;
        const zj = bedrock[j]! + soil[j]!;
        const drop = zi - zj;
        if (drop < minDrop || zj + water[j]! > si - minFall) return;
        drive += q * Math.min(drop, maxDrop);
        floor = Math.max(floor, zj);
      };
      if (x < W - 1) face(i + 1, qx[i]!);
      if (x > 0) face(i - 1, -qx[i - 1]!);
      if (y < H - 1) face(i + W, qy[i]!);
      if (y > 0) face(i - W, -qy[i - W]!);
      if (drive <= 0) continue;
      const er = SOIL_PROPS[soilType[i]!]!.erodibility * (1 + p.looseErodibility * loose[i]!) * (1 - p.vegetationHold * vegetation[i]!);
      const dz = Math.min(k * drive * er, maxFrac * soil[i]!, 0.5 * (zi - floor));
      if (!(dz > 0)) continue;
      takeSoil(world, i, dz);
      sediment[i]! += dz * CELL_AREA;
      eroded += dz * CELL_AREA;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  ledger.eroded += eroded;
  dirty.y0 = y0;
  dirty.y1 = y1;
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
  active?: ActiveSet | null,
): void {
  const { width: W, height: H, bedrock, soil, soilType, water, sediment, velX, velY, flags, inflow, fertility, vegetation } = world;
  // Only active cells change; frozen neighbours are read, never written.
  const rows = rowsOf(active, W, H);
  const act = active && !active.all ? active : null;
  const { bedAcc, transport, inflowConc, reach, loose } = scratch;
  const vegHold = p.vegetationHold;
  const t0 = scratch.time;
  scratch.time = t0 + dt;
  if (!scratch.sources) scratch.sources = buildSources(world, scratch);
  const sources = scratch.sources;
  const A = CELL_AREA;
  const hMin = p.erosionMinDepth;
  const pickup = Math.min(1, p.pickupRate * dt);
  const settle = p.settlingVelocity * dt;
  const maxFrac = p.maxSoilFraction;
  const bedK = p.bedrockErodibility;
  const slack = p.depositSlack;
  const bankK = p.bankK * p.morfac * dt;
  const vcBank = p.bankCriticalVelocity;
  const vSilt = p.siltVelocity;
  const siltT = p.siltThreshold;
  const fertK = p.fertilityPerMetre;
  const vcBed = p.bedCriticalVelocity;
  const armour = p.armourDepth;
  const looseK = p.looseErodibility;

  let eroded = 0;
  let bank = 0;
  let deposited = 0;
  let sedIn = 0;
  let y0 = dirty.y0;
  let y1 = dirty.y1;

  for (let r = 0; r < rows.length; r += 3) {
    const y = rows[r]!;
    const row = y * W;
    let changed = false;
    for (let x = rows[r + 1]!; x < rows[r + 2]!; x++) {
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
        const want = inflowConc[i]! * h * A;
        if (s < want) {
          sedIn += want - s;
          sediment[i] = want;
        }
        continue;
      }
      if ((f & NO_EXCHANGE) !== 0) continue;

      const st0 = soilType[i]!;
      const kh = capacity(h, speed, p);
      // Clear water too slow to carry anything (most ponds and puddles):
      // no pickup, settling or bank erosion (vcBank ≥ the critical speed).
      if (kh === 0 && s <= 0) continue;
      const kap = kh * A;
      const kp = speed > vcBed[st0]! ? capacity(h, speed, p, vcBed[st0]!, true) * A : 0;
      transport[i] = kh * speed;

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

      if (kp > s) {
        // Pickup.
        const props = SOIL_PROPS[st0]!;
        const room = 0.5 * (zi - zmin);
        if (room > 0) {
          const demand = ((kp - s) * pickup) / A;
          const so = soil[i]!;
          const er = props.erodibility * (1 + looseK * loose[i]!) * (1 - vegHold * vegetation[i]!);
          let e = Math.min(demand * er, maxFrac * so, room);
          if (e < 0) e = 0;
          let eb = 0;
          if (e < demand * er && so * maxFrac < 1e-3) {
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
            const r = reach[i]!;
            if (r >= 0) sources[r]!.net += tot * A;
            const acc = bedAcc[i]! - tot;
            if (acc < -armour && st0 >= SoilType.Sand && st0 !== SoilType.Clay) {
              soilType[i] = SoilType.Gravel;
              bedAcc[i] = 0;
            } else bedAcc[i] = acc;
            changed = true;
          }
        }
      } else if (s > kap) {
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
          const r = reach[i]!;
          if (r >= 0) sources[r]!.net -= d * A;
          const acc = bedAcc[i]! + d;
          bedAcc[i] = acc;
          const slow = speed < vSilt;
          if (slow) {
            const fe = fertility[i]! + d * fertK;
            fertility[i] = fe > 1 ? 1 : fe;
          }
          if (acc > siltT) {
            if (slow && st0 !== SoilType.Silt && st0 !== SoilType.Peat) soilType[i] = SoilType.Silt;
            else if (!slow && st0 <= SoilType.Gravel) soilType[i] = SoilType.Sand;
            bedAcc[i] = 0;
          }
          changed = true;
        }
      }

      // Lateral migration: flow running into a bank (the outer bank of a
      // bend) wears it down, and the material is laid down as a point bar on
      // the far side of the channel. The channel shifts but keeps its width
      // and depth. Flow along a bank wears it a little (bankAlong), which
      // rounds off the sharp edges of dug trenches.
      if (h > hMin && speed > vcBank) {
        const eta = zi + h;
        const drive = speed - vcBank;
        const inv = 1 / speed;
        const along = p.bankAlong;
        for (let d = 0; d < 4; d++) {
          let step: number;
          let jx = x;
          let jy = y;
          if (d === 0) {
            if (x === W - 1) continue;
            step = 1;
            jx++;
          } else if (d === 1) {
            if (x === 0) continue;
            step = -1;
            jx--;
          } else if (d === 2) {
            if (y === H - 1) continue;
            step = W;
            jy++;
          } else {
            if (y === 0) continue;
            step = -W;
            jy--;
          }
          const j = i + step;
          if (act && !act.at(jx, jy)) continue;
          if (bedrock[j]! + soil[j]! <= eta) continue;
          // How directly the flow runs up the bank: velocity against the
          // bank's own uphill direction (from the smoothed terrain gradient,
          // not the grid axis, so straight diagonal channels do not widen).
          const gx = zAt(world, jx + 1, jy) - zAt(world, jx - 1, jy);
          const gy = zAt(world, jx, jy + 1) - zAt(world, jx, jy - 1);
          const gl = Math.sqrt(gx * gx + gy * gy);
          let un = gl > 0 ? ((vx * gx + vy * gy) * inv) / gl : 0;
          un = (un > 0 ? un : 0) + along;
          if (un <= 0) continue;
          const b = bankErode(world, zi, j, drive * un * (1 + looseK * loose[j]!), eta, bankK, maxFrac, bedK);
          if (b <= 0) continue;
          bank += b;
          const yb = y + (d === 2 ? 1 : d === 3 ? -1 : 0);
          if (yb < y0) y0 = yb;
          if (yb > y1) y1 = yb;
          // Walk across the channel to its far margin.
          let m = i;
          let mx = x;
          let my = y;
          const sx = d === 0 ? -1 : d === 1 ? 1 : 0;
          const sy = d === 2 ? -1 : d === 3 ? 1 : 0;
          for (let k = 0; k < BAR_REACH; k++) {
            const nx = mx + sx;
            const ny = my + sy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) break;
            if (act && !act.at(nx, ny)) break;
            const n = ny * W + nx;
            if (water[n]! <= hMin || (flags[n]! & NO_EXCHANGE) !== 0 || inflow[n]! > 0) break;
            m = n;
            mx = nx;
            my = ny;
          }
          let put = 0;
          if (m !== i) {
            const zm = bedrock[m]! + soil[m]!;
            const room = maxNeighbour(world, mx, my) - zm;
            put = Math.min(b / A, room > 0 ? room : 0);
            if (put > 0) {
              soil[m]! += put;
              deposited += put * A;
              const acc = bedAcc[m]! + put;
              if (acc > siltT) {
                if (soilType[m]! <= SoilType.Gravel) soilType[m] = SoilType.Sand;
                bedAcc[m] = 0;
              } else bedAcc[m] = acc;
              if (my < y0) y0 = my;
              if (my > y1) y1 = my;
            }
          }
          // Whatever does not fit on the bar goes downstream. (Bank and bar
          // exchanges are lateral and do not count towards the inflow reach
          // budget, only what is left over does.)
          s += b - put * A;
          const r = reach[i]!;
          if (r >= 0) sources[r]!.net += b - put * A;
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
  updateInflows(world, scratch, dt, p, t0);
  if (p.bedSlopeK > 0) bedSlope(world, transport, dt, p, dirty, rows, act);
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
function bedSlope(world: World, transport: Float32Array, dt: number, p: GeoParams, dirty: RowRange, rows: Int32Array, act: ActiveSet | null): void {
  const { width: W, height: H, bedrock, soil, water, flags, inflow } = world;
  const hMin = p.erosionMinDepth;
  const k = (p.bedSlopeK * dt) / (CELL * CELL);
  const maxFrac = p.maxSoilFraction;
  let y0 = dirty.y0;
  let y1 = dirty.y1;
  for (let r = 0; r < rows.length; r += 3) {
    const y = rows[r]!;
    const row = y * W;
    for (let x = rows[r + 1]!; x < rows[r + 2]!; x++) {
      const i = row + x;
      const ti = transport[i]!;
      if (water[i]! <= hMin || (flags[i]! & NO_EXCHANGE) !== 0 || inflow[i]! > 0) continue;
      // Right and down faces (each face once).
      for (let f = 0; f < 2; f++) {
        let j: number;
        if (f === 0) {
          if (x === W - 1 || (act && !act.at(x + 1, y))) continue;
          j = i + 1;
        } else {
          if (y === H - 1 || (act && !act.at(x, y + 1))) continue;
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

/** Terrain at (x, y), clamped to the map. */
function zAt(world: World, x: number, y: number): number {
  const xx = x < 0 ? 0 : x >= world.width ? world.width - 1 : x;
  const yy = y < 0 ? 0 : y >= world.height ? world.height - 1 : y;
  const i = yy * world.width + xx;
  return world.bedrock[i]! + world.soil[i]!;
}

/** Highest terrain among the 4 neighbours of (x, y). */
function maxNeighbour(world: World, x: number, y: number): number {
  const { width: W, height: H, bedrock, soil } = world;
  const i = y * W + x;
  let z = -Infinity;
  if (x > 0) z = Math.max(z, bedrock[i - 1]! + soil[i - 1]!);
  if (x < W - 1) z = Math.max(z, bedrock[i + 1]! + soil[i + 1]!);
  if (y > 0) z = Math.max(z, bedrock[i - W]! + soil[i - W]!);
  if (y < H - 1) z = Math.max(z, bedrock[i + W]! + soil[i + W]!);
  return z;
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
 * years. The surface does not move. Loose soil settles meanwhile.
 */
export function weatherStep(world: World, days: number, p: GeoParams, ledger: SedimentLedger, loose?: Float32Array, active?: ActiveSet | null): void {
  const { width: W, height: H, bedrock, soil, flags } = world;
  const rows = rowsOf(active, W, H);
  if (loose) {
    const keep = Math.exp(-days / p.looseDays);
    for (let r = 0; r < rows.length; r += 3) {
      for (let i = rows[r]! * W + rows[r + 1]!, e = rows[r]! * W + rows[r + 2]!; i < e; i++) {
        const l = loose[i]!;
        if (l === 0) continue;
        loose[i] = l < 0.01 ? 0 : l * keep;
      }
    }
  }
  const rate = (p.weatheringPerYear * days) / DAYS_PER_YEAR;
  const inv = 1 / p.weatheringDepth;
  const maxS = p.maxSoil;
  let sum = 0;
  for (let r = 0; r < rows.length; r += 3) {
    for (let i = rows[r]! * W + rows[r + 1]!, e = rows[r]! * W + rows[r + 2]!; i < e; i++) {
      if ((flags[i]! & CellFlag.Lined) !== 0) continue;
      const s = soil[i]!;
      if (s >= maxS) continue;
      let w = rate * Math.exp(-s * inv);
      if (s + w > maxS) w = maxS - s;
      w = lowerBedrock(bedrock, i, w);
      soil[i] = s + w;
      sum += w;
    }
  }
  ledger.weathered += sum * CELL_AREA;
}

