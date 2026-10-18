/**
 * Ideas for this valley (docs/GAMEPLAY.md §3.3): a few gentle, concrete
 * suggestions drawn from this world's actual problems, shown at the top of
 * the Achievements card. Every IDEAS_EVERY days the sim looks at what it
 * already has: the villagers' field moisture in summer (dry fields), the
 * flood memory (land flooded last spring), shallow standing water by a
 * village (a marsh), a strong stream near a village without a mill, a
 * finished weir without a turbine, houses far from power.
 *
 * An idea appears after it is found on two looks in a row and goes away
 * after two looks without it (no flicker after a shower); dry fields are
 * only judged in summer and the idea stays until the next summer says
 * otherwise. When an idea goes away by the player's works, Good Idea is
 * earned. The sim sends every idea; the UI shows the first three whose
 * tool is unlocked.
 *
 * Purely an observer, like the achievements: it never changes the world
 * and draws no random numbers. Its small state is saved with the world.
 */
import type { IdeaInfo, IdeaKind } from '../shared/protocol';
import { DAYS_PER_SEASON, DAYS_PER_YEAR } from './constants';
import { CellFlag, LandUse } from './world';
import { CROP_MOISTURE } from './people/village';
import { MILL } from './people/mills';
import type { AchievementHost, Achievements } from './achievements';

/** What the ideas look at (the Simulation). */
export interface IdeasHost extends AchievementHost {
  readonly achievements: Achievements;
}

/** Days between two looks. */
export const IDEAS_EVERY = 2;

export const IDEAS = {
  /** Dry fields: at least this many field cells, and this share of a village's fields, too dry to grow well in summer. */
  dryCells: 6,
  dryShare: 0.1,
  /** Fields belong to the nearest village within this many cells. */
  fieldReach: 30,
  /** Dry fields are judged from this day of summer on (the soil dries through spring). */
  drySummerDay: 3,
  /** Flood: village land within `floodReach` cells flooded within the last year (flood memory ≥ 255 − a year). */
  floodCells: 10,
  floodReach: 20,
  /** Marsh: shallow, still water (m, m/s) away from deep water, within `marshReach` cells. */
  marshCells: 25,
  marshReach: 14,
  marshDepth: [0.02, 0.35] as const,
  marshStill: 0.15,
  marshDeep: 0.6,
  /** Mill: water this deep (m) and fast (m/s) within MILL.radius, on at least this many cells. */
  millDepth: 0.3,
  millSpeed: 0.4,
  millCells: 3,
  /** Turbine and poles: villages with at least this many houses; poles when less than this share is lit. */
  houses: 4,
  litShare: 0.25,
};

/** Order in the list (most pressing first). */
const PRIORITY: Readonly<Record<IdeaKind, number>> = { flood: 6, dry: 5, mill: 4, poles: 3, turbine: 2.5, marsh: 2 };

const TOOL: Readonly<Record<IdeaKind, string>> = { dry: 'dig', flood: 'raise', marsh: 'dig', mill: 'weir', turbine: 'turbine', poles: 'poles' };

/** Looks in a row without the problem before an idea goes (a mill's stream runs low in late summer: half a year). */
const KEEP: Readonly<Record<IdeaKind, number>> = { flood: 2, dry: 2, marsh: 3, mill: 12, turbine: 2, poles: 2 };

/** An idea's spot moves only when the problem moved at least this far (cells): fewer updates. */
const MOVE = 3;

const ACHIEVEMENT: Partial<Record<IdeaKind, string>> = { flood: 'weathered', mill: 'millersHead', turbine: 'brightWindows', poles: 'villageLights' };

interface Entry {
  info: IdeaInfo;
  /** The village it is about (index), for the text. */
  village: number;
  /** Looks in a row that found it, and that did not. */
  hits: number;
  misses: number;
  shown: boolean;
  /** Priority for the order. */
  p: number;
}

export interface IdeasState {
  entries: Entry[];
}

/** A found problem, before it becomes an idea. */
interface Found {
  kind: IdeaKind;
  village: number;
  x: number;
  y: number;
  r: number;
  /** Extra priority (e.g. how big it is). */
  weight: number;
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

/** How the k-th of n villages is called (no names: "the village", "the old village", "the third village"). */
export function villageLabel(k: number, n: number): string {
  if (n <= 1) return 'the village';
  if (n === 2) return k === 0 ? 'the old village' : 'the new village';
  return ORDINALS[k] ? `the ${ORDINALS[k]} village` : 'a village';
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export class Ideas {
  private entries = new Map<string, Entry>();
  /** Set when the shown list changed, for snapshots. */
  dirty = true;

  /** The shown ideas, most pressing first. */
  list(): IdeaInfo[] {
    return [...this.entries.values()]
      .filter((e) => e.shown)
      .sort((a, b) => b.p - a.p || (a.info.id < b.info.id ? -1 : 1))
      .map((e) => ({ ...e.info }));
  }

  /** The list for the next snapshot (clears `dirty`). */
  take(): IdeaInfo[] {
    this.dirty = false;
    return this.list();
  }

  /** At the end of `day`: look again every IDEAS_EVERY days. */
  daily(h: IdeasHost, day: number): void {
    if (day % IDEAS_EVERY === 0) this.look(h, day);
  }

  /** Look at the world now and update the ideas (exported for tests: call twice to show). */
  look(h: IdeasHost, day: number): void {
    const doy = ((day % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR;
    const season = Math.floor(doy / DAYS_PER_SEASON);
    const judgeDry = season === 1 && doy % DAYS_PER_SEASON >= IDEAS.drySummerDay;
    const found = new Map<string, Found>();
    for (const f of findProblems(h, judgeDry)) {
      const id = f.kind === 'turbine' ? 'turbine' : `${f.kind}:${f.village}`;
      if (!found.has(id)) found.set(id, f);
    }
    const looked = (k: IdeaKind) => k !== 'dry' || judgeDry;
    // Found: count the hit, show after two.
    for (const [id, f] of found) {
      let e = this.entries.get(id);
      if (e && Math.hypot(e.info.x - f.x, e.info.y - f.y) < MOVE && Math.abs(e.info.r - f.r) < MOVE) {
        // Much the same spot: keep it.
        f.x = e.info.x;
        f.y = e.info.y;
        f.r = e.info.r;
      }
      const info: IdeaInfo = { id, kind: f.kind, tool: TOOL[f.kind], text: ideaText(h, f), x: f.x, y: f.y, r: f.r };
      const ach = ACHIEVEMENT[f.kind];
      if (ach) info.achievement = ach;
      if (!e) {
        e = { info, village: f.village, hits: 0, misses: 0, shown: false, p: 0 };
        this.entries.set(id, e);
      }
      if (e.shown && (e.info.text !== info.text || e.info.x !== info.x || e.info.y !== info.y || e.info.r !== info.r)) this.dirty = true;
      e.info = info;
      e.village = f.village;
      e.p = PRIORITY[f.kind] + f.weight;
      e.hits++;
      e.misses = 0;
      if (!e.shown && e.hits >= 2) {
        e.shown = true;
        this.dirty = true;
      }
    }
    // Not found: two looks without it and it goes (solved, if by the player's works).
    for (const [id, e] of this.entries) {
      if (found.has(id)) continue;
      // Kept for now; the village may have a new name meanwhile ("the old village").
      const text = ideaText(h, { kind: e.info.kind, village: e.village, x: e.info.x, y: e.info.y, r: e.info.r, weight: 0 });
      if (e.shown && text !== e.info.text) this.dirty = true;
      e.info.text = text;
      if (!looked(e.info.kind)) continue;
      e.hits = 0;
      e.misses++;
      // A mill built: no need to wait for the stream to run strong again.
      const done = e.info.kind === 'mill' && h.people?.buildings.some((b) => b.kind === 'mill' && b.settlement === h.people!.settlements[e.village]?.state.id);
      if (e.shown && e.misses < KEEP[e.info.kind] && !done) continue;
      this.entries.delete(id);
      if (!e.shown) continue;
      this.dirty = true;
      const k = e.info.kind;
      const byWorks = k === 'turbine' || k === 'poles' || h.achievements.near(h.world.idx(e.info.x, e.info.y));
      if (byWorks) h.achievements.earn('goodIdea', day);
    }
  }

  getState(): IdeasState {
    return { entries: [...this.entries.values()].map((e) => ({ ...e, info: { ...e.info } })) };
  }

  setState(st: IdeasState | undefined): void {
    this.entries.clear();
    for (const e of st?.entries ?? []) this.entries.set(e.info.id, { ...e, info: { ...e.info } });
    this.dirty = true;
  }
}

/** The idea's sentence: where, relative to its village (no names, no compass: the camera turns), and what might help. */
function ideaText(h: AchievementHost, f: Found): string {
  const p = h.people!;
  const w = h.world;
  const n = p.settlements.length;
  const label = villageLabel(f.village, n);
  const s = p.settlements[f.village]?.state;
  const where = (near: string) => {
    if (!s || Math.hypot(f.x - s.x, f.y - s.y) < 6) return `${near} ${label}`;
    const dh = w.terrain(w.idx(f.x, f.y)) - w.terrain(w.idx(Math.round(s.x), Math.round(s.y)));
    return dh > 1.5 ? `above ${label}` : dh < -1.5 ? `below ${label}` : `beside ${label}`;
  };
  switch (f.kind) {
    case 'dry':
      return `The fields ${where('around')} dry out in summer — a channel dug from the water could keep them green.`;
    case 'flood':
      return `The land ${where('around')} flooded last spring — a bank of raised earth could keep it dry.`;
    case 'marsh':
      return `The ground ${where('by')} is boggy — a ditch dug down to lower land could drain it for fields.`;
    case 'mill':
      return `The stream runs strong ${where('near')} — a weir there could turn a mill.`;
    case 'turbine':
      return `Your weir ${where('by')} could light the houses — try a turbine on its crest.`;
    case 'poles':
      return `${cap(label)}’s houses are far from power — a line of poles from the turbine could reach them.`;
  }
}

/** Every problem the world has now (dry fields only when `judgeDry`). */
export function findProblems(h: AchievementHost, judgeDry: boolean): Found[] {
  const p = h.people;
  const w = h.world;
  if (!p || !p.settlements.length) return [];
  const out: Found[] = [];
  const n = p.settlements.length;
  const W = w.width;
  const { water, velX, velY, landuse, floodMemory } = w;
  const speed2 = (i: number) => velX[i]! ** 2 + velY[i]! ** 2;
  const r2 = (cx: number, cy: number, R: number, f: (i: number, x: number, y: number) => void) => {
    for (let y = Math.max(0, Math.floor(cy - R)); y <= Math.min(w.height - 1, Math.ceil(cy + R)); y++)
      for (let x = Math.max(0, Math.floor(cx - R)); x <= Math.min(W - 1, Math.ceil(cx + R)); x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 <= R * R) f(y * W + x, x, y);
  };
  /** Centroid and radius of a set of cells. */
  const area = (xs: number[], ys: number[]) => {
    let sx = 0;
    let sy = 0;
    for (let k = 0; k < xs.length; k++) {
      sx += xs[k]!;
      sy += ys[k]!;
    }
    const cx = sx / xs.length;
    const cy = sy / ys.length;
    let rr = 0;
    for (let k = 0; k < xs.length; k++) rr += Math.hypot(xs[k]! - cx, ys[k]! - cy);
    return { x: Math.round(cx), y: Math.round(cy), r: Math.max(3, Math.round((rr / xs.length) * 1.5)) };
  };

  // Dry fields in summer: each field cell belongs to the nearest village.
  if (judgeDry) {
    const total = new Array<number>(n).fill(0);
    const dx: number[][] = p.settlements.map(() => []);
    const dy: number[][] = p.settlements.map(() => []);
    const reach2 = IDEAS.fieldReach ** 2;
    for (let i = 0; i < w.size; i++) {
      if (landuse[i] !== LandUse.Field) continue;
      const x = i % W;
      const y = (i / W) | 0;
      let best = -1;
      let bd = reach2;
      for (let k = 0; k < n; k++) {
        const s = p.settlements[k]!.state;
        const d = (s.x - x) ** 2 + (s.y - y) ** 2;
        if (d <= bd) {
          bd = d;
          best = k;
        }
      }
      if (best < 0) continue;
      total[best]!++;
      if (water[i]! < 0.05 && p.fieldMoisture[i]! < CROP_MOISTURE.moist) {
        dx[best]!.push(x);
        dy[best]!.push(y);
      }
    }
    for (let k = 0; k < n; k++) {
      const c = dx[k]!.length;
      if (c < IDEAS.dryCells || c < IDEAS.dryShare * total[k]!) continue;
      const a = area(dx[k]!, dy[k]!);
      out.push({ kind: 'dry', village: k, ...a, weight: Math.min(0.9, c / 200) });
    }
  }

  const floodedSince = 255 - DAYS_PER_YEAR;
  const mills = new Set(p.buildings.filter((b) => b.kind === 'mill').map((b) => b.settlement));
  for (let k = 0; k < n; k++) {
    const s = p.settlements[k]!.state;
    // Village land flooded within the last year.
    const fx: number[] = [];
    const fy: number[] = [];
    r2(s.x, s.y, IDEAS.floodReach, (i, x, y) => {
      if (floodMemory[i]! >= floodedSince) {
        fx.push(x);
        fy.push(y);
      }
    });
    if (fx.length >= IDEAS.floodCells) {
      const a = area(fx, fy);
      out.push({ kind: 'flood', village: k, ...a, weight: Math.min(0.9, fx.length / 200) });
    }

    // A marsh: shallow, still water on open land, away from deep water.
    const mx: number[] = [];
    const my: number[] = [];
    const [lo, hi] = IDEAS.marshDepth;
    r2(s.x, s.y, IDEAS.marshReach, (i, x, y) => {
      const d = water[i]!;
      if (d < lo || d > hi || landuse[i] !== LandUse.None || speed2(i) > IDEAS.marshStill ** 2 || (w.flags[i]! & CellFlag.Structure) !== 0) return;
      for (let yy = Math.max(0, y - 2); yy <= Math.min(w.height - 1, y + 2); yy++)
        for (let xx = Math.max(0, x - 2); xx <= Math.min(W - 1, x + 2); xx++) if (water[yy * W + xx]! >= IDEAS.marshDeep) return;
      mx.push(x);
      my.push(y);
    });
    if (mx.length >= IDEAS.marshCells) {
      const a = area(mx, my);
      out.push({ kind: 'marsh', village: k, ...a, weight: 0 });
    }

    // A strong stream near a village big enough for a mill, which has none.
    if (s.population >= MILL.minPeople && !mills.has(s.id)) {
      let best = -1;
      let bestQ = 0;
      let cells = 0;
      r2(s.x, s.y, MILL.radius, (i) => {
        const d = water[i]!;
        if (d < IDEAS.millDepth || speed2(i) < IDEAS.millSpeed ** 2) return;
        cells++;
        const q = d * Math.sqrt(speed2(i));
        if (q > bestQ) {
          bestQ = q;
          best = i;
        }
      });
      if (cells >= IDEAS.millCells && best >= 0) {
        const x = best % W;
        const y = (best / W) | 0;
        out.push({ kind: 'mill', village: k, x, y, r: 4, weight: 0 });
      }
    }
  }

  // Power: a finished weir without a turbine; houses far from power.
  const houses = new Map<number, number>();
  for (const b of p.buildings) if (b.kind === 'house' && b.progress >= 1) houses.set(b.settlement, (houses.get(b.settlement) ?? 0) + 1);
  const pw = h.power;
  const flags = w.flags;
  const villages = p.settlements.map((s, k) => ({ k, s: s.state })).filter((v) => (houses.get(v.s.id) ?? 0) >= IDEAS.houses);
  if (villages.length && (!pw || pw.turbines.length === 0)) {
    let best: { x: number; y: number; k: number; d: number } | null = null;
    for (const wr of h.structures.weirs) {
      if (!wr.cells.length || !wr.cells.every((c) => (flags[c]! & CellFlag.Lined) !== 0)) continue;
      const x = Math.round((wr.x + wr.x2) / 2);
      const y = Math.round((wr.y + wr.y2) / 2);
      for (const v of villages) {
        const d = Math.hypot(v.s.x - x, v.s.y - y);
        if (!best || d < best.d) best = { x, y, k: v.k, d };
      }
    }
    if (best) out.push({ kind: 'turbine', village: best.k, x: best.x, y: best.y, r: 4, weight: 0 });
  }
  if (pw && pw.turbines.length > 0 && pw.lastDay.produced > 0) {
    for (const v of villages) {
      if ((v.s.light ?? 0) >= IDEAS.litShare) continue;
      out.push({ kind: 'poles', village: v.k, x: Math.round(v.s.x), y: Math.round(v.s.y), r: 6, weight: 0 });
    }
  }
  return out;
}
