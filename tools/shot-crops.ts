/**
 * Visual review of the field crops (docs/PEOPLE.md §3.1): the ordinary crop,
 * millet, a paddy and a pegged plot side by side by a real village, in
 * several seasons, at close, desktop and phone zoom.
 *
 *   npx tsx tools/shot-crops.ts make            # Node: out/crops-<season>.bin (+ out/crops.json)
 *   npx vite preview --port 4173 &              # after npm run build
 *   npx tsx tools/shot-crops.ts shoot [--url http://localhost:4173/]
 *
 * PNGs go to out/crops-<season>-<view>.png. The save is put in the page's
 * autosave slot and resumed paused (?test=1&persist=1), so nothing moves.
 */
import { chromium, devices } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const mode = process.argv[2] ?? 'make';
const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};
mkdirSync('out', { recursive: true });

/** Season variants: season index, crop stage of the showcase fields, snow (water equivalent, m) over the land. */
const SEASONS: { name: string; season: number; day: number; crop: number; snow?: number }[] = [
  { name: 'spring', season: 0, day: 8, crop: 70 },
  { name: 'summer', season: 1, day: 4, crop: 170 },
  { name: 'ripe', season: 1, day: 11, crop: 240 },
  { name: 'autumn', season: 2, day: 6, crop: 0 },
  // Fields under snow (stay readable at every zoom): deep winter snow on bare
  // land, and a late snow on a young spring crop.
  { name: 'winter', season: 3, day: 6, crop: 0, snow: 0.03 },
  { name: 'thaw', season: 0, day: 3, crop: 40, snow: 0.004 },
];

if (mode === 'make') {
  const { newGame } = await import('../src/sim/newgame');
  const { saveGame } = await import('../src/sim/persist');
  const { STEPS_PER_DAY, DAYS_PER_SEASON, DAYS_PER_YEAR } = await import('../src/sim/constants');
  const { LandUse } = await import('../src/sim/world');
  const seed = Number(arg('seed', '3'));
  const { sim } = newGame(seed, 128);
  const days = Number(arg('days', '14'));
  for (let d = 0; d < days; d++) sim.run(STEPS_PER_DAY);
  const p = sim.people!;
  const w = sim.world;
  const st = p.settlements[0]!.state;
  // A 4 x 16 strip of flat, dry, unbuilt land near the store: four 4 x 4 blocks.
  const ok = (x: number, y: number) => {
    if (!w.inBounds(x, y)) return false;
    const i = w.idx(x, y);
    const lu = w.landuse[i]!;
    return (lu === LandUse.None || lu === LandUse.Field || lu === LandUse.Path || lu === LandUse.Pasture) && w.water[i]! < 0.01;
  };
  let best: [number, number, number] | null = null;
  const cx = Math.round(st.x);
  const cy = Math.round(st.y);
  for (let y0 = cy - 26; y0 <= cy + 26; y0++)
    for (let x0 = cx - 30; x0 <= cx + 14; x0++) {
      let good = true;
      let lo = Infinity;
      let hi = -Infinity;
      for (let y = y0; y < y0 + 4 && good; y++)
        for (let x = x0; x < x0 + 16 && good; x++) {
          good = ok(x, y);
          if (good) {
            const t = w.terrain(w.idx(x, y));
            lo = Math.min(lo, t);
            hi = Math.max(hi, t);
          }
        }
      if (!good) continue;
      const d = Math.hypot(x0 + 8 - cx, y0 + 2 - cy);
      const score = d + 30 * (hi - lo);
      if (d > 5 && (!best || score < best[2])) best = [x0, y0, score];
    }
  if (!best) throw new Error('no flat strip near the village');
  const [x0, y0] = best;
  console.log(`showcase at ${x0},${y0} (village ${cx},${cy})`);
  const fc = p.fieldCrop;
  const pegs: number[] = [];
  for (const s of SEASONS) {
    for (let y = y0; y < y0 + 4; y++)
      for (let x = x0; x < x0 + 16; x++) {
        const i = w.idx(x, y);
        const block = Math.floor((x - x0) / 4);
        if (block === 3) {
          w.landuse[i] = LandUse.None;
          w.crop[i] = 0;
          if (s === SEASONS[0]) pegs.push(i);
          continue;
        }
        w.landuse[i] = LandUse.Field;
        w.crop[i] = s.crop;
        fc[i] = block;
        w.vegetation[i] = 0.15;
        // The paddy stands in a hand's depth of water, level across the block.
        if (block === 2) w.water[i] = 0.12;
        else w.water[i] = 0;
      }
    // Level the paddy's water surface.
    let top = -Infinity;
    for (let y = y0; y < y0 + 4; y++) for (let x = x0 + 8; x < x0 + 12; x++) top = Math.max(top, w.terrain(w.idx(x, y)) + 0.05);
    for (let y = y0; y < y0 + 4; y++) for (let x = x0 + 8; x < x0 + 12; x++) w.water[w.idx(x, y)] = top + 0.07 - w.terrain(w.idx(x, y));
    // Snow over the whole map (none on the paddy's water).
    for (let i = 0; i < w.size; i++) w.snow[i] = s.snow && w.water[i]! < 0.01 ? s.snow : 0;
    st.pegs = pegs;
    (p as unknown as { rebuildPegMask(): void }).rebuildPegMask();
    sim.step = (DAYS_PER_YEAR + s.season * DAYS_PER_SEASON + s.day) * STEPS_PER_DAY + STEPS_PER_DAY / 2;
    const bytes = await saveGame(sim, {});
    writeFileSync(`out/crops-${s.name}.bin`, new Uint8Array(bytes));
    console.log(`wrote out/crops-${s.name}.bin`);
  }
  writeFileSync('out/crops.json', JSON.stringify({ x: x0 + 8, y: y0 + 2, seed }));
} else {
  const url = arg('url', 'http://localhost:4173/');
  const at = JSON.parse(readFileSync('out/crops.json', 'utf8')) as { x: number; y: number; seed: number };
  const only = arg('seasons', SEASONS.map((s) => s.name).join(',')).split(',');
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const views: { name: string; phone: boolean; cam: Record<string, number> }[] = [
    { name: 'close', phone: false, cam: { viewHeight: 12, pitch: 0.75 } },
    { name: 'desktop', phone: false, cam: { viewHeight: 36 } },
    { name: 'phone', phone: true, cam: { viewHeight: 40 } },
    { name: 'far', phone: false, cam: { viewHeight: 90 } },
  ];
  for (const s of SEASONS.filter((x) => only.includes(x.name))) {
    const b64 = readFileSync(`out/crops-${s.name}.bin`).toString('base64');
    for (const v of views) {
      const ctx = await browser.newContext(v.phone ? devices['Pixel 7'] : { viewport: { width: 1280, height: 800 } });
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
        { b64, seed: at.seed },
      );
      await page.goto(`${url}?test=1&persist=1`);
      await page.waitForFunction(() => (window as any).__hydro, null, { timeout: 120_000 });
      await page.evaluate((c) => (window as any).__hydro.renderer.camera.setState(c, true), { x: at.x, y: at.y, ...v.cam });
      await page.waitForTimeout(4000);
      const path = `out/crops-${s.name}-${v.name}.png`;
      await page.screenshot({ path, timeout: 120_000 });
      console.log(`wrote ${path}`);
      await ctx.close();
    }
  }
  await browser.close();
}
