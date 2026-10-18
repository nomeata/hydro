/**
 * The hidden settlement economy (docs/PEOPLE.md §4). It owns decisions and
 * demography only: food enters through `bookFood` when agents finish work;
 * this module never produces anything by itself.
 */
import type { Rng } from '../../shared/rng';
import { DAYS_PER_SEASON, DAYS_PER_YEAR } from '../constants';
import { MILL } from './mills';
import { POWER } from '../power/power';
import type { Jetty } from './works';

export const ECONOMY = {
  /** Food eaten per person per day (person-days, by definition 1). */
  consumption: 1,
  /** Fraction of the store that spoils per day. */
  spoilage: 0.004,
  /** Storage capacity in years of need. */
  storageYears: 1.5,
  /** Smoothing time of wellbeing (days). */
  wellbeingTau: 6,
  /** People per house. */
  houseCapacity: 4,
  /** Expected arriving families per day at w = 1 with one free house. */
  arrivalRate: 0.6,
  /** Expected leaving families per day per household at w = 0. */
  departureRate: 0.02,
  /** Arrivals need w above this; departures happen below the second. */
  arriveAbove: 0.6,
  leaveBelow: 0.4,
  /**
   * Families stop arriving and births pause while food security is below
   * this, so a village levels off fed rather than hungry (GAMEPLAY §4.1).
   */
  growFood: 1,
  /** Natural births/deaths per person per year (small, roughly balanced). */
  birthRate: 0.04,
  deathRate: 0.035,
  /** Extra deaths per person per year when starving. */
  starvationDeathRate: 0.3,
  /** Families arrive with this many people (min, max). */
  familySize: [2, 5] as const,
  /** Logs the woodpile holds at most. */
  woodMax: 10,
  /** Logs burnt per day in winter, and in the rest of the year. */
  woodBurnWinter: 0.6,
  woodBurn: 0.15,
  /** Wellbeing bonus of a warm hearth (wood on the pile) in winter. */
  warmWinter: 0.05,
};

/** The village herd's day (docs/PEOPLE.md §5): out at pasture with the herder, or home at the fold. */
export interface HerdState {
  /** The herd is out at pasture (cows and sheep head for `pasture`), else home at `fold`. */
  out: boolean;
  /** Pasture cell of the current or next outing. */
  pasture: number;
  /** Where the herd stays by the village. */
  fold: number;
  /** Step before which the herder rests between outings. */
  restUntil: number;
}

export interface SettlementState {
  id: number;
  x: number;
  y: number;
  population: number;
  houses: number;
  food: number;
  wellbeing: number;
  /** Day of year of the main harvest (end of summer). */
  harvestDay: number;
  /** Rolling score of water access and safety, 0..1, set by the land model. */
  waterAccess: number;
  safety: number;
  /** Starving days in a row (for visible distress). */
  hungryDays: number;
  /** Banks and canal cells the village wants to line, best first (works.ts; absent in old saves). */
  lineSites?: number[];
  /** Cells the village may line now (grows daily with wellbeing). */
  lineBudget?: number;
  /** The village's fishing jetty, once chosen. */
  jetty?: Jetty;
  /**
   * Visible mood (docs/PEOPLE.md §7), from wellbeing with hysteresis so the
   * props it drives don't flicker: 1 prosperous, 0 ordinary, −1 struggling
   * (absent in old saves: 0).
   */
  mood?: Mood;
  /** Logs on the woodpile (M3-δ; absent in old saves: none). Cosmetic, plus a warm winter. */
  wood?: number;
  /** Forest edge cells the woodcutters may fell, best first (daily). */
  chopSites?: number[];
  /** The herd's day, once the village keeps animals. */
  herd?: HerdState;
  /** The village's mill turned today (GAMEPLAY §1.2: a little wellbeing; absent in old saves). */
  milling?: boolean;
  /** Share of the village's houses lit by the power grid yesterday, 0..1 (M6, power/grid.ts; absent: none). */
  light?: number;
}

export type Mood = -1 | 0 | 1;

/** Wellbeing thresholds of the visible mood: enter above/below the first, leave past the second. */
export const MOOD = {
  prosperousEnter: 0.62,
  prosperousLeave: 0.55,
  strugglingEnter: 0.28,
  strugglingLeave: 0.35,
};

/** The next mood for a wellbeing, given the current one (hysteresis). */
export function nextMood(mood: Mood, w: number): Mood {
  if (mood === 1) return w < MOOD.prosperousLeave ? nextMood(0, w) : 1;
  if (mood === -1) return w > MOOD.strugglingLeave ? nextMood(0, w) : -1;
  if (w > MOOD.prosperousEnter) return 1;
  if (w < MOOD.strugglingEnter) return -1;
  return 0;
}

export interface DayEvents {
  arrived: number;
  left: number;
  born: number;
  died: number;
}

export class Settlement {
  state: SettlementState;

  constructor(id: number, x: number, y: number, population: number, food: number) {
    this.state = {
      id,
      x,
      y,
      population,
      houses: 0,
      food,
      wellbeing: 0.7,
      harvestDay: Math.round(DAYS_PER_YEAR * 0.6),
      waterAccess: 1,
      safety: 1,
      hungryDays: 0,
    };
  }

  get storageCap(): number {
    return Math.max(60, this.state.population * ECONOMY.consumption * DAYS_PER_YEAR * ECONOMY.storageYears);
  }

  get freeHouses(): number {
    const s = this.state;
    return s.houses - Math.ceil(s.population / ECONOMY.houseCapacity);
  }

  /** Agents deliver food (person-days). Excess beyond storage is lost. */
  bookFood(amount: number): void {
    const s = this.state;
    s.food = Math.min(this.storageCap, s.food + amount);
  }

  /** Days until the next main harvest, given the day of year. */
  daysToHarvest(dayOfYear: number): number {
    const d = this.state.harvestDay - dayOfYear;
    return d >= 0 ? d : d + DAYS_PER_YEAR;
  }

  /** Food security: stock relative to need until the next harvest (+ margin). */
  foodSecurity(dayOfYear: number): number {
    const s = this.state;
    if (s.population <= 0) return 1;
    return s.food / (s.population * ECONOMY.consumption * (this.daysToHarvest(dayOfYear) + 6));
  }

  /** Advance one game day. */
  day(dayOfYear: number, rng: Rng): DayEvents {
    const s = this.state;
    const ev: DayEvents = { arrived: 0, left: 0, born: 0, died: 0 };

    // Eat and spoil.
    const need = s.population * ECONOMY.consumption;
    const starving = s.food < need;
    s.food = Math.max(0, s.food - need);
    s.food *= 1 - ECONOMY.spoilage;
    s.hungryDays = starving && s.population > 0 ? s.hungryDays + 1 : 0;

    // Wellbeing (never feeds back into production; see PEOPLE.md §4).
    const housing = s.population === 0 ? 1 : Math.min(1, (s.houses * ECONOMY.houseCapacity) / s.population);
    // Firewood: burnt over the year, most in winter, when a warm hearth cheers people up a little.
    const winter = Math.floor(dayOfYear / DAYS_PER_SEASON) === 3;
    const warm = winter && (s.wood ?? 0) >= 1 ? ECONOMY.warmWinter : 0;
    if (s.wood !== undefined) s.wood = Math.max(0, s.wood - (winter ? ECONOMY.woodBurnWinter : ECONOMY.woodBurn));
    const target = Math.min(
      1,
      0.55 * Math.min(1, this.foodSecurity(dayOfYear)) + 0.2 * housing + 0.15 * s.waterAccess + 0.1 * s.safety + warm + (s.milling ? MILL.wellbeing : 0) + POWER.wellbeing * (s.light ?? 0),
    );
    s.wellbeing += (target - s.wellbeing) / ECONOMY.wellbeingTau;
    s.mood = nextMood(s.mood ?? 0, s.wellbeing);

    // Natural change (small, mostly cosmetic).
    const perDay = 1 / DAYS_PER_YEAR;
    const fed = this.foodSecurity(dayOfYear) >= ECONOMY.growFood;
    const births = fed ? s.population * ECONOMY.birthRate * perDay * (s.wellbeing > 0.5 ? 1 : 0.3) : 0;
    const deaths = s.population * (ECONOMY.deathRate + (starving ? ECONOMY.starvationDeathRate : 0)) * perDay;
    if (rng.next() < births) {
      s.population++;
      ev.born++;
    }
    if (s.population > 0 && rng.next() < deaths) {
      s.population--;
      ev.died++;
    }

    // Migration: the main lever, rate-limited by housing.
    const free = Math.max(0, this.freeHouses);
    const pArrive = fed ? ECONOMY.arrivalRate * Math.max(0, s.wellbeing - ECONOMY.arriveAbove) * free : 0;
    if (free > 0 && rng.next() < pArrive) {
      const n = rng.int(ECONOMY.familySize[0], ECONOMY.familySize[1] + 1);
      s.population += n;
      ev.arrived += n;
    }
    const households = Math.ceil(s.population / ECONOMY.houseCapacity);
    const pLeave = ECONOMY.departureRate * Math.max(0, ECONOMY.leaveBelow - s.wellbeing) * households;
    if (s.population > 0 && rng.next() < pLeave) {
      const n = Math.min(s.population, rng.int(ECONOMY.familySize[0], ECONOMY.familySize[1] + 1));
      s.population -= n;
      ev.left += n;
    }
    return ev;
  }

  /** Whether the settlement wants another house built. */
  wantsHouse(): boolean {
    return this.freeHouses < 1 && this.state.wellbeing > 0.5;
  }
}
