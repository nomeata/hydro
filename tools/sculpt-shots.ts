/**
 * Visual check of the sculpting brushes: dig a canal from the river and raise
 * a bank, with the mouse, and screenshot the steps.
 *
 *   npx vite preview --port 4517 &
 *   npx tsx tools/sculpt-shots.ts [outDir] [baseUrl]
 */
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';

const out = process.argv[2] ?? 'out/sculpt';
const base = process.argv[3] ?? 'http://localhost:4517/';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => m.type() === 'error' && console.log('console.error', m.text()));
page.on('pageerror', (e) => console.log('pageerror', String(e)));
await page.goto(`${base}?test=1&seed=1&cheat=1`);
await page.waitForFunction(() => (window as any).__hydro !== undefined, null, { timeout: 120_000 });
await page.waitForTimeout(1500);
// A river cell near the start, and dry land beside it.
const site = await page.evaluate(() => {
  const h = (window as any).__hydro;
  const W = h.data.info.width;
  const d = h.renderer.heights.depth as Float32Array;
  const t = h.mirror.terrainH as Float32Array;
  const sx = h.data.info.startX;
  const sy = h.data.info.startY;
  let best = -1;
  let bd = 1e9;
  for (let y = sy - 30; y <= sy + 30; y++)
    for (let x = sx - 30; x <= sx + 30; x++) {
      const i = y * W + x;
      if (d[i]! < 0.5) continue;
      const dist = Math.hypot(x - sx, y - sy);
      if (dist < bd) {
        bd = dist;
        best = i;
      }
    }
  const rx = best % W;
  const ry = (best / W) | 0;
  // Direction away from the water: towards the start.
  const len = Math.hypot(sx - rx, sy - ry) || 1;
  return { rx, ry, ux: (sx - rx) / len, uy: (sy - ry) / len, z: t[best], W };
});
console.log('site', site);
await page.evaluate(({ rx, ry }) => {
  const h = (window as any).__hydro;
  h.renderer.camera.focus(rx, ry);
  h.renderer.camera.setState({ viewHeight: 45 }, true);
}, site);
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/0-before.png` });
/** Screen positions of ground points, all at once (one round trip: the camera stands still). */
const screens = async (pts: [number, number][]) => (await page.evaluate((ps) => ps.map(([a, b]) => (window as any).__hydro.project(a, b)), pts)) as [number, number][];
const screen = async (x: number, y: number) => (await screens([[x, y]]))[0]!;
await page.keyboard.press('3'); // Dig
const n = 24;
const a = await screen(site.rx - site.ux * 1, site.ry - site.uy * 1);
await page.mouse.move(a[0], a[1]);
await page.mouse.down();
const digLine = await screens(Array.from({ length: n + 1 }, (_, k) => [site.rx + site.ux * ((k / n) * 16 - 1), site.ry + site.uy * ((k / n) * 16 - 1)] as [number, number]));
for (let pass = 0; pass < 3; pass++) {
  for (let k = 0; k <= n; k++) {
    const p = digLine[pass % 2 ? n - k : k]!;
    await page.mouse.move(p[0], p[1]);
    await page.waitForTimeout(40);
  }
  await page.screenshot({ path: `${out}/1-dig-pass${pass + 1}.png` });
}
await page.mouse.up();
// A bank beside the canal.
await page.keyboard.press('2'); // Raise
const px = -site.uy;
const py = site.ux;
const b0 = await screen(site.rx + site.ux * 4 + px * 6, site.ry + site.uy * 4 + py * 6);
await page.mouse.move(b0[0], b0[1]);
await page.mouse.down();
const bankLine = await screens(Array.from({ length: n + 1 }, (_, k) => [site.rx + site.ux * (4 + (k / n) * 12) + px * 6, site.ry + site.uy * (4 + (k / n) * 12) + py * 6] as [number, number]));
for (let pass = 0; pass < 3; pass++)
  for (let k = 0; k <= n; k++) {
    const p = bankLine[pass % 2 ? n - k : k]!;
    await page.mouse.move(p[0], p[1]);
    await page.waitForTimeout(40);
  }
await page.mouse.up();
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/2-bank.png` });
// Let the water come.
await page.evaluate(() => (window as any).__hydro.client.setSpeed(3));
await page.waitForTimeout(8000);
await page.screenshot({ path: `${out}/3-water.png` });
const info = await page.evaluate(({ rx, ry, ux, uy, W }) => {
  const h = (window as any).__hydro;
  const d = h.renderer.heights.depth as Float32Array;
  const out: string[] = [];
  for (let k = 0; k <= 16; k += 2) {
    const i = Math.round(ry + uy * k) * W + Math.round(rx + ux * k);
    out.push(`${k}: z=${h.mirror.terrainH[i].toFixed(2)} d=${d[i].toFixed(2)}`);
  }
  return { out, undo: h.sculptor.undoable };
}, site);
console.log(info);
await browser.close();
