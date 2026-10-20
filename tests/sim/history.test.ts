import { describe, expect, it } from 'vitest';
import { BIN_DAYS, DAILY_DAYS, History, YEARLY_AFTER, mergeSamples, type DayReport } from '../../src/sim/history';
import { milestoneFraction, milestoneSpan, prosperity, unlockMilestones } from '../../src/shared/progress';
import { PROGRESSION, TOOL_UNLOCKS } from '../../src/shared/unlocks';
import { generateWorld } from '../../src/sim/worldgen';
import { Simulation } from '../../src/sim/sim';
import { loadGame, saveGame } from '../../src/sim/persist';
import { buildChart, drySpells } from '../../src/ui/historyChart';
import { milestonesBetween } from '../../src/ui/statsbar';

/** A synthetic day: population grows by one a day, 2 mm of rain every third day. */
function report(day: number, totals: { precip: number; cells: number; ruined: number }): DayReport {
  if (day % 3 === 0) totals.precip += 2e-3 * 1e6; // 2 mm over 1 km²
  if (day === 40) totals.ruined += 2;
  if (day % 50 === 0) totals.cells += 30;
  const pop = Math.min(day, 120);
  return {
    day,
    villages: pop > 0 ? [{ population: pop, wellbeing: 0.5 }] : [],
    peak: pop,
    precipTotal: totals.precip,
    area: 1e6,
    temperature: 10 + (day % 48) / 4,
    floodCells: totals.cells,
    ruined: totals.ruined,
  };
}

function runHistory(days: number, h = new History()): History {
  const totals = { precip: 0, cells: 0, ruined: 0 };
  h.reset(0, 0, 0);
  for (let d = 0; d < days; d++) h.record(report(d, totals));
  return h;
}

describe('prosperity and milestones', () => {
  it('prosperity is the population-weighted mean wellbeing in %', () => {
    expect(prosperity(undefined)).toBeNull();
    expect(prosperity([])).toBeNull();
    expect(prosperity([{ population: 0, wellbeing: 0.9 }])).toBeNull();
    expect(prosperity([{ population: 10, wellbeing: 0.8 }])).toBeCloseTo(80);
    expect(
      prosperity([
        { population: 30, wellbeing: 1 },
        { population: 10, wellbeing: 0.2 },
      ]),
    ).toBeCloseTo(80);
  });

  it('the population bar spans the progression milestones on a log scale, then doublings', () => {
    const ms = unlockMilestones().map((m) => m.population);
    expect(ms).toEqual(PROGRESSION.map((m) => m.population));
    // Tools unlock at 15 and 30 (GAMEPLAY.md §4.5); later steps wait for their tools.
    expect(TOOL_UNLOCKS).toEqual({ gate: 15, weir: 30, wheel: 50, turbine: 100, pump: 250 });
    expect(unlockMilestones().slice(0, 3)).toEqual([
      { population: 15, tools: ['gate'] },
      { population: 30, tools: ['weir'] },
      { population: 50, tools: ['wheel'] },
    ]);
    const first = ms[0]!;
    const lastM = ms[ms.length - 1]!;
    expect(milestoneSpan(0)).toMatchObject({ prev: 1, next: first, nextTools: ['gate'] });
    expect(milestoneFraction(0)).toBe(0);
    expect(milestoneSpan(first)).toMatchObject({ prev: first, next: ms[1]!, nextTools: ['weir'] });
    expect(milestoneSpan(30)).toMatchObject({ prev: 30, next: 50, nextTools: ['wheel'] });
    expect(milestoneFraction(first)).toBeCloseTo(first / ms[1]!);
    expect(milestoneSpan(lastM)).toMatchObject({ prev: lastM, next: lastM * 2, nextTools: [] });
    expect(milestoneSpan(lastM * 3)).toMatchObject({ prev: lastM * 2, next: lastM * 4 });
    // Linear from 0: 1.5 × the last milestone is three quarters of the way to its double.
    expect(milestoneFraction(lastM * 1.5)).toBeCloseTo(0.75);
    expect(milestonesBetween(0, lastM * 2).map((m) => m.population)).toEqual([...ms, lastM * 2]);
    expect(milestonesBetween(first, first)).toEqual([]);
  });
});

describe('history', () => {
  it('records one sample per day with rain, floods and milestones', () => {
    const h = runHistory(60);
    expect(h.samples).toHaveLength(60);
    const s3 = h.samples[3]!;
    expect(s3).toMatchObject({ d: 3, n: 1, p: 3, w: 50, r: 2, v: 1 });
    expect(h.samples[4]!.r).toBe(0);
    expect(h.samples[40]!.h).toBe(2);
    expect(h.samples[50]!.f).toBe(30);
    expect(h.samples[0]).toMatchObject({ p: 0, w: 0, v: 0 });
    const reached = unlockMilestones().filter((m) => m.population < 60);
    expect(h.milestones).toEqual(reached.map((m) => ({ population: m.population, day: m.population })));
  });

  it('thins old days into bins and keeps totals', () => {
    const days = DAILY_DAYS + 10 * BIN_DAYS + 3;
    const h = runHistory(days);
    expect(h.samples.reduce((n, s) => n + s.n, 0)).toBe(days);
    // Days stay contiguous.
    for (let k = 1; k < h.samples.length; k++) expect(h.samples[k]!.d).toBe(h.samples[k - 1]!.d + h.samples[k - 1]!.n);
    const daily = h.samples.filter((s) => s.n === 1);
    expect(daily.length).toBeGreaterThanOrEqual(DAILY_DAYS);
    expect(daily.length).toBeLessThan(DAILY_DAYS + BIN_DAYS);
    expect(h.samples.filter((s) => s.n === BIN_DAYS).length).toBe(10);
    const rain = h.samples.reduce((r, s) => r + s.r * s.n, 0);
    expect(rain).toBeCloseTo(Math.ceil(days / 3) * 2, 0);
    expect(h.samples.reduce((n, s) => n + s.h, 0)).toBe(2);
  });

  it('keeps very long games compact (yearly bins after 20 years)', () => {
    const days = YEARLY_AFTER + 5 * 48;
    const h = runHistory(days);
    expect(h.samples.reduce((n, s) => n + s.n, 0)).toBe(days);
    expect(h.samples.length).toBeLessThan(25 + 30 * 8 + DAILY_DAYS);
    expect(h.samples[0]!.n).toBe(48);
    expect(JSON.stringify(h.getState()).length).toBeLessThan(40_000);
  });

  it('merges samples by day-weighted means', () => {
    const m = mergeSamples([
      { d: 6, n: 1, p: 3, w: 40, r: 1, t: 10, f: 0, h: 1, v: 1 },
      { d: 7, n: 2, p: 5, w: 70, r: 4, t: 13, f: 3, h: 0, v: 2 },
    ]);
    expect(m).toEqual({ d: 6, n: 3, p: 5, w: 60, r: 3, t: 12, f: 3, h: 1, v: 2 });
  });

  it('round-trips through its saved state (JSON) and continues identically', () => {
    const totals = { precip: 0, cells: 0, ruined: 0 };
    const a = new History();
    a.reset(0, 0, 0);
    for (let d = 0; d < 150; d++) a.record(report(d, totals));
    const b = new History();
    b.setState(JSON.parse(JSON.stringify(a.getState())));
    expect(b.data()).toEqual(a.data());
    const t2 = { ...totals };
    for (let d = 150; d < 200; d++) {
      a.record(report(d, totals));
      b.record(report(d, t2));
    }
    expect(b.data()).toEqual(a.data());
  });

  it('is recorded by the simulation at calendar day boundaries and saved with it', async () => {
    const { world } = generateWorld({ seed: 5, size: 64 });
    const sim = new Simulation(world, 5);
    sim.run(600 * 3);
    const n = sim.history.samples.length;
    expect(n).toBe(sim.time.day);
    expect(sim.history.samples.map((s) => s.d)).toEqual([...Array(n).keys()]);
    for (const s of sim.history.samples) {
      expect(s.r).toBeGreaterThanOrEqual(0);
      expect(s.t).toBeGreaterThan(-30);
      expect(s.t).toBeLessThan(40);
    }
    const { sim: loaded } = await loadGame(await saveGame(sim));
    expect(loaded.history.data()).toEqual(sim.history.data());
    sim.run(600);
    loaded.run(600);
    expect(loaded.history.data()).toEqual(sim.history.data());
  });
});

describe('history chart', () => {
  it('finds dry warm spells', () => {
    const s = (d: number, r: number, t = 20) => ({ d, n: 1, p: 1, w: 50, r, t, f: 0, h: 0, v: 1 });
    const samples = [s(0, 3), ...Array.from({ length: 10 }, (_, k) => s(1 + k, 0)), s(11, 2), s(12, 0), s(13, 0, 0)];
    expect(drySpells(samples)).toEqual([[1, 11]]);
  });

  it('draws axis stars for reached and upcoming milestones within the log axis', () => {
    const h = runHistory(20);
    const data = h.data();
    const { svg, layout } = buildChart(data, 600);
    const ms = unlockMilestones();
    const peak = Math.max(...data.samples.map((s) => s.p));
    // The axis tops out at the power of ten above the data and the next milestone.
    const next = ms.find((m) => m.population > peak)!.population;
    const topP = 10 ** Math.ceil(Math.log10(Math.max(10, peak * 1.02, next)) - 1e-9);
    expect(svg.match(/class="star reached"/g)?.length ?? 0).toBe(ms.filter((m) => m.population <= peak).length);
    expect(svg.match(/class="star ahead"/g)?.length ?? 0).toBe(ms.filter((m) => m.population > peak && m.population <= topP).length);
    // Each star sits on the right of the plot, at its population level.
    for (const m of ms.filter((m) => m.population <= topP)) {
      const g = svg.match(new RegExp(`data-population="${m.population}"[^>]*><title>[^<]*</title><circle cx="([\\d.]+)" cy="([\\d.]+)"`));
      expect(g).not.toBeNull();
      expect(Number(g![1])).toBeGreaterThan(layout.x1);
      expect(Number(g![2])).toBeCloseTo(layout.popY(m.population), 0);
    }
    expect(layout.dayToX(0)).toBe(layout.x0);
    expect(layout.xToDay(layout.dayToX(10))).toBeCloseTo(10);
    expect(buildChart({ samples: [], milestones: [] }, 320).svg).toContain('Waiting for the first settlers');
  });
});
