/**
 * Main-thread and GPU cost of the game's render loop in headless Chromium
 * (SwiftShader: GPU work shows up as CPU time of the GPU process).
 *
 *   npx vite preview --port 4391 &
 *   npx tsx tools/perf-render.ts [--url http://localhost:4391/] [--views close,mid,far,winter,phone]
 *     [--secs 8] [--shots out/perf] [--modes active,idle] [--days 2] [--size 640x400]
 *     [--gpu] (GPU ms with each scene child hidden) [--calls] (draw calls of a frame)
 *     [--sched] (no drawing: frames/s as the frame pacing chooses them)
 *
 * For each view and mode (active: 1×, idle: paused, camera still) it reports
 * frames drawn per second, ms of main-thread JS per drawn frame (split by
 * layer), draw calls, triangles, and CPU seconds per wall second of the page
 * and of the GPU process. `--shots dir` saves a still of each view (paused,
 * held) for before/after pixel diffs.
 */
import { chromium, devices, type Browser, type Page } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1]! : d;
};
const url = opt('url', 'http://localhost:4391/');
const views = opt('views', 'close,mid,far,winter,phone').split(',');
const modes = opt('modes', 'active,idle').split(',').filter((m) => m);
const secs = Number(opt('secs', '8'));
const shots = opt('shots', '');
const days = Number(opt('days', '2'));
const gpu = args.includes('--gpu');
const sizeOpt = opt('size', '');
const winterDays = Number(opt('winter-days', '40'));
if (shots) mkdirSync(shots, { recursive: true });

interface View {
  phone: boolean;
  winter: boolean;
  viewHeight: number;
}
const VIEWS: Record<string, View> = {
  close: { phone: false, winter: false, viewHeight: 18 },
  mid: { phone: false, winter: false, viewHeight: 40 },
  far: { phone: false, winter: false, viewHeight: 200 },
  winter: { phone: false, winter: true, viewHeight: 40 },
  phone: { phone: true, winter: false, viewHeight: 50 },
  phonefar: { phone: true, winter: false, viewHeight: 200 },
};

const localChromium = '/opt/pw-browsers/chromium';
const browser: Browser = await chromium.launch({
  executablePath: existsSync(localChromium) ? localChromium : undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

async function procCpu(): Promise<{ gpu: number; renderer: number }> {
  const s = await browser.newBrowserCDPSession();
  const r = (await s.send('SystemInfo.getProcessInfo')) as { processInfo: { type: string; cpuTime: number }[] };
  await s.detach();
  let gpu = 0;
  let renderer = 0;
  for (const p of r.processInfo) {
    if (p.type === 'GPU') gpu += p.cpuTime;
    if (p.type === 'renderer') renderer += p.cpuTime;
  }
  return { gpu, renderer };
}

/** Wrap the renderer's frame and its layers' per-frame methods with timers. */
const instrument = () => {
  const h = (window as any).__hydro;
  const r = h.renderer;
  const T: Record<string, number> = {};
  const P: any = ((window as any).__perf = { T, frames: 0, snaps: 0, why: {} });
  const wrap = (obj: any, name: string, label: string) => {
    if (!obj || typeof obj[name] !== 'function') return;
    const f = obj[name].bind(obj);
    obj[name] = (...a: unknown[]) => {
      const t0 = performance.now();
      try {
        return f(...a);
      } finally {
        T[label] = (T[label] ?? 0) + performance.now() - t0;
      }
    };
  };
  const f0 = r.frame.bind(r);
  r.frame = (now: number) => {
    P.frames++;
    const why = r.frameReason ?? '?';
    P.why[why] = (P.why[why] ?? 0) + 1;
    const t0 = performance.now();
    try {
      return f0(now);
    } finally {
      T.frame = (T.frame ?? 0) + performance.now() - t0;
    }
  };
  wrap(r.gl, 'render', 'gl.render');
  wrap(r.flow, 'update', 'flow');
  wrap(r.weather, 'update', 'weather');
  wrap(r.crops, 'update', 'crops');
  wrap(r.cues, 'update', 'cues');
  wrap(r.structures, 'update', 'structures');
  wrap(r.power, 'update', 'power');
  wrap(r.millWheels, 'update', 'millWheels');
  wrap(r.camera, 'update', 'camera');
  wrap(h.crowd, 'update', 'crowd');
  wrap(h.footprints, 'update', 'footprints');
  // Listeners run inside frame (layers' crowd/footprints/fish...).
  const ls = (r as any).listeners as ((...a: unknown[]) => void)[];
  for (let k = 0; k < ls.length; k++) {
    const fn = ls[k]!;
    ls[k] = (...a: unknown[]) => {
      const t0 = performance.now();
      try {
        fn(...a);
      } finally {
        T[`listener${k}`] = (T[`listener${k}`] ?? 0) + performance.now() - t0;
      }
    };
  }
  // Snapshot handling (outside the frame): renderer + layers + mirror.
  wrap(r, 'applySnapshot', 'snap.renderer');
  wrap(h.mirror, 'apply', 'snap.mirror');
  const c = h.client;
  const on = c.onSnapshot?.bind(c);
  void on;
  // Count snapshots via the renderer wrapper.
  const a0 = r.applySnapshot;
  r.applySnapshot = (s: unknown) => {
    P.snaps++;
    return a0(s);
  };
};

async function setupView(page: Page, v: View): Promise<void> {
  await page.evaluate(async (d) => {
    const h = (window as any).__hydro;
    await h.client.runDays(d);
    await new Promise((r) => setTimeout(r, 300));
  }, v.winter ? winterDays : days);
  await page.evaluate((vh) => {
    const h = (window as any).__hydro;
    let sx = 0;
    let sy = 0;
    let k = 0;
    for (const b of h.renderer.buildings.buildings ?? []) {
      sx += b.x;
      sy += b.y;
      k++;
    }
    const st = k ? { x: sx / k, y: sy / k } : {};
    h.renderer.camera.setState({ ...st, viewHeight: vh }, true);
  }, v.viewHeight);
}

async function measure(page: Page, label: string): Promise<Record<string, unknown>> {
  await page.evaluate(() => {
    const P = (window as any).__perf;
    for (const k of Object.keys(P.T)) P.T[k] = 0;
    P.frames = 0;
    P.snaps = 0;
    P.why = {};
    P.t0 = performance.now();
  });
  const c0 = await procCpu();
  await page.waitForTimeout(secs * 1000);
  const c1 = await procCpu();
  const r = await page.evaluate(() => {
    const P = (window as any).__perf;
    const h = (window as any).__hydro;
    const info = h.renderer.gl.info.render;
    return {
      wall: (performance.now() - P.t0) / 1000,
      frames: P.frames,
      snaps: P.snaps,
      why: { ...P.why },
      T: { ...P.T },
      calls: info.calls,
      triangles: info.triangles,
      dpr: h.renderer.gl.getPixelRatio(),
      size: [h.renderer.gl.domElement.width, h.renderer.gl.domElement.height],
    };
  });
  const fps = r.frames / r.wall;
  const per = (k: string) => (r.frames ? (r.T[k] ?? 0) / r.frames : 0);
  const breakdown = Object.entries(r.T as Record<string, number>)
    .filter(([k, t]) => t > 0 && !k.startsWith('snap') && k !== 'frame')
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => `${k} ${per(k).toFixed(2)}`)
    .join(', ');
  const out = {
    label,
    fps: +fps.toFixed(1),
    frameMs: +per('frame').toFixed(2),
    snapMsPerSec: +(((r.T['snap.renderer'] ?? 0) + (r.T['snap.mirror'] ?? 0)) / r.wall).toFixed(1),
    snapsPerSec: +(r.snaps / r.wall).toFixed(1),
    calls: r.calls,
    tris: r.triangles,
    pageCpu: +((c1.renderer - c0.renderer) / r.wall).toFixed(2),
    gpuCpu: +((c1.gpu - c0.gpu) / r.wall).toFixed(2),
    gpuMsPerFrame: r.frames ? Math.round(((c1.gpu - c0.gpu) * 1000) / r.frames) : 0,
    dpr: r.dpr,
    size: r.size.join('x'),
  };
  console.log(JSON.stringify(out));
  console.log(`   per frame ms: ${breakdown}; drawn because: ${JSON.stringify(r.why)}`);
  return out;
}

/** GPU ms per frame (render + 1-pixel readback) with each scene child hidden in turn. */
const gpuBreakdown = async () => {
  const h = (window as any).__hydro;
  h.render.hold = true;
  await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  const r = h.renderer;
  const gl = r.gl.getContext() as WebGL2RenderingContext;
  const px = new Uint8Array(4);
  const once = () => {
    r.gl.render(r.scene, r.camera.camera);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  };
  const time = (n: number) => {
    once();
    const t0 = performance.now();
    for (let i = 0; i < n; i++) once();
    return (performance.now() - t0) / n;
  };
  const names = new Map<unknown, string>();
  const own = (o: any, prefix: string) => {
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (!v || typeof v !== 'object') continue;
      for (const f of ['group', 'mesh', 'points', 'object']) if (v[f]?.isObject3D) names.set(v[f], prefix + k);
      if (v.isObject3D) names.set(v, prefix + k);
    }
  };
  own(r, '');
  own(h, 'h.');
  const base = time(4);
  const out: Record<string, number> = { all: +base.toFixed(1) };
  const kids = [...r.scene.children] as any[];
  for (const [k, c] of kids.entries()) {
    if (!c.visible) continue;
    let tri = 0;
    c.traverse((o: any) => o.isMesh && (tri += 1));
    c.visible = false;
    const t = time(3);
    c.visible = true;
    const d = base - t;
    if (d > 0.5) out[names.get(c) ?? `${k}:${c.type}${c.name ? ':' + c.name : ''}(${tri})`] = +d.toFixed(1);
  }
  h.render.hold = false;
  return out;
};

/** Every draw call of one frame: object path, triangles (× instances), material. */
const callList = async () => {
  const h = (window as any).__hydro;
  const r = h.renderer;
  const list: { name: string; tris: number; inst: number; mat: string }[] = [];
  const f = r.gl.renderBufferDirect;
  r.gl.renderBufferDirect = (cam: any, scene: any, geo: any, mat: any, obj: any, group: any) => {
    const path: string[] = [];
    for (let o = obj; o && o !== r.scene; o = o.parent) path.unshift(o.name || o.type);
    const idx = geo.index ? geo.index.count : (geo.attributes.position?.count ?? 0);
    const cnt = group ? group.count : Math.min(idx, geo.drawRange.count);
    const inst = obj.isInstancedMesh ? obj.count : geo.isInstancedBufferGeometry ? geo.instanceCount : 1;
    list.push({ name: path.join('/'), tris: Math.round(cnt / 3), inst, mat: mat.type + (mat.name ? ':' + mat.name : '') });
    return f.call(r.gl, cam, scene, geo, mat, obj, group);
  };
  await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  await new Promise((res) => setTimeout(res, 3000));
  r.gl.renderBufferDirect = f;
  // Group by name.
  const by = new Map<string, { n: number; tris: number }>();
  for (const c of list) {
    const k = `${c.name} [${c.mat}]`;
    const e = by.get(k) ?? { n: 0, tris: 0 };
    e.n++;
    e.tris += c.tris * c.inst;
    by.set(k, e);
  }
  return [...by.entries()].sort((a, b) => b[1].tris - a[1].tris).map(([k, e]) => `${e.n}× ${k}: ${e.tris} tris`);
};

const results: Record<string, unknown>[] = [];
for (const name of views) {
  const v = VIEWS[name];
  if (!v) throw new Error(`unknown view ${name}`);
  const [sw, sh] = (sizeOpt || '1280x800').split('x').map(Number);
  const ctx = await browser.newContext(v.phone ? devices['Pixel 7'] : { viewport: { width: sw!, height: sh! } });
  // (tsx keeps function names with a __name helper, also in evaluated functions.)
  await ctx.addInitScript('window.__name = (f) => f');
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[pageerror] ${e}`));
  await page.goto(`${url}?test=1&seed=1`);
  await page.waitForFunction(() => (window as any).__hydro, null, { timeout: 120_000 });
  await setupView(page, v);
  await page.evaluate(instrument);
  if (shots) {
    await page.waitForTimeout(Number(opt('shot-wait', '1500')));
    await page.evaluate(() => ((document.getElementById('ui') as HTMLElement).style.visibility = 'hidden'));
    await page.waitForTimeout(500);
    await page.evaluate(() => ((window as any).__hydro.render.hold = true));
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${shots}/${name}.png`, timeout: 120_000 });
    await page.evaluate(() => {
      (window as any).__hydro.render.hold = false;
      (document.getElementById('ui') as HTMLElement).style.visibility = '';
    });
  }
  if (gpu) {
    await page.evaluate((s) => (window as any).__hydro.client.setSpeed(s), 0);
    await page.waitForTimeout(1000);
    console.log(`${name} GPU ms/frame (all, and saved by hiding each):`, JSON.stringify(await page.evaluate(gpuBreakdown)));
  }
  // Frame pacing only: drawing is stubbed out, so the frames/s show the scheduler's choice, not the GPU's speed.
  if (args.includes('--sched')) await page.evaluate(() => ((window as any).__hydro.renderer.gl.render = () => {}));
  if (args.includes('--calls')) console.log((await page.evaluate(callList)).join('\n'));
  for (const m of modes) {
    await page.evaluate((s) => (window as any).__hydro.client.setSpeed(s), m === 'active' ? 1 : 0);
    await page.waitForTimeout(3000);
    results.push(await measure(page, `${name}/${m}`));
  }
  await ctx.close();
}
await browser.close();
console.log('\n| view | frames/s | JS ms/frame | snap ms/s | calls | tris | page CPU | GPU CPU | GPU ms/frame |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const r of results as any[])
  console.log(`| ${r.label} | ${r.fps} | ${r.frameMs} | ${r.snapMsPerSec} | ${r.calls} | ${r.tris} | ${r.pageCpu} | ${r.gpuCpu} | ${r.gpuMsPerFrame} |`);
