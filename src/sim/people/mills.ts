/**
 * Village mills (docs/GAMEPLAY.md §1.2, priority 8): a bigger farming
 * village builds a mill on the bank where the water drops with force near
 * home, typically at the spill of the player's weir or a step in a canal.
 * The wheel turns with the flow; while it does, grain brought to the mill
 * is ground into flour, which keeps better (a little more food reaches the
 * table) and cheers the village. Run-of-river: no water is taken. Pure
 * functions over the world; village.ts decides, builders build, the
 * miller grinds.
 */
import { CELL, GRAVITY } from '../constants';
import { CellFlag, LandUse, type World } from '../world';

export const MILL = {
  /** Villages need this many people and grain fields before they build a mill; they look every few days. */
  minPeople: 20,
  minFields: 20,
  everyDays: 4,
  /** Head sites within this many cells of the centre. */
  radius: 20,
  /** A head site: the water surface drops this much within `reach` cells… */
  minDrop: 0.8,
  reach: 2,
  /** The head may be this many cells from the mill's bank (a short race leads the water to the wheel). */
  race: 2,
  /** …with water this fast at the wheel… */
  minSpeed: 0.3,
  /** …and this much flow past it (m³/s, through the stream's cross-section, at most `section` cells either side)… */
  minFlow: 0.5,
  section: 6,
  /** …giving at least this power (W, ρ g Q Δh). */
  minPower: 3000,
  /** A built mill grinds while power and flow are at least this share of minPower and minFlow, and stops below. */
  runShare: 0.5,
  /** The wheel turns at all above this share (a trickle does not move it). */
  turnShare: 0.2,
  /** A mill without a head for this many days (a whole year: weir gone, river moved) is given up. */
  abandonDays: 48,
  /** Milled grain books this much more food (flour keeps: less waste between field and table). */
  bonus: 1.1,
  /** Wellbeing bonus while the village's mill works (fresh bread, smoke from the ovens). */
  wellbeing: 0.04,
  /** Grain (person-days) ground per visit of the miller, and how long it takes (steps). */
  grind: 24,
  grindSteps: 90,
  /** Farmers take their sacks to the store instead while this much grain waits at the mill. */
  backlog: 72,
};

const RHO = 1000;

/** The head at a wheel cell c: surface drop around it (m), speed (m/s), flow (m³/s) and power (W). */
export interface Head {
  drop: number;
  speed: number;
  flow: number;
  power: number;
}

/**
 * Measure the head at cell c (zeros if it is dry): the drop of the water
 * surface along the flow through c, from `reach` cells upstream to `reach`
 * cells downstream (so the slope of a river's banks does not count).
 */
export function headAt(w: World, c: number): Head {
  const h = w.water[c]!;
  if (h < 0.05) return { drop: 0, speed: 0, flow: 0, power: 0 };
  const W = w.width;
  const vx = w.velX[c]!;
  const vy = w.velY[c]!;
  const speed = Math.hypot(vx, vy);
  if (speed < 1e-3) return { drop: 0, speed, flow: 0, power: 0 };
  const x0 = c % W;
  const y0 = (c / W) | 0;
  // The highest surface a little upstream, the lowest a little downstream (each at least c's own).
  let up = w.surface(c);
  let down = up;
  for (let k = 1; k <= MILL.reach; k++) {
    const ux = Math.round(x0 - (vx / speed) * k);
    const uy = Math.round(y0 - (vy / speed) * k);
    const dx = Math.round(x0 + (vx / speed) * k);
    const dy = Math.round(y0 + (vy / speed) * k);
    if (w.inBounds(ux, uy) && w.water[w.idx(ux, uy)]! >= 0.05) up = Math.max(up, w.surface(w.idx(ux, uy)));
    if (w.inBounds(dx, dy) && w.water[w.idx(dx, dy)]! >= 0.05) down = Math.min(down, w.surface(w.idx(dx, dy)));
  }
  const drop = Math.max(0, up - down);
  const flow = sectionFlow(w, c, vx / speed, vy / speed);
  return { drop, speed, flow, power: RHO * GRAVITY * flow * drop };
}

/**
 * Discharge (m³/s) through the cross-section at cell c, across the flow
 * direction (ux, uy): the whole stream's water passes the mill (its race
 * takes what the wheel needs), not just the one cell's.
 */
export function sectionFlow(w: World, c: number, ux: number, uy: number): number {
  const W = w.width;
  const x0 = c % W;
  const y0 = (c / W) | 0;
  let q = 0;
  for (const sgn of [1, -1]) {
    for (let k = sgn > 0 ? 0 : 1; k <= MILL.section; k++) {
      const x = Math.round(x0 - uy * k * sgn);
      const y = Math.round(y0 + ux * k * sgn);
      if (!w.inBounds(x, y)) break;
      const j = w.idx(x, y);
      if (w.water[j]! < 0.05) break;
      q += w.water[j]! * Math.max(0, w.velX[j]! * ux + w.velY[j]! * uy) * CELL;
    }
  }
  return q;
}

/** Whether the head at a cell makes a mill site (the thresholds of MILL). */
export function isHeadSite(hd: Head): boolean {
  return hd.drop >= MILL.minDrop && hd.speed >= MILL.minSpeed && hd.flow >= MILL.minFlow && hd.power >= MILL.minPower;
}

/** Whether a built mill's wheel turns (`share` = MILL.turnShare) or grinds (MILL.runShare) at a head: enough power and flow. */
export function millTurns(hd: Head, share: number): boolean {
  return hd.power >= share * MILL.minPower && hd.flow >= share * MILL.minFlow;
}

/**
 * A chosen mill site: the bank cell for the mill house, the water cell
 * beside it where the wheel turns (`side`), and the cell whose head drives
 * it (`wheel`: the strongest head within MILL.race cells of the bank; a
 * short race leads the current to the wheel).
 */
export interface MillSite {
  bank: number;
  side: number;
  wheel: number;
  power: number;
}

/**
 * The best head site within MILL.radius of (cx, cy), with a dry,
 * buildable bank cell beside the water (`ok(i)` filters bank cells:
 * ownership, known land). Stronger and nearer sites win. Null if there is none.
 */
export function chooseMillSite(
  w: World,
  cx: number,
  cy: number,
  ok: (i: number) => boolean,
  slope: (i: number) => number,
): MillSite | null {
  const W = w.width;
  const R = MILL.radius;
  const Rr = MILL.race;
  const x0 = Math.max(2, Math.round(cx - R));
  const x1 = Math.min(W - 3, Math.round(cx + R));
  const y0 = Math.max(2, Math.round(cy - R));
  const y1 = Math.min(w.height - 3, Math.round(cy + R));
  // Head sites in (and just around) the window.
  const heads = new Map<number, Head>();
  for (let y = Math.max(0, y0 - Rr); y <= Math.min(w.height - 1, y1 + Rr); y++)
    for (let x = Math.max(0, x0 - Rr); x <= Math.min(W - 1, x1 + Rr); x++) {
      const c = y * W + x;
      if (w.water[c]! < 0.1) continue;
      const hd = headAt(w, c);
      if (isHeadSite(hd)) heads.set(c, hd);
    }
  if (!heads.size) return null;
  let best: MillSite | null = null;
  let bestScore = -Infinity;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const r = Math.hypot(x - cx, y - cy);
      if (r > R) continue;
      const b = y * W + x;
      if (!bankOk(w, b) || slope(b) >= 0.5 || !ok(b)) continue;
      let wheel = -1;
      let power = 0;
      for (let dy = -Rr; dy <= Rr; dy++)
        for (let dx = -Rr; dx <= Rr; dx++) {
          const hd = heads.get(b + dy * W + dx);
          if (hd && hd.power > power) {
            power = hd.power;
            wheel = b + dy * W + dx;
          }
        }
      if (wheel < 0) continue;
      // The wheel turns in the wet cell beside the house nearest the head.
      let side = -1;
      let sideD = Infinity;
      for (const j of [b - 1, b + 1, b - W, b + W]) {
        if (w.water[j]! < 0.05) continue;
        const d = Math.hypot((j % W) - (wheel % W), ((j / W) | 0) - ((wheel / W) | 0));
        if (d < sideD) {
          sideD = d;
          side = j;
        }
      }
      if (side < 0) continue;
      const score = Math.min(power, 20000) / 2000 - r / 6 - sideD;
      if (score > bestScore) {
        bestScore = score;
        best = { bank: b, side, wheel, power };
      }
    }
  return best;
}

/** A dry bank cell a mill house may stand on (not on a structure, a plan or used land). */
function bankOk(w: World, b: number): boolean {
  const lu = w.landuse[b]!;
  if (lu !== LandUse.None && lu !== LandUse.Pasture && lu !== LandUse.Path) return false;
  return w.water[b]! < 0.01 && Number.isNaN(w.plan[b]!) && (w.flags[b]! & CellFlag.Structure) === 0;
}
