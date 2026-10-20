/**
 * Scratch (round 6): a hands-off game (or with a bot) rendered as the
 * in-game history chart (villagers, prosperity), to judge whether
 * prosperity reads intuitively (high → growing, falling → people leaving).
 *
 *   npx tsx tools/playtest/diag-chart.ts <seed> [bot] [days] [out.png]
 */
import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';
import { STEPS_PER_DAY } from '../../src/sim/constants';
import { newGame } from '../../src/sim/newgame';
import { buildChart } from '../../src/ui/historyChart';
import { makeBot } from './bots';

const seed = Number(process.argv[2] ?? 4);
const name = process.argv[3] ?? 'baseline';
const days = Number(process.argv[4] ?? 144);
const out = process.argv[5] ?? `out/chart-s${seed}-${name}.png`;
const { sim } = newGame(seed, 128);
const bot = name === 'baseline' ? null : makeBot(name);
for (let d = 0; d < days; d++) {
  if (bot && d >= 16 && (d - 16) % 12 === 0) for (const a of bot.check(sim, d)) for (const c of a.commands) sim.command(c);
  sim.run(STEPS_PER_DAY);
}
const local = '/opt/pw-browsers/chromium';
const browser = await chromium.launch(existsSync(local) ? { executablePath: local } : {});
const page = await browser.newPage({ viewport: { width: 752, height: 400 }, deviceScaleFactor: 2 });
await page.setContent(`<body style="margin:10px;font-family:sans-serif;background:#fffaf0">${buildChart(sim.history.data(), 732).svg}</body>`);
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log(`wrote ${out}`);
