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
  /** …with water this fast at the wheel… */
  minSpeed: 0.3,
  /** …and this much flow past it (m³/s; depth × speed × a cell's width)… */
  minFlow: 0.5,
  /** …giving at least this power (W, ρ g Q Δh). */
  minPower: 3000,
  /** A built mill grinds while the power is at least this share of minPower, and stops below. */
  runShare: 0.5,
  /** The wheel turns at all above this share (a trickle does not move it). */
  turnShare: 0.2,
  /** A mill without a head for this many days (weir gone, river moved) is given up. */
  abandonDays: 60,
  /** Milled grain books this much more food (flour keeps: less waste between field and table). */
  bonus: 1.1,
  /** Wellbeing bonus while the village's mill works (fresh bread, smoke from the ovens). */
  wellbeing: 0.04,
  /** Grain (person-days) ground per visit of the miller, and how long it takes (steps). */
  grind: 24,
  grindSteps: 90,
};

const RHO = 1000;

/** The head at a wheel cell c: surface drop around it (m), speed (m/s), flow (m³/s) and power (W). */
export interface Head {
  drop: number;
  speed: number;
  flow: number;
  power: number;
}

/** Measure the head at cell c (zeros if it is dry). */
export function headAt(w: World, c: number): Head {
  const h = w.water[c]!;
  if (h < 0.05) return { drop: 0, speed: 0, flow: 0, power: 0 };
  const W = w.width;
  const x0 = c % W;
  const y0 = (c / W) | 0;
  const R = MILL.reach;
  let hi = -Infinity;
  let lo = Infinity;
  for (let y = Math.max(0, y0 - R); y <= Math.min(w.height - 1, y0 + R); y++)
    for (let x = Math.max(0, x0 - R); x <= Math.min(W - 1, x0 + R); x++) {
      const j = y * W + x;
      if (w.water[j]! < 0.05) continue;
      const s = w.surface(j);
      if (s > hi) hi = s;
      if (s < lo) lo = s;
    }
  const drop = Math.max(0, hi - lo);
  const speed = Math.hypot(w.velX[c]!, w.velY[c]!);
  const flow = h * speed * CELL;
  return { drop, speed, flow, power: RHO * GRAVITY * flow * drop };
}

/** Whether the head at a cell makes a mill site (the thresholds of MILL). */
export function isHeadSite(hd: Head): boolean {
  return hd.drop >= MILL.minDrop && hd.speed >= MILL.minSpeed && hd.flow >= MILL.minFlow && hd.power >= MILL.minPower;
}

/** A chosen mill site: the bank cell for the mill house and the water cell of its wheel. */
export interface MillSite {
  bank: number;
  wheel: number;
  power: number;
}

/**
 * The best head site within MILL.radius of (cx, cy), with a dry,
 * buildable bank cell beside it (`ok(i)` filters bank cells: ownership,
 * known land). Stronger and nearer sites win. Null if there is none.
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
  let best: MillSite | null = null;
  let bestScore = -Infinity;
  for (let y = Math.max(2, Math.round(cy - R)); y <= Math.min(w.height - 3, Math.round(cy + R)); y++)
    for (let x = Math.max(2, Math.round(cx - R)); x <= Math.min(W - 3, Math.round(cx + R)); x++) {
      const r = Math.hypot(x - cx, y - cy);
      if (r > R) continue;
      const c = y * W + x;
      if (w.water[c]! < 0.1) continue;
      const hd = headAt(w, c);
      if (!isHeadSite(hd)) continue;
      for (const b of [c - 1, c + 1, c - W, c + W]) {
        if (!bankOk(w, b) || slope(b) >= 0.5 || !ok(b)) continue;
        const score = Math.min(hd.power, 20000) / 2000 - Math.hypot((b % W) - cx, ((b / W) | 0) - cy) / 6;
        if (score > bestScore) {
          bestScore = score;
          best = { bank: b, wheel: c, power: hd.power };
        }
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
