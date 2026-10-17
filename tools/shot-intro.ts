/**
 * Screenshot the welcome panels' live scenes for visual review.
 *   npx tsx tools/shot-intro.ts [--url http://localhost:4233/] [--phone] [--pages 0,1,2] [--times 3,6,9] [--full]
 *     [--cam '{"pitch":0.5}']   (override the scene camera, for trying angles)
 * Writes out/intro-<page>-<t>[-phone].png (the dialog card, or the whole page with --full).
 * Times are seconds after the panel's scene went live. Assumes a preview
 * server is running (`npx vite preview --port 4233`).
 */
import { chromium, devices } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1]! : d;
};
const url = opt('url', 'http://localhost:4233/');
const phone = args.includes('--phone');
const pages = opt('pages', '0,1,2').split(',').map(Number);
const times = opt('times', '3,7').split(',').map(Number);
const full = args.includes('--full');
/** Camera override (JSON CameraState fields), applied once the scene is live. */
const cam = opt('cam', '');

mkdirSync('out', { recursive: true });
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const ctx = await browser.newContext(phone ? devices['Pixel 7'] : { viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning' || m.text().startsWith('[sim]')) console.log(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => console.log(`[pageerror] ${e}`));
await page.goto(`${url}?test=1&seed=1&size=64`);
await page.waitForFunction(() => (window as any).__hydro, null, { timeout: 120_000 });
await page.evaluate(() => (window as any).__hydro.showIntro());
for (const p of pages) {
  await page.evaluate((k) => (document.querySelector(`.intro .dot[data-page="${k}"]`) as HTMLElement).click(), p);
  const t0 = Date.now();
  await page.waitForSelector('.intro-art.live-on', { timeout: 60_000 });
  console.log(`page ${p} live after ${Date.now() - t0} ms`);
  if (cam) await page.evaluate((c) => (window as any).__hydro.intro.scenes.renderer.camera.setState(JSON.parse(c), true), cam);
  const live = Date.now();
  for (const t of times) {
    const wait = live + t * 1000 - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
    const path = `out/intro-${p}-${t}${phone ? '-phone' : ''}.png`;
    if (full) await page.screenshot({ path });
    else await page.locator('.intro-card').screenshot({ path });
    console.log(`wrote ${path}`);
  }
}
const fps = await page.evaluate(`new Promise((resolve) => {
  let n = 0;
  const t0 = performance.now();
  const f = () => (++n >= 20 ? resolve((n * 1000) / (performance.now() - t0)) : requestAnimationFrame(f));
  requestAnimationFrame(f);
})`);
console.log(`fps ~${(fps as number).toFixed(1)}`);
await browser.close();
