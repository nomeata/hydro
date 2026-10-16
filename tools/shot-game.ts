/**
 * Screenshot the real game for visual review.
 *   npx tsx tools/shot-game.ts [name] [--query "seed=3"] [--days 1] [--cam '{"viewHeight":20}'] [--phone]
 *     [--eval "js run in the page after setup (window.__hydro is `h`)"] [--speed 1]
 *     [--shots 2 --interval 1000]   (several shots: out/<name>-0.png, …)
 *     [--eval-file script.js]   (like --eval, read from a file)
 *     [--focus-village]   (centre the camera on the buildings, after --cam)
 * Assumes `npx vite preview --port 4173` (or dev server via --url) is running.
 */
import { chromium, devices } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';

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
const evalFile = opt('eval-file', '');
const evalJs = evalFile ? readFileSync(evalFile, 'utf8') : opt('eval', '');
const speed = Number(opt('speed', '0'));
const shots = Number(opt('shots', '1'));
const interval = Number(opt('interval', '1000'));

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
if (args.includes('--focus-village')) {
  await page.waitForTimeout(800);
  const r = await page.evaluate(() => {
    const bs = (window as any).__hydro.renderer.buildings.buildings as { x: number; y: number }[];
    if (!bs.length) return null;
    const x = bs.reduce((a, b) => a + b.x, 0) / bs.length;
    const y = bs.reduce((a, b) => a + b.y, 0) / bs.length;
    (window as any).__hydro.renderer.camera.setState({ x, y }, true);
    return { buildings: bs.length, x, y };
  });
  console.log('focus village', JSON.stringify(r));
}
if (evalJs) {
  const r = await page.evaluate((js) => new Function('h', js)((window as any).__hydro), evalJs);
  if (r !== undefined) console.log('eval:', JSON.stringify(r));
}
if (speed > 0) await page.evaluate((s) => (window as any).__hydro.client.setSpeed(s), speed);
await page.waitForTimeout(1500);
const stats = await page.evaluate(() => {
  const r = (window as any).__hydro.renderer;
  const i = r.gl.info.render;
  return { calls: i.calls, triangles: i.triangles, buildingMeshes: r.buildings?.meshCount, crops: r.crops?.instanceCount, flow: r.flow.count, flowTarget: r.flow.target, cand: r.flow.candCount, box: r.flow.box, puffs: r.weather.puffCount };
});
console.log('render stats', JSON.stringify(stats));
for (let k = 0; k < shots; k++) {
  if (k > 0) await page.waitForTimeout(interval);
  const path = shots > 1 ? `out/${name}-${k}.png` : `out/${name}.png`;
  await page.screenshot({ path });
  console.log(`wrote ${path}`);
}
await browser.close();
