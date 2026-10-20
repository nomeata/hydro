/**
 * Help for a struggling village (sim/ideas.ts kind 'help'; docs/GAMEPLAY.md
 * §3.3, §4.6): when a village has been poor for a while (reputation, i.e.
 * prosperity over the last weeks, below HELP.enter, or stuck at the floor of
 * eight without drawing families), the ideas look for one concrete thing the
 * player could do *with the brushes* (Raise, Dig: always to hand) that would
 * feed it, and name the place:
 *
 * - floods reach its fields: raise a bank (the flooded fields, ringed);
 * - its dry fields or dry fertile ground within walking reach could be
 *   watered from higher water (a stream, a pool): a graded channel along the
 *   slope (plans/canal.ts planCanal, the bots' planner), ringed from the
 *   intake to the land it waters; only when one fits, within HELP.earth;
 * - waterlogged ground by the village with lower water near enough: a ditch
 *   down to it.
 *
 * Only what is feasible and would help is suggested; nothing otherwise.
 * Purely an observer (no random numbers, no changes to the world).
 */
import type { Command, Pt } from '../shared/protocol';
import { DAYS_PER_YEAR } from './constants';
import { isRevealed } from './fog';
import type { AchievementHost } from './achievements';
import { canalCommand, houseMargin, planCanal, worthOf, type CanalHost, type CanalStart } from './plans/canal';
import { CROP_MOISTURE } from './people/village';
import { ECONOMY, type Settlement } from './people/settlement';
import { saturation } from './vegetation';
import { LandUse } from './world';

export const HELP = {
  /** A village is struggling below this reputation, or at the floor of eight without drawing families. */
  enter: 0.4,
  /** ... and no longer once its reputation is back above this. */
  leave: 0.5,
  /** Days a village must have struggled before the ideas look for help. */
  days: 8,
  /** Walking reach of the fields (people/village.ts FIELD_RADIUS). */
  reach: 18,
  /** Open ground worth watering: at least this fertile (ideas.ts IDEAS.landFertility). */
  fertility: 0.35,
  /** Water a channel may start from, within this many cells of the village. */
  sourceReach: 50,
  /** Earth a suggested channel may move at most (m³): a few evenings' brushing. */
  earth: 4000,
  /** A channel is cut at most this deep (m): into the bank above a pond, too. */
  cut: 3,
  /** Worth of the land a channel must water (dry fields 1, open fertile land 0.35). */
  channelWorth: 12,
  /** Floods: fields flooded within the last year, at least this many and this share of the village's fields. */
  floodCells: 6,
  floodShare: 0.2,
  /** Wet ground: at least this many waterlogged cells (fields or fertile open land) round one core. */
  wetCells: 8,
  /** A drain's outlet: water this much lower (m) within `drainReach` cells. */
  drainDrop: 0.6,
  drainReach: 35,
};

export type HelpWhat = 'channel' | 'bank' | 'drain';

export interface HelpPlan {
  what: HelpWhat;
  tool: 'dig' | 'raise';
  /** The ring: the place to work. */
  x: number;
  y: number;
  r: number;
  /** The land it is for (the flooded fields, the dry land a channel waters, the wet core). */
  at: Pt;
  /** Fields (true) or open ground the channel waters. */
  fields: boolean;
  /** A channel's water: a stream (true) or still water (a pool, a lake). */
  stream: boolean;
  /** Commands that would do it (the bots' terrain API; for headless checks, never sent by the sim). */
  commands: Command[];
}

/** What the planner needs (the Simulation). */
export type HelpHost = AchievementHost & CanalHost;

/** Is village s struggling now (`was`: it was struggling at the last look; hysteresis)? */
export function struggling(s: Settlement, was: boolean): boolean {
  const rep = s.reputation;
  const floor = s.state.population <= ECONOMY.stayers && rep < s.arriveAbove;
  return rep < HELP.enter || floor || (was && rep < HELP.leave);
}

const D4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** Smallest circle (roughly) round a set of points, at least `min` cells. */
function ring(pts: readonly Pt[], min = 4): { x: number; y: number; r: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const x = Math.round((x0 + x1) / 2);
  const y = Math.round((y0 + y1) / 2);
  let r = min;
  for (const [px, py] of pts) r = Math.max(r, Math.hypot(px - x, py - y) + 1);
  return { x, y, r: Math.round(r) };
}

/** One concrete thing that would help village s (index k), or null when nothing feasible would. */
export function planHelp(h: HelpHost, s: Settlement): HelpPlan | null {
  const p = h.people!;
  const w = h.world;
  const W = w.width;
  const { x: sx, y: sy } = s.state;
  const shown = (i: number) => !h.fog || isRevealed(w, i);
  const around = (cx: number, cy: number, R: number): number[] => {
    const out: number[] = [];
    for (let y = Math.max(0, Math.floor(cy - R)); y <= Math.min(w.height - 1, Math.ceil(cy + R)); y++)
      for (let x = Math.max(0, Math.floor(cx - R)); x <= Math.min(W - 1, Math.ceil(cx + R)); x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 <= R * R && shown(y * W + x)) out.push(y * W + x);
    return out;
  };
  const pt = (i: number): Pt => [i % W, (i / W) | 0];
  const near = around(sx, sy, HELP.reach);
  const fields = near.filter((i) => w.landuse[i] === LandUse.Field);

  // Floods on the fields: a bank.
  const floodedSince = 255 - DAYS_PER_YEAR;
  const flooded = fields.filter((i) => w.floodMemory[i]! >= floodedSince);
  const bank = (): HelpPlan | null => {
    if (flooded.length < HELP.floodCells || flooded.length < HELP.floodShare * fields.length) return null;
    const r = ring(flooded.map(pt));
    return { what: 'bank', tool: 'raise', ...r, at: [r.x, r.y], fields: true, stream: true, commands: [] };
  };
  const b = bank();
  if (b) return b;

  // Dry land a channel would turn green.
  const m = p.fieldMoisture;
  // Open ground helps only a village that has no good land left to claim (limit 'land'); else its own fields.
  const open = s.state.limit === 'land';
  const targets = new Set<number>();
  for (const i of near) {
    const lu = w.landuse[i];
    if ((lu !== LandUse.Field && (lu !== LandUse.None || !open)) || w.water[i]! > 0.01 || Math.hypot((i % W) - sx, ((i / W) | 0) - sy) < 3) continue;
    if (m[i]! >= CROP_MOISTURE.moist) continue;
    if (lu === LandUse.None && (w.fertility[i]! < HELP.fertility || w.vegetation[i]! > 0.7 || p.slope(i) > 0.25)) continue;
    targets.add(i);
  }
  if (targets.size >= HELP.channelWorth) {
    const starts: CanalStart[] = [];
    const seen = new Set<number>();
    const flows = new Map<number, boolean>();
    for (const i of around(sx, sy, HELP.sourceReach)) {
      const d = w.water[i]!;
      const flowing = d >= 0.1 && Math.hypot(w.velX[i]!, w.velY[i]!) >= 0.08;
      if (!flowing && d < 0.5) continue;
      const [x, y] = pt(i);
      for (const [dx, dy] of D4) {
        if (!w.inBounds(x + dx, y + dy)) continue;
        const c = w.idx(x + dx, y + dy);
        if (seen.has(c) || w.water[c]! > 0.05) continue;
        seen.add(c);
        starts.push({ cell: c, level: w.surface(i) - 0.05 });
        flows.set(c, flowing);
      }
    }
    const R = HELP.sourceReach + 2;
    const box = { x0: Math.floor(sx - R), y0: Math.floor(sy - R), x1: Math.ceil(sx + R), y1: Math.ceil(sy + R) };
    const canal = starts.length ? planCanal(h, starts, targets, { village: { x: sx, y: sy, r: 10 }, maxEarth: HELP.earth, maxCut: HELP.cut, box, ends: 60 }, HELP.channelWorth) : null;
    if (canal && worthOf(w, canal.covered) >= HELP.channelWorth) {
      const nf = canal.covered.filter((i) => w.landuse[i] === LandUse.Field).length;
      const at = ring(canal.covered.map(pt));
      return {
        what: 'channel',
        tool: 'dig',
        ...ring([...canal.points, ...canal.covered.map(pt)]),
        at: [at.x, at.y],
        fields: nf * 2 >= canal.covered.length,
        stream: flows.get(canal.path[0]!) ?? true,
        commands: [canalCommand(canal)],
      };
    }
  }

  // Waterlogged ground: a ditch down to lower water.
  const wet = near.filter((i) => {
    const lu = w.landuse[i];
    if (lu !== LandUse.Field && !(lu === LandUse.None && w.fertility[i]! >= HELP.fertility)) return false;
    if (w.water[i]! > 0.3) return false;
    return saturation(w, i) >= 0.9 || m[i]! >= CROP_MOISTURE.soggy || w.water[i]! > 0.05;
  });
  if (wet.length >= HELP.wetCells) {
    const wetSet = new Set(wet);
    let core = -1;
    let coreN = -1;
    for (const i of wet) {
      const [x, y] = pt(i);
      let n = 0;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (w.inBounds(x + dx, y + dy) && wetSet.has(w.idx(x + dx, y + dy))) n++;
      if (n > coreN) {
        coreN = n;
        core = i;
      }
    }
    if (coreN >= HELP.wetCells) {
      const C = pt(core);
      const zC = w.terrain(core);
      const R = HELP.drainReach + 3;
      const margin = houseMargin(h, 2.5, { x0: Math.floor(C[0] - R), y0: Math.floor(C[1] - R), x1: C[0] + R, y1: C[1] + R });
      let best: { j: number; d: number } | null = null;
      for (const j of around(C[0], C[1], HELP.drainReach)) {
        if (w.water[j]! < 0.1 || w.surface(j) > zC - HELP.drainDrop) continue;
        const d = Math.hypot((j % W) - C[0], ((j / W) | 0) - C[1]);
        if (best && d >= best.d) continue;
        // A straight ditch: clear of the houses, never more than 2.5 m deep.
        const n = Math.ceil(d);
        let ok = true;
        for (let k = 1; k < n && ok; k++) {
          const c = w.idx(Math.round(C[0] + (((j % W) - C[0]) * k) / n), Math.round(C[1] + ((((j / W) | 0) - C[1]) * k) / n));
          const floor = zC - 0.8 - ((zC - 0.8 - (w.surface(j) - 0.1)) * k) / n;
          if (margin[c] || h.isFixed(c) || w.terrain(c) - floor > 2.5) ok = false;
        }
        if (ok) best = { j, d };
      }
      if (best) {
        const O = pt(best.j);
        const f0 = zC - 0.8;
        const f1 = Math.min(f0 - 0.05, w.surface(best.j) - 0.1);
        const commands: Command[] = [{ type: 'shapeLine', tool: 'dig', points: [C, O], width: 2, floor: [f0, f1] }];
        return { what: 'drain', tool: 'dig', ...ring([C, O]), at: C, fields: true, stream: true, commands };
      }
    }
  }
  return null;
}
