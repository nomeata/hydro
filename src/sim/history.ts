/**
 * The game's history for the stats bar's chart: one sample per game day
 * (population, prosperity, precipitation, temperature, floods, villages)
 * plus the days tool-unlock milestones were reached. Recorded at each day
 * boundary by the Simulation, saved with it, and thinned for long games:
 * daily for the last two years, bins of BIN_DAYS before that, and bins of a
 * whole year beyond YEARLY_AFTER days.
 */
import type { HistoryData, HistoryMilestone, HistorySample } from '../shared/protocol';
import { prosperity, unlockMilestones } from '../shared/progress';
import { DAYS_PER_SEASON, DAYS_PER_YEAR } from './constants';

/** Days kept at daily resolution. */
export const DAILY_DAYS = 2 * DAYS_PER_YEAR;
/** Older samples are merged into bins of this many days (half a season). */
export const BIN_DAYS = DAYS_PER_SEASON / 2;
/** Samples older than this many days are merged into yearly bins. */
export const YEARLY_AFTER = 20 * DAYS_PER_YEAR;

/** What the simulation reports at the end of each day. */
export interface DayReport {
  /** The day that just ended. */
  day: number;
  villages: readonly { population: number; wellbeing: number }[];
  /** Highest population so far (milestones). */
  peak: number;
  /** Cumulative precipitation (m³ over the map) and the map area (m²). */
  precipTotal: number;
  area: number;
  /** Daily mean temperature (°C). */
  temperature: number;
  /** Cumulative flood counters. */
  floodCells: number;
  ruined: number;
  /** The power grid, once there is one: mean power produced over the day (kW), houses on the grid. */
  power?: { kw: number; lit: number };
}

/** Saved form: columns, rounded for compactness. */
export interface HistoryState {
  /** Columns d, n, p, w, r, t, f, h, v of the samples, then e and l (null where absent; missing in older saves). */
  cols: number[][];
  milestones: HistoryMilestone[];
  /** Cumulative totals seen at the previous day boundary. */
  last: { precip: number; floodCells: number; ruined: number };
}

const KEYS = ['d', 'n', 'p', 'w', 'r', 't', 'f', 'h', 'v'] as const;
/** Optional columns (M6 power): absent in a sample before the grid existed. */
const OPT_KEYS = ['e', 'l'] as const;

const round1 = (x: number) => Math.round(x * 10) / 10;

/** Merge consecutive samples into one covering all their days. */
export function mergeSamples(ss: readonly HistorySample[]): HistorySample {
  const first = ss[0]!;
  const last = ss[ss.length - 1]!;
  let n = 0;
  let w = 0;
  let r = 0;
  let t = 0;
  let f = 0;
  let h = 0;
  let e = 0;
  let en = 0;
  for (const s of ss) {
    if (s.e !== undefined) {
      e += s.e * s.n;
      en += s.n;
    }
    n += s.n;
    w += s.w * s.n;
    r += s.r * s.n;
    t += s.t * s.n;
    f += s.f;
    h += s.h;
  }
  const out: HistorySample = { d: first.d, n, p: last.p, w: round1(w / n), r: Math.round((r / n) * 100) / 100, t: round1(t / n), f, h, v: last.v };
  // Power: the mean over the days the grid existed; houses lit at the end.
  if (en > 0) out.e = round1(e / n);
  if (last.l !== undefined) out.l = last.l;
  return out;
}

export class History {
  samples: HistorySample[] = [];
  milestones: HistoryMilestone[] = [];
  private last = { precip: NaN, floodCells: NaN, ruined: NaN };

  /** Start afresh, counting from the given cumulative totals. */
  reset(precipTotal: number, floodCells: number, ruined: number): void {
    this.samples = [];
    this.milestones = [];
    this.last = { precip: precipTotal, floodCells, ruined };
  }

  /** Record the day that just ended. */
  record(rep: DayReport): void {
    const last = this.last;
    // The first report after creation (or an old save) only sets the baseline counters.
    const first = Number.isNaN(last.precip);
    const precip = first ? 0 : Math.max(0, rep.precipTotal - last.precip);
    const s: HistorySample = {
      d: rep.day,
      n: 1,
      p: rep.villages.reduce((n, v) => n + v.population, 0),
      w: round1(prosperity(rep.villages) ?? 0),
      r: Math.round(((precip / rep.area) * 1000) * 100) / 100,
      t: round1(rep.temperature),
      f: first ? 0 : Math.max(0, rep.floodCells - last.floodCells),
      h: first ? 0 : Math.max(0, rep.ruined - last.ruined),
      v: rep.villages.length,
    };
    if (rep.power) {
      s.e = round1(rep.power.kw);
      s.l = rep.power.lit;
    }
    this.last = { precip: rep.precipTotal, floodCells: rep.floodCells, ruined: rep.ruined };
    this.samples.push(s);
    for (const m of unlockMilestones()) {
      if (rep.peak >= m.population && !this.milestones.some((x) => x.population === m.population)) {
        this.milestones.push({ population: m.population, day: rep.day });
      }
    }
    this.thin(rep.day);
  }

  /** Merge old daily samples into bins (deterministic: bins are aligned to day numbers). */
  thin(today: number): void {
    this.thinRange(today - YEARLY_AFTER, DAYS_PER_YEAR);
    this.thinRange(today - DAILY_DAYS, BIN_DAYS);
  }

  /** Merge samples ending before `cutoff` into aligned bins of `bin` days. */
  private thinRange(cutoff: number, bin: number): void {
    const ss = this.samples;
    const out: HistorySample[] = [];
    let k = 0;
    let changed = false;
    while (k < ss.length) {
      const s = ss[k]!;
      const start = Math.floor(s.d / bin) * bin;
      const end = start + bin;
      if (end > cutoff || s.n >= bin) {
        out.push(s);
        k++;
        continue;
      }
      const group: HistorySample[] = [];
      while (k < ss.length && ss[k]!.d < end) group.push(ss[k++]!);
      if (group.length > 1) changed = true;
      out.push(group.length > 1 ? mergeSamples(group) : group[0]!);
    }
    if (changed) this.samples = out;
  }

  data(): HistoryData {
    return { samples: this.samples.map((s) => ({ ...s })), milestones: this.milestones.map((m) => ({ ...m })) };
  }

  getState(): HistoryState {
    return {
      cols: [...KEYS.map((k) => this.samples.map((s) => s[k])), ...(this.samples.some((s) => s.e !== undefined) ? OPT_KEYS.map((k) => this.samples.map((s) => s[k] ?? (null as unknown as number))) : [])],
      milestones: this.milestones.map((m) => ({ ...m })),
      last: { ...this.last },
    };
  }

  setState(st: HistoryState): void {
    const n = st.cols[0]?.length ?? 0;
    this.samples = [];
    for (let i = 0; i < n; i++) {
      const s = {} as Record<(typeof KEYS)[number], number>;
      KEYS.forEach((k, c) => (s[k] = st.cols[c]?.[i] ?? 0));
      const hs = s as HistorySample;
      OPT_KEYS.forEach((k, c) => {
        const v = st.cols[KEYS.length + c]?.[i];
        if (v !== undefined && v !== null) hs[k] = v;
      });
      this.samples.push(hs);
    }
    this.milestones = st.milestones.map((m) => ({ ...m }));
    // JSON turns NaN into null.
    const num = (x: number | null) => (x === null || x === undefined ? NaN : x);
    this.last = { precip: num(st.last.precip), floodCells: num(st.last.floodCells), ruined: num(st.last.ruined) };
  }
}
