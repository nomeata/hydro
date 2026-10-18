/**
 * Achievements (DESIGN §4a): little goals per world, all positive and none
 * secret. The static table (titles, descriptions, icons) is shared by the
 * sim, which checks and records them (src/sim/achievements.ts), and the UI,
 * which shows the toasts, the Achievements card and the chart medals.
 * docs/ACHIEVEMENTS.md lists them with their exact conditions.
 */

export type AchievementCategory = 'water' | 'land' | 'people' | 'time';

export interface AchievementInfo {
  id: string;
  title: string;
  /** One cozy line: what it takes (shown for unearned ones too). */
  description: string;
  /** Icon key (src/ui/achievementIcons.ts). */
  icon: string;
  category: AchievementCategory;
}

export const CATEGORY_NAMES: Readonly<Record<AchievementCategory, string>> = {
  water: 'Waterworks',
  land: 'The land',
  people: 'The people',
  time: 'Seasons',
};

/** Thresholds, shared so that descriptions and checks agree. */
export const ACH = {
  /** Long Canal: path length of a finished trench (cells; 5 m each). */
  canalCells: 40,
  /** Lake Maker: new standing water cells (≥ lakeDepth deep). */
  lakeCells: 30,
  lakeDepth: 0.5,
  /** Waterfall: drop (m) of the water surface within two cells. */
  fallDrop: 3,
  /** Green Desert: dry cells turned moist. */
  greenCells: 150,
  /** Golden Year: field harvests in one calendar year. */
  harvests: 250,
  /** Weathered the Storm: village land cells under water on one spring day. */
  floodCells: 10,
  /** Cattle Country: cows in one village's herd. */
  herdCows: 5,
  /** Well Trodden: cells of one connected desire path. */
  pathCells: 30,
  /** Forest Keeper: new forest cells near the works. */
  forestCells: 40,
  /** Wellspring: a new well within this many cells of the player's works. */
  wellNear: 10,
  /** Miller's Head: a mill's head within this many cells of the player's works. */
  millNear: 3,
  /** Uphill: water lifted by one water wheel (m³). */
  liftedM3: 100,
  /** Village Lights: houses on the power grid. */
  gridHouses: 20,
  /** Night and Day: energy (kWh) pumped up and given back by pumped storage on one day. */
  storageKWh: 0.02,
} as const;

export const ACHIEVEMENTS: readonly AchievementInfo[] = [
  // Waterworks
  { id: 'firstSpade', title: 'First Spade', description: 'Your first earthwork is finished.', icon: 'spade', category: 'water' },
  { id: 'longCanal', title: 'Long Canal', description: `Dig a canal at least ${ACH.canalCells * 5} m long.`, icon: 'canal', category: 'water' },
  { id: 'lakeMaker', title: 'Lake Maker', description: 'Fill a new pond where the land used to be dry.', icon: 'lake', category: 'water' },
  { id: 'waterfall', title: 'Waterfall', description: `Let water tumble ${ACH.fallDrop} m down over your works.`, icon: 'waterfall', category: 'water' },
  { id: 'weirBuilder', title: 'Weir Builder', description: 'Finish a weir across the water.', icon: 'weir', category: 'water' },
  { id: 'gatekeeper', title: 'Gatekeeper', description: 'Villagers open a sluice gate to water their fields.', icon: 'gate', category: 'water' },
  { id: 'millersHead', title: 'Miller’s Head', description: 'Villagers build a mill where your works make the water fall.', icon: 'mill', category: 'water' },
  { id: 'uphill', title: 'Uphill', description: `A water wheel lifts its first ${ACH.liftedM3} m³ of river water onto the bank.`, icon: 'wheel', category: 'water' },
  { id: 'brightWindows', title: 'Bright Windows', description: 'A turbine in your weir or dam lights its first cottage.', icon: 'light', category: 'water' },
  { id: 'villageLights', title: 'Village Lights', description: `${ACH.gridHouses} houses on the power grid.`, icon: 'pole', category: 'water' },
  { id: 'nightAndDay', title: 'Night and Day', description: 'Pumped storage: a pump fills a basin with spare power, and its turbine gives it back in the evening.', icon: 'pump', category: 'water' },
  { id: 'safetyValve', title: 'Safety Valve', description: 'A sluice gate opens before the flood spills over its dike.', icon: 'valve', category: 'water' },
  // The land
  { id: 'newGround', title: 'New Ground', description: 'Villagers farm land that was too dry for fields at first.', icon: 'sprout', category: 'land' },
  { id: 'greenDesert', title: 'Green Desert', description: `Bring water to ${ACH.greenCells} cells of dry land.`, icon: 'green', category: 'land' },
  { id: 'forestKeeper', title: 'Forest Keeper', description: 'New woods grow up by your works.', icon: 'forest', category: 'land' },
  { id: 'wellTrodden', title: 'Well Trodden', description: `Villagers wear a path ${ACH.pathCells * 5} m long.`, icon: 'path', category: 'land' },
  // The people
  { id: 'founders', title: 'Founders', description: 'The first family settles in your valley.', icon: 'house', category: 'people' },
  { id: 'firstHarvest', title: 'First Harvest', description: 'A field is brought in.', icon: 'wheat', category: 'people' },
  { id: 'newHome', title: 'A New Home', description: 'A second village is founded.', icon: 'houses', category: 'people' },
  { id: 'threeVillages', title: 'Three Villages', description: 'Three villages share the valley.', icon: 'village', category: 'people' },
  { id: 'goneFishing', title: 'Gone Fishing', description: 'A fish is caught in water that you made.', icon: 'fish', category: 'people' },
  { id: 'goldenYear', title: 'Golden Year', description: `${ACH.harvests} harvests in a single year.`, icon: 'sheaf', category: 'people' },
  { id: 'stoneByStone', title: 'Stone by Stone', description: 'The villagers line a bank with stone.', icon: 'stone', category: 'people' },
  { id: 'quayside', title: 'Quayside', description: 'Villagers line a quay by their houses.', icon: 'quay', category: 'people' },
  { id: 'cattleCountry', title: 'Cattle Country', description: `A village keeps a herd of ${ACH.herdCows} cows.`, icon: 'cow', category: 'people' },
  { id: 'wellspring', title: 'Wellspring', description: 'Villagers dig a well by your works.', icon: 'well', category: 'people' },
  { id: 'jetty', title: 'Fishing Jetty', description: 'Villagers build a jetty out over the water.', icon: 'jetty', category: 'people' },
  { id: 'pop10', title: 'Hamlet', description: '10 villagers live in the valley.', icon: 'pop', category: 'people' },
  { id: 'pop50', title: 'Village Life', description: '50 villagers live in the valley.', icon: 'pop', category: 'people' },
  { id: 'pop100', title: 'Bustling Valley', description: '100 villagers live in the valley.', icon: 'pop', category: 'people' },
  { id: 'pop250', title: 'Little Town', description: '250 villagers live in the valley.', icon: 'pop', category: 'people' },
  // Seasons
  { id: 'weathered', title: 'Weathered the Storm', description: 'A spring flood comes and goes, and every house still stands.', icon: 'storm', category: 'time' },
  { id: 'rebuilt', title: 'Rebuilt', description: 'A ruined house is lived in again.', icon: 'rebuild', category: 'time' },
  { id: 'year1', title: 'Years Go By', description: 'Your valley’s first year.', icon: 'year', category: 'time' },
  { id: 'decade', title: 'A Decade', description: 'Ten years of life in the valley.', icon: 'decade', category: 'time' },
];

/** Population achievements: id → villagers needed. */
export const POPULATION_ACHIEVEMENTS: readonly [string, number][] = [
  ['pop10', 10],
  ['pop50', 50],
  ['pop100', 100],
  ['pop250', 250],
];

const BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));

export function achievementInfo(id: string): AchievementInfo | undefined {
  return BY_ID.get(id);
}
