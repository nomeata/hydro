/**
 * Survey of water-wheel sites near the start village (docs/GAMEPLAY.md §1.3):
 *
 *   npx tsx tools/wheel-sites.ts [--seeds 1..8] [--size 256] [--days 0]
 *
 * For every revealed river cell (water ≥ WHEEL_MIN_DEPTH deep), the best
 * bank along the 8 directions is checked against the wheel's site rules;
 * cells that fail are counted by the first rule they break (too slow, no
 * dry bank in reach, bank too high, bank below the river). The lift of the
 * good sites is given in m³ per game day.
 */
import { newGame } from '../src/sim/newgame';
import { isRevealed } from '../src/sim/fog';
import { DT, STEPS_PER_DAY } from '../src/sim/constants';
import { WHEEL_MAX_LIFT, WHEEL_MIN_DEPTH, WHEEL_MIN_SPEED, WHEEL_REACH, wheelLift } from '../src/sim/structures/wheel';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1]! : d;
};
const [s0, s1] = opt('seeds', '1..8').split('..').map(Number);
const size = Number(opt('size', '256'));
const days = Number(opt('days', '0'));
const rules = [
  { name: 'old', reach: 3, lift: 5, speed: 0.3 },
  { name: 'now', reach: WHEEL_REACH, lift: WHEEL_MAX_LIFT, speed: WHEEL_MIN_SPEED },
];
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

for (let seed = s0!; seed <= (s1 ?? s0!); seed++) {
  const { sim, gen } = newGame(seed, size);
  if (days) sim.run(days * STEPS_PER_DAY);
  const w = sim.world;
  const W = w.width;
  let river = 0;
  const line: string[] = [];
  for (const r of rules) {
    const c = { ok: 0, slow: 0, far: 0, high: 0, low: 0 };
    const q: number[] = [];
    const nearest: number[] = [];
    river = 0;
    for (let y = 1; y < w.height - 1; y++)
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        const h = w.water[i]!;
        if (h < WHEEL_MIN_DEPTH || !isRevealed(w, i)) continue;
        // Only the river's banks: a wet cell with a dry cell within reach.
        river++;
        const v = Math.hypot(w.velX[i]!, w.velY[i]!);
        const surf = w.terrain(i) + h;
        let best = Infinity;
        let any = false;
        for (const [dx, dy] of DIRS)
          for (let k = 1; k <= r.reach; k++) {
            const nx = x + dx * k;
            const ny = y + dy * k;
            if (nx < 0 || ny < 0 || nx >= W || ny >= w.height) break;
            const j = ny * W + nx;
            if (w.water[j]! >= 0.1) continue;
            any = true;
            const lift = w.terrain(j) - surf;
            if (lift >= 0.2 && lift < best) best = lift;
            break;
          }
        if (!any) continue; // mid-river, no bank in reach: not a candidate
        if (v < r.speed) c.slow++;
        else if (best === Infinity) c.low++;
        else if (best > r.lift) c.high++;
        else {
          c.ok++;
          q.push(wheelLift(v, h, best) * DT * STEPS_PER_DAY);
          nearest.push(Math.hypot(x - gen.startX, y - gen.startY));
        }
      }
    q.sort((a, b) => a - b);
    const med = q.length ? q[q.length >> 1]!.toFixed(0) : '-';
    const near = nearest.length ? Math.min(...nearest).toFixed(0) : '-';
    line.push(`${r.name}: ok ${c.ok} (median ${med} m³/d, nearest ${near} cells) slow ${c.slow} too-high ${c.high} below ${c.low}`);
  }
  // (Rows with "far" never happen above: a bank-side cell has a bank in reach by definition.)
  console.log(`seed ${seed} (${river} wet cells revealed)\n  ${line.join('\n  ')}`);
}
