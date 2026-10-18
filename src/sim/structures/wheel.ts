/**
 * Water wheel / noria (docs/GAMEPLAY.md §1.3): a player tool that lifts
 * river water up to a canal on the terrace above, driven by the river's
 * own current.
 *
 * Placement is a short stroke from the river onto the bank: the wheel
 * stands in the quickest water around where the stroke starts, and its
 * wooden trough (an aqueduct on stilts) runs along the stroke to the
 * **head cell**, the last dry cell of the stroke at most WHEEL_REACH cells
 * from the wheel, which may lie up to WHEEL_MAX_LIFT above the river's
 * surface. The wheel is as tall as its lift, so higher banks get larger
 * wheels and less water. A tap picks the lowest dry cell next to the water.
 * `wheelSite` is pure, so the tool preview (main thread) and the sim agree;
 * `wheelSites` lists the places where a tapped wheel would turn well (the
 * marks the tool shows on the map).
 *
 * Lift (each step, `wheelLift`): an undershot wheel's power
 * `P = ¼·½ ρ A v³`, A = 5 m × min(depth, 1 m), lifts
 * `Q = gain · P / (ρ g H)` (capped) over the head H; nothing below
 * WHEEL_MIN_SPEED, so a wheel in a pond stands still. Shallow fast water
 * counts: the race below a weir spills thin and quick, which is where a
 * wheel turns best. The water is moved from the wheel cell to the head
 * cell: mass is conserved, and the ledger books it as `lifted` (an
 * internal transfer).
 */
import { CELL, DT, GRAVITY, STEPS_PER_DAY } from '../constants';
import { PARAMS } from '../params';

/** Highest lift above the river's surface (m): the tallest norias stand ~10 m. */
export const WHEEL_MAX_LIFT = 10;
/** How far the head cell may be from the wheel (cells, along the stroke): the trough's length. */
export const WHEEL_REACH = 6;
/** Water this deep turns a wheel (m); the head cell must be drier than DRY_HEAD. */
export const WHEEL_MIN_DEPTH = 0.05;
const DRY_HEAD = 0.1;
/** Slowest current that turns a wheel (m/s). */
export const WHEEL_MIN_SPEED = 0.3;
/** A site is marked as good when a wheel there would lift at least this much (m³ per game day). */
export const WHEEL_GOOD_LIFT = 10;
/** Lowest lift worth a wheel (m): below it a dug channel brings the water by itself. */
const MIN_LIFT = 0.2;
/** The trough may pass over ground at most this much above the head cell (m). */
const RIDGE = 0.5;
const RHO = 1000;

/** What the site check needs to see of the world (the sim's World or the UI's mirror). */
export interface WheelGrid {
  readonly width: number;
  readonly height: number;
  terrain(i: number): number;
  /** Water depth (m). */
  depth(i: number): number;
  /** Speed of the water (m/s). */
  speed(i: number): number;
  /** Known land (fog of war); absent: everywhere. */
  allowed?(i: number): boolean;
}

export interface WheelSite {
  ok: boolean;
  /** Why not (one short line, for tests and logs), when !ok. */
  reason?: string;
  /** Wheel and head cells (the head is the wheel's own cell when none was found). */
  x: number;
  y: number;
  hx: number;
  hy: number;
  /** Head cell ground above the river's surface (m). */
  lift: number;
  /** What it would lift now (m³ per game day; 0 when !ok). */
  perDay: number;
}

/** Water lifted per game day by `q` m³ per hydraulic second. */
export const perDay = (q: number): number => q * DT * STEPS_PER_DAY;

/** Where a wheel drawn along `points` would stand and lift to (see the module comment). */
export function wheelSite(g: WheelGrid, points: readonly (readonly [number, number])[]): WheelSite | null {
  if (points.length === 0) return null;
  const W = g.width;
  const H = g.height;
  const inb = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H;
  const a = points[0]!;
  const b = points[points.length - 1]!;
  const ax = Math.round(a[0]);
  const ay = Math.round(a[1]);
  if (!inb(ax, ay)) return null;
  // The wheel stands in the quickest water at or beside the start (the start cell when it turns as well).
  let x = -1;
  let y = -1;
  let best = -1;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const nx = ax + dx;
      const ny = ay + dy;
      if (!inb(nx, ny)) continue;
      const i = ny * W + nx;
      const d = g.depth(i);
      if (d < WHEEL_MIN_DEPTH) continue;
      const score = Math.min(d, 1) * g.speed(i) ** 3 * (dx === 0 && dy === 0 ? 1.25 : 1) + d * 1e-6;
      if (score > best) {
        best = score;
        x = nx;
        y = ny;
      }
    }
  if (x < 0) return { ok: false, reason: 'Start in the river: the wheel stands in the water.', x: ax, y: ay, hx: ax, hy: ay, lift: 0, perDay: 0 };
  const wi = y * W + x;
  const h = g.depth(wi);
  const surface = g.terrain(wi) + h;
  const dry = (i: number) => g.depth(i) < DRY_HEAD && i !== wi;
  let hx = -1;
  let hy = -1;
  const tap = Math.hypot(b[0] - a[0], b[1] - a[1]) < 1.5;
  if (tap) {
    const head = tapHead(g, x, y, surface);
    hx = head.hx;
    hy = head.hy;
  } else {
    // A stroke: the last dry cell along it, at most WHEEL_REACH from the wheel
    // (a little past the stroke's end: drawing to the edge of the bank is enough).
    const len = Math.hypot(b[0] - x, b[1] - y);
    const ux = (b[0] - x) / len;
    const uy = (b[1] - y) / len;
    for (let t = 1; t <= len + 0.3; t += 0.25) {
      const nx = Math.round(x + ux * t);
      const ny = Math.round(y + uy * t);
      if (!inb(nx, ny) || (nx === x && ny === y)) continue;
      if (Math.max(Math.abs(nx - x), Math.abs(ny - y)) > WHEEL_REACH) break;
      if (dry(ny * W + nx)) {
        hx = nx;
        hy = ny;
      }
    }
  }
  const fail = (reason: string, lift = 0): WheelSite => ({ ok: false, reason, x, y, hx: hx < 0 ? x : hx, hy: hy < 0 ? y : hy, lift, perDay: 0 });
  if (hx < 0) return fail(`Draw from the river onto the bank (at most ${WHEEL_REACH * CELL} m).`);
  const hi = hy * W + hx;
  const lift = g.terrain(hi) - surface;
  if (g.allowed && (!g.allowed(wi) || !g.allowed(hi))) return fail('Only on known land.', lift);
  if (lift > WHEEL_MAX_LIFT) return fail(`Too high: ${lift.toFixed(1)} m above the river (${WHEEL_MAX_LIFT} m at most).`, lift);
  if (lift < MIN_LIFT) return fail('That bank is below the river: a dug channel brings the water by itself.', lift);
  if (ridge(g, x, y, hx, hy) > g.terrain(hi) + RIDGE) return fail('A rise is in the way of the trough.', lift);
  const v = g.speed(wi);
  if (v < WHEEL_MIN_SPEED) return fail('The current is too slow here to turn a wheel.', lift);
  return { ok: true, x, y, hx, hy, lift, perDay: perDay(wheelLift(v, h, lift)) };
}

/** A tap's head cell: the lowest dry cell within 2 cells of the wheel that is above the water (else the nearest dry cell, or none). */
function tapHead(g: WheelGrid, x: number, y: number, surface: number): { hx: number; hy: number } {
  const W = g.width;
  let low = Infinity;
  let near = Infinity;
  let hx = -1;
  let hy = -1;
  let nx0 = -1;
  let ny0 = -1;
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if ((dx === 0 && dy === 0) || nx < 0 || ny < 0 || nx >= W || ny >= g.height) continue;
      const i = ny * W + nx;
      if (g.depth(i) >= DRY_HEAD) continue;
      const t = g.terrain(i);
      if (t >= surface + MIN_LIFT && t < low) {
        low = t;
        hx = nx;
        hy = ny;
      }
      const d = dx * dx + dy * dy;
      if (d < near) {
        near = d;
        nx0 = nx;
        ny0 = ny;
      }
    }
  return hx >= 0 ? { hx, hy } : { hx: nx0, hy: ny0 };
}

/** Highest ground under the trough between the wheel and the head cell (exclusive). */
function ridge(g: WheelGrid, x: number, y: number, hx: number, hy: number): number {
  const n = Math.max(Math.abs(hx - x), Math.abs(hy - y));
  let top = -Infinity;
  for (let k = 1; k < n; k++) {
    const cx = Math.round(x + ((hx - x) * k) / n);
    const cy = Math.round(y + ((hy - y) * k) / n);
    top = Math.max(top, g.terrain(cy * g.width + cx));
  }
  return top;
}

/**
 * Good wheel sites (the tool's marks): river cells where a tapped wheel
 * would lift at least WHEEL_GOOD_LIFT m³ a day, the best of each stretch
 * (none within `spacing` cells of a better one), at most `max` of them.
 */
export function wheelSites(g: WheelGrid, spacing = 4, max = 80): WheelSite[] {
  const W = g.width;
  const found: WheelSite[] = [];
  for (let y = 0; y < g.height; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (g.depth(i) < WHEEL_MIN_DEPTH || g.speed(i) < WHEEL_MIN_SPEED || (g.allowed && !g.allowed(i))) continue;
      const s = wheelSite(g, [[x, y]]);
      if (s?.ok && s.x === x && s.y === y && s.perDay >= WHEEL_GOOD_LIFT) found.push(s);
    }
  found.sort((p, q) => q.perDay - p.perDay || p.y - q.y || p.x - q.x);
  const kept: WheelSite[] = [];
  for (const s of found) {
    if (kept.some((k) => Math.max(Math.abs(k.x - s.x), Math.abs(k.y - s.y)) < spacing)) continue;
    kept.push(s);
    if (kept.length >= max) break;
  }
  return kept;
}

/**
 * Water lifted (m³ per hydraulic second) by a wheel in water `depth` deep
 * flowing at `speed`, over a head of `head` metres.
 */
export function wheelLift(speed: number, depth: number, head: number): number {
  if (speed < WHEEL_MIN_SPEED || depth < WHEEL_MIN_DEPTH) return 0;
  const area = CELL * Math.min(depth, 1);
  const power = 0.25 * 0.5 * RHO * area * speed ** 3;
  return Math.min(PARAMS.wheelMaxFlow, (PARAMS.wheelGain * power) / (RHO * GRAVITY * Math.max(0.5, head)));
}
