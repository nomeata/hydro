/**
 * The two headline stats (stats bar, history chart): population progress
 * between tool-unlock milestones, and prosperity. Pure functions, shared by
 * the sim (history recording) and the UI.
 */
import { TOOL_UNLOCKS } from './unlocks';

/**
 * Display names of tools that unlock (fallback: the id, capitalised). The
 * tool palette labels its buttons with these too (one source of truth).
 */
const TOOL_NAMES: Readonly<Record<string, string>> = {
  weir: 'Weir',
  gate: 'Gate',
  well: 'Well',
  wheel: 'Water wheel',
};

export function toolName(id: string): string {
  return TOOL_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

export interface Milestone {
  population: number;
  /** Tools unlocked at this population (empty for the doubling milestones beyond the last unlock). */
  tools: string[];
}

/** Tool-unlock milestones, ascending; tools sharing a threshold are grouped. */
export function unlockMilestones(): Milestone[] {
  const by = new Map<number, string[]>();
  for (const [tool, pop] of Object.entries(TOOL_UNLOCKS)) {
    if (pop <= 0) continue;
    by.set(pop, [...(by.get(pop) ?? []), tool]);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([population, tools]) => ({ population, tools }));
}

/**
 * The milestone below and above `population`: the unlock thresholds, then
 * doublings of the last one (100, 200, … for a last unlock at 50).
 */
export function milestoneSpan(population: number): { prev: number; next: number; nextTools: string[] } {
  let prev = 1;
  for (const m of unlockMilestones()) {
    if (population < m.population) return { prev, next: m.population, nextTools: m.tools };
    prev = m.population;
  }
  let next = prev * 2;
  while (population >= next) {
    prev = next;
    next *= 2;
  }
  return { prev, next, nextTools: [] };
}

/** Bar fill 0..1 on a log scale from the previous milestone to the next. */
export function milestoneFraction(population: number): number {
  const { prev, next } = milestoneSpan(population);
  if (population <= prev) return 0;
  return Math.min(1, Math.log(population / prev) / Math.log(next / prev));
}

/** Prosperity in % (population-weighted mean wellbeing), or null without villagers. */
export function prosperity(villages: readonly { population: number; wellbeing: number }[] | undefined): number | null {
  if (!villages) return null;
  let pop = 0;
  let sum = 0;
  for (const v of villages) {
    pop += v.population;
    sum += v.population * v.wellbeing;
  }
  return pop > 0 ? Math.max(0, Math.min(100, (sum / pop) * 100)) : null;
}
