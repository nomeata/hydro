/**
 * Close-ups of the Raise and Dig brushes (DESIGN.md §4): small and large,
 * held still on dry land, and a channel dug along a line, desktop and phone.
 * Drives the client's sculptor directly (the same samples a held pointer
 * sends), waits for the sim's terrain, and screenshots each with the
 * brush's ring over it.
 *
 *   npx vite preview --port 4517 &
 *   npx tsx tools/brush-shots.ts [outDir] [baseUrl]
 */
import { chromium, devices } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';

const out = process.argv[2] ?? 'out/brush';
const base = process.argv[3] ?? 'http://localhost:4517/';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

interface Shot {
  name: string;
  tool: 'dig' | 'raise';
  size: number;
  seconds: number;
  /** A line to drag along (cells, relative to the spot), at `speed` cells/s. */
  line?: [number, number];
  speed?: number;
}
const shots: Shot[] = [
  { name: 'dig-small', tool: 'dig', size: 0, seconds: 2 },
  { name: 'dig-large', tool: 'dig', size: 2, seconds: 3 },
  { name: 'raise-small', tool: 'raise', size: 0, seconds: 2 },
  { name: 'raise-large', tool: 'raise', size: 2, seconds: 3 },
  { name: 'channel', tool: 'dig', size: 1, seconds: 0, line: [16, 0], speed: 2 },
];

for (const [device, opts] of [
  ['desktop', { viewport: { width: 1280, height: 800 } }],
  ['phone', { ...devices['Pixel 7'] }],
] as const) {
  for (const shot of shots) {
    const page = await browser.newPage(opts);
    page.on('pageerror', (e) => console.log('pageerror', String(e)));
    await page.goto(`${base}?test=1&seed=1&cheat=1`);
    await page.waitForFunction(() => (window as any).__hydro !== undefined, null, { timeout: 120_000 });
    await page.waitForTimeout(1500);
    // A dry, free spot near the start.
    const spot = await page.evaluate(() => {
      const h = (window as any).__hydro;
      const m = h.mirror;
      const depth: Float32Array = h.renderer.heights.depth;
      const W = m.width;
      const { startX, startY } = h.data.info;
      // Up the map first (open meadow on the default seed, no trees in the way).
      for (let r = 10; r < 60; r++)
        for (let k = 18; k < 42; k++) {
          const x = Math.round(startX + Math.cos((k / 24) * Math.PI * 2) * r);
          const y = Math.round(startY + Math.sin((k / 24) * Math.PI * 2) * r);
          let ok = true;
          for (let dy = -9; dy <= 9 && ok; dy++)
            for (let dx = -9; dx <= 25 && ok; dx++) {
              const i = (y + dy) * W + x + dx;
              if (m.isFixed(i) || depth[i]! > 0.01) ok = false;
            }
          if (ok) return { x, y };
        }
      return { x: startX, y: startY };
    });
    const cx = spot.x + (shot.line ? shot.line[0] / 2 : 0);
    await page.evaluate(
      ({ x, y }) => {
        const h = (window as any).__hydro;
        h.renderer.camera.focus(x, y);
        h.renderer.camera.setState({ viewHeight: 13 }, true);
      },
      { x: cx, y: spot.y },
    );
    await page.keyboard.press(shot.tool === 'dig' ? '3' : '2');
    await page.waitForTimeout(600);
    await page.evaluate(
      ({ s, x, y }) => {
        const h = (window as any).__hydro;
        h.tools.setBrushSize(s.size);
        const r = h.tools.brushRadius;
        h.sculptor.begin(s.tool, r);
        if (s.line) {
          const len = Math.hypot(s.line[0], s.line[1]);
          const n = Math.round((len / s.speed!) * 60);
          for (let k = 0; k <= n; k++) h.sculptor.sample(x + (s.line[0] * k) / n, y + (s.line[1] * k) / n, 1 / 60);
        } else for (let t = 0; t < s.seconds; t += 1 / 60) h.sculptor.sample(x, y, 1 / 60);
        h.sculptor.flush();
      },
      { s: shot, x: spot.x, y: spot.y },
    );
    await page.waitForFunction(() => ((window as any).__hydro.sculptor.pending as unknown[]).length === 0, null, { timeout: 60_000 });
    await page.waitForTimeout(800);
    // The ring over the result (mouse; on the phone the ring shows only while held).
    if (device === 'desktop') {
      const p = await page.evaluate(({ x, y }) => (window as any).__hydro.project(x, y), { x: spot.x + (shot.line ? shot.line[0] : 0), y: spot.y });
      await page.mouse.move(p[0], p[1]);
      await page.mouse.move(p[0] + 1, p[1]);
      await page.waitForTimeout(400);
    }
    await page.screenshot({ path: `${out}/${device}-${shot.name}.png`, timeout: 180_000 });
    const prof = await page.evaluate(
      ({ x, y }) => {
        const h = (window as any).__hydro;
        const W = h.mirror.width;
        const z0 = h.mirror.terrainH[y * W + x - 12];
        const row: string[] = [];
        for (let dx = -8; dx <= 8; dx++) row.push((h.mirror.terrainH[y * W + x + dx] - z0).toFixed(2));
        return row.join(' ');
      },
      { x: spot.x, y: spot.y },
    );
    console.log(device, shot.name, prof);
    await page.close();
  }
}
await browser.close();
