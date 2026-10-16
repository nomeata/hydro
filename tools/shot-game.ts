/**
 * Screenshot the real game for visual review.
 *   npx tsx tools/shot-game.ts [name] [--query "seed=3"] [--days 1] [--cam '{"viewHeight":20}'] [--phone]
 * Assumes `npx vite preview --port 4173` (or dev server via --url) is running.
 */
import { chromium, devices } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1]! : d;
};
const name = args[0] && !args[0].startsWith('--') ? args[0] : 'game';
const url = opt('url', 'http://localhost:4173/');
const query = opt('query', 'seed=1');
const days = Number(opt('days', '0.5'));
const cam = opt('cam', '');
const phone = args.includes('--phone');

mkdirSync('out', { recursive: true });
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const ctx = await browser.newContext(phone ? devices['Pixel 7'] : { viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => console.log(`[pageerror] ${e}`));
const t0 = Date.now();
await page.goto(`${url}?test=1&${query}`);
await page.waitForFunction(() => (window as any).__hydro, null, { timeout: 120_000 });
console.log(`ready after ${Date.now() - t0} ms`);
if (days > 0) await page.evaluate((d) => (window as any).__hydro.client.runDays(d), days);
if (cam) await page.evaluate((c) => (window as any).__hydro.renderer.camera.setState(JSON.parse(c), true), cam);
await page.waitForTimeout(1500);
await page.screenshot({ path: `out/${name}.png` });
console.log(`wrote out/${name}.png`);
await browser.close();
