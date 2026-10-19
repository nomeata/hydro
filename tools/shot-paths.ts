/**
 * Screenshots of saved games from tools/paths-run.ts (desire-path review):
 * loads each save as the autosave and shoots the start village, desktop and
 * phone, with the HUD hidden.
 *
 *   npx tsx tools/shot-paths.ts out/paths-d114 [more saves…] [--url http://localhost:4173/] [--tag after]
 *     [--view 28] [--phone-view 14] [--yaw 3.5] [--pitch 0.8]
 * writes out/<save name>-<tag>-desktop.png and -phone.png.
 */
import { chromium, devices } from '@playwright/test';
import { basename } from 'node:path';
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv.splice(i, 2)[1]! : d;
};
const url = opt('url', 'http://localhost:4173/');
const tag = opt('tag', 'shot');
const view = Number(opt('view', '28'));
const phoneView = Number(opt('phone-view', '14'));
const yaw = Number(opt('yaw', '3.5'));
const pitch = Number(opt('pitch', '0.8'));
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
for (const save of argv) {
  const meta = JSON.parse(readFileSync(`${save}.json`, 'utf8')) as { seed: number; x: number; y: number };
  const b64 = readFileSync(`${save}.bin`).toString('base64');
  for (const phone of [false, true]) {
    const ctx = await browser.newContext(phone ? devices['Pixel 7'] : { viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log(`[pageerror] ${e}`));
    page.on('console', (m) => m.type() === 'error' && console.log(`[error] ${m.text()}`));
    await page.goto(`${url}?test=1&seed=1&size=64`);
    await page.waitForFunction(() => (window as any).__hydro, null, { timeout: 120_000 });
    await page.evaluate(
      (data) =>
        new Promise<void>((resolve, reject) => {
          const bin = atob(data.b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const req = indexedDB.open('hydro', 1);
          req.onupgradeneeded = () => req.result.createObjectStore('saves');
          req.onsuccess = () => {
            const tx = req.result.transaction('saves', 'readwrite');
            tx.objectStore('saves').put({ savedAt: Date.now(), seed: data.seed, day: 0, bytes: bytes.buffer }, 'autosave');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          };
          req.onerror = () => reject(req.error);
        }),
      { b64, seed: meta.seed },
    );
    await page.goto(`${url}?test=1&persist=1`);
    await page.waitForFunction(() => (window as any).__hydro, null, { timeout: 120_000 });
    await page.waitForFunction(() => document.querySelector('#loading')?.classList.contains('done'), null, { timeout: 120_000 });
    await page.evaluate(() => (window as any).__hydro.client.pause?.());
    await page.evaluate((c) => (window as any).__hydro.renderer.camera.setState(c, true), {
      x: meta.x,
      y: meta.y,
      yaw,
      pitch,
      viewHeight: phone ? phoneView : view,
    });
    await page.addStyleTag({ content: '#ui > * { display: none !important; }' });
    await page.waitForTimeout(4000);
    const out = `out/${basename(save)}-${tag}-${phone ? 'phone' : 'desktop'}.png`;
    await page.screenshot({ path: out });
    console.log(out);
    await ctx.close();
  }
}
await browser.close();
