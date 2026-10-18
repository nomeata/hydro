/**
 * The social-media link preview (og:image, 1200×630): a summer village by
 * the river with a weir and a water wheel, the HUD hidden and a small
 * "Hydro" wordmark. Deterministic (fixed seed, days, camera), so CI can
 * regenerate it with the README screenshots (e2e/screenshots.spec.ts);
 * public/og.png is the committed copy for local builds.
 *
 *   npx tsx tools/og-image.ts make                # Node: out/og.bin + out/og.json
 *   npx vite preview --port 4173 &                # after npm run build
 *   npx tsx tools/og-image.ts shoot [--url http://localhost:4173/] [--out public/og.png]
 */
import type { Page } from '@playwright/test';

export const OG = { seed: 8, size: 128, days: 21, width: 1200, height: 630 };

export interface OgScene {
  bytes: Uint8Array;
  seed: number;
  /** Camera look-at (cells) and framing. */
  cam: { x: number; y: number; yaw: number; pitch: number; viewHeight: number };
  log: string[];
}

/** Grow the scene headless: the starting village, a weir across the river nearby and a wheel at a good site. */
export async function makeOgScene(seed = OG.seed): Promise<OgScene> {
  const { newGame } = await import('../src/sim/newgame');
  const { saveGame } = await import('../src/sim/persist');
  const { STEPS_PER_DAY } = await import('../src/sim/constants');
  const { wheelSites } = await import('../src/sim/structures/wheel');
  const log: string[] = [];
  const { sim } = newGame(seed, OG.size);
  const w = sim.world;
  const st = sim.people!.settlements[0]!.state;
  const near = (x: number, y: number) => Math.hypot(x - st.x, y - st.y);
  sim.run(STEPS_PER_DAY * 4);

  // A weir across the flow, the nearest good spot 6–18 cells from the village.
  let weir: { a: [number, number]; b: [number, number]; d: number } | null = null;
  for (let y = 8; y < w.height - 8; y++)
    for (let x = 8; x < w.width - 8; x++) {
      const i = w.idx(x, y);
      const vx = w.velX[i]!;
      const vy = w.velY[i]!;
      const sp = Math.hypot(vx, vy);
      const d = near(x, y);
      if (w.water[i]! < 0.3 || sp < 0.4 || d < 6 || d > 18) continue;
      const ends: [number, number][] = [];
      for (const s of [-1, 1]) {
        for (let k = 1; k <= 7; k++) {
          const px = Math.round(x - (vy / sp) * k * s);
          const py = Math.round(y + (vx / sp) * k * s);
          if (!w.inBounds(px, py)) break;
          if (w.water[w.idx(px, py)]! < 0.05) {
            ends.push([x - (vy / sp) * (k + 1) * s, y + (vx / sp) * (k + 1) * s]);
            break;
          }
        }
      }
      if (ends.length === 2 && (!weir || d < weir.d)) weir = { a: ends[0]!, b: ends[1]!, d };
    }
  if (weir) {
    sim.command({ type: 'planWeir', points: [weir.a, weir.b], height: 1.2 });
    log.push(`weir ${weir.a.map(Math.round)}–${weir.b.map(Math.round)}`);
  }
  sim.run(STEPS_PER_DAY * 4);

  const grid = {
    width: w.width,
    height: w.height,
    terrain: (i: number) => w.terrain(i),
    depth: (i: number) => w.water[i]!,
    speed: (i: number) => Math.hypot(w.velX[i]!, w.velY[i]!),
  };
  const site = wheelSites(grid, 4, 400)
    .filter((s) => near(s.x, s.y) < 16)
    .sort((p, q) => near(p.x, p.y) - near(q.x, q.y))[0];
  if (site) {
    sim.command({ type: 'placeWheel', points: [[site.x, site.y]] });
    log.push(`wheel ${site.x},${site.y}`);
  }
  sim.run(STEPS_PER_DAY * (OG.days - 8));

  // Frame the village and the works.
  const pts: [number, number][] = [[st.x, st.y]];
  if (weir) pts.push([(weir.a[0] + weir.b[0]) / 2, (weir.a[1] + weir.b[1]) / 2]);
  if (site) pts.push([site.x, site.y]);
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const bytes = new Uint8Array(await saveGame(sim, {}));
  log.push(`village ${Math.round(st.x)},${Math.round(st.y)} pop ${st.population}, day ${sim.step / STEPS_PER_DAY}`);
  return { bytes, seed, cam: { x: cx, y: cy, yaw: 3.5, pitch: 0.7, viewHeight: 20 }, log };
}

/** Load the scene into the page (as its autosave), hide the HUD, add the wordmark. `page` has the og viewport. */
export async function showOgScene(page: Page, url: string, scene: OgScene, cam: Partial<OgScene['cam']> = {}): Promise<void> {
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
    { b64: Buffer.from(scene.bytes).toString('base64'), seed: scene.seed },
  );
  await page.goto(`${url}?test=1&persist=1`);
  await page.waitForFunction(() => (window as any).__hydro, null, { timeout: 120_000 });
  await page.waitForFunction(() => document.querySelector('#loading')?.classList.contains('done'), null, { timeout: 120_000 });
  await page.evaluate((c) => (window as any).__hydro.renderer.camera.setState(c, true), { ...scene.cam, ...cam });
  await page.addStyleTag({
    content: `#ui > * { display: none !important; }
      #ui > .og-mark { display: block !important; position: absolute; left: 28px; bottom: 26px; padding: 8px 22px 10px;
        font: bold 46px 'Trebuchet MS', 'Segoe UI', system-ui, sans-serif; letter-spacing: 1px; color: var(--ink);
        background: var(--paper); border: 3px solid var(--wood); border-radius: 18px; box-shadow: var(--shadow); }
      #ui > .og-mark span { color: var(--accent); }`,
  });
  await page.evaluate(() => {
    const m = document.createElement('div');
    m.className = 'og-mark';
    m.innerHTML = '<svg viewBox="0 0 32 32" width="40" height="40" style="vertical-align:-5px;margin-right:6px"><path d="M16 3C11 11 7 15 7 20a9 9 0 0 0 18 0c0-5-4-9-9-17z" fill="#3d9bd6"/></svg>Hydro';
    document.querySelector('#ui')!.appendChild(m);
  });
  // Let the scene settle (wheel turning, water drawn, fog faded).
  await page.waitForTimeout(5000);
}

if (process.argv[1]?.endsWith('og-image.ts')) {
  const { mkdirSync, readFileSync, writeFileSync } = await import('node:fs');
  const arg = (k: string, d: string) => {
    const i = process.argv.indexOf(`--${k}`);
    return i >= 0 ? process.argv[i + 1]! : d;
  };
  mkdirSync('out', { recursive: true });
  if (process.argv[2] === 'make') {
    const s = await makeOgScene(Number(arg('seed', String(OG.seed))));
    writeFileSync('out/og.bin', s.bytes);
    writeFileSync('out/og.json', JSON.stringify({ seed: s.seed, cam: s.cam }));
    console.log(s.log.join('\n'));
  } else {
    const { chromium } = await import('@playwright/test');
    const meta = JSON.parse(readFileSync('out/og.json', 'utf8'));
    const scene: OgScene = { bytes: readFileSync('out/og.bin'), seed: meta.seed, cam: meta.cam, log: [] };
    const browser = await chromium.launch({
      executablePath: '/opt/pw-browsers/chromium',
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    });
    const page = await browser.newPage({ viewport: { width: OG.width, height: OG.height } });
    page.on('pageerror', (e) => console.log(`[pageerror] ${e}`));
    const cam = JSON.parse(arg('cam', '{}'));
    await showOgScene(page, arg('url', 'http://localhost:4173/'), scene, cam);
    const out = arg('out', 'out/og.png');
    await page.screenshot({ path: out, timeout: 120_000 });
    console.log(`wrote ${out}`);
    await browser.close();
  }
}
