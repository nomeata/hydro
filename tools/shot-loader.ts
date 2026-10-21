/**
 * Prerender the loading animation of the welcome panels and tool cards
 * (src/ui/loader-mill.webp): a village mill by the weir card's weir,
 * its wheel turning in the race, drawn by the real engine.
 *   npx tsx tools/shot-loader.ts [--url http://localhost:4233/] [--probe] [--cam '{"yaw":0.5}']
 * --probe only writes out/loader-probe.png (for trying the framing). Otherwise
 * it steps the renderer through one seamless loop with a fixed clock, crops
 * the frames square, crossfades the loop's tail into its head (the water's
 * texture does not repeat) and packs them into a horizontal sprite strip with
 * ffmpeg (lossy WebP). Assumes a preview server is running.
 */
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1]! : d;
};
const url = opt('url', 'http://localhost:4233/');
const probe = args.includes('--probe');
const cam = opt('cam', '');
/** Frames in the loop, the frame size in the strip (px), and the overlap crossfaded at the seam. */
const FRAMES = Number(opt('frames', '24'));
const SIZE = Number(opt('size', '320'));
const BLEND = Number(opt('blend', '5'));
const OUT = opt('out', 'src/ui/loader-mill.webp');

mkdirSync('out/loader', { recursive: true });
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
// The canvas is rendered at 2× the CSS size of the card art (the strip is crisp on phones).
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
// tsx names the arrow functions inside page.evaluate callbacks with a helper the page lacks.
await page.addInitScript('window.__name = (f) => f');
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => console.log(`[pageerror] ${e}`));
await page.goto(`${url}?test=1&seed=1&size=64&cards=1`);
await page.waitForFunction(() => (window as any).__hydro, null, { timeout: 120_000 });
await page.evaluate(() => {
  const h = (window as any).__hydro;
  h.IntroScenes.hold = true;
  h.showCard('weir');
});
await page.waitForSelector('.tool-card .intro-art.live-on', { timeout: 120_000 });
// Let the river settle under the weir.
await page.waitForTimeout(4000);

/** Put a finished mill on the bank just below the weir, its wheel in the race. */
const placed = await page.evaluate((camJson) => {
  const h = (window as any).__hydro;
  const sc = h.cards.scenes;
  const r = sc.renderer;
  const m = sc.mirror;
  const W = m.width;
  // Below the weir's north-east end: walk from the river towards the bank.
  const wet = (x: number, y: number) => m.wet[y * W + x] === 1;
  let bx = 0;
  let by = 0;
  let sx = 0;
  let sy = 0;
  outer: for (let k = 0; k < 12; k++) {
    // Along the bank-normal (+1, −1) from a point in the river below the weir.
    const x = Math.round(31 + k * 0.7);
    const y = Math.round(44 - k * 0.7);
    for (const [dx, dy] of [[1, 0], [0, -1]] as const) {
      if (wet(x, y) && !wet(x + dx, y + dy)) {
        bx = x + dx;
        by = y + dy;
        sx = x;
        sy = y;
        break outer;
      }
    }
  }
  const rot = Math.round(Math.atan2(-(sy - by), sx - bx) / (Math.PI / 2)) * (Math.PI / 2);
  const mill = { id: 9001, kind: 'mill', x: bx, y: by, rot, progress: 1, spin: 1.6, sacks: 2 };
  (window as any).__loaderMill = mill;
  const list = [mill];
  r.buildingList = list;
  r.buildings.setBuildings(list);
  r.millWheels.setBuildings(list);
  // Keep later snapshots from dropping it.
  const apply = r.applySnapshot.bind(r);
  r.applySnapshot = (s: any) => apply(s.buildings ? { ...s, buildings: [...s.buildings, mill] } : s);
  // No clouds or jumping fish: the loop must repeat.
  h.cards.scenes.layers.fishJumps.rateScale = 0;
  r.weather.zoomBias = 0;
  r.camera.limits.minViewHeight = 1;
  r.camera.setState({ x: bx + 0.4, y: by - 0.4, yaw: -1, pitch: 0.6, viewHeight: 3.8, ...(camJson ? JSON.parse(camJson) : {}) }, true);
  return { bx, by, sx, sy, rot };
}, cam);
console.log('mill', placed);

/** Stop the scene's own frames; draw one at `t` ms and return the art box's pixels as a PNG data URL. */
async function frameAt(t: number): Promise<string> {
  return page.evaluate((tt) => {
    const h = (window as any).__hydro;
    h.IntroScenes.freeze = true;
    const r = h.cards.scenes.renderer;
    r.frame(tt);
    return (r.gl.domElement as HTMLCanvasElement).toDataURL('image/png');
  }, t);
}

function decode(url: string): PNG {
  return PNG.sync.read(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
}

/** Square crop around the canvas centre, resampled to SIZE (box filter). */
function crop(png: PNG): PNG {
  const side = Math.min(png.width, png.height);
  const x0 = Math.floor((png.width - side) / 2);
  const y0 = Math.floor((png.height - side) / 2);
  const out = new PNG({ width: SIZE, height: SIZE });
  const k = side / SIZE;
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const acc = [0, 0, 0];
      let n = 0;
      for (let v = Math.floor(y * k); v < Math.floor((y + 1) * k); v++)
        for (let u = Math.floor(x * k); u < Math.floor((x + 1) * k); u++) {
          const i = ((y0 + v) * png.width + x0 + u) * 4;
          acc[0] += png.data[i]!;
          acc[1] += png.data[i + 1]!;
          acc[2] += png.data[i + 2]!;
          n++;
        }
      const o = (y * SIZE + x) * 4;
      out.data[o] = acc[0]! / n;
      out.data[o + 1] = acc[1]! / n;
      out.data[o + 2] = acc[2]! / n;
      out.data[o + 3] = 255;
    }
  return out;
}

if (probe) {
  // Warm up a few frames at real pace, then one shot.
  // --probe-cams '[{"yaw":0.6},{"yaw":2}]': one shot per camera override.
  const cams = JSON.parse(opt('probe-cams', '[{}]')) as object[];
  for (const [n, c] of cams.entries()) {
    await page.evaluate((cc) => {
      const r = (window as any).__hydro.cards.scenes.renderer;
      r.camera.setState({ ...r.camera.getCurrentState(), ...cc }, true);
    }, c);
    for (let k = 0; k < 4; k++) await frameAt(100_000 + n * 1000 + k * 50);
    writeFileSync(`out/loader-probe-${n}.png`, PNG.sync.write(crop(decode(await frameAt(100_000 + n * 1000 + 250)))));
    console.log(`wrote out/loader-probe-${n}.png`, JSON.stringify(c));
  }
  await browser.close();
  process.exit(0);
}

// One loop of LOOP seconds: the wheel turns by two of its 12 paddles (2π/6), calmly.
const LOOP = Number(opt('loop', '2.4'));
const loopSec = LOOP;
await page.evaluate((loop) => {
  const r = (window as any).__hydro.cards.scenes.renderer;
  const k = Math.min(3, Math.max(0, r.flow.gameSpeed as number));
  // MillWheelsLayer turns at spin × 1.4 rad/s per game speed.
  const spin = (2 * Math.PI) / 6 / loop / (1.4 * k);
  (window as any).__loaderMill.spin = spin;
  for (const w of r.millWheels.wheels) w.spin = spin;
  // Hold the land's look (growing plants) still for the loop; the water keeps flowing.
  const apply = r.applySnapshot.bind(r);
  r.applySnapshot = (s: any) => apply({ ...s, look: undefined, fields: undefined, buildings: undefined, entities: undefined });
  const layers = (window as any).__hydro.cards.scenes.layers;
  const applyL = layers.applySnapshot.bind(layers);
  layers.applySnapshot = (s: any) => applyL({ ...s, look: undefined, fields: undefined, buildings: undefined });
}, LOOP);
const step = (loopSec * 1000) / FRAMES;
// The renderer clamps dt to 0.1 s: step finer than that, and draw BLEND extra frames past the loop.
const sub = Math.ceil(step / 90);
const T0 = 200_000;
// Warm up (pending vegetation rebuilds run between frames).
for (let j = 0; j < 30; j++) {
  await frameAt(T0 - (30 - j) * 50);
  await page.waitForTimeout(50);
}
const raw: PNG[] = [];
for (let f = 0; f < FRAMES + BLEND; f++) {
  for (let s = 1; s < sub; s++) await frameAt(T0 + (f - 1) * step + (s * step) / sub);
  raw.push(crop(decode(await frameAt(T0 + f * step))));
  process.stdout.write('.');
}
console.log();
// Crossfade: the frames past the loop (which match the first ones in the wheel's phase) fade into them.
const frames = raw.slice(0, FRAMES);
for (let b = 0; b < BLEND; b++) {
  const a = (b + 1) / (BLEND + 1);
  const head = frames[b]!;
  const tail = raw[FRAMES + b]!;
  // Frame b shows the tail's water for a few frames, easing into its own.
  for (let i = 0; i < head.data.length; i++) head.data[i] = tail.data[i]! * (1 - a) + head.data[i]! * a;
}
rmSync('out/loader', { recursive: true, force: true });
mkdirSync('out/loader', { recursive: true });
frames.forEach((p, i) => writeFileSync(`out/loader/f${String(i).padStart(2, '0')}.png`, PNG.sync.write(p)));
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', 'out/loader/f%02d.png', '-vf', `tile=${FRAMES}x1`, '-frames:v', '1', 'out/loader/strip.png']);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', 'out/loader/strip.png', '-c:v', 'libwebp', '-quality', opt('q', '72'), '-compression_level', '6', OUT]);
// A preview of the animation for review.
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FRAMES / loopSec), '-i', 'out/loader/f%02d.png', '-plays', '0', 'out/loader/preview.apng']);
console.log(`wrote ${OUT} (${FRAMES} frames of ${SIZE} px, ${(loopSec / FRAMES * 1000).toFixed(0)} ms each)`);
await browser.close();
