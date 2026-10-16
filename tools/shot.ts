/**
 * Screenshot the renderer harness (dev/render.html) with headless Chromium.
 *
 *   npx vite --port 5173 &      # dev server (assumed running)
 *   npx tsx tools/shot.ts [name:query[:WxH]] ...
 *
 * Without arguments a default set (desktop + phone) is taken. PNGs go to out/.
 * Console errors and warnings are printed; exit code 1 on page errors.
 */
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';

const BASE = process.env.HARNESS_URL ?? 'http://localhost:5173/dev/render.html';
const localChromium = '/opt/pw-browsers/chromium';

interface Shot {
  name: string;
  query: string;
  width: number;
  height: number;
}

const defaults: Shot[] = [
  { name: 'desktop', query: '', width: 1280, height: 800 },
  { name: 'desktop-close', query: 'cam=110,140,45,35,40', width: 1280, height: 800 },
  { name: 'desktop-far', query: 'cam=128,128,45,40,300', width: 1280, height: 800 },
  { name: 'phone', query: '', width: 412, height: 915 },
  { name: 'desktop-evening', query: 'sun=0.76', width: 1280, height: 800 },
  { name: 'desktop-night', query: 'sun=0.95', width: 1280, height: 800 },
];

function parse(arg: string): Shot {
  const [name, query = '', size = '1280x800'] = arg.split('|');
  const [w, h] = size.split('x').map(Number);
  return { name: name!, query, width: w!, height: h! };
}

const shots = process.argv.length > 2 ? process.argv.slice(2).map(parse) : defaults;
mkdirSync('out', { recursive: true });

const browser = await chromium.launch({
  executablePath: existsSync(localChromium) ? localChromium : undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
let failed = false;
for (const s of shots) {
  const phone = s.width < 600;
  const page = await browser.newPage({
    viewport: { width: s.width, height: s.height },
    deviceScaleFactor: phone ? 2.625 : 1,
    isMobile: phone,
    hasTouch: phone,
  });
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      console.log(`[${s.name}] console.${m.type()}: ${m.text()}`);
      if (m.type() === 'error') failed = true;
    } else if (m.type() === 'info' && m.text().includes('[render]')) console.log(`[${s.name}] ${m.text()}`);
  });
  page.on('pageerror', (e) => {
    console.log(`[${s.name}] pageerror: ${e.message}`);
    failed = true;
  });
  const url = `${BASE}?${s.query}`;
  await page.goto(url);
  await page.waitForFunction(() => ((window as unknown as { __hydro?: { frames: number } }).__hydro?.frames ?? 0) > 8, null, {
    timeout: 90_000,
  });
  const wait = Number(new URLSearchParams(s.query).get('wait') ?? 0);
  if (wait > 0) await page.waitForTimeout(wait);
  const t = Date.now();
  await page.screenshot({ path: `out/${s.name}.png` });
  const pickCheck = await page.evaluate(() => {
    const h = (window as unknown as { __hydro: { renderer: { pick(x: number, y: number): unknown; camera: { getCurrentState(): unknown } } } }).__hydro;
    return { pickAtCentre: h.renderer.pick(innerWidth / 2, innerHeight / 2), camera: h.renderer.camera.getCurrentState() };
  });
  console.log(`[${s.name}] ${JSON.stringify(pickCheck)}`);
  const hud = await page.textContent('#hud');
  console.log(`[${s.name}] saved out/${s.name}.png (${Date.now() - t} ms) — ${hud}`);
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
