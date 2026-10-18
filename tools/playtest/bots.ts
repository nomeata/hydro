/**
 * Scripted "player bots" for the playtest harness (tools/playtest.ts). Each
 * bot looks at the world like a player would (where are the dry fields, the
 * river, the floodplain), and issues ordinary player commands through
 * `Simulation.command`, respecting the tool unlocks. Bots are checked on a
 * schedule (`check`), may act several times (e.g. for each new village) and
 * report what they did and which cells they expect to change ("targets"),
 * so the harness can measure how quickly a visible response follows.
 */
import type { Command, Pt } from '../../src/shared/protocol';
import { isUnlocked } from '../../src/shared/unlocks';
import type { Settlement } from '../../src/sim/people/settlement';
import type { Simulation } from '../../src/sim/sim';
import { LandUse } from '../../src/sim/world';
import {
  cellsAround,
  cellX,
  cellY,
  crossLine,
  dist,
  fieldsOf,
  flowDir,
  homesOf,
  isRiver,
  isShore,
  isWater,
  lineClear,
  polyLength,
  routeAround,
  lineRevealed,
  lowestOn,
  pt,
  saturation,
  villages,
} from './geo';

export interface BotAction {
  /** Game day the action was taken. */
  day: number;
  /** Village it was meant for (settlement id). */
  village: number;
  /** What the bot did, in words. */
  note: string;
  /** Player commands issued. */
  commands: Command[];
  /** Cells the action should visibly change (for the response latency). */
  targets: number[];
  /** Diagnostic numbers (e.g. the target's moisture before). */
  info?: Record<string, number>;
}

export interface Bot {
  readonly name: string;
  readonly description: string;
  /** Look at the world and return the actions to take now (commands not yet issued). */
  check(sim: Simulation, day: number): BotAction[];
}

/** Whether a tool is usable now (unlocks by the highest population so far). */
export function unlocked(sim: Simulation, tool: string): boolean {
  const p = sim.people;
  const peak = p ? Math.max(p.peakPopulation, p.population) : 0;
  return isUnlocked(tool, peak);
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** Point `back` cells before b on the way from a to b. */
function shortOf(a: Pt, b: Pt, back: number): Pt {
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (l <= back + 1) return b;
  const t = (l - back) / l;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Bots that act once per village (and look again on later checks for new villages). */
abstract class PerVillageBot implements Bot {
  abstract readonly name: string;
  abstract readonly description: string;
  protected done = new Set<number>();
  check(sim: Simulation, day: number): BotAction[] {
    const out: BotAction[] = [];
    for (const s of villages(sim)) {
      if (this.done.has(s.state.id)) continue;
      const a = this.forVillage(sim, s, day);
      if (a) {
        this.done.add(s.state.id);
        out.push(a);
      }
    }
    return out;
  }
  protected abstract forVillage(sim: Simulation, s: Settlement, day: number): BotAction | null;
}

/**
 * (a) Irrigation: a canal from the nearest river or lake that can feed it
 * by gravity to the village's driest fields.
 */
export class IrrigateBot extends PerVillageBot {
  readonly name = 'irrigate';
  readonly description = 'trench from the nearest river/lake that can feed it by gravity to the driest fields';
  protected forVillage(sim: Simulation, s: Settlement, day: number): BotAction | null {
    const w = sim.world;
    const m = sim.people!.fieldMoisture;
    const fields = fieldsOf(sim, s);
    if (fields.length < 6) return null;
    fields.sort((a, b) => m[a]! - m[b]! || a - b);
    const dry = fields.slice(0, Math.max(4, Math.ceil(fields.length / 4)));
    const cx = mean(dry.map((i) => cellX(w, i)));
    const cy = mean(dry.map((i) => cellY(w, i)));
    // Aim at the middle of the dry fields first, then at other dry cells (some sit right by the houses).
    const aims = [...dry].sort((a, b) => dist(w, a, cx, cy) - dist(w, b, cx, cy) || a - b);
    let best: { src: number; depth: number; route: Pt[]; T: Pt } | null = null;
    for (const target of aims.filter((_, k) => k % 3 === 0).slice(0, 8)) {
      const T = pt(w, target);
      // Candidate sources, cheapest first (short, shallow), then the first with a clear route.
      const cands: { src: number; depth: number; score: number; end: Pt }[] = [];
      for (const j of cellsAround(sim, T[0], T[1], 50)) {
        if (!isShore(w, j)) continue;
        const S = pt(w, j);
        const end = shortOf(S, T, 1);
        const zEnd = w.terrain(w.idx(Math.round(end[0]), Math.round(end[1])));
        // The canal floor at its end must lie 0.4 m below the source's surface.
        const depth = Math.max(1, zEnd - w.surface(j) + 0.4);
        if (depth > 3) continue;
        cands.push({ src: j, depth, score: Math.hypot(S[0] - T[0], S[1] - T[1]) + 8 * depth, end });
      }
      cands.sort((a, b) => a.score - b.score || a.src - b.src);
      for (const c of cands.filter((_, k) => k % 2 === 0).slice(0, 20)) {
        const route = routeAround(sim, pt(w, c.src), c.end);
        if (route) {
          best = { src: c.src, depth: c.depth, route, T };
          break;
        }
      }
      if (best) break;
    }
    if (!best) return null;
    const T = best.T;
    const targets = dry.filter((i) => dist(w, i, T[0], T[1]) < 8);
    return {
      day,
      village: s.state.id,
      note: `canal ${Math.round(polyLength(best.route))} cells${best.route.length > 2 ? ' (dogleg)' : ''}, depth ${best.depth.toFixed(1)} m, to ${dry.length} driest fields`,
      commands: [{ type: 'planTrench', points: best.route, width: 2, depth: best.depth }],
      targets,
      info: { moistureBefore: mean(targets.map((i) => m[i]!)), fields: fields.length },
    };
  }
}

/**
 * (b) Flood protection: dikes between the village and the water, where the
 * land is low-lying or remembers floods. Looks again later: new flood
 * memory near a village gets dikes too.
 */
export class DikeBot implements Bot {
  readonly name = 'dike';
  readonly description = 'dikes between the village and nearby water where the land is low or remembers floods';
  private readonly rays = new Map<number, Set<number>>();
  check(sim: Simulation, day: number): BotAction[] {
    const w = sim.world;
    const out: BotAction[] = [];
    const N = 48;
    for (const s of villages(sim)) {
      const done = this.rays.get(s.state.id) ?? new Set<number>();
      this.rays.set(s.state.id, done);
      const { x, y } = s.state;
      const hits: { k: number; p: Pt; cell: number }[] = [];
      for (let k = 0; k < N; k++) {
        if (done.has(k)) continue;
        const a = (k / N) * 2 * Math.PI;
        let mem = 0;
        let wet = -1;
        for (let r = 3; r <= 30; r += 0.5) {
          const xx = Math.round(x + Math.cos(a) * r);
          const yy = Math.round(y + Math.sin(a) * r);
          if (!w.inBounds(xx, yy)) break;
          const i = w.idx(xx, yy);
          mem = Math.max(mem, w.floodMemory[i]!);
          if (isWater(w, i)) {
            wet = r;
            break;
          }
        }
        if (wet < 6) continue;
        const r = wet - 3;
        const px = Math.round(x + Math.cos(a) * r);
        const py = Math.round(y + Math.sin(a) * r);
        const c = w.idx(px, py);
        const wx = Math.round(x + Math.cos(a) * wet);
        const wy = Math.round(y + Math.sin(a) * wet);
        const level = w.surface(w.idx(wx, wy));
        const low = w.terrain(c) < level + 2.5;
        const lu = w.landuse[c];
        if (lu === LandUse.Building || lu === LandUse.Yard) continue;
        if (sim.fog && w.revealed[c]! < 128) continue;
        if (low || mem > 50) hits.push({ k, p: [px, py], cell: c });
      }
      // Consecutive rays make a dike; long ones are split so each keeps a local crest.
      const segs: (typeof hits)[] = [];
      for (const h of hits) {
        const last = segs[segs.length - 1];
        const prev = last?.[last.length - 1];
        if (last && prev && (h.k - prev.k === 1 || h.k - prev.k === 2) && last.length < 8 && Math.hypot(h.p[0] - prev.p[0], h.p[1] - prev.p[1]) < 7)
          last.push(h);
        else segs.push([h]);
      }
      // Wrap around: join the last segment to the first.
      if (segs.length > 1) {
        const first = segs[0]!;
        const last = segs[segs.length - 1]!;
        if (first[0]!.k === 0 && last[last.length - 1]!.k === N - 1 && first.length + last.length <= 8) {
          segs[0] = [...last, ...first];
          segs.pop();
        }
      }
      const commands: Command[] = [];
      const targets: number[] = [];
      for (const seg of segs) {
        if (seg.length < 2) continue;
        commands.push({ type: 'planDike', points: seg.map((h) => h.p), width: 2, height: 1.5 });
        for (const h of seg) done.add(h.k);
      }
      if (!commands.length) continue;
      // Protected: the village's homes and fields.
      targets.push(...homesOf(sim, s), ...fieldsOf(sim, s));
      out.push({ day, village: s.state.id, note: `${commands.length} dike(s), ${commands.reduce((n, c) => n + (c.type === 'planDike' ? c.points.length : 0), 0)} points`, commands, targets });
    }
    return out;
  }
}

/**
 * (c) Reservoir: a weir across the river upstream of the biggest village
 * (crest 1 m above the water, below the houses if close). Needs the weir unlock.
 */
export class WeirBot implements Bot {
  readonly name = 'weir';
  readonly description = 'weir across the river upstream of the village (once unlocked), crest 1 m above the water';
  private done = false;
  /** Why candidates were rejected at the last check (diagnostics). */
  why: Record<string, number> = {};
  /** Act regardless of the unlock (for experiments). */
  constructor(private readonly ignoreUnlock = false) {}
  check(sim: Simulation, day: number): BotAction[] {
    if (this.done || (!this.ignoreUnlock && !unlocked(sim, 'weir'))) return [];
    const w = sim.world;
    const vs = villages(sim);
    if (!vs.length) return [];
    const s = vs.reduce((a, b) => (b.state.population > a.state.population ? b : a));
    const { x, y } = s.state;
    const zv = Math.min(w.terrain(w.idx(Math.round(x), Math.round(y))), ...homesOf(sim, s).map((i) => w.terrain(i)));
    const cand = cellsAround(sim, x, y, 40).filter((i) => isRiver(w, i));
    if (!cand.length) return [];
    let near = cand[0]!;
    for (const i of cand) if (dist(w, i, x, y) < dist(w, near, x, y)) near = i;
    const s0 = w.surface(near);
    let best: { i: number; line: [Pt, Pt]; h: number; score: number } | null = null;
    const why = { tried: 0, banks: 0, crest: 0, route: 0 };
    for (const i of cand) {
      const d = dist(w, i, x, y);
      if (d < 12 || w.surface(i) < s0 + 0.3) continue;
      why.tried++;
      const pre = crossLine(w, i, w.surface(i), 0.5);
      if (!pre) {
        why.banks++;
        continue;
      }
      const bed = lowestOn(w, pre[0], pre[1]);
      // Crest WEIR_HEAD above today's water. A reservoir upstream spills over
      // the weir and on down the river; only close to the village must its
      // level stay below the houses.
      const h = Math.min(3.5, w.surface(i) - bed + WEIR_HEAD);
      if (d < 20 && bed + h > zv - 0.3) {
        why.crest++;
        continue;
      }
      // Banks high enough for the crest.
      const line = crossLine(w, i, bed + h, 0.2, 20);
      if (!line || !lineRevealed(sim, line[0], line[1]) || !lineClear(w, line[0], line[1], 1)) {
        why.route++;
        continue;
      }
      const len = Math.hypot(line[1][0] - line[0][0], line[1][1] - line[0][1]);
      const score = -0.02 * Math.abs(d - 22) - 0.03 * len;
      if (!best || score > best.score) best = { i, line, h, score };
    }
    this.why = why;
    if (!best) return [];
    this.done = true;
    const bed = lowestOn(w, best.line[0], best.line[1]);
    const [cx, cy] = pt(w, best.i);
    const targets = cellsAround(sim, cx, cy, 12, false).filter((j) => w.terrain(j) < bed + best.h && w.water[j]! < bed + best.h - w.terrain(j));
    return [
      {
        day,
        village: s.state.id,
        note: `weir ${Math.round(Math.hypot(best.line[1][0] - best.line[0][0], best.line[1][1] - best.line[0][1]))} cells, crest ${best.h.toFixed(1)} m, ${Math.round(dist(w, best.i, x, y))} cells from village`,
        commands: [{ type: 'planWeir', points: best.line, width: 2, height: best.h }],
        targets,
        info: { crest: best.h },
      },
    ];
  }
}

/** (d) Drainage: a ditch from the wettest patch near the village down to lower water. */
export class DrainBot extends PerVillageBot {
  readonly name = 'drain';
  readonly description = 'ditch from the wettest patch near the village down to lower water';
  protected forVillage(sim: Simulation, s: Settlement, day: number): BotAction | null {
    const w = sim.world;
    const m = sim.people!.fieldMoisture;
    const { x, y } = s.state;
    const wet = cellsAround(sim, x, y, 25).filter((i) => {
      const lu = w.landuse[i];
      if (lu === LandUse.Building || lu === LandUse.Yard || w.water[i]! > WATER_SHALLOW) return false;
      return saturation(w, i) >= 0.9 || m[i]! >= 0.9 || w.water[i]! > 0.05;
    });
    if (wet.length < 8) return null;
    const wetSet = new Set(wet);
    let core = -1;
    let coreN = -1;
    for (const i of wet) {
      let n = 0;
      for (const j of cellsAround(sim, cellX(w, i), cellY(w, i), 4, false)) if (wetSet.has(j)) n++;
      if (n > coreN) {
        coreN = n;
        core = i;
      }
    }
    const C = pt(w, core);
    const zC = w.terrain(core);
    const outs = cellsAround(sim, C[0], C[1], 45)
      .filter((j) => isShore(w, j) && w.surface(j) <= zC - 0.6)
      .map((j) => ({ j, d: dist(w, j, C[0], C[1]) }))
      .sort((a, b) => a.d - b.d || a.j - b.j);
    let best: { j: number; d: number; route: Pt[] } | null = null;
    for (const o of outs.slice(0, 40)) {
      const route = routeAround(sim, C, pt(w, o.j));
      if (route) {
        best = { ...o, d: polyLength(route), route };
        break;
      }
    }
    if (!best || coreN < 6) return null;
    const targets = wet.filter((i) => dist(w, i, C[0], C[1]) <= 6);
    return {
      day,
      village: s.state.id,
      note: `ditch ${Math.round(best.d)} cells from a wet patch of ${coreN} cells`,
      commands: [{ type: 'planTrench', points: best.route, width: 2, depth: 0.8 }],
      targets,
      info: { wetCells: wet.length, saturationBefore: mean(targets.map((i) => saturation(w, i))) },
    };
  }
}

/** Weir crest above the river's water level (m). */
const WEIR_HEAD = 1;

/** Shallow standing water still counts as marsh for the drainage bot (m). */
const WATER_SHALLOW = 0.3;

/**
 * (e) Vandal: diverts the river into the first village: a canal from the
 * water upstream straight to the store, and a dam across the river just
 * below its intake.
 */
export class VandalBot implements Bot {
  readonly name: string = 'vandal';
  readonly description: string = 'canal from the river upstream into the village, and a dam across the river below the intake';
  private done = false;
  check(sim: Simulation, day: number): BotAction[] {
    if (this.done) return [];
    const w = sim.world;
    const s = villages(sim)[0];
    if (!s) return [];
    const { x, y } = s.state;
    const V: Pt = [x, y];
    const zv = w.terrain(w.idx(Math.round(x), Math.round(y)));
    let best: { j: number; score: number } | null = null;
    for (const j of cellsAround(sim, x, y, 45)) {
      if (!isShore(w, j)) continue;
      const head = w.surface(j) - zv;
      const d = dist(w, j, x, y);
      if (d < 5) continue;
      const score = head - 0.03 * d + (isRiver(w, j) ? 0.5 : 0);
      if (!best || score > best.score) best = { j, score };
    }
    if (!best) return [];
    this.done = true;
    const S = pt(w, best.j);
    const head = w.surface(best.j) - zv;
    const commands: Command[] = [{ type: 'planTrench', points: [S, V], width: 3, depth: Math.max(1.5, 1 - head + 0.5) }];
    // Dam the river a few cells downstream of the intake.
    const d = flowDir(w, best.j);
    if (d) {
      for (let r = 3; r <= 8; r++) {
        const xx = Math.round(S[0] + d[0] * r);
        const yy = Math.round(S[1] + d[1] * r);
        if (!w.inBounds(xx, yy)) break;
        const i = w.idx(xx, yy);
        if (!isWater(w, i)) continue;
        const line = crossLine(w, i, w.surface(i), 1.5);
        if (line && lineRevealed(sim, line[0], line[1])) {
          commands.push({ type: 'planDike', points: line, width: 3, height: 3 });
          break;
        }
      }
    }
    return [
      {
        day,
        village: s.state.id,
        note: `diversion canal from ${Math.round(dist(w, best.j, x, y))} cells away (head ${head.toFixed(1)} m)${commands.length > 1 ? ' + dam' : ''}`,
        commands,
        targets: homesOf(sim, s),
        info: { head },
      },
    ];
  }
}

/** Days after the vandal's works that `undo` takes them out again. */
export const UNDO_AFTER = 48;

/**
 * (f) Vandal, then remorse: the vandal's canal and dam, and a year later a
 * trench through the dam (down to the river bed) and a dike across the
 * canal by its intake, as a player would undo them. Measures recovery.
 */
export class UndoBot extends VandalBot {
  override readonly name = 'undo';
  override readonly description = "the vandal's works, cut through a year later (dam trenched, canal closed by its intake)";
  private works: Command[] | null = null;
  private at = 0;
  private undone = false;
  override check(sim: Simulation, day: number): BotAction[] {
    if (!this.works) {
      const acts = super.check(sim, day);
      if (acts.length) {
        this.works = acts[0]!.commands;
        this.at = day;
      }
      return acts;
    }
    if (this.undone || day < this.at + UNDO_AFTER) return [];
    this.undone = true;
    const commands: Command[] = [];
    for (const c of this.works) {
      if (c.type === 'planDike') {
        // Trench through the dam along the river, its floor at the bed just up- and downstream.
        const [a, b] = c.points as [Pt, Pt];
        const m: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const nx = -(b[1] - a[1]) / len;
        const ny = (b[0] - a[0]) / len;
        const u: Pt = [m[0] + nx * 4, m[1] + ny * 4];
        const d: Pt = [m[0] - nx * 4, m[1] - ny * 4];
        commands.push({ type: 'planTrench', points: [u, d], width: Math.max(3, len - 3), depth: 0.1 });
      } else if (c.type === 'planTrench') {
        // Close the diversion canal a few cells from its intake.
        const [S, V] = c.points as [Pt, Pt];
        const len = Math.hypot(V[0] - S[0], V[1] - S[1]);
        const ux = (V[0] - S[0]) / len;
        const uy = (V[1] - S[1]) / len;
        const p: Pt = [S[0] + ux * 4, S[1] + uy * 4];
        const half = c.width / 2 + 3;
        commands.push({ type: 'planDike', points: [[p[0] - uy * half, p[1] + ux * half], [p[0] + uy * half, p[1] - ux * half]], width: 3, height: c.depth + 2 });
      }
    }
    const s = villages(sim)[0];
    return [{ day, village: s?.state.id ?? 0, note: `undo: ${commands.length} works`, commands, targets: s ? homesOf(sim, s) : [] }];
  }
}

export const BOT_NAMES = ['irrigate', 'dike', 'weir', 'drain', 'vandal', 'undo'] as const;
export type BotName = (typeof BOT_NAMES)[number];

export function makeBot(name: string, opts: { ignoreUnlocks?: boolean } = {}): Bot {
  switch (name) {
    case 'irrigate':
      return new IrrigateBot();
    case 'dike':
      return new DikeBot();
    case 'weir':
      return new WeirBot(opts.ignoreUnlocks);
    case 'drain':
      return new DrainBot();
    case 'vandal':
      return new VandalBot();
    case 'undo':
      return new UndoBot();
    default:
      throw new Error(`unknown bot ${name} (known: ${BOT_NAMES.join(', ')})`);
  }
}
