/**
 * Audio review loop, the ears' analogue of the screenshot tools: records the
 * real game's mixing ticks for a few scenarios in headless Chromium, renders
 * them offline through the game's own Web Audio graph
 * (SoundSystem.renderOffline), writes WAVs and analyses them: loudness
 * (BS.1770-style, approx LUFS), peaks and headroom, consistency across
 * scenarios, spot events per minute, spectral balance, sustained tones
 * (drones) and click candidates; with ffmpeg present also a spectrogram and
 * a waveform PNG per scenario (look at them!).
 *
 *   npx vite build && npx vite preview --port 4173 &
 *   npm run sound-review -- [--url http://localhost:4173/] [--seconds 20] [--only river,village]
 *
 * Output: out/sound/<scenario>.wav, .png (spectrogram), -wave.png, report.json.
 */
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1]! : d;
};
const url = opt('url', `http://localhost:${process.env.HYDRO_PW_PORT ?? 4173}/`);
const seconds = Number(opt('seconds', '20'));
const only = opt('only', '')
  .split(',')
  .filter(Boolean);
const OUT = 'out/sound';
const DEG = Math.PI / 180;

interface Scenario {
  name: string;
  what: string;
  /** A staged scene (welcome panels / tool cards) with its camera, or the main game. */
  scene?: { id: string; camera: { x: number; y: number; yaw: number; pitch: number; viewHeight: number }; speed: number };
  /** Main game: where to look (a JS expression over `h`, returning a camera state) and the speed. */
  game?: { camera: string; speed: number; days?: number };
}

/** Find a cell by a predicate over the mirror grids, nearest the start. */
const FIND = `
  (pred) => {
    const m = h.mirror, W = m.width, depth = h.renderer.heights.depth, vel = h.renderer.flow.vel;
    const { startX, startY } = h.data.info;
    let best = null;
    for (let y = 4; y < m.height - 4; y++) for (let x = 4; x < W - 4; x++) {
      if (!m.isRevealed(x, y)) continue;
      const i = y * W + x;
      const sp = Math.hypot(vel[2 * i], vel[2 * i + 1]);
      const score = pred(x, y, depth[i], sp, (dx, dy) => depth[(y + dy) * W + x + dx]);
      if (score === null) continue;
      const d = Math.hypot(x - startX, y - startY) - score;
      if (!best || d < best.d) best = { x, y, d };
    }
    return best ?? { x: startX, y: startY };
  }`;

const SCENARIOS: Scenario[] = [
  {
    name: 'meadow',
    what: 'quiet dry land in spring, nothing flowing in view',
    game: {
      speed: 1,
      camera: `(() => { const p = (${FIND})((x, y, d, sp, at) => { for (let dy = -9; dy <= 9; dy += 3) for (let dx = -12; dx <= 12; dx += 3) if (at(dx, dy) > 0.03) return null; return 0; }); return { x: p.x, y: p.y, viewHeight: 24 }; })()`,
    },
  },
  {
    name: 'river',
    what: 'close-up on the fastest-flowing river water near the start',
    game: {
      speed: 1,
      camera: `(() => { const p = (${FIND})((x, y, d, sp) => (d > 0.4 && sp > 0.5 ? sp * 20 : null)); return { x: p.x, y: p.y, viewHeight: 16 }; })()`,
    },
  },
  {
    name: 'paused',
    what: 'the river close-up, game paused',
    game: {
      speed: 0,
      camera: `(() => { const p = (${FIND})((x, y, d, sp) => (d > 0.4 && sp > 0.5 ? sp * 20 : null)); return { x: p.x, y: p.y, viewHeight: 16 }; })()`,
    },
  },
  {
    name: 'zoomed-out',
    what: 'the whole known land from far out',
    game: { speed: 1, camera: `({ x: h.data.info.startX, y: h.data.info.startY, viewHeight: 220 })` },
  },
  {
    name: 'village',
    what: 'the staged village (welcome scene): builders, fields, fishers, pond',
    scene: { id: 'village', camera: { x: 34, y: 71, yaw: 25 * DEG, pitch: 38 * DEG, viewHeight: 13 }, speed: 3 },
  },
  {
    name: 'rain',
    what: 'the welcome water scene: a rain front over the river',
    scene: { id: 'water', camera: { x: 46, y: 42, yaw: 45 * DEG, pitch: 30 * DEG, viewHeight: 30 }, speed: 3 },
  },
  {
    name: 'weir',
    what: 'the weir card: spill over a weir across the river',
    scene: { id: 'weir', camera: { x: 27, y: 41, yaw: 40 * DEG, pitch: 36 * DEG, viewHeight: 20 }, speed: 3 },
  },
  {
    name: 'wheel',
    what: 'the water wheel card: a noria turning in the current',
    scene: { id: 'wheel', camera: { x: 71, y: 84, yaw: -30 * DEG, pitch: 34 * DEG, viewHeight: 9 }, speed: 3 },
  },
];

// ---------------------------------------------------------------------------
// Analysis.

function biquad(x: Float64Array, b: number[], a: number[]): Float64Array {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b[0]! * x[i]! + b[1]! * x1 + b[2]! * x2 - a[1]! * y1 - a[2]! * y2) / a[0]!;
    x2 = x1;
    x1 = x[i]!;
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

/** BS.1770 K-weighting (high shelf +4 dB at 1.5 kHz, high pass at 38 Hz), RBJ form for any rate. */
function kWeight(x: Float32Array, fs: number): Float64Array {
  const shelf = () => {
    const A = Math.pow(10, 4 / 40);
    const w = (2 * Math.PI * 1500) / fs;
    const al = Math.sin(w) / (2 * Math.SQRT1_2);
    const c = Math.cos(w);
    const s = 2 * Math.sqrt(A) * al;
    return {
      b: [A * (A + 1 + (A - 1) * c + s), -2 * A * (A - 1 + (A + 1) * c), A * (A + 1 + (A - 1) * c - s)],
      a: [A + 1 - (A - 1) * c + s, 2 * (A - 1 - (A + 1) * c), A + 1 - (A - 1) * c - s],
    };
  };
  const hp = () => {
    const w = (2 * Math.PI * 38) / fs;
    const al = Math.sin(w) / (2 * 0.5);
    const c = Math.cos(w);
    return { b: [(1 + c) / 2, -(1 + c), (1 + c) / 2], a: [1 + al, -2 * c, 1 - al] };
  };
  const s = shelf();
  const h = hp();
  return biquad(biquad(Float64Array.from(x), s.b, s.a), h.b, h.a);
}

const db = (v: number) => (v > 0 ? 10 * Math.log10(v) : -Infinity);

function loudness(l: Float32Array, r: Float32Array, fs: number) {
  const kl = kWeight(l, fs);
  const kr = kWeight(r, fs);
  const block = Math.round(0.4 * fs);
  const hop = Math.round(0.1 * fs);
  const ms: number[] = [];
  for (let s = 0; s + block <= kl.length; s += hop) {
    let e = 0;
    for (let i = s; i < s + block; i++) e += kl[i]! * kl[i]! + kr[i]! * kr[i]!;
    ms.push(e / block);
  }
  const L = (z: number) => -0.691 + db(z);
  const abs = ms.filter((z) => L(z) > -70);
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const rel = L(mean(abs)) - 10;
  const gated = abs.filter((z) => L(z) > rel);
  // Skip the first 2 s: the offline render fades the layers in from silence.
  const momentary = ms.map(L).slice(20);
  return { integrated: L(mean(gated)), momentaryMax: Math.max(...momentary), momentaryMin: Math.min(...momentary.filter(Number.isFinite)) };
}

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len)
      for (let k = 0; k < len / 2; k++) {
        const c = Math.cos(a * k);
        const s = Math.sin(a * k);
        const ur = re[i + k]!, ui = im[i + k]!;
        const vr = re[i + k + len / 2]! * c - im[i + k + len / 2]! * s;
        const vi = re[i + k + len / 2]! * s + im[i + k + len / 2]! * c;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
      }
  }
}

/** Mean power spectrum (Hann, 4096) of the mono mix. */
function spectrum(m: Float32Array): Float64Array {
  const N = 4096;
  const out = new Float64Array(N / 2);
  let frames = 0;
  for (let s = 0; s + N <= m.length; s += N / 2) {
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = m[s + i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
    fft(re, im);
    for (let k = 0; k < N / 2; k++) out[k]! += re[k]! * re[k]! + im[k]! * im[k]!;
    frames++;
  }
  for (let k = 0; k < out.length; k++) out[k]! /= Math.max(1, frames);
  return out;
}

const BANDS: [string, number, number][] = [
  ['sub <120', 0, 120],
  ['low 120-500', 120, 500],
  ['mid 500-2k', 500, 2000],
  ['presence 2-6k', 2000, 6000],
  ['air >6k', 6000, 24000],
];

function analyse(l: Float32Array, r: Float32Array, fs: number) {
  const n = l.length;
  const m = new Float32Array(n);
  let peak = 0;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    m[i] = (l[i]! + r[i]!) / 2;
    peak = Math.max(peak, Math.abs(l[i]!), Math.abs(r[i]!));
    sq += (l[i]! * l[i]! + r[i]! * r[i]!) / 2;
  }
  const spec = spectrum(m);
  const bin = fs / 4096;
  const total = spec.reduce((a, b) => a + b, 0) || 1;
  const bands: Record<string, number> = {};
  for (const [name, a, b] of BANDS) {
    let e = 0;
    for (let k = Math.floor(a / bin); k < Math.min(spec.length, Math.ceil(b / bin)); k++) e += spec[k]!;
    bands[name] = Math.round((e / total) * 1000) / 10;
  }
  // Sustained tones: bins ≥ 12 dB above the median of their ±40-bin neighbourhood.
  const tones: { hz: number; prominenceDb: number }[] = [];
  for (let k = 3; k < spec.length - 3; k++) {
    if (spec[k]! < spec[k - 1]! || spec[k]! < spec[k + 1]!) continue;
    const nb = Array.from(spec.subarray(Math.max(0, k - 40), Math.min(spec.length, k + 40))).sort((a, b) => a - b);
    const med = nb[nb.length >> 1]!;
    const p = db(spec[k]! / Math.max(1e-20, med));
    if (p >= 12 && spec[k]! / total > 1e-4) tones.push({ hz: Math.round(k * bin), prominenceDb: Math.round(p) });
  }
  tones.sort((a, b) => b.prominenceDb - a.prominenceDb);
  // Click candidates: a sample step far above the local step size (5 ms around), in silence-ish context.
  const clicks: number[] = [];
  const win = Math.round(0.005 * fs);
  let acc = 0;
  const d = new Float32Array(n);
  for (let i = 1; i < n; i++) d[i] = Math.abs(m[i]! - m[i - 1]!);
  for (let i = 1; i < Math.min(n, win); i++) acc += d[i]!;
  for (let i = win; i < n - win; i++) {
    acc += d[i + win - 1]! - d[i - win]!;
    const local = acc / (2 * win);
    if (d[i]! > 0.01 && d[i]! > 10 * local) {
      clicks.push(Math.round((i / fs) * 1000) / 1000);
      i += win;
    }
  }
  const lu = loudness(l, r, fs);
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return {
    peakDbfs: r1(20 * Math.log10(peak || 1e-9)),
    rmsDbfs: r1(db(sq / n)),
    integrated: r1(lu.integrated),
    momentaryMax: r1(lu.momentaryMax),
    momentaryMin: r1(lu.momentaryMin),
    bands,
    tones: tones.slice(0, 5),
    clicks: clicks.slice(0, 20),
    clickCount: clicks.length,
  };
}

function wav(l: Float32Array, r: Float32Array, fs: number): Buffer {
  const n = l.length;
  const b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 4, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(fs, 24);
  b.writeUInt32LE(fs * 4, 28);
  b.writeUInt16LE(4, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 4, 40);
  const q = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  for (let i = 0; i < n; i++) {
    b.writeInt16LE(q(l[i]!), 44 + i * 4);
    b.writeInt16LE(q(r[i]!), 46 + i * 4);
  }
  return b;
}

function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Recording.

mkdirSync(OUT, { recursive: true });
const localChromium = '/opt/pw-browsers/chromium';
const browser = await chromium.launch({
  executablePath: existsSync(localChromium) ? localChromium : undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const ffmpeg = hasFfmpeg();
const report: Record<string, unknown>[] = [];
for (const sc of SCENARIOS) {
  if (only.length && !only.includes(sc.name)) continue;
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${url}?test=1&sound=1&seed=1`);
  await page.waitForFunction(() => (window as any).__hydro, null, { timeout: 120_000 });
  if (sc.game) {
    if (sc.game.days) await page.evaluate((d) => (window as any).__hydro.client.runDays(d), sc.game.days);
    await page.waitForTimeout(1500);
    const cam = await page.evaluate((js) => {
      const h = (window as any).__hydro;
      const c = new Function('h', `return ${js}`)(h);
      h.renderer.camera.setState(c, true);
      return c;
    }, sc.game.camera);
    await page.evaluate((s) => (window as any).__hydro.client.setSpeed(s), sc.game.speed);
    console.log(`[${sc.name}] camera ${JSON.stringify(cam)}`);
  } else if (sc.scene) {
    await page.evaluate(async (s) => {
      const h = (window as any).__hydro;
      const c = new h.SimClient({ scene: s.id, speed: s.speed });
      const data = await c.ready;
      const view = { ...s.camera, aspect: 1.6 };
      c.onSnapshot((snap: unknown) => h.sound.scene(snap, view, data.info.width));
      (window as any).__sceneClient = c;
    }, sc.scene);
  }
  // Let the mix settle (ramps, the first summaries), then record (a scene from its start).
  await page.waitForTimeout(2000);
  if (sc.scene) await page.evaluate((s) => (window as any).__sceneClient.scene(s.id, s.speed), sc.scene);
  await page.evaluate(() => (window as any).__hydro.sound.startRecording());
  await page.waitForTimeout(seconds * 1000);
  const ticks = await page.evaluate(() => (window as any).__hydro.sound.stopRecording());
  // A string, so the bundler's helpers (__name) do not leak into the page.
  await page.evaluate(`window.__ticks = ${JSON.stringify(ticks)}`);
  const rendered = (await page.evaluate(`(async () => {
    const r = await window.__hydro.sound.renderOffline(window.__ticks, ${seconds});
    const enc = (a) => {
      const i16 = new Int16Array(a.length);
      for (let i = 0; i < a.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(a[i] * 32767)));
      const u8 = new Uint8Array(i16.buffer);
      let s = '';
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
      return btoa(s);
    };
    return { l: enc(r.left), r: enc(r.right), fs: r.sampleRate };
  })()`)) as { l: string; r: string; fs: number };
  await page.close();
  const dec = (s: string) => {
    const b = Buffer.from(s, 'base64');
    const i16 = new Int16Array(b.buffer, b.byteOffset, b.length / 2);
    return Float32Array.from(i16, (v) => v / 32767);
  };
  const L = dec(rendered.l);
  const R = dec(rendered.r);
  const fs = rendered.fs;
  const file = `${OUT}/${sc.name}.wav`;
  writeFileSync(file, wav(L, R, fs));
  // Events per minute (spots) and the mean layer gains.
  const counts: Record<string, number> = {};
  const layerSum: Record<string, number> = {};
  let frames = 0;
  for (const t of ticks as { frame?: { spots: { kind: string }[]; layers: Record<string, number> }; ui?: string }[]) {
    if (!t.frame) continue;
    frames++;
    for (const s of t.frame.spots) counts[s.kind] = (counts[s.kind] ?? 0) + 1;
    for (const [k, v] of Object.entries(t.frame.layers)) layerSum[k] = (layerSum[k] ?? 0) + v;
  }
  const perMin = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Math.round((v / seconds) * 60 * 10) / 10]));
  const layers = Object.fromEntries(Object.entries(layerSum).map(([k, v]) => [k, Math.round((v / Math.max(1, frames)) * 100) / 100]));
  const a = analyse(L, R, fs);
  if (ffmpeg) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-lavfi', 'showspectrumpic=s=1200x400:legend=1:scale=log', `${OUT}/${sc.name}.png`]);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-lavfi', 'showwavespic=s=1200x240:split_channels=1:scale=sqrt', '-frames:v', '1', `${OUT}/${sc.name}-wave.png`]);
  }
  const row = { name: sc.name, what: sc.what, file, ...a, eventsPerMin: perMin, layers, errors };
  report.push(row);
  console.log(
    `[${sc.name}] ${a.integrated} LUFS (momentary ${a.momentaryMin}…${a.momentaryMax}), peak ${a.peakDbfs} dBFS, ` +
      `bands ${JSON.stringify(a.bands)}, events/min ${JSON.stringify(perMin)}, layers ${JSON.stringify(layers)}, ` +
      `tones ${JSON.stringify(a.tones)}, clicks ${a.clickCount}${errors.length ? `, ERRORS ${errors.join(' | ')}` : ''}`,
  );
}
await browser.close();

// Checks across scenarios.
const loud = report.map((r) => r.integrated as number).filter(Number.isFinite);
const warnings: string[] = [];
for (const r of report) {
  if ((r.peakDbfs as number) > -3) warnings.push(`${r.name}: peak ${r.peakDbfs} dBFS (want ≤ −3)`);
  if ((r.integrated as number) > -18) warnings.push(`${r.name}: ${r.integrated} LUFS is loud for an ambience (want ≤ −18)`);
  if ((r.errors as string[]).length) warnings.push(`${r.name}: console errors`);
}
if (loud.length > 1) {
  const med = [...loud].sort((a, b) => a - b)[loud.length >> 1]!;
  for (const r of report) if (Math.abs((r.integrated as number) - med) > 8 && r.name !== 'paused' && r.name !== 'meadow') warnings.push(`${r.name}: ${r.integrated} LUFS is ${((r.integrated as number) - med).toFixed(1)} dB from the median ${med}`);
}
writeFileSync(`${OUT}/report.json`, JSON.stringify({ seconds, report, warnings }, null, 2));
console.log(warnings.length ? `\nWarnings:\n  ${warnings.join('\n  ')}` : '\nNo warnings.');
console.log(`Wrote ${OUT}/*.wav${ffmpeg ? ', *.png' : ''}, report.json`);
