/**
 * Screenshot a tool card's live scene for visual review.
 *   npx tsx tools/shot-card.ts [--url http://localhost:4233/] [--tool wheel] [--times 3,8] [--phone]
 *     [--cam '{"pitch":0.5}']   (override the scene camera)
 * Writes out/card-<tool>-<t>[-phone].png. Assumes a preview server is running.
 */
import { chromium, devices } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1]! : d;
};
const url = opt('url', 'http://localhost:4233/');
const tool = opt('tool', 'wheel');
const phone = args.includes('--phone');
const times = opt('times', '3,8').split(',').map(Number);
const cam = opt('cam', '');

mkdirSync('out', { recursive: true });
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const ctx = await browser.newContext(phone ? devices['Pixel 7'] : { viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
page.on('console', (m) => {
  console.log(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => console.log(`[pageerror] ${e}`));
await page.goto(`${url}?test=1&seed=1&size=64&cards=1`);
await page.waitForFunction(() => (window as any).__hydro, null, { timeout: 120_000 });
if (args.includes('--big')) await page.addStyleTag({ content: '.tool-card .intro-card{width:1150px !important;max-width:none}' });
await page.evaluate((t) => (window as any).__hydro.showCard(t), tool);
await page.waitForSelector('.tool-card .intro-art.live-on', { timeout: 90_000 }).catch(async (e) => { await page.screenshot({ path: 'out/card-fail.png' }); throw e; });
if (cam) await page.evaluate((c) => (window as any).__hydro.cards.scenes.renderer.camera.setState(JSON.parse(c), true), cam);
const t0 = Date.now();
for (const t of times) {
  while (Date.now() - t0 < t * 1000) await page.waitForTimeout(100);
  const path = `out/card-${tool}-${t}${phone ? '-phone' : ''}.png`;
  await page.locator('.tool-card .intro-card').screenshot({ path });
  console.log(`wrote ${path}`);
}
await browser.close();
