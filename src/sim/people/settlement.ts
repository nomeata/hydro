/**
 * The hidden settlement economy (docs/PEOPLE.md §4). It owns decisions and
 * demography only: food enters through `bookFood` when agents finish work;
 * this module never produces anything by itself.
 */
import type { Rng } from '../../shared/rng';
import { DAYS_PER_YEAR } from '../constants';

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
  /** Natural births/deaths per person per year (small, roughly balanced). */
  birthRate: 0.04,
  deathRate: 0.035,
  /** Extra deaths per person per year when starving. */
  starvationDeathRate: 0.3,
  /** Families arrive with this many people (min, max). */
  familySize: [2, 5] as const,
};

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
    const target =
      0.55 * Math.min(1, this.foodSecurity(dayOfYear)) + 0.2 * housing + 0.15 * s.waterAccess + 0.1 * s.safety;
    s.wellbeing += (target - s.wellbeing) / ECONOMY.wellbeingTau;

    // Natural change (small, mostly cosmetic).
    const perDay = 1 / DAYS_PER_YEAR;
    const births = s.population * ECONOMY.birthRate * perDay * (s.wellbeing > 0.5 ? 1 : 0.3);
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
    const pArrive = ECONOMY.arrivalRate * Math.max(0, s.wellbeing - ECONOMY.arriveAbove) * free;
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
