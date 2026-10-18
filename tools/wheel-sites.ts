/**
 * Survey of water-wheel sites near the start village (docs/GAMEPLAY.md §1.3):
 *
 *   npx tsx tools/wheel-sites.ts [--seeds 1..8] [--size 256] [--days 0]
 *
 * Revealed river cells by the bank are checked against the old site rule
 * (first dry cell within 3, ≤ 5 m) and counted by the first rule they
 * break; then the new rule's marked sites (wheelSites) and the strokes
 * that reach ground ≥ 2 m above the river (the terrace) are counted.
 */
import { newGame } from '../src/sim/newgame';
import { isRevealed } from '../src/sim/fog';
import { STEPS_PER_DAY } from '../src/sim/constants';
import { WHEEL_GOOD_LIFT, WHEEL_MIN_SPEED, WHEEL_REACH, wheelSite, wheelSites, type WheelGrid } from '../src/sim/structures/wheel';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1]! : d;
};
const [s0, s1] = opt('seeds', '1..8').split('..').map(Number);
const size = Number(opt('size', '256'));
const days = Number(opt('days', '0'));
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

for (let seed = s0!; seed <= (s1 ?? s0!); seed++) {
  const { sim, gen } = newGame(seed, size);
  if (days) sim.run(days * STEPS_PER_DAY);
  const w = sim.world;
  const W = w.width;
  const g: WheelGrid = {
    width: W,
    height: w.height,
    terrain: (i) => w.terrain(i),
    depth: (i) => w.water[i]!,
    speed: (i) => Math.hypot(w.velX[i]!, w.velY[i]!),
    allowed: (i) => isRevealed(w, i),
  };
  // The old rule (before the noria rework): wheel ≥ 0.2 m deep, first dry cell within 3, 0.2–5 m up, ≥ 0.3 m/s.
  const old = { ok: 0, slow: 0, high: 0, low: 0 };
  // The new rule: strokes 2–6 cells long onto the terrace (≥ 2 m up).
  let terrace = 0;
  for (let y = 1; y < w.height - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const h = w.water[i]!;
      if (h < 0.2 || !isRevealed(w, i)) continue;
      const v = g.speed(i);
      const surf = w.terrain(i) + h;
      let best = Infinity;
      let any = false;
      for (const [dx, dy] of DIRS)
        for (let k = 1; k <= 3; k++) {
          const j = (y + dy * k) * W + x + dx * k;
          if (w.water[j]! >= 0.1) continue;
          any = true;
          const lift = w.terrain(j) - surf;
          if (lift >= 0.2 && lift < best) best = lift;
          break;
        }
      if (!any) continue;
      if (v < 0.3) old.slow++;
      else if (best === Infinity) old.low++;
      else if (best > 5) old.high++;
      else old.ok++;
      if (v < WHEEL_MIN_SPEED) continue;
      for (const [dx, dy] of DIRS)
        for (let k = 2; k <= WHEEL_REACH; k++) {
          const s = wheelSite(g, [[x, y], [x + dx * k, y + dy * k]]);
          if (s?.ok && s.x === x && s.y === y && s.lift >= 2 && s.perDay >= WHEEL_GOOD_LIFT) {
            terrace++;
            break;
          }
        }
    }
  const marks = wheelSites(g, 4, 1000);
  const near = marks.length ? Math.min(...marks.map((m) => Math.hypot(m.x - gen.startX, m.y - gen.startY))) : NaN;
  const best = marks.length ? Math.max(...marks.map((m) => m.perDay)) : 0;
  console.log(
    `seed ${seed}: old rule ok ${old.ok}, too slow ${old.slow}, bank below river ${old.low}, too high ${old.high}; ` +
      `new: ${marks.length} marked sites (nearest ${near.toFixed(0)} cells from the village, best ${best.toFixed(0)} m³/d), ` +
      `${terrace} river cells × directions with a stroke onto ground ≥ 2 m up`,
  );
}
