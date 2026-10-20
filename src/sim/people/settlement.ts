/**
 * The hidden settlement economy (docs/PEOPLE.md §4). It owns decisions and
 * demography only: food enters through `bookFood` when agents finish work;
 * this module never produces anything by itself.
 */
import type { Rng } from '../../shared/rng';
import { DAYS_PER_SEASON, DAYS_PER_YEAR } from '../constants';
import type { Ditch } from './ditches';
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
  /**
   * Prosperity (`wellbeing`) follows the day's plenty quickly (τ days), and
   * the village's reputation follows prosperity over a few weeks
   * (`reputationTau` game days: a game day is about a calendar week).
   * Newcomers judge by reputation, i.e. by how good the village has looked
   * lately, not by forecasts (docs/PLAYTEST.md round 6).
   */
  wellbeingTau: 3,
  reputationTau: 5,
  /** People per house. */
  houseCapacity: 4,
  /**
   * Plenty (`Settlement.plenty`): food in the store and in the fields now,
   * against the need until the next harvest (and the year after it, for the
   * share of the crop already grown: by the crops' stage in spring, the
   * calendar from summer, up to `growDays`). 1 = just enough. Prosperity's food
   * part is 0 at `plentyLo` and full at `plentyHi` ("plenty for everyone
   * and then some").
   */
  plentyLo: 0.6,
  plentyHi: 1.4,
  /** Below this plenty families leave (`leaveRate` per household and day per unit of the shortfall). */
  enough: 1,
  leaveRate: 0.3,
  /** Days of the growing season over which the fields' crop comes to count as next year's food. */
  growDays: 2 * DAYS_PER_SEASON - 2,
  /**
   * Prosperity = food part × (comfortBase + (1 − comfortBase) × comfort):
   * comfort (housing, water access, safety, weighted by `comfort`) is a
   * small term, as are the warm hearth, the mill and lit houses.
   */
  comfortBase: 0.85,
  comfort: [0.4, 0.35, 0.25] as readonly number[],
  /**
   * Arrivals: families a day = arrivalRate × (arrivalBase + population / arrivalScale)
   * × (reputation − arriveAbove) / (1 − arriveAbove): word spreads further
   * from a bigger village. A family comes when the summed rate passes a
   * threshold drawn from `pullNeed`; with no free house it camps at the
   * edge until one is built.
   */
  arrivalRate: 0.25,
  arrivalBase: 1,
  arrivalScale: 20,
  pullNeed: [0.6, 1.4] as readonly number[],
  arriveAbove: 0.6,
  /**
   * A village smaller than this takes migrants at a lower reputation
   * (`arriveSmall`): a trickle that refills a village after a setback
   * (PEOPLE.md §4, recovery floor).
   */
  smallVillage: 12,
  arriveSmall: 0.45,
  /** Each ruin by the village (not rebuilt, not yet gone) costs this much reputation, at most `ruinMax`. */
  ruinPenalty: 0.04,
  ruinMax: 0.2,
  /**
   * The recovery floor (no failure; GAMEPLAY §4.2): families leave a village
   * only while more than this many people live there, and at or below it
   * hunger kills nobody.
   */
  stayers: 8,
  /**
   * Births per person per year: `birthRate`, plus up to `birthBoost` as
   * prosperity rises from 0.5 to 1 (a prosperous village has more children);
   * deaths per person per year.
   */
  birthRate: 0.02,
  birthBoost: 0.16,
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
  /** Field ditches dug (or being dug) off the player's canals (people/ditches.ts; absent: none). */
  ditches?: Ditch[];
  /** Share of the village's houses lit by the power grid yesterday, 0..1 (M6, power/grid.ts; absent: none). */
  light?: number;
  /**
   * Good land staked out for farmers still to come (pegged plots, daily;
   * docs/PEOPLE.md §3.1; absent: none): only while the village has more good
   * land than hands.
   */
  pegs?: number[];
  /**
   * What holds the village's growth back (daily, after the day's planning;
   * `classifyGrowth`; absent in old saves until the next day).
   */
  limit?: GrowthLimit;
  /** Summed arrival chances since the last family came, and the sum the next one needs (Settlement.day). */
  pull?: number;
  pullNeed?: number;
  /** Day from which `limit` has been one that stops growth (land, food, wellbeing, room); absent while growing. */
  stalledSince?: number;
  /**
   * Newcomers camping at the village edge (docs/GAMEPLAY.md §4.6): a family
   * that would like to settle but finds no room (no site for a house) or no
   * land (good land used up). `cell` is where their cart stands, `since` the
   * day they came; they leave after `CAMP.stay` days if nothing changes, and
   * move in when the village can take them.
   */
  camp?: { cell: number; since: number };
  /** Day from which another family may camp (after one moved on). */
  campAgain?: number;
  /**
   * Round 6 (docs/PLAYTEST.md): the food in the fields now (person-days: each
   * sown field at its crop's current stage; village.ts manageFields, daily),
   * the day's plenty (`Settlement.plenty`), the reputation (prosperity
   * smoothed over weeks; newcomers judge by it), the ruins by the village
   * (each costs reputation), and the summed departure pressure since the last
   * family left. All absent in old saves.
   */
  crops?: number;
  /** Mean stage of the sown crops, 0..1 (village.ts manageFields, daily). */
  ripe?: number;
  plenty?: number;
  reputation?: number;
  ruins?: number;
  push?: number;
}

/**
 * Why a village is not growing (docs/GAMEPLAY.md §4.6), most binding first:
 * - `land`: food is short (plenty below enough, or too little for a good
 *   reputation) and the good land within walking reach is used up (hardy
 *   crops, no pegs);
 * - `food`: food is short though good land is left (poor yields: dry or
 *   tired fields, a flood, a lean season);
 * - `wellbeing`: fed, but the reputation is too low for newcomers (ruins,
 *   no well, floods);
 * - `room`: families would come, a house is wanted but there is no site for it;
 * - `building`: a house is going up (growing);
 * - `open`: a free house waits for newcomers (growing).
 */
export type GrowthLimit = 'land' | 'food' | 'wellbeing' | 'room' | 'building' | 'open';

export interface GrowthFacts {
  reputation: number;
  /** Reputation above which families arrive (arriveAbove, or arriveSmall for a small village). */
  arriveAbove: number;
  /** Today's plenty (`Settlement.plenty`). */
  plenty: number;
  freeHouses: number;
  /** A house is being built (or a ruin rebuilt). */
  building: boolean;
  /** Good land the village could still claim (unclaimed plots within walking reach). */
  goodLeft: number;
}

export function classifyGrowth(f: GrowthFacts): GrowthLimit {
  const hungry = f.plenty < ECONOMY.enough || (f.reputation <= f.arriveAbove && foodPart(f.plenty) <= f.arriveAbove + 0.05);
  if (hungry) return f.goodLeft > 0 ? 'food' : 'land';
  if (f.reputation <= f.arriveAbove) return 'wellbeing';
  if (f.freeHouses > 0) return 'open';
  if (f.building) return 'building';
  return 'room';
}

/** Prosperity's food part for a plenty: 0 at `plentyLo`, 1 from `plentyHi`. */
export function foodPart(plenty: number): number {
  return Math.max(0, Math.min(1, (plenty - ECONOMY.plentyLo) / (ECONOMY.plentyHi - ECONOMY.plentyLo)));
}

/** Camping newcomers (docs/GAMEPLAY.md §4.6). */
export const CAMP = {
  /** Days a family camps before giving up and moving on. */
  stay: 24,
  /** Days without a camp before another family tries. */
  again: 12,
  /** Distance (cells) of the camp from the village centre. */
  dist: 9,
};

/** Limits under which newcomers camp at the edge: they want to come, but the village can't take them. */
export function campsFor(limit: GrowthLimit | undefined, reputation: number, arriveAbove: number, population = Infinity): boolean {
  // While a house goes up the next family waits for it at the edge (round 5), once the village is
  // past its first few houses (a hamlet's founders build for themselves).
  const building = limit === 'building' && population >= ECONOMY.smallVillage;
  return (limit === 'room' || limit === 'land' || building) && reputation > arriveAbove;
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

  /**
   * Agents deliver food (person-days). Excess beyond storage is lost (but a
   * delivery never shrinks the stock: the founders' provisions are more than a
   * hamlet's store holds, and the first sack of fish used to throw them away).
   */
  bookFood(amount: number): void {
    const s = this.state;
    s.food = Math.max(s.food, Math.min(this.storageCap, s.food + amount));
  }

  /** Days until the next main harvest, given the day of year. */
  daysToHarvest(dayOfYear: number): number {
    const d = this.state.harvestDay - dayOfYear;
    return d >= 0 ? d : d + DAYS_PER_YEAR;
  }

  /** Food security: stock relative to need until the next harvest (+ margin). */
  foodSecurity(dayOfYear: number, minDays = 0): number {
    const s = this.state;
    if (s.population <= 0) return 1;
    return s.food / (s.population * ECONOMY.consumption * (Math.max(minDays, this.daysToHarvest(dayOfYear)) + 6));
  }

  /**
   * Plenty now (round 6): the store plus the crops standing in the fields at
   * their current stage, against the need until the next harvest plus, for
   * the share of the growing season gone by, the year after it. 1 = just
   * enough; a stunted or drowned crop shows at once, a forecast never enters.
   */
  plenty(dayOfYear: number): number {
    const s = this.state;
    if (s.population <= 0) return ECONOMY.plentyHi;
    // The share of next year's food the fields hold: as far as the crops have grown, but by summer
    // at least as far as the calendar says (so a stunted crop shows as the shortfall it is).
    const summer = Math.max(0, Math.min(1, (dayOfYear - DAYS_PER_SEASON) / (ECONOMY.growDays - DAYS_PER_SEASON)));
    const g = dayOfYear <= s.harvestDay ? Math.max(s.ripe ?? 0, summer) : 0;
    const days = Math.max(DAYS_PER_SEASON, this.daysToHarvest(dayOfYear) + g * DAYS_PER_YEAR);
    // The store spoils as it waits (about half of it waits half the time).
    const spoil = 1 + (ECONOMY.spoilage * days) / 2;
    return (s.food + (s.crops ?? 0)) / (s.population * ECONOMY.consumption * days * spoil);
  }

  /** Reputation (absent in old saves: the wellbeing). */
  get reputation(): number {
    return this.state.reputation ?? this.state.wellbeing;
  }

  /** Reputation above which families come. */
  get arriveAbove(): number {
    return this.state.population < ECONOMY.smallVillage ? ECONOMY.arriveSmall : ECONOMY.arriveAbove;
  }

  /** A family is ready to come and waits for a house (it camps at the edge meanwhile). */
  get ready(): boolean {
    const s = this.state;
    return s.pullNeed !== undefined && (s.pull ?? 0) >= s.pullNeed;
  }

  /** A waiting family moved in (village.ts tendCamp): its pull is used up. */
  movedIn(): void {
    const s = this.state;
    if (s.pullNeed !== undefined) s.pull = Math.max(0, (s.pull ?? 0) - s.pullNeed);
    delete s.pullNeed;
  }

  /** Advance one game day. */
  day(dayOfYear: number, rng: Rng): DayEvents {
    const s = this.state;
    const E = ECONOMY;
    const ev: DayEvents = { arrived: 0, left: 0, born: 0, died: 0 };

    // Eat and spoil.
    const need = s.population * E.consumption;
    const starving = s.food < need;
    s.food = Math.max(0, s.food - need);
    s.food *= 1 - E.spoilage;
    s.hungryDays = starving && s.population > 0 ? s.hungryDays + 1 : 0;

    // Prosperity (never feeds back into production; see PEOPLE.md §4): plenty now, a little comfort.
    const plenty = this.plenty(dayOfYear);
    s.plenty = plenty;
    const housing = s.population === 0 ? 1 : Math.min(1, (s.houses * E.houseCapacity) / s.population);
    // Firewood: burnt over the year, most in winter, when a warm hearth cheers people up a little.
    const winter = Math.floor(dayOfYear / DAYS_PER_SEASON) === 3;
    const warm = winter && (s.wood ?? 0) >= 1 ? E.warmWinter : 0;
    if (s.wood !== undefined) s.wood = Math.max(0, s.wood - (winter ? E.woodBurnWinter : E.woodBurn));
    const comfort = E.comfort[0]! * housing + E.comfort[1]! * s.waterAccess + E.comfort[2]! * s.safety;
    const food = starving && s.population > E.stayers ? 0 : foodPart(plenty);
    const target = Math.min(1, food * (E.comfortBase + (1 - E.comfortBase) * comfort) + warm + (s.milling ? MILL.wellbeing : 0) + POWER.wellbeing * (s.light ?? 0));
    s.wellbeing += (target - s.wellbeing) / E.wellbeingTau;
    s.mood = nextMood(s.mood ?? 0, s.wellbeing);
    // Reputation: how good the village has looked lately, less its ruins.
    const ruins = Math.min(E.ruinMax, (s.ruins ?? 0) * E.ruinPenalty);
    const rep = s.reputation ?? s.wellbeing;
    s.reputation = rep + (Math.max(0, s.wellbeing - ruins) - rep) / E.reputationTau;

    // Natural change: more children in good times.
    const perDay = 1 / DAYS_PER_YEAR;
    const floor = s.population <= E.stayers;
    const short = Math.max(0, 1 - plenty / E.enough);
    const births = short === 0 || floor ? s.population * (E.birthRate + E.birthBoost * Math.max(0, (s.wellbeing - 0.5) / 0.5)) * perDay : 0;
    const deaths = s.population * (E.deathRate + (starving && !floor ? E.starvationDeathRate : 0)) * perDay;
    if (rng.next() < births) {
      s.population++;
      ev.born++;
    }
    if (s.population > 0 && rng.next() < deaths) {
      s.population--;
      ev.died++;
    }

    // Arrivals: word of a good village spreads (reputation above the threshold), the more so the
    // bigger it is. Families come as the pull adds up, each when it passes a threshold drawn
    // around 1 (round 4: far less luck than a daily coin toss); with no free house the next family
    // waits (camps at the edge, village.ts) until one is built.
    const draw = Math.max(0, (this.reputation - this.arriveAbove) / (1 - this.arriveAbove));
    const pArrive = short === 0 ? E.arrivalRate * (E.arrivalBase + s.population / E.arrivalScale) * draw : 0;
    s.pullNeed ??= E.pullNeed[0]! + (E.pullNeed[1]! - E.pullNeed[0]!) * rng.next();
    s.pull = Math.min(s.pullNeed, (s.pull ?? 0) + pArrive);
    if (pArrive === 0) s.pull *= 0.9; // they hear of hard times
    if (this.ready && short === 0 && this.freeHouses > 0 && !s.camp) {
      const n = rng.int(E.familySize[0], E.familySize[1] + 1);
      s.population += n;
      ev.arrived += n;
      this.movedIn();
    }

    // Departures: families leave as the food falls short (a bad harvest, a flood), so the village
    // tracks what its land feeds; at or below the floor everybody stays.
    const households = Math.ceil(s.population / E.houseCapacity);
    const pLeave = E.leaveRate * (starving ? 1 : short) * households;
    s.push = pLeave > 0 ? (s.push ?? 0) + pLeave : 0;
    if (s.push >= 1 && s.population > E.stayers) {
      s.push -= 1;
      const n = Math.min(s.population - E.stayers, rng.int(E.familySize[0], E.familySize[1] + 1));
      s.population -= n;
      ev.left += n;
    }
    return ev;
  }

  /** Whether the settlement wants another house built. */
  wantsHouse(building = 0): boolean {
    return this.freeHouses + building < 1 + (this.ready ? 1 : 0) && (this.ready || this.reputation > this.arriveAbove);
  }
}
