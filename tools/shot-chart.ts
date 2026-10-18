/**
 * Screenshot the history chart (src/ui/historyChart.ts) on synthetic data,
 * without the game: desktop (732 px) and phone (360 px) widths.
 *
 *   npx tsx tools/shot-chart.ts [outPrefix]
 */
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { buildChart } from '../src/ui/historyChart';
import type { HistoryData, HistorySample } from '../src/shared/protocol';

const prefix = process.argv[2] ?? 'out/chart';
mkdirSync(prefix.replace(/\/[^/]*$/, ''), { recursive: true });

function data(days: number, peak: number): HistoryData {
  const samples: HistorySample[] = [];
  const milestones: HistoryData['milestones'] = [];
  const hit = new Set<number>();
  for (let d = 0; d < days; d++) {
    const p = Math.round(4 * Math.exp((Math.log(peak / 4) * d) / (days - 1)) * (1 + 0.05 * Math.sin(d / 3)));
    for (const m of [15, 30, 50, 100, 150, 250]) if (p >= m && !hit.has(m)) (hit.add(m), milestones.push({ population: m, day: d }));
    const r = Math.max(0, 3 + 4 * Math.sin(d * 1.7) * Math.sin(d / 9));
    samples.push({ d, n: 1, p, w: 50 + 20 * Math.sin(d / 7), r, t: 12 + 10 * Math.sin((d / 48) * 2 * Math.PI), f: d % 37 === 5 ? 30 : 0, h: d === 42 ? 2 : 0, v: 1 });
  }
  return { samples, milestones, achievements: [{ id: 'first-weir', day: 10 }] };
}

const cases = [
  ['early', data(30, 22)],
  ['mid', data(120, 120)],
];
const localChromium = '/opt/pw-browsers/chromium';
const browser = await chromium.launch(existsSync(localChromium) ? { executablePath: localChromium } : {});
for (const [w, tag] of [
  [732, 'desktop'],
  [340, 'phone'],
] as const) {
  const page = await browser.newPage({ viewport: { width: w + 20, height: 600 }, deviceScaleFactor: 2 });
  const html = cases.map(([n, d]) => `<p>${n}</p>${buildChart(d as HistoryData, w).svg}`).join('');
  await page.setContent(`<body style="margin:10px;font-family:sans-serif;background:#fffaf0">${html}</body>`);
  await page.screenshot({ path: `${prefix}-${tag}.png`, fullPage: true });
}
await browser.close();
