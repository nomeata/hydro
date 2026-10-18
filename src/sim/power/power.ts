/**
 * Hydro power (docs/GAMEPLAY.md §1.4–1.5, M6): the pure parts, shared by
 * the simulation (power/grid.ts) and the tool previews (ui/tools.ts).
 *
 * - **Turbine**: tapped onto the crest of a weir, a dike or a dam (also
 *   beside a sluice gate). A penstock through the wall takes water from the
 *   cell on the high side (`a` or `b`, whichever surface is higher now) to
 *   the cell on the low side: `Q = min(Q_max, C_d·A·√(2gH))` over the head
 *   `H` between the two water surfaces, power `P = η ρ g Q H`. The water is
 *   moved, not made: what goes through the turbine does not go over the
 *   spillway or out of the gate.
 * - **Power pole**: carries power on; every finished house within
 *   SUPPLY_RADIUS of a pole (or a turbine's powerhouse) is on the grid.
 * - **Electric pump**: a stroke from water to wherever the water should go
 *   (any lift up to PUMP_MAX_LIFT): `Q = η_p P / (ρ g H)`.
 *
 * Units: SI on the hydraulic clock (W, m³/s, J); a game day is 300 s.
 */
import { CELL, GRAVITY } from '../constants';

export const RHO = 1000;

export const POWER = {
  /** Turbine efficiency (GAMEPLAY §1.5). */
  turbineEff: 0.8,
  /** Penstock: discharge coefficient × area (m²), and the largest flow (m³/s). */
  penstockCdA: 0.6,
  turbineMaxFlow: 5,
  /** Less head than this turns nothing (m). */
  minHead: 0.4,
  /** The turbine leaves this much water in its intake cell (m). */
  keep: 0.05,
  /**
   * A turbine whose pool stands at its spill level (the water would leave
   * anyway, over the crest or around the wall) runs at full flow; below it
   * the pool is storage and the turbine runs only to cover what the free
   * turbines cannot. Smooth between level − storageBand and level −
   * spillBand. The spill level is the lower of the wall's crest and the
   * pool's high-water mark, which sinks by markDecay per game day (so a
   * pool that settles below the crest, leaking round the wall's end, still
   * counts as full).
   */
  storageBand: 0.4,
  spillBand: 0.05,
  markDecay: 0.01,
  /**
   * A turbine whose pool a pump on its network fills (the pump's outlet
   * within this many cells of the intake, at the pool's level) is pumped
   * storage: it never runs free, only when the houses need it.
   */
  pairReach: 12,
  /** A house's demand at its evening peak (W; GAMEPLAY §1.5: ~2 kW). */
  houseDemand: 2000,
  /** Pump efficiency, rating (W) and the head below which it counts as this much (m). */
  pumpEff: 0.7,
  pumpRating: 20000,
  pumpMinHead: 1,
  /** Wellbeing bonus for a village whose houses are all lit all day (gentle; settlement.ts). */
  wellbeing: 0.05,
};

/** Houses within this many cells of a pole (or a powerhouse, or a pump) are supplied. */
export const SUPPLY_RADIUS = 8;
/** Poles of a stroke stand this many cells apart; a wire spans at most LINK_SPAN. */
export const POLE_SPACING = 6;
export const LINK_SPAN = 11;
/** A stroke starting or ending this close to a pole or turbine joins it. */
export const POLE_SNAP = 2.5;
/** A pump's pipe is at most this long (cells) and lifts at most this high (m). */
export const PUMP_REACH = 24;
export const PUMP_MAX_LIFT = 30;
/** How far a turbine's intake and tailrace may lie from the crest (cells). */
export const TURBINE_REACH = 4;

/** Full flow through a turbine's penstock (m³/s) for a head H (m). */
export function turbineFlow(head: number): number {
  if (!(head >= POWER.minHead)) return 0;
  return Math.min(POWER.turbineMaxFlow, POWER.penstockCdA * Math.sqrt(2 * GRAVITY * head));
}

/** Electric power (W) from a flow Q (m³/s) falling H (m): η ρ g Q H. */
export function turbinePower(flow: number, head: number): number {
  return POWER.turbineEff * RHO * GRAVITY * flow * Math.max(0, head);
}

/** Water a pump lifts (m³/s) with power P (W) over a head H (m): η P / (ρ g H). */
export function pumpFlow(power: number, head: number): number {
  return (POWER.pumpEff * Math.max(0, power)) / (RHO * GRAVITY * Math.max(POWER.pumpMinHead, head));
}

/** Power (W) a pump needs to lift Q (m³/s) over H (m): the inverse of pumpFlow. */
export function pumpPower(flow: number, head: number): number {
  return (RHO * GRAVITY * Math.max(0, flow) * Math.max(POWER.pumpMinHead, head)) / POWER.pumpEff;
}

/**
 * Demand of one house (W) at a time of day (0..1, 0.5 = noon) and of the
 * year (0..1 from the start of spring): low at night, a small morning bump,
 * the evening peak; more in winter, less in summer.
 */
export function houseDemand(timeOfDay: number, yearFrac: number): number {
  const g = (t: number, c: number, w: number) => {
    let d = Math.abs(t - c);
    d = Math.min(d, 1 - d);
    return Math.exp(-((d / w) ** 2));
  };
  const daily = 0.35 + 0.65 * g(timeOfDay, 0.8, 0.09) + 0.3 * g(timeOfDay, 0.3, 0.07) + 0.15 * g(timeOfDay, 0.55, 0.15);
  // Seasons: spring 0, summer 0.25, autumn 0.5, winter 0.75 of the year; most at mid-winter (0.875).
  const season = 1 + 0.25 * Math.cos(2 * Math.PI * (yearFrac - 0.875));
  return POWER.houseDemand * daily * season;
}

/** What the site checks need to see of the world (the sim's World or the UI's mirror). */
export interface PowerGrid2D {
  readonly width: number;
  readonly height: number;
  terrain(i: number): number;
  /** Water depth (m). */
  depth(i: number): number;
  /** Known land (fog of war); absent: everywhere. */
  allowed?(i: number): boolean;
}

export interface TurbineSite {
  ok: boolean;
  /** Why not (one friendly line), when !ok. */
  reason?: string;
  /** Crest cell, and the direction along the wall (0 or π/2). */
  x: number;
  y: number;
  rot: number;
  /** The two ends of the penstock, either side of the wall. */
  a: number;
  b: number;
  /** Lowest crest of the wall around the turbine (m). */
  crest: number;
  /** Head now between the two sides (m, ≥ 0), and the power it would give at full flow (W). */
  head: number;
  power: number;
}

/**
 * Where a turbine tapped at `p` would go: on the crest cell (the highest
 * ground within a cell of the tap), with its penstock across the wall to
 * the lowest ground within TURBINE_REACH on either side (past the wall's slopes).
 */
export function turbineSite(g: PowerGrid2D, p: readonly [number, number]): TurbineSite | null {
  const W = g.width;
  const H = g.height;
  const inb = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H;
  let x = Math.round(p[0]);
  let y = Math.round(p[1]);
  if (!inb(x, y)) return null;
  // Snap to the crest: the highest dry-ish ground right around the tap.
  let best = -Infinity;
  const x0 = x;
  const y0 = y;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x0 + dx;
      const ny = y0 + dy;
      if (!inb(nx, ny)) continue;
      const t = g.terrain(ny * W + nx) - 0.01 * (Math.abs(dx) + Math.abs(dy));
      if (t > best) {
        best = t;
        x = nx;
        y = ny;
      }
    }
  const at = (xx: number, yy: number) => g.terrain(Math.max(0, Math.min(H - 1, yy)) * W + Math.max(0, Math.min(W - 1, xx)));
  const top = g.terrain(y * W + x);
  // The wall runs where the ground stays high.
  const ridge = (ux: number, uy: number) => {
    let s = 0;
    for (const k of [-2, -1, 1, 2]) s += at(x + ux * k, y + uy * k);
    return s;
  };
  const [dx, dy] = ridge(1, 0) >= ridge(0, 1) ? [1, 0] : [0, 1];
  // The turbine sits on the crest: its pool spills at about this height.
  const crest = top;
  const end = (s: number): number => {
    let low = Infinity;
    let cell = -1;
    for (let k = 1; k <= TURBINE_REACH; k++) {
      const nx = x + dy * k * s;
      const ny = y + dx * k * s;
      if (!inb(nx, ny)) break;
      const i = ny * W + nx;
      const t = g.terrain(i);
      if (t < low) {
        low = t;
        cell = i;
      }
      // Past the wall's foot the ground rises again: stop there.
      if (t > low + 0.3) break;
    }
    return cell;
  };
  const a = end(-1);
  const b = end(1);
  const fail = (reason: string): TurbineSite => ({ ok: false, reason, x, y, rot: dx === 1 ? 0 : Math.PI / 2, a, b, crest, head: 0, power: 0 });
  if (a < 0 || b < 0 || top - g.terrain(a) < 0.4 || top - g.terrain(b) < 0.4)
    return fail('Tap the crest of a weir or a dam: the water must fall through the wall.');
  if (g.allowed && (!g.allowed(a) || !g.allowed(b) || !g.allowed(y * W + x))) return fail('Only on known land.');
  const sa = g.terrain(a) + g.depth(a);
  const sb = g.terrain(b) + g.depth(b);
  const head = Math.abs(sa - sb);
  const upDepth = g.depth(sa >= sb ? a : b);
  const power = upDepth > 0.1 ? turbinePower(turbineFlow(head), head) : 0;
  return { ok: true, x, y, rot: dx === 1 ? 0 : Math.PI / 2, a, b, crest, head, power };
}

export interface PumpSite {
  ok: boolean;
  reason?: string;
  /** Inlet (in the water), the pump house (the first dry cell along the stroke) and the outlet. */
  x: number;
  y: number;
  hx: number;
  hy: number;
  ox: number;
  oy: number;
  /** Outlet ground above the inlet's water surface (m). */
  lift: number;
}

/** Where a pump drawn along `points` would stand: from the water at the start to the stroke's end. */
export function pumpSite(g: PowerGrid2D, points: readonly (readonly [number, number])[]): PumpSite | null {
  if (points.length === 0) return null;
  const W = g.width;
  const H = g.height;
  const inb = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H;
  const a = points[0]!;
  const b = points[points.length - 1]!;
  let x = Math.round(a[0]);
  let y = Math.round(a[1]);
  const ox = Math.round(b[0]);
  const oy = Math.round(b[1]);
  if (!inb(x, y) || !inb(ox, oy)) return null;
  const fail = (reason: string, hx = x, hy = y, lift = 0): PumpSite => ({ ok: false, reason, x, y, hx, hy, ox, oy, lift });
  if (g.depth(y * W + x) < 0.2) {
    let best = -1;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inb(nx, ny)) continue;
        const d = g.depth(ny * W + nx);
        if (d >= 0.2 && d > best) {
          best = d;
          x = nx;
          y = ny;
        }
      }
    if (best < 0) return fail('Start in the water: the pump draws from a river, a pond or a canal.');
  }
  const len = Math.hypot(ox - x, oy - y);
  if (len < 1.5) return fail('Draw from the water to where it should go.');
  if (len > PUMP_REACH) return fail(`Too far: the pipe reaches ${PUMP_REACH * CELL} m.`);
  // The pump house: the first dry cell along the pipe.
  let hx = ox;
  let hy = oy;
  for (let t = 1; t <= len; t += 0.5) {
    const nx = Math.round(x + ((ox - x) * t) / len);
    const ny = Math.round(y + ((oy - y) * t) / len);
    if (g.depth(ny * W + nx) < 0.1) {
      hx = nx;
      hy = ny;
      break;
    }
  }
  const wi = y * W + x;
  const oi = oy * W + ox;
  const lift = g.terrain(oi) - (g.terrain(wi) + g.depth(wi));
  if (g.allowed && (!g.allowed(wi) || !g.allowed(oi) || !g.allowed(hy * W + hx))) return fail('Only on known land.', hx, hy, lift);
  if (lift > PUMP_MAX_LIFT) return fail(`Too high: ${lift.toFixed(0)} m (${PUMP_MAX_LIFT} m at most).`, hx, hy, lift);
  return { ok: true, x, y, hx, hy, ox, oy, lift };
}

/** Pole positions along a stroke: its start, then every POLE_SPACING cells, and its end. */
export function polePositions(points: readonly (readonly [number, number])[]): [number, number][] {
  if (points.length === 0) return [];
  const out: [number, number][] = [[points[0]![0], points[0]![1]]];
  let carry = 0;
  for (let k = 0; k + 1 < points.length; k++) {
    const p = points[k]!;
    const q = points[k + 1]!;
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
    let t = POLE_SPACING - carry;
    while (t <= l) {
      out.push([p[0] + ((q[0] - p[0]) * t) / l, p[1] + ((q[1] - p[1]) * t) / l]);
      t += POLE_SPACING;
    }
    carry = l - (t - POLE_SPACING);
  }
  const last = points[points.length - 1]!;
  const prev = out[out.length - 1]!;
  const gap = Math.hypot(last[0] - prev[0], last[1] - prev[1]);
  if (gap > POLE_SPACING * 0.4) out.push([last[0], last[1]]);
  else if (out.length > 1) out[out.length - 1] = [last[0], last[1]];
  return out.map(([px, py]) => [Math.round(px), Math.round(py)]);
}
