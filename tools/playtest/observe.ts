/**
 * Observers for the playtest harness: per-day and per-season metrics, notable
 * events (for pacing), and probes of a bot's target cells (for the response
 * latency). Read-only: nothing here changes the simulation. The one hook is
 * a wrapper around `Settlement.day` that reports arrivals and departures
 * (the sim computes them but does not keep them).
 */
import { DAYS_PER_SEASON, STEPS_PER_DAY, STEPS_PER_SECOND_1X } from '../../src/sim/constants';
import { prosperity, unlockMilestones } from '../../src/shared/progress';
import { REVEALED } from '../../src/sim/fog';
import { Settlement, type DayEvents } from '../../src/sim/people/settlement';
import type { Simulation } from '../../src/sim/sim';
import { forestCover, saturation } from '../../src/sim/vegetation';
import { LandUse } from '../../src/sim/world';
import { isRiver } from './geo';

// --- Arrivals and departures -------------------------------------------------

let daySink: ((ev: DayEvents) => void) | null = null;
const PATCHED = Symbol.for('hydro.playtest.dayPatched');
const proto = Settlement.prototype as unknown as Record<symbol, boolean> & { day: Settlement['day'] };
if (!proto[PATCHED]) {
  const orig = proto.day;
  proto.day = function (this: Settlement, doy, rng) {
    const ev = orig.call(this, doy, rng);
    daySink?.(ev);
    return ev;
  };
  proto[PATCHED] = true;
}

/** Real minutes at 1× for a number of game days. */
export const realMinutes = (days: number): number => (days * STEPS_PER_DAY) / STEPS_PER_SECOND_1X / 60;

export type EventKind =
  | 'house'
  | 'village'
  | 'flood'
  | 'flee'
  | 'unlock'
  | 'milestone'
  | 'arrival'
  | 'departure'
  | 'mood'
  | 'field'
  | 'river'
  | 'achievement';

export interface GameEvent {
  day: number;
  kind: EventKind;
  detail?: string;
}

/** One sample per season (taken mid-season). */
export interface SeasonSample {
  day: number;
  year: number;
  season: number;
  population: number;
  prosperity: number;
  villages: number;
  houses: number;
  fields: number;
  /** Fraction of the map that is revealed. */
  revealed: number;
  /** Food security (population-weighted, each village capped at 2). */
  foodSecurity: number;
  /** Food in store per head (person-days). */
  foodPerHead: number;
  /** Field cells with dry / waterlogged crop stress (growing seasons only, else 0). */
  dryStress: number;
  wetStress: number;
  /** Mean field moisture over fields. */
  fieldMoisture: number;
  forest: number;
  /** Cumulative counters. */
  floodCells: number;
  housesRuined: number;
  fled: number;
  arrived: number;
  left: number;
  born: number;
  died: number;
}

/** Daily series (compact). */
export interface DailySeries {
  population: number[];
  prosperity: number[];
  villages: number[];
  houses: number[];
  /** Villages with newcomers camping at the edge (round 5). */
  camps: number[];
  fields: number[];
  foodSecurity: number[];
  /** Fraction of fields under dry stress (null outside the growing season). */
  dryStress: (number | null)[];
}

export interface Totals {
  floodCells: number;
  housesRuined: number;
  fled: number;
  arrived: number;
  left: number;
  born: number;
  died: number;
}

const FLOOD_EVENT_CELLS = 5;
const RIVER_SHIFT_CELLS = 15;
const FIELD_EVENT_CELLS = 4;

export class Observer {
  readonly seasons: SeasonSample[] = [];
  readonly daily: DailySeries = { population: [], prosperity: [], villages: [], houses: [], camps: [], fields: [], foodSecurity: [], dryStress: [] };
  readonly events: GameEvent[] = [];
  /** First day the peak population reached each milestone. */
  readonly milestones: Record<number, number> = {};
  /** First day with a village, and the day each further village was founded. */
  readonly foundings: number[] = [];
  readonly totals: Totals = { floodCells: 0, housesRuined: 0, fled: 0, arrived: 0, left: 0, born: 0, died: 0 };
  /** Channel cells that changed (new channel outside the old one), per year. */
  readonly riverChange: number[] = [];
  private fleeing = new Set<number>();
  private builtHouses = new Set<number>();
  private moods = new Map<number, number>();
  private lastFlood = -10;
  private lastFlee = -10;
  private maxFields = 0;
  private achievements = 0;
  private villageCount = 0;
  private lastFloods = { cells: 0, ruined: 0 };
  /** Days each cell was a river channel this season, and last year's channel per season. */
  private riverDays: Uint8Array;
  private riverYearAgo: (Uint8Array | null)[] = [null, null, null, null];
  private readonly milestoneList: number[];

  constructor(private readonly sim: Simulation) {
    this.riverDays = new Uint8Array(sim.world.size);
    this.milestoneList = [...unlockMilestones().map((m) => m.population), 100, 200, 400];
    const f = sim.people?.floods;
    if (f) this.lastFloods = { ...f };
  }

  /** Run the sim `steps` steps, watching for people fleeing. */
  run(steps: number): void {
    const sim = this.sim;
    daySink = (ev) => {
      this.totals.arrived += ev.arrived;
      this.totals.left += ev.left;
      this.totals.born += ev.born;
      this.totals.died += ev.died;
      const day = sim.time.day;
      if (ev.arrived) this.events.push({ day, kind: 'arrival', detail: `${ev.arrived}` });
      if (ev.left) this.events.push({ day, kind: 'departure', detail: `${ev.left}` });
    };
    for (let done = 0; done < steps; ) {
      const n = Math.min(20, steps - done);
      sim.run(n);
      done += n;
      const p = sim.people;
      if (!p) continue;
      let any = false;
      for (const a of p.agents) {
        if (a.flee) {
          if (!this.fleeing.has(a.id)) {
            this.fleeing.add(a.id);
            this.totals.fled++;
            any = true;
          }
        } else this.fleeing.delete(a.id);
      }
      if (any) {
        const day = sim.time.day;
        if (day - this.lastFlee > 1) this.events.push({ day, kind: 'flee' });
        this.lastFlee = day;
      }
    }
    daySink = null;
  }

  /** Called after each full game day (`day` is the day that just ended). */
  endOfDay(day: number): void {
    const sim = this.sim;
    const w = sim.world;
    const p = sim.people;
    const t = sim.time;
    const vs = p ? p.settlements.filter((s) => s.state.population > 0) : [];
    const pop = vs.reduce((n, s) => n + s.state.population, 0);
    const prosp = prosperity(vs.map((s) => s.state)) ?? 0;
    const doy = t.season * DAYS_PER_SEASON + t.dayOfSeason;
    const fs = pop > 0 ? vs.reduce((n, s) => n + s.state.population * Math.min(2, s.foodSecurity(doy)), 0) / pop : 0;
    const growing = t.season === 0 || t.season === 1;
    let fields = 0;
    let dry = 0;
    let wet = 0;
    let moist = 0;
    if (p) {
      for (let i = 0; i < w.size; i++) {
        if (w.landuse[i] !== LandUse.Field) continue;
        fields++;
        moist += p.fieldMoisture[i]!;
        const st = p.stressAt(i, t.season);
        if (st >= 128) wet++;
        else if (st > 0) dry++;
      }
    }
    this.daily.population.push(pop);
    this.daily.prosperity.push(Math.round(prosp * 10) / 10);
    this.daily.villages.push(vs.length);
    this.daily.houses.push(vs.reduce((n, s) => n + s.state.houses, 0));
    this.daily.camps.push(vs.filter((s) => s.state.camp).length);
    this.daily.fields.push(fields);
    this.daily.foodSecurity.push(Math.round(fs * 100) / 100);
    this.daily.dryStress.push(growing && fields ? Math.round((dry / fields) * 1000) / 1000 : null);

    // Events.
    if (p) {
      const count = p.settlements.length;
      while (this.villageCount < count) {
        this.foundings.push(day);
        if (this.villageCount > 0) this.events.push({ day, kind: 'village', detail: `#${this.villageCount + 1}` });
        this.villageCount++;
      }
      for (const b of p.buildings) {
        if (b.kind === 'house' && b.progress >= 1 && !this.builtHouses.has(b.id)) {
          this.builtHouses.add(b.id);
          this.events.push({ day, kind: 'house' });
        }
        if (b.kind === 'ruin') this.builtHouses.delete(b.id);
      }
      const dc = p.floods.cells - this.lastFloods.cells;
      const dr = p.floods.ruined - this.lastFloods.ruined;
      this.totals.floodCells += dc;
      this.totals.housesRuined += dr;
      this.lastFloods = { ...p.floods };
      if (dc >= FLOOD_EVENT_CELLS || dr > 0) {
        if (day - this.lastFlood > 1) this.events.push({ day, kind: 'flood', detail: `${dc} cells, ${dr} houses` });
        else {
          let e: GameEvent | undefined;
          for (let k = this.events.length - 1; k >= 0 && !e; k--) if (this.events[k]!.kind === 'flood') e = this.events[k];
          if (e) e.detail = `${e.detail}; +${dc} cells, ${dr} houses`;
        }
        this.lastFlood = day;
      }
      for (const s of vs) {
        const m = s.state.mood ?? 0;
        const was = this.moods.get(s.state.id) ?? 0;
        if (m !== was) this.events.push({ day, kind: 'mood', detail: `village ${s.state.id}: ${was} → ${m}` });
        this.moods.set(s.state.id, m);
      }
      const peak = Math.max(p.peakPopulation, p.population);
      for (const ms of this.milestoneList) {
        if (peak >= ms && this.milestones[ms] === undefined) {
          this.milestones[ms] = day;
          const tools = unlockMilestones().find((m) => m.population === ms)?.tools;
          this.events.push({ day, kind: tools ? 'unlock' : 'milestone', detail: tools ? `${ms}: ${tools.join(', ')}` : `${ms}` });
        }
      }
    }
    if (fields >= this.maxFields + FIELD_EVENT_CELLS) {
      this.events.push({ day, kind: 'field', detail: `${fields} cells` });
      this.maxFields = fields;
    }
    const earned = sim.achievements.earned.length;
    for (let k = this.achievements; k < earned; k++) this.events.push({ day, kind: 'achievement', detail: sim.achievements.earned[k]!.id });
    this.achievements = earned;

    // River channel: cells that were river on most days of a season, compared
    // with the same season a year before (seasonal swelling is not a shift).
    for (let i = 0; i < w.size; i++) if (isRiver(w, i) && this.riverDays[i]! < 255) this.riverDays[i]!++;
    if (t.dayOfSeason === 0 && day > 0) {
      // The season that just ended.
      const season = (t.season + 3) % 4;
      const mask = Uint8Array.from(this.riverDays, (n) => (n >= DAYS_PER_SEASON / 2 ? 1 : 0));
      const old = this.riverYearAgo[season];
      if (old) {
        const changed = newChannel(old, mask, w.width, w.height, 2);
        const year = Math.floor((day - 1) / (4 * DAYS_PER_SEASON));
        this.riverChange[year] = (this.riverChange[year] ?? 0) + changed;
        if (changed >= RIVER_SHIFT_CELLS) this.events.push({ day, kind: 'river', detail: `${changed} new channel cells` });
      }
      this.riverYearAgo[season] = mask;
      this.riverDays.fill(0);
    }

    // Seasonal sample, mid-season.
    if (t.dayOfSeason === DAYS_PER_SEASON / 2) {
      let revealed = 0;
      for (let i = 0; i < w.size; i++) if (w.revealed[i]! >= REVEALED) revealed++;
      const food = vs.reduce((n, s) => n + s.state.food, 0);
      this.seasons.push({
        day,
        year: t.year,
        season: t.season,
        population: pop,
        prosperity: Math.round(prosp * 10) / 10,
        villages: vs.length,
        houses: vs.reduce((n, s) => n + s.state.houses, 0),
        fields,
        revealed: Math.round((revealed / w.size) * 1000) / 1000,
        foodSecurity: Math.round(fs * 100) / 100,
        foodPerHead: pop ? Math.round(food / pop) : 0,
        dryStress: growing && fields ? Math.round((dry / fields) * 1000) / 1000 : 0,
        wetStress: growing && fields ? Math.round((wet / fields) * 1000) / 1000 : 0,
        fieldMoisture: fields ? Math.round((moist / fields) * 1000) / 1000 : 0,
        forest: Math.round(forestCover(w) * 1000) / 1000,
        ...this.totals,
      });
    }
  }
}

/** Cells of `now` farther than r cells from any cell of `old`. */
function newChannel(old: Uint8Array, now: Uint8Array, W: number, H: number, r: number): number {
  let n = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!now[y * W + x]) continue;
      let near = false;
      for (let yy = Math.max(0, y - r); yy <= Math.min(H - 1, y + r) && !near; yy++)
        for (let xx = Math.max(0, x - r); xx <= Math.min(W - 1, x + r); xx++)
          if (old[yy * W + xx]) {
            near = true;
            break;
          }
      if (!near) n++;
    }
  return n;
}

/** Mean state of a set of cells (a bot's targets). */
export interface Probe {
  depth: number;
  moisture: number;
  saturation: number;
  /** Mean crop stress byte over the field cells among them (0 if none). */
  stress: number;
  /** Cells flooded (> 0.3 m). */
  flooded: number;
}

export function probe(sim: Simulation, cells: readonly number[]): Probe {
  const w = sim.world;
  const p = sim.people;
  const season = sim.time.season;
  let depth = 0;
  let moisture = 0;
  let sat = 0;
  let stress = 0;
  let nf = 0;
  let flooded = 0;
  for (const i of cells) {
    depth += w.water[i]!;
    moisture += p ? p.fieldMoisture[i]! : 0;
    sat += saturation(w, i);
    if (w.water[i]! > 0.3) flooded++;
    if (p && w.landuse[i] === LandUse.Field) {
      stress += p.stressAt(i, season);
      nf++;
    }
  }
  const n = Math.max(1, cells.length);
  return { depth: depth / n, moisture: moisture / n, saturation: sat / n, stress: nf ? stress / nf : 0, flooded };
}

/** How big a difference between bot and control counts as a visible response. */
export const RESPONSE_THRESHOLDS: Record<keyof Probe, number> = { depth: 0.05, moisture: 0.05, saturation: 0.05, stress: 8, flooded: 1 };
