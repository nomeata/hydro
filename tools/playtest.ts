/**
 * Playability evaluation harness (docs/PLAYTEST.md).
 *
 *   npm run playtest -- [--seeds 1..8] [--years 10 | --days N] [--bot-years Y] [--size 128]
 *                       [--bots baseline,irrigate,dike,weir,drain,vandal]
 *                       [--jobs 4] [--out out/playtest] [--act-day 16]
 *                       [--check-every 12] [--window 36] [--ignore-unlocks]
 *                       [--force] [--summary-only]
 *
 * Runs a new game per seed hands-off ("baseline") and with each scripted
 * player bot (tools/playtest/bots.ts), headless and deterministic, one child
 * process per job (`--jobs` at a time). Each job writes
 * <out>/<bot>-s<seed>-<size>-<days>d.json; existing results with the same
 * spec are reused (`--force` reruns), so an interrupted run resumes. Then a
 * markdown summary (world variety, outcomes and their spread, bot deltas
 * and response latency, pacing) is printed and written to <out>/summary.md.
 */
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAYS_PER_YEAR } from '../src/sim/constants';
import { BOT_NAMES } from './playtest/bots';
import { runJob, type JobResult, type JobSpec } from './playtest/run';
import { summarise } from './playtest/summary';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1]! : d;
};
const flag = (k: string): boolean => args.includes(`--${k}`);

function parseSeeds(s: string): number[] {
  const out: number[] = [];
  for (const part of s.split(',')) {
    const m = /^(\d+)\.\.(\d+)$/.exec(part.trim());
    if (m) for (let k = Number(m[1]); k <= Number(m[2]); k++) out.push(k);
    else if (part.trim()) out.push(Number(part));
  }
  return out;
}

const fileFor = (out: string, s: JobSpec): string => join(out, `${s.bot}-s${s.seed}-${s.size}-${s.days}d.json`);

async function child(): Promise<void> {
  const spec = JSON.parse(opt('job', '{}')) as JobSpec;
  const file = opt('file', '');
  const res = await runJob(spec, (m) => console.log(m));
  writeFileSync(file, JSON.stringify(res));
}

function spawnJob(spec: JobSpec, file: string): Promise<void> {
  const self = fileURLToPath(import.meta.url);
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [...process.execArgv, self, '--job', JSON.stringify(spec), '--file', file], { stdio: ['ignore', 'pipe', 'inherit'] });
    p.stdout.on('data', (b: Buffer) => process.stdout.write(b));
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`job ${spec.bot} seed ${spec.seed} exited with ${code}`))));
  });
}

async function main(): Promise<void> {
  if (args.includes('--job')) return child();
  const seeds = parseSeeds(opt('seeds', '1..4'));
  const size = Number(opt('size', '128'));
  const days = args.includes('--days') ? Number(opt('days', '0')) : Math.round(Number(opt('years', '5')) * DAYS_PER_YEAR);
  const bots = opt('bots', ['baseline', ...BOT_NAMES].join(',')).split(',');
  if (!bots.includes('baseline')) bots.unshift('baseline');
  const jobs = Number(opt('jobs', String(Math.max(1, availableParallelism()))));
  const out = opt('out', 'out/playtest');
  const common = {
    size,
    days,
    actDay: Number(opt('act-day', '16')),
    checkEvery: Number(opt('check-every', '12')),
    window: Number(opt('window', '36')),
    ...(flag('ignore-unlocks') ? { ignoreUnlocks: true } : {}),
  };
  mkdirSync(out, { recursive: true });
  const specs: JobSpec[] = [];
  // Bots may run shorter than the baseline (their effects show within a few years).
  const botDays = args.includes('--bot-years') ? Math.round(Number(opt('bot-years', '0')) * DAYS_PER_YEAR) : days;
  for (const bot of bots) for (const seed of seeds) specs.push({ seed, bot, ...common, days: bot === 'baseline' ? days : botDays });
  const results = new Map<JobSpec, JobResult>();
  const todo: JobSpec[] = [];
  for (const s of specs) {
    const file = fileFor(out, s);
    if (!flag('force') && existsSync(file)) {
      const r = JSON.parse(readFileSync(file, 'utf8')) as JobResult;
      if (JSON.stringify(r.spec) === JSON.stringify(s)) {
        results.set(s, r);
        continue;
      }
    }
    todo.push(s);
  }
  if (!flag('summary-only') && todo.length) {
    console.log(`${todo.length} job(s) to run (${specs.length - todo.length} cached), ${jobs} at a time`);
    const t0 = performance.now();
    if (jobs <= 1) {
      for (const s of todo) {
        const r = await runJob(s, (m) => console.log(m));
        writeFileSync(fileFor(out, s), JSON.stringify(r));
        results.set(s, r);
      }
    } else {
      const queue = [...todo];
      const failed: string[] = [];
      await Promise.all(
        Array.from({ length: Math.min(jobs, queue.length) }, async () => {
          for (let s = queue.shift(); s; s = queue.shift()) {
            try {
              await spawnJob(s, fileFor(out, s));
              results.set(s, JSON.parse(readFileSync(fileFor(out, s), 'utf8')) as JobResult);
            } catch (e) {
              failed.push(String(e));
            }
          }
        }),
      );
      if (failed.length) console.error(failed.join('\n'));
    }
    console.log(`ran in ${((performance.now() - t0) / 60000).toFixed(1)} min`);
  }
  let commit = '';
  try {
    commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    // not a git checkout
  }
  const md = summarise(
    specs.map((s) => results.get(s)).filter((r): r is JobResult => !!r),
    { commit, command: `npm run playtest -- ${args.join(' ')}` },
  );
  writeFileSync(join(out, 'summary.md'), md);
  console.log(md);
  console.log(`wrote ${join(out, 'summary.md')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
