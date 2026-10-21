/**
 * Disrepair (docs/PEOPLE.md §5.6): the villagers' own structures — the
 * jetty, footbridges, wells, mills and their stone lining — remember the
 * day they were last used (`used`) and have a condition 1 → 0 (`cond`,
 * absent = 1). Unused for longer than WEAR.grace days, the condition falls
 * by 1/WEAR.span a day (WEAR.wet times faster under water); at 0 the
 * structure is gone and its cells are free again. Used again while still
 * standing, a builder mends it (WEAR.perRepair per visit) as a small work
 * task. Pure state helpers; village.ts decides what counts as use.
 * Player-built structures (weirs, gates, wheels, turbines, pumps, lining
 * the player ordered) and the power grid never wear.
 */
import { DAYS_PER_YEAR } from '../constants';

export const WEAR = {
  /** Days unused before a structure starts to decay (half a year). */
  grace: Math.round(DAYS_PER_YEAR / 2),
  /** Days from sound to gone once decaying (a year and a quarter). */
  span: Math.round(1.25 * DAYS_PER_YEAR),
  /** Decay is this much faster for a structure standing in (or under) the water. */
  wet: 2.5,
  /** A structure in use below this condition gets a builder to mend it… */
  repairBelow: 0.8,
  /** …who restores this much per visit. */
  perRepair: 0.25,
  /** Traffic (desire.ts footfall, fading a little each day) on a deck cell that shows someone walked there lately. */
  traffic: 1,
  /** Villagers' lining is kept up within this many cells of their houses (and by their canals and jetty). */
  liningNear: 10,
  /** Kept-up lining recovers this much a day. */
  mend: 1 / 12,
  /** Conditions at which the look changes: weathered below `weathered`, falling apart below `broken`. */
  weathered: 0.66,
  broken: 0.33,
};

/** Anything that wears: the day last used, and its condition (absent = sound). */
export interface Worn {
  used?: number;
  cond?: number;
}

export function condOf(o: Worn): number {
  return o.cond ?? 1;
}

/** Look: 0 sound, 1 weathered (grey wood, moss), 2 falling apart (planks missing, posts askew). */
export function wearLevel(cond: number): 0 | 1 | 2 {
  return cond >= WEAR.weathered ? 0 : cond >= WEAR.broken ? 1 : 2;
}

/**
 * One day of weather for `o` (its use already marked for today). Older
 * saves and new structures start counting today. Returns the condition.
 */
export function weather(o: Worn, day: number, wet: boolean): number {
  if (o.used === undefined) o.used = day;
  if (day - o.used <= WEAR.grace) return condOf(o);
  const c = Math.max(0, condOf(o) - (wet ? WEAR.wet : 1) / WEAR.span);
  o.cond = c;
  return c;
}

/** Whether a structure still in use needs mending. */
export function needsRepair(o: Worn, day: number): boolean {
  return condOf(o) < WEAR.repairBelow && o.used !== undefined && day - o.used <= WEAR.grace;
}

/** A builder's visit: returns whether the look changed. */
export function repair(o: Worn): boolean {
  const before = wearLevel(condOf(o));
  const c = Math.min(1, condOf(o) + WEAR.perRepair);
  if (c >= 1) delete o.cond;
  else o.cond = c;
  return wearLevel(c) !== before;
}

/** Built (or rebuilt) today: sound and in use. */
export function renew(o: Worn, day: number): void {
  o.used = day;
  delete o.cond;
}

/** Per-cell threshold (0..0.5) below which a worn lined cell loses its stones: a stretch fails cell by cell. */
export function liningFails(cell: number): number {
  let h = Math.imul(cell ^ 0x2c1b3c6d, 0x297a2d39);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return ((h >>> 0) / 4294967296) * 0.5;
}
