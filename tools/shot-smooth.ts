/**
 * Flat vs smooth terrain shading (terrain.ts, URL flag ?smooth=1): the same
 * saves and cameras rendered both ways, plus a side-by-side PNG per scene.
 *
 *   npx tsx tools/shot-smooth.ts make [--seed 3]   # Node: out/smooth-summer.bin, out/smooth-winter.bin, out/smooth.json
 *   npx vite preview --port 4173 &                 # after npm run build
 *   npx tsx tools/shot-smooth.ts shoot [--url http://localhost:4173/] [--out out/smooth] [--scenes village,landscape]
 *
 * Writes <out>/<scene>-flat.png, <scene>-smooth.png and <scene>-compare.png.
 */
import { chromium, devices, type Browser } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const mode = process.argv[2] ?? 'make';
const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};
mkdirSync('out', { recursive: true });

if (mode === 'make') {
  const { newGame } = await import('../src/sim/newgame');
  const { saveGame } = await import('../src/sim/persist');
  const { STEPS_PER_DAY, DAYS_PER_SEASON } = await import('../src/sim/constants');
  const seed = Number(arg('seed', '3'));
  const size = Number(arg('size', '256'));
  const { sim } = newGame(seed, size);
  const runTo = (day: number) => {
    while (sim.step < day * STEPS_PER_DAY) sim.run(STEPS_PER_DAY / 4);
  };
  // Summer: mid-season, the village a few weeks old.
  runTo(DAYS_PER_SEASON * 1 + 8);
  writeFileSync('out/smooth-summer.bin', new Uint8Array(await saveGame(sim, {})));
  const st = sim.people!.settlements[0]!.state;
  console.log(`summer saved, village at ${st.x.toFixed(1)},${st.y.toFixed(1)}`);
  // Winter: mid-season.
  runTo(DAYS_PER_SEASON * 3 + 7);
  let snowy = 0;
  for (let i = 0; i < sim.world.size; i++) if (sim.world.snow[i]! > 0.002) snowy++;
  console.log(`winter: ${((100 * snowy) / sim.world.size).toFixed(0)}% of cells snowy`);
  writeFileSync('out/smooth-winter.bin', new Uint8Array(await saveGame(sim, {})));
  writeFileSync('out/smooth.json', JSON.stringify({ seed, x: st.x, y: st.y }));
} else {
  const url = arg('url', 'http://localhost:4173/');
  const outDir = arg('out', 'out/smooth');
  mkdirSync(outDir, { recursive: true });
  const at = JSON.parse(readFileSync('out/smooth.json', 'utf8')) as { x: number; y: number; seed: number };
  const scenes: { name: string; save: string; phone: boolean; cam: Record<string, number> }[] = [
    { name: 'village', save: 'summer', phone: false, cam: { x: at.x, y: at.y, viewHeight: 22, pitch: 0.72, yaw: 0.6 } },
    { name: 'landscape', save: 'summer', phone: false, cam: { x: at.x, y: at.y, viewHeight: 75, pitch: 0.62, yaw: 2.2 } },
    { name: 'winter', save: 'winter', phone: false, cam: { x: at.x, y: at.y, viewHeight: 40, pitch: 0.7, yaw: 1.2 } },
    { name: 'phone', save: 'summer', phone: true, cam: { x: at.x, y: at.y, viewHeight: 32, pitch: 0.8, yaw: 3.5 } },
  ];
  const extra = JSON.parse(arg('cams', '{}')) as Record<string, Record<string, number>>;
  const only = arg('scenes', scenes.map((s) => s.name).join(',')).split(',');
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  for (const s of scenes.filter((x) => only.includes(x.name))) {
    const b64 = readFileSync(`out/smooth-${s.save}.bin`).toString('base64');
    const cam = { ...s.cam, ...extra[s.name] };
    for (const variant of ['flat', 'smooth']) {
      await shoot(browser, url, b64, at.seed, s.phone, cam, variant === 'smooth', `${outDir}/${s.name}-${variant}.png`);
    }
    await compare(browser, `${outDir}/${s.name}-flat.png`, `${outDir}/${s.name}-smooth.png`, `${outDir}/${s.name}-compare.png`);
  }
  await browser.close();
}

async function shoot(
  browser: Browser,
  url: string,
  b64: string,
  seed: number,
  phone: boolean,
  cam: Record<string, number>,
  smooth: boolean,
  path: string,
): Promise<void> {
  const ctx = await browser.newContext(phone ? devices['Pixel 7'] : { viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[pageerror] ${e}`));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`[error] ${m.text()}`);
  });
  await page.goto(`${url}?test=1&seed=1&size=64`);
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
    { b64, seed },
  );
  await page.goto(`${url}?test=1&persist=1${smooth ? '&smooth=1' : ''}`);
  await page.waitForFunction(() => (window as any).__hydro, null, { timeout: 120_000 });
  await page.evaluate((c) => (window as any).__hydro.renderer.camera.setState(c, true), cam);
  await page.waitForTimeout(4000);
  await page.screenshot({ path, timeout: 120_000 });
  console.log(`wrote ${path}`);
  await ctx.close();
}

/** Two PNGs side by side (labelled) in one PNG, composed in a page. */
async function compare(browser: Browser, a: string, b: string, out: string): Promise<void> {
  const ia = `data:image/png;base64,${readFileSync(a).toString('base64')}`;
  const ib = `data:image/png;base64,${readFileSync(b).toString('base64')}`;
  const page = await browser.newPage();
  // (A string, so that tsx's helpers do not leak into the page.)
  const size = (await page.evaluate(`(async () => {
    const load = (src) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = src; });
    const [A, B] = await Promise.all([load(${JSON.stringify(ia)}), load(${JSON.stringify(ib)})]);
    const gap = 8;
    const c = document.createElement('canvas');
    c.width = A.width + gap + B.width;
    c.height = Math.max(A.height, B.height);
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(A, 0, 0);
    g.drawImage(B, A.width + gap, 0);
    const fs = Math.round(c.height / 28);
    g.font = 'bold ' + fs + 'px sans-serif';
    for (const [label, x] of [['flat', 12], ['smooth', A.width + gap + 12]]) {
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillRect(x - 6, c.height - fs * 1.9, g.measureText(label).width + 12, fs * 1.5);
      g.fillStyle = '#fff';
      g.fillText(label, x, c.height - fs * 0.75);
    }
    window.__png = c.toDataURL('image/png');
    return [c.width, c.height];
  })()`)) as number[];
  const png = (await page.evaluate(() => (window as any).__png)) as string;
  writeFileSync(out, Buffer.from(png.split(',')[1]!, 'base64'));
  console.log(`wrote ${out} (${size[0]}x${size[1]})`);
  await page.close();
}
