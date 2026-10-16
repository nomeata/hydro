/**
 * Screenshots of dev/objects.html for visual review.
 *
 *   npx vite --port 5174 &      (dev server)
 *   npx tsx tools/shot-objects.ts [name=query ...]
 *
 * Writes out/objects-<name>.png and prints console errors, failed requests and
 * the render stats the page exposes (draw calls, triangles).
 */
import { existsSync, mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.BASE ?? 'http://localhost:5174/dev/objects.html';
const shots: [string, string][] = process.argv.slice(2).length
  ? process.argv.slice(2).map((a) => {
      const k = a.indexOf('=');
      return [a.slice(0, k), a.slice(k + 1)] as [string, string];
    })
  : [
      ['village', 'advance=3'],
      ['wide', 'zoom=90&advance=1'],
      ['lineup', 'lineup=1&zoom=30'],
    ];

async function main(): Promise<void> {
  mkdirSync('out', { recursive: true });
  const exe = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    executablePath: existsSync(exe) ? exe : undefined,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  for (const [name, query] of shots) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') console.log(`[${name}] console.${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => console.log(`[${name}] pageerror: ${e.message}`));
    page.on('response', (r) => {
      if (r.status() >= 400) console.log(`[${name}] HTTP ${r.status()} ${r.url()}`);
    });
    page.on('requestfailed', (r) => console.log(`[${name}] request failed ${r.url()}`));
    await page.goto(`${BASE}?${query}`);
    await page.waitForFunction(() => (window as unknown as { __objects?: { ready: boolean } }).__objects?.ready === true, null, { timeout: 120_000 });
    await page.waitForTimeout(500);
    const stats = await page.evaluate(() => (window as unknown as { __objects: unknown }).__objects);
    const file = `out/objects-${name}.png`;
    await page.screenshot({ path: file });
    console.log(`${file}  ${JSON.stringify(stats)}`);
    await page.close();
  }
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
