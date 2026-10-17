/**
 * One playtest job: a new game for a seed, run for a number of game days,
 * hands-off ("baseline") or with a player bot. With a bot, the game is
 * forked (save → load) the day the bot first acts, and the untouched copy
 * runs alongside for `window` days, so the response of the targeted cells
 * can be compared day by day with what would have happened anyway.
 */
import { CELL_AREA, DAYS_PER_YEAR, STEPS_PER_DAY } from '../../src/sim/constants';
import { START_REVEAL } from '../../src/sim/fog';
import { newGame } from '../../src/sim/newgame';
import { loadGame, saveGame } from '../../src/sim/persist';
import type { Simulation } from '../../src/sim/sim';
import { forestCover, saturation } from '../../src/sim/vegetation';
import { makeBot, type BotAction } from './bots';
import { cellsAround, dist, isRiver, isWater, villages } from './geo';
import { Observer, RESPONSE_THRESHOLDS, probe, realMinutes, type DailySeries, type EventKind, type GameEvent, type Probe, type SeasonSample, type Totals } from './observe';

export interface JobSpec {
  seed: number;
  size: number;
  days: number;
  /** 'baseline' or a bot name (bots.ts). */
  bot: string;
  /** First day the bot looks at the world, and how often it looks again (days). */
  actDay: number;
  checkEvery: number;
  /** Days the untouched control copy runs alongside after the first action. */
  window: number;
  /** Let bots use tools before they unlock (experiments). */
  ignoreUnlocks?: boolean;
}

export interface Descriptors {
  startX: number;
  startY: number;
  /** Terrain range (m) and mean slope (rise/run) of the map. */
  relief: number;
  meanSlope: number;
  /** River sources at the map edge (clusters of inflow cells) and their total discharge (m³/s). */
  inflowSources: number;
  inflow: number;
  /** Map fractions of open water and of flowing river. */
  water: number;
  river: number;
  /** Distance (cells) from the start point to the nearest river and to any open water. */
  startRiverDist: number;
  startWaterDist: number;
  /** Mean soil saturation and fertility of the land around the start. */
  startSaturation: number;
  startFertility: number;
  /** Distance (cells) from the first village to the nearest river (set once founded). */
  villageRiverDist?: number;
  /** Precipitation and evaporation over the run (mm per year, map mean). */
  precipMm?: number;
  evapMm?: number;
  /** Flood episodes per year (from the run). */
  floodsPerYear?: number;
  /** Mean new channel cells per year (river activity). */
  riverChangePerYear?: number;
}

export interface ActionRecord extends BotAction {
  /** Plan cells the commands placed, and the day the earthworks were finished. */
  planCells: number;
  doneDay: number | null;
}

export interface ResponseRecord {
  /** Day of the first action and the window length. */
  day: number;
  window: number;
  targets: number;
  /** Whether the fork's state hash matched the original's (determinism check). */
  forkMatches: boolean;
  /** Days after the action until the targets differ from the control by each threshold (null: never in the window). */
  firstDay: Partial<Record<keyof Probe, number | null>>;
  /** The quickest of them. */
  first: { metric: keyof Probe; days: number } | null;
  /** Probes of the targets at the end of the window, bot and control. */
  atEnd: { bot: Probe; control: Probe };
  /** Daily probe differences (bot − control) of the targets. */
  series: { moisture: number[]; depth: number[]; saturation: number[]; stress: number[] };
  /** Village outcome at the end of the window, bot − control. */
  outcome: { population: number; prosperity: number; foodSecurity: number };
}

export interface Pacing {
  /** Count per event kind. */
  counts: Partial<Record<EventKind, number>>;
  /** All events, and the less routine ones (no house/field/arrival/mood), per real hour at 1×. */
  perHour: number;
  majorPerHour: number;
  /** Per game year: events per real hour. */
  perHourByYear: number[];
  /** Longest stretch without any event (real minutes at 1×), and stretches ≥ 15 min. */
  longestGap: number;
  longestMajorGap: number;
  boring: { from: number; to: number; minutes: number }[];
}

export interface Outcome {
  population: number;
  peak: number;
  /** Mean prosperity and food security over the last game year. */
  prosperity: number;
  foodSecurity: number;
  villages: number;
  maxVillages: number;
  houses: number;
  fields: number;
  revealed: number;
  /** Mean dry-stressed share of fields over the growing days (whole run / last year). */
  dryStress: number;
  dryStressLastYear: number;
  forestStart: number;
  forestEnd: number;
  /** Day the peak population first reached each milestone (absent: never). */
  milestones: Record<number, number>;
  /** Days of each founding (first village first). */
  foundings: number[];
  totals: Totals;
}

export interface JobResult {
  spec: JobSpec;
  descriptors: Descriptors;
  outcome: Outcome;
  pacing: Pacing;
  actions: ActionRecord[];
  response: ResponseRecord | null;
  seasons: SeasonSample[];
  daily: DailySeries;
  events: GameEvent[];
  riverChange: number[];
  runtimeSec: number;
}

function describe(sim: Simulation, startX: number, startY: number): Descriptors {
  const w = sim.world;
  const W = w.width;
  let zmin = Infinity;
  let zmax = -Infinity;
  let slope = 0;
  let land = 0;
  let water = 0;
  let river = 0;
  let rd = Infinity;
  let wd = Infinity;
  for (let i = 0; i < w.size; i++) {
    const z = w.terrain(i);
    zmin = Math.min(zmin, z);
    zmax = Math.max(zmax, z);
    const x = i % W;
    const y = (i / W) | 0;
    if (isWater(w, i)) {
      water++;
      wd = Math.min(wd, dist(w, i, startX, startY));
      if (isRiver(w, i)) {
        river++;
        rd = Math.min(rd, dist(w, i, startX, startY));
      }
    } else if (x > 0 && y > 0 && x < W - 1 && y < w.height - 1) {
      land++;
      slope += Math.hypot(w.terrain(i + 1) - w.terrain(i - 1), w.terrain(i + W) - w.terrain(i - W)) / (2 * 5);
    }
  }
  // River sources: runs of inflow cells along the edge.
  let sources = 0;
  let inflow = 0;
  const seen = new Set<number>();
  for (let i = 0; i < w.size; i++) {
    if (w.inflow[i]! <= 0) continue;
    inflow += w.inflow[i]!;
    if (seen.has(i)) continue;
    sources++;
    const stack = [i];
    seen.add(i);
    while (stack.length) {
      const c = stack.pop()!;
      const cx = c % W;
      const cy = (c / W) | 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          if (!w.inBounds(cx + dx, cy + dy)) continue;
          const j = w.idx(cx + dx, cy + dy);
          if (w.inflow[j]! > 0 && !seen.has(j)) {
            seen.add(j);
            stack.push(j);
          }
        }
    }
  }
  const around = cellsAround(sim, startX, startY, START_REVEAL / 2, false).filter((i) => !isWater(w, i));
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    startX,
    startY,
    relief: Math.round((zmax - zmin) * 10) / 10,
    meanSlope: r3(slope / Math.max(1, land)),
    inflowSources: sources,
    inflow: Math.round(inflow * 10) / 10,
    water: r3(water / w.size),
    river: r3(river / w.size),
    startRiverDist: Number.isFinite(rd) ? Math.round(rd) : -1,
    startWaterDist: Number.isFinite(wd) ? Math.round(wd) : -1,
    startSaturation: r3(around.reduce((n, i) => n + saturation(w, i), 0) / Math.max(1, around.length)),
    startFertility: r3(around.reduce((n, i) => n + w.fertility[i]!, 0) / Math.max(1, around.length)),
  };
}

function planSnapshot(sim: Simulation): Float32Array {
  return Float32Array.from(sim.world.plan);
}

export function pacing(events: GameEvent[], days: number): Pacing {
  const counts: Partial<Record<EventKind, number>> = {};
  for (const e of events) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  const hours = realMinutes(days) / 60;
  const routine = new Set<EventKind>(['house', 'field', 'arrival', 'mood']);
  const major = events.filter((e) => !routine.has(e.kind));
  const gaps = (es: GameEvent[]) => {
    const ds = [0, ...es.map((e) => e.day).sort((a, b) => a - b), days];
    const out: { from: number; to: number; minutes: number }[] = [];
    for (let k = 1; k < ds.length; k++) out.push({ from: ds[k - 1]!, to: ds[k]!, minutes: Math.round(realMinutes(ds[k]! - ds[k - 1]!) * 10) / 10 });
    return out;
  };
  const all = gaps(events);
  const years = Math.ceil(days / DAYS_PER_YEAR);
  const perHourByYear: number[] = [];
  for (let y = 0; y < years; y++) {
    const d0 = y * DAYS_PER_YEAR;
    const d1 = Math.min(days, d0 + DAYS_PER_YEAR);
    const n = events.filter((e) => e.day >= d0 && e.day < d1).length;
    perHourByYear.push(Math.round((n / (realMinutes(d1 - d0) / 60)) * 10) / 10);
  }
  return {
    counts,
    perHour: Math.round((events.length / hours) * 10) / 10,
    majorPerHour: Math.round((major.length / hours) * 10) / 10,
    perHourByYear,
    longestGap: Math.max(0, ...all.map((g) => g.minutes)),
    longestMajorGap: Math.max(0, ...gaps(major).map((g) => g.minutes)),
    boring: all.filter((g) => g.minutes >= 15).sort((a, b) => b.minutes - a.minutes).slice(0, 8),
  };
}

const meanOf = (xs: readonly (number | null)[]): number => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 1000) / 1000 : 0;
};

export async function runJob(spec: JobSpec, log: (msg: string) => void = () => {}): Promise<JobResult> {
  const t0 = performance.now();
  const { sim, gen } = newGame(spec.seed, spec.size);
  const descriptors = describe(sim, gen.startX, gen.startY);
  const forestStart = forestCover(sim.world);
  const obs = new Observer(sim);
  const bot = spec.bot === 'baseline' ? null : makeBot(spec.bot, { ignoreUnlocks: spec.ignoreUnlocks });
  const actions: ActionRecord[] = [];
  const pending: { rec: ActionRecord; cells: number[] }[] = [];
  let control: Simulation | null = null;
  let response: ResponseRecord | null = null;
  let targets: number[] = [];
  const ledger0 = { rain: sim.ledger.rain + sim.ledger.snowfall, evap: sim.ledger.evaporation };

  for (let d = 0; d < spec.days; d++) {
    if (bot && d >= spec.actDay && (d - spec.actDay) % spec.checkEvery === 0) {
      const acts = bot.check(sim, d);
      if (acts.length && !response) {
        // Fork an untouched copy to compare with.
        control = (await loadGame(await saveGame(sim))).sim;
        targets = [...new Set(acts.flatMap((a) => a.targets))];
        const a = probe(sim, targets);
        const b = probe(control, targets);
        response = {
          day: d,
          window: spec.window,
          targets: targets.length,
          forkMatches: sim.stateHash() === control.stateHash(),
          firstDay: {},
          first: null,
          atEnd: { bot: a, control: b },
          series: { moisture: [], depth: [], saturation: [], stress: [] },
          outcome: { population: 0, prosperity: 0, foodSecurity: 0 },
        };
      }
      for (const act of acts) {
        const before = planSnapshot(sim);
        for (const c of act.commands) sim.command(c);
        const cells: number[] = [];
        const plan = sim.world.plan;
        for (let i = 0; i < plan.length; i++) if (!Number.isNaN(plan[i]!) && !Object.is(plan[i], before[i])) cells.push(i);
        const rec: ActionRecord = { ...act, planCells: cells.length, doneDay: cells.length ? null : d };
        actions.push(rec);
        if (cells.length) pending.push({ rec, cells });
        log(`seed ${spec.seed} ${spec.bot} day ${d}: ${act.note} (${cells.length} plan cells)`);
      }
    }
    obs.run(STEPS_PER_DAY);
    obs.endOfDay(d);
    for (let k = pending.length - 1; k >= 0; k--) {
      const { rec, cells } = pending[k]!;
      if (cells.every((i) => Number.isNaN(sim.world.plan[i]!))) {
        rec.doneDay = d;
        pending.splice(k, 1);
      }
    }
    if (control && response) {
      control.run(STEPS_PER_DAY);
      const a = probe(sim, targets);
      const b = probe(control, targets);
      const after = d - response.day;
      for (const key of Object.keys(RESPONSE_THRESHOLDS) as (keyof Probe)[]) {
        if (response.firstDay[key] == null && Math.abs(a[key] - b[key]) >= RESPONSE_THRESHOLDS[key]) response.firstDay[key] = after;
      }
      const r3 = (x: number) => Math.round(x * 1000) / 1000;
      response.series.moisture.push(r3(a.moisture - b.moisture));
      response.series.depth.push(r3(a.depth - b.depth));
      response.series.saturation.push(r3(a.saturation - b.saturation));
      response.series.stress.push(Math.round(a.stress - b.stress));
      if (after + 1 >= spec.window || d === spec.days - 1) {
        for (const key of Object.keys(RESPONSE_THRESHOLDS) as (keyof Probe)[]) response.firstDay[key] ??= null;
        let first: ResponseRecord['first'] = null;
        for (const [k, v] of Object.entries(response.firstDay)) if (v != null && (!first || v < first.days)) first = { metric: k as keyof Probe, days: v };
        response.first = first;
        response.atEnd = { bot: a, control: b };
        const stat = (s: Simulation) => {
          const vs = villages(s);
          const pop = vs.reduce((n, v) => n + v.state.population, 0);
          const t = s.time;
          const doy = t.season * 12 + t.dayOfSeason;
          return {
            pop,
            w: pop ? vs.reduce((n, v) => n + v.state.population * v.state.wellbeing, 0) / pop : 0,
            fs: pop ? vs.reduce((n, v) => n + v.state.population * Math.min(2, v.foodSecurity(doy)), 0) / pop : 0,
          };
        };
        const sb = stat(sim);
        const sc = stat(control);
        response.outcome = {
          population: sb.pop - sc.pop,
          prosperity: Math.round((sb.w - sc.w) * 1000) / 10,
          foodSecurity: Math.round((sb.fs - sc.fs) * 100) / 100,
        };
        control = null;
      }
    }
    if ((d + 1) % DAYS_PER_YEAR === 0) {
      const p = sim.people;
      log(`seed ${spec.seed} ${spec.bot}: year ${(d + 1) / DAYS_PER_YEAR}, pop ${p?.population ?? 0}, villages ${p?.settlements.length ?? 0}, ${((performance.now() - t0) / 60000).toFixed(1)} min`);
    }
  }

  const years = spec.days / DAYS_PER_YEAR;
  const area = sim.world.size * CELL_AREA;
  descriptors.precipMm = Math.round(((sim.ledger.rain + sim.ledger.snowfall - ledger0.rain) / area) * 1000 / years);
  descriptors.evapMm = Math.round(((sim.ledger.evaporation - ledger0.evap) / area) * 1000 / years);
  descriptors.floodsPerYear = Math.round((obs.events.filter((e) => e.kind === 'flood').length / years) * 100) / 100;
  descriptors.riverChangePerYear = Math.round(obs.riverChange.reduce((a, b) => a + (b ?? 0), 0) / Math.max(1, years - 1));
  const first = sim.people?.settlements[0];
  if (first) {
    let rd = Infinity;
    for (let i = 0; i < sim.world.size; i++) if (isRiver(sim.world, i)) rd = Math.min(rd, dist(sim.world, i, first.state.x, first.state.y));
    descriptors.villageRiverDist = Number.isFinite(rd) ? Math.round(rd) : -1;
  }

  const dly = obs.daily;
  const lastYear = Math.max(0, spec.days - DAYS_PER_YEAR);
  const p = sim.people;
  const vs = villages(sim);
  const last = obs.seasons[obs.seasons.length - 1];
  const outcome: Outcome = {
    population: dly.population[dly.population.length - 1] ?? 0,
    peak: p ? Math.max(p.peakPopulation, p.population) : 0,
    prosperity: meanOf(dly.prosperity.slice(lastYear)),
    foodSecurity: meanOf(dly.foodSecurity.slice(lastYear)),
    villages: vs.length,
    maxVillages: Math.max(0, ...dly.villages),
    houses: vs.reduce((n, s) => n + s.state.houses, 0),
    fields: last?.fields ?? 0,
    revealed: last?.revealed ?? 0,
    dryStress: meanOf(dly.dryStress),
    dryStressLastYear: meanOf(dly.dryStress.slice(lastYear)),
    forestStart: Math.round(forestStart * 1000) / 1000,
    forestEnd: Math.round(forestCover(sim.world) * 1000) / 1000,
    milestones: { ...obs.milestones },
    foundings: [...obs.foundings],
    totals: { ...obs.totals },
  };
  return {
    spec,
    descriptors,
    outcome,
    pacing: pacing(obs.events, spec.days),
    actions,
    response,
    seasons: obs.seasons,
    daily: dly,
    events: obs.events,
    riverChange: obs.riverChange,
    runtimeSec: Math.round((performance.now() - t0) / 1000),
  };
}
