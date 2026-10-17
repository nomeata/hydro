/**
 * Markdown summary of a set of playtest results (tools/playtest.ts): world
 * variety, hands-off outcomes and their spread, the bots' effects against
 * the baseline (agency, response latency), and pacing.
 */
import { DAYS_PER_YEAR } from '../../src/sim/constants';
import { realMinutes } from './observe';
import type { JobResult, Outcome } from './run';

const f = (x: number | null | undefined, d = 1): string => (x === null || x === undefined || Number.isNaN(x) ? '–' : x.toFixed(d));
const sgn = (x: number | null | undefined, d = 1): string => (x === null || x === undefined || Number.isNaN(x) ? '–' : `${x > 0 ? '+' : ''}${x.toFixed(d)}`);
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs: number[]): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const sd = (xs: number[]): number => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

function table(head: string[], rows: (string | number)[][]): string {
  const out = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const r of rows) out.push(`| ${r.join(' | ')} |`);
  return out.join('\n');
}

/** Real minutes at 1× to a milestone, or '–'. */
const mins = (day: number | undefined): string => (day === undefined ? '–' : `${Math.round(realMinutes(day))}`);

const MILESTONES = [15, 30, 50, 100];

const outcomeMetrics: { key: string; label: string; get: (o: Outcome) => number; d?: number }[] = [
  { key: 'population', label: 'final pop', get: (o) => o.population, d: 0 },
  { key: 'peak', label: 'peak pop', get: (o) => o.peak, d: 0 },
  { key: 'prosperity', label: 'prosperity % (last yr)', get: (o) => o.prosperity },
  { key: 'foodSecurity', label: 'food security (last yr)', get: (o) => o.foodSecurity, d: 2 },
  { key: 'villages', label: 'villages', get: (o) => o.villages, d: 0 },
  { key: 'revealed', label: 'revealed %', get: (o) => o.revealed * 100 },
  { key: 'dryStress', label: 'dry-stressed fields %', get: (o) => o.dryStress * 100 },
  { key: 'floodCells', label: 'flooded land cells', get: (o) => o.totals.floodCells, d: 0 },
  { key: 'ruined', label: 'houses ruined', get: (o) => o.totals.housesRuined, d: 0 },
  { key: 'fled', label: 'people fled', get: (o) => o.totals.fled, d: 0 },
  { key: 'left', label: 'people left', get: (o) => o.totals.left, d: 0 },
];

export function summarise(results: JobResult[], meta: { commit?: string; command?: string } = {}): string {
  const base = results.filter((r) => r.spec.bot === 'baseline').sort((a, b) => a.spec.seed - b.spec.seed);
  const bots = [...new Set(results.map((r) => r.spec.bot).filter((b) => b !== 'baseline'))];
  const any = results[0];
  const lines: string[] = [];
  lines.push(`# Playtest summary`);
  lines.push('');
  if (any) {
    lines.push(
      `Map ${any.spec.size}², ${f(any.spec.days / DAYS_PER_YEAR, 1)} game years (${f(realMinutes(any.spec.days) / 60, 1)} real hours at 1×), seeds ${base.map((r) => r.spec.seed).join(', ') || '–'}; bots act from day ${any.spec.actDay}, look again every ${any.spec.checkEvery} days.` +
        (meta.commit ? ` Commit ${meta.commit}.` : ''),
    );
    if (meta.command) lines.push('', '`' + meta.command + '`');
  }

  // ---- Variety ----------------------------------------------------------
  if (base.length) {
    lines.push('', '## World variety (per seed)', '');
    lines.push(
      table(
        ['seed', 'precip mm/yr', 'evap mm/yr', 'relief m', 'slope', 'sources', 'inflow m³/s', 'river %', 'start→river', 'village→river', 'start sat.', 'floods/yr', 'channel change/yr'],
        base.map((r) => {
          const d = r.descriptors;
          return [r.spec.seed, d.precipMm ?? '–', d.evapMm ?? '–', f(d.relief, 0), f(d.meanSlope, 3), d.inflowSources, f(d.inflow, 1), f(d.river * 100, 1), d.startRiverDist, d.villageRiverDist ?? '–', f(d.startSaturation, 2), f(d.floodsPerYear, 1), d.riverChangePerYear ?? '–'];
        }),
      ),
    );
    lines.push('', '## Hands-off outcomes (baseline)', '');
    lines.push(
      table(
        ['seed', 'final pop', 'peak', 'prosp. %', 'food sec.', 'villages (max)', 'revealed %', 'dry fields %', 'min to 15', 'min to 30', 'min to 50', 'min to 100', 'flooded cells', 'ruined', 'fled', 'left', 'forest % start→end'],
        base.map((r) => {
          const o = r.outcome;
          return [
            r.spec.seed,
            o.population,
            o.peak,
            f(o.prosperity, 0),
            f(o.foodSecurity, 2),
            `${o.villages} (${o.maxVillages})`,
            f(o.revealed * 100, 0),
            f(o.dryStress * 100, 0),
            ...MILESTONES.map((m) => mins(o.milestones[m])),
            o.totals.floodCells,
            o.totals.housesRuined,
            o.totals.fled,
            o.totals.left,
            `${f(o.forestStart * 100, 0)}→${f(o.forestEnd * 100, 0)}`,
          ];
        }),
      ),
    );
    lines.push('', 'Spread across seeds:', '');
    lines.push(
      table(
        ['metric', 'min', 'median', 'max', 'CV'],
        outcomeMetrics.map((m) => {
          const xs = base.map((r) => m.get(r.outcome));
          const cv = mean(xs) !== 0 ? sd(xs) / Math.abs(mean(xs)) : NaN;
          return [m.label, f(Math.min(...xs), m.d ?? 1), f(median(xs), m.d ?? 1), f(Math.max(...xs), m.d ?? 1), f(cv, 2)];
        }),
      ),
    );
    const reach = MILESTONES.map((m) => {
      const ds = base.map((r) => r.outcome.milestones[m]).filter((x): x is number => x !== undefined);
      return `${m}: ${ds.length}/${base.length}${ds.length ? ` (median ${Math.round(realMinutes(median(ds)))} min, day ${Math.round(median(ds))})` : ''}`;
    });
    lines.push('', `Milestones reached hands-off: ${reach.join('; ')}.`);
    const second = base.map((r) => r.outcome.foundings[1]).filter((x): x is number => x !== undefined);
    lines.push(`Second village founded on ${second.length}/${base.length} seeds${second.length ? ` (median day ${Math.round(median(second))})` : ''}.`);
  }

  // ---- Bots -------------------------------------------------------------
  if (bots.length && base.length) {
    lines.push('', '## Player bots vs baseline (mean of per-seed differences)', '');
    const rows: (string | number)[][] = [];
    const detail: string[] = [];
    for (const b of bots) {
      const pairs = results
        .filter((r) => r.spec.bot === b)
        .map((r) => ({ r, base: base.find((x) => x.spec.seed === r.spec.seed) }))
        .filter((p): p is { r: JobResult; base: JobResult } => !!p.base)
        .sort((a, b2) => a.r.spec.seed - b2.r.spec.seed);
      const acted = pairs.filter((p) => p.r.actions.length > 0);
      const delta = (g: (o: Outcome) => number) => mean(acted.map((p) => g(p.r.outcome) - g(p.base.outcome)));
      const firstDays = acted.map((p) => p.r.actions[0]!.day);
      const build = acted.flatMap((p) => p.r.actions.filter((a) => a.doneDay !== null).map((a) => a.doneDay! - a.day + 1));
      const resp = acted.map((p) => p.r.response?.first?.days).filter((x): x is number => x !== undefined);
      const respKinds = acted.map((p) => p.r.response?.first?.metric).filter(Boolean);
      const kind = [...new Set(respKinds)].join('/');
      const d30 = acted
        .map((p) => (p.r.outcome.milestones[30] !== undefined && p.base.outcome.milestones[30] !== undefined ? p.r.outcome.milestones[30]! - p.base.outcome.milestones[30]! : null))
        .filter((x): x is number => x !== null);
      const reached30 = `${acted.filter((p) => p.r.outcome.milestones[30] !== undefined).length}/${acted.filter((p) => p.base.outcome.milestones[30] !== undefined).length}`;
      rows.push([
        b,
        `${acted.length}/${pairs.length}`,
        f(median(firstDays), 0),
        f(median(build), 0),
        `${f(median(resp), 0)} ${kind ? `(${kind})` : ''} ${resp.length}/${acted.length}`,
        sgn(mean(acted.map((p) => p.r.response?.outcome.population ?? 0)), 1),
        sgn(delta((o) => o.population), 1),
        sgn(delta((o) => o.peak), 1),
        sgn(delta((o) => o.prosperity), 1),
        sgn(delta((o) => o.foodSecurity), 2),
        sgn(delta((o) => o.dryStress * 100), 1),
        sgn(delta((o) => o.villages), 1),
        sgn(delta((o) => o.totals.floodCells), 0),
        sgn(delta((o) => o.totals.housesRuined), 1),
        sgn(delta((o) => o.totals.fled), 0),
        `${sgn(mean(d30), 0)} (${reached30})`,
      ]);
      detail.push(`### ${b}`, '');
      detail.push(
        table(
          ['seed', 'actions (day: what)', 'built in days', 'first response', 'Δ moisture / depth at window end', 'pop bot/base', 'prosp. bot/base', 'dry % bot/base', 'ruined bot/base', 'fled bot/base'],
          pairs.map(({ r, base: bs }) => {
            const rp = r.response;
            const dm = rp ? `${sgn(rp.atEnd.bot.moisture - rp.atEnd.control.moisture, 2)} / ${sgn(rp.atEnd.bot.depth - rp.atEnd.control.depth, 2)} m` : '–';
            return [
              r.spec.seed,
              r.actions.length ? r.actions.map((a) => `${a.day}: ${a.note}`).join('; ') : 'never acted',
              r.actions.map((a) => (a.doneDay === null ? 'not done' : `${a.doneDay - a.day + 1}`)).join(', ') || '–',
              rp?.first ? `${rp.first.days} d (${rp.first.metric})${rp.forkMatches ? '' : ' ⚠ fork differs'}` : rp ? 'none in window' : '–',
              dm,
              `${r.outcome.population}/${bs.outcome.population}`,
              `${f(r.outcome.prosperity, 0)}/${f(bs.outcome.prosperity, 0)}`,
              `${f(r.outcome.dryStress * 100, 0)}/${f(bs.outcome.dryStress * 100, 0)}`,
              `${r.outcome.totals.housesRuined}/${bs.outcome.totals.housesRuined}`,
              `${r.outcome.totals.fled}/${bs.outcome.totals.fled}`,
            ];
          }),
        ),
        '',
      );
    }
    lines.push(
      table(
        ['bot', 'acted', 'first act day', 'built (days)', 'first visible response (days, metric, seeds)', 'Δ pop at window end', 'Δ final pop', 'Δ peak', 'Δ prosp. pts', 'Δ food sec.', 'Δ dry fields pts', 'Δ villages', 'Δ flooded cells', 'Δ ruined', 'Δ fled', 'Δ days to 30 (reached bot/base)'],
        rows,
      ),
    );
    lines.push('', 'Per-seed detail:', '', ...detail);
  }

  // ---- Pacing -----------------------------------------------------------
  if (base.length) {
    lines.push('## Pacing (baseline, real time at 1×)', '');
    const kinds = [...new Set(base.flatMap((r) => Object.keys(r.pacing.counts)))].sort();
    const hours = realMinutes(base[0]!.spec.days) / 60;
    lines.push(
      table(
        ['seed', 'events/h', 'major/h', ...kinds.map((k) => `${k}/h`), 'events/h by year', 'longest gap (min)', 'longest major gap (min)'],
        base.map((r) => [
          r.spec.seed,
          f(r.pacing.perHour),
          f(r.pacing.majorPerHour),
          ...kinds.map((k) => f((r.pacing.counts[k as keyof typeof r.pacing.counts] ?? 0) / hours)),
          r.pacing.perHourByYear.map((x) => f(x, 0)).join(' '),
          f(r.pacing.longestGap, 0),
          f(r.pacing.longestMajorGap, 0),
        ]),
      ),
    );
    const boring = base.flatMap((r) => r.pacing.boring.map((g) => ({ seed: r.spec.seed, ...g }))).sort((a, b) => b.minutes - a.minutes);
    lines.push('', `Quiet stretches of 15+ real minutes without any event: ${boring.length} over ${base.length} runs.`);
    if (boring.length)
      lines.push(
        'Longest: ' +
          boring
            .slice(0, 8)
            .map((g) => `seed ${g.seed} days ${g.from}–${g.to} (${Math.round(g.minutes)} min)`)
            .join('; ') +
          '.',
      );
  }
  return lines.join('\n') + '\n';
}
