/**
 * River seasons and wet/dry years (docs/GAMEPLAY.md §4.3 P1).
 *
 * Every boundary inflow is multiplied by
 *   Q(t) = base · season(t) · (1 + freshet(t)) · anomaly(year)
 * - `season`: a smooth profile (cosine-interpolated between the season
 *   midpoints): high water in spring, low water in late summer.
 * - `freshet`: the snowmelt surge from the mountains upstream in the first
 *   days of spring, larger after a wet winter (winter precipitation on the
 *   map against its running mean stands in for the snowpack upstream).
 * - `anomaly`: an AR(1) process per year, a' = ρ·a + σ·ε, drawn at New Year
 *   (the first day of spring) from a hash of the seed and the year, so it
 *   never disturbs the weather's random stream; the factor exp(a) is clamped
 *   to [0.55, 1.6]. The same anomaly makes rain fronts more or less frequent.
 *   It eases in over the first season of the year, so rivers never jump.
 *
 * Deterministic and saved (`SimState.climate`); old saves start at a = 0.
 */
import { Rng } from '../../shared/rng';
import type { SimTime } from '../../shared/protocol';
import { DAYS_PER_SEASON } from '../constants';

export const CLIMATE = {
  /** Inflow multiplier at the middle of spring, summer, autumn, winter. */
  inflowSeason: [1.6, 0.45, 0.8, 1.0] as readonly number[],
  /** Extra inflow at the freshet's peak (×base, scaled by the snow factor)... */
  freshet: 2.0,
  /** ...lasting this many days from the first day of spring, peaking on this day. */
  freshetDays: 8,
  freshetPeak: 2,
  /** The snow factor's range (winter precipitation against its mean). */
  snowMin: 0.5,
  snowMax: 2,
  /** AR(1) anomaly: persistence and innovation (stationary sd ≈ 0.3: a dry year, factor < 0.75, about one in six). */
  anomalyRho: 0.6,
  anomalyNoise: 0.24,
  /** Range of the yearly factor exp(a). */
  factorMin: 0.55,
  factorMax: 1.6,
  /** The first year is kept ordinary (the player's first impression)... */
  firstYear: [-0.1, 0.2] as readonly number[],
  /**
   * ...and the second one is dry at most this (factor ≈ 0.7): the first
   * summer shortage comes while the player has just got the weir
   * (docs/PLAYTEST.md round 2, the year-2 lull).
   */
  secondYearMax: -0.35,
  /**
   * Big freshets (spring floods that go over the floodplain): from year
   * `bigFrom` (0-based) on, a year has one with chance `bigChance · exp(bigWet · a)`
   * (clamped to `bigChanceRange`; return period ≈ 4 years, likelier in wet
   * years; at least `bigEarly` in the years before `bigEarlyUntil`, and one
   * of them has one for sure, so the floodplain fields learn what a flood is
   * early: round 5), and its freshet
   * is `bigFactor` (+ up to `bigSpread`) times the usual one, lasting
   * `bigDays` days. Drawn from a hash of seed and year.
   */
  bigChance: 0.25,
  bigWet: 1.5,
  bigChanceRange: [0.1, 0.6] as readonly number[],
  bigFactor: 3,
  bigSpread: 1.5,
  bigDays: 12,
  bigFrom: 1,
  bigEarly: 0.5,
  bigEarlyUntil: 3,
  /** Rain fronts per day × exp(frontsAnomaly · a). */
  frontsAnomaly: 0.8,
  /** Per-tile rain factor range (generation climate: wetness, rain shadow). */
  rainMin: 0.4,
  rainMax: 2,
};

/** What a save needs to resume the climate exactly. */
export interface ClimateRunState {
  /** Year whose anomaly is `anomaly`. */
  year: number;
  anomaly: number;
  /** Last year's anomaly (eased into the new one over the first season). */
  prevAnomaly: number;
  /** Precipitation ledger total (m³) when the current winter began (−1 outside winter). */
  winterStart: number;
  /** Running mean of winter precipitation (m³; 0 = none seen yet). */
  winterMean: number;
  /** Freshet size of the current year (winter precipitation against its mean). */
  snowFactor: number;
  /** Per-tile rain factor from the generation climate (absent: uniform). */
  rainMap?: number[];
  /** Steady rivers, no wet or dry years (staged scenes). */
  steady?: boolean;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** The yearly innovation ε ~ N(0, 1) for `year`, a pure function of the seed. */
function innovation(seed: number, year: number): number {
  return new Rng((seed * 0x9e3779b1) ^ (year * 0x85ebca6b) ^ 0xc11a7e).normal();
}

/**
 * The size of `year`'s big freshet relative to an ordinary one (0: none),
 * a pure function of the seed, the year and its anomaly `a`.
 */
export function bigFreshet(seed: number, year: number, a: number): number {
  if (year < CLIMATE.bigFrom) return 0;
  const r = new Rng((seed * 0x2545f491) ^ (year * 0x9e3779b1) ^ 0xf1d0);
  const [lo, hi] = CLIMATE.bigChanceRange;
  let chance = Math.max(clamp(CLIMATE.bigChance * Math.exp(CLIMATE.bigWet * a), lo!, hi!), year < CLIMATE.bigEarlyUntil ? CLIMATE.bigEarly : 0);
  // The last early year has one if the first early year drew none (its draw was above bigEarly).
  if (year === CLIMATE.bigEarlyUntil - 1 && year > CLIMATE.bigFrom) {
    const first = new Rng((seed * 0x2545f491) ^ (CLIMATE.bigFrom * 0x9e3779b1) ^ 0xf1d0).next();
    if (first >= CLIMATE.bigEarly) chance = 1;
  }
  const u = r.next();
  return u < chance ? CLIMATE.bigFactor + CLIMATE.bigSpread * r.next() : 0;
}

export class Climate {
  state: ClimateRunState;

  /** Whether rivers follow the seasons and years (staged scenes keep them steady; saved). */
  get seasonal(): boolean {
    return !this.state.steady;
  }

  set seasonal(on: boolean) {
    if (on) delete this.state.steady;
    else this.state.steady = true;
  }

  constructor(private readonly seed: number) {
    const a0 = clamp(CLIMATE.anomalyNoise * innovation(seed, 0) * 1.25, CLIMATE.firstYear[0]!, CLIMATE.firstYear[1]!);
    this.state = { year: 0, anomaly: a0, prevAnomaly: a0, winterStart: -1, winterMean: 0, snowFactor: 1 };
  }

  /** Yearly factor exp(a), clamped. */
  static factor(a: number): number {
    return clamp(Math.exp(a), CLIMATE.factorMin, CLIMATE.factorMax);
  }

  /** The anomaly in effect at `t` (eased from last year's over the first season). */
  anomalyAt(t: SimTime): number {
    const s = this.state;
    const f = Math.min(1, t.yearFrac * 4);
    const e = f * f * (3 - 2 * f);
    return s.prevAnomaly + (s.anomaly - s.prevAnomaly) * e;
  }

  /** This year's wetness factor (1 = an ordinary year). */
  yearFactor(): number {
    return Climate.factor(this.state.anomaly);
  }

  /**
   * Advance the yearly bookkeeping (call before each weather update):
   * a new anomaly at New Year, winter precipitation for next spring's freshet.
   * `precipTotal` is the ledger's rain + snowfall so far (m³).
   */
  update(t: SimTime, precipTotal: number): void {
    const s = this.state;
    if (t.year > s.year) {
      s.year = t.year;
      s.prevAnomaly = s.anomaly;
      s.anomaly = CLIMATE.anomalyRho * s.anomaly + CLIMATE.anomalyNoise * innovation(this.seed, t.year);
      if (t.year === 1) s.anomaly = Math.min(s.anomaly, CLIMATE.secondYearMax);
      // Last winter's snowpack sizes this spring's freshet.
      if (s.winterStart >= 0) {
        const winter = precipTotal - s.winterStart;
        s.snowFactor = s.winterMean > 0 ? clamp(winter / s.winterMean, CLIMATE.snowMin, CLIMATE.snowMax) : 1;
        s.winterMean = s.winterMean > 0 ? 0.7 * s.winterMean + 0.3 * winter : winter;
        s.winterStart = -1;
      }
    }
    if (t.season === 3 && s.winterStart < 0) s.winterStart = precipTotal;
  }

  /** Multiplier on every boundary inflow at time `t`. */
  inflowFactor(t: SimTime): number {
    if (!this.seasonal) return 1;
    return seasonalInflow(t.yearFrac, this.state.snowFactor, this.bigFreshet()) * Climate.factor(this.anomalyAt(t));
  }

  /** This year's big freshet relative to an ordinary one (0: none this year). */
  bigFreshet(): number {
    return bigFreshet(this.seed, this.state.year, this.state.anomaly);
  }

  /** Multiplier on the rain-front frequency. */
  frontFactor(t: SimTime): number {
    if (!this.seasonal) return 1;
    return Math.exp(CLIMATE.frontsAnomaly * this.anomalyAt(t));
  }

  getState(): ClimateRunState {
    return { ...this.state, rainMap: this.state.rainMap?.slice() };
  }

  setState(st: ClimateRunState): void {
    this.state = { ...st, rainMap: st.rainMap?.slice() };
  }
}

/**
 * The seasonal inflow profile at `yearFrac` (0 = first day of spring):
 * cosine interpolation between the season midpoints, plus the freshet.
 */
export function seasonalInflow(yearFrac: number, snowFactor = 1, big = 0): number {
  const p = CLIMATE.inflowSeason;
  // Season midpoints at 0.125, 0.375, …; u counts midpoints from spring's.
  const u = (((yearFrac - 0.125) * 4) % 4 + 4) % 4;
  const k = Math.floor(u);
  const f = u - k;
  const c = (1 - Math.cos(Math.PI * f)) / 2;
  const base = p[k % 4]! * (1 - c) + p[(k + 1) % 4]! * c;
  const day = yearFrac * 4 * DAYS_PER_SEASON;
  let fr = 0;
  const len = big > 0 ? CLIMATE.bigDays : CLIMATE.freshetDays;
  if (day < len) {
    const pk = CLIMATE.freshetPeak;
    const shape = day < pk ? Math.sin((Math.PI / 2) * (day / pk)) : Math.cos((Math.PI / 2) * ((day - pk) / (len - pk)));
    fr = CLIMATE.freshet * Math.max(snowFactor, big > 0 ? 1 : 0) * Math.max(1, big) * shape * shape;
  }
  return base + fr;
}

/** Tile means of a per-cell rain factor, clamped (the live weather's rain map). */
export function tileRainMap(rain: Float32Array, W: number, H: number, tile: number): number[] {
  const tw = Math.ceil(W / tile);
  const th = Math.ceil(H / tile);
  const sum = new Float64Array(tw * th);
  const n = new Float64Array(tw * th);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const t = ((y / tile) | 0) * tw + ((x / tile) | 0);
      sum[t]! += rain[y * W + x]!;
      n[t]! += 1;
    }
  const out: number[] = [];
  for (let t = 0; t < tw * th; t++) out.push(Math.round(clamp(sum[t]! / Math.max(1, n[t]!), CLIMATE.rainMin, CLIMATE.rainMax) * 1000) / 1000);
  return out;
}
