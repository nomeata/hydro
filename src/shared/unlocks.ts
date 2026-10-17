/**
 * Tool unlocks (DESIGN.md §4): tools become available as the people
 * prosper. The one table of population milestones, used by the tool
 * palette (locked tools are greyed out with a hint). Tools not listed are
 * available from the start.
 */

/** Total villagers needed before a tool can be used. */
export const TOOL_UNLOCKS: Readonly<Record<string, number>> = {
  line: 15,
  weir: 30,
  gate: 50,
};

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
  return population >= unlockPopulation(tool);
}
