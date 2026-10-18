/**
 * Tool unlocks (docs/GAMEPLAY.md §4.5): tools become available as the
 * people prosper. The one table of population milestones, used by the tool
 * palette (locked tools are greyed out with a hint), the stats bar and the
 * history chart. Tools not listed are available from the start (the brushes
 * raise, dig, even, and remove).
 */

/**
 * The progression, ascending. Each step names the tool it unlocks, or none
 * for a milestone whose tool is not built yet: the bar and the chart show
 * those milestones already, and a new tool slots in by adding its id.
 * The power modes (turbine, poles, pump) share the Power palette button (ui/tools.ts).
 */
export const PROGRESSION: readonly { population: number; tool?: string }[] = [
  { population: 15, tool: 'weir' },
  { population: 30, tool: 'gate' },
  { population: 50, tool: 'wheel' },
  { population: 100, tool: 'turbine' },
  { population: 150, tool: 'poles' },
  { population: 250, tool: 'pump' },
];

/** Total villagers needed before a tool can be used. */
export const TOOL_UNLOCKS: Readonly<Record<string, number>> = Object.fromEntries(
  PROGRESSION.filter((m) => m.tool).map((m) => [m.tool!, m.population]),
);

/** Cheat for testing (`?cheat=1`): every tool is available from the start. */
let unlockAll = false;
export function setUnlockAll(on: boolean): void {
  unlockAll = on;
}

/** Villagers needed for `tool` (0 = from the start). */
export function unlockPopulation(tool: string): number {
  return TOOL_UNLOCKS[tool] ?? 0;
}

/**
 * Whether `tool` is usable with `population` villagers. Unlocks are kept
 * once reached (pass the highest population seen), so a bad winter never
 * takes a tool away again.
 */
export function isUnlocked(tool: string, population: number): boolean {
  return unlockAll || population >= unlockPopulation(tool);
}
