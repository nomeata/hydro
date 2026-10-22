/**
 * Which way does the player's noria turn? Places a wheel by the start of a
 * seed-3 world (as e2e/wheel.spec.ts does), builds it, and screenshots it
 * close up in 3 frames, the wheel advanced by the renderer's own spin
 * direction between them, with the local current drawn as a blue arrow.
 *   npx tsx tools/shot-noria.ts [--url http://localhost:4233/] [--out out] [--yaw 0.6] [--step 0.12]
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1]! : d;
};
const url = opt('url', 'http://localhost:4233/');
const out = opt('out', 'out');
const yawOpt = opt('yaw', '');
const step = Number(opt('step', '0.12'));
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await (await browser.newContext({ viewport: { width: 1000, height: 750 } })).newPage();
// tsx wraps named closures in __name(); give the page one.
await page.addInitScript('window.__name = (f) => f');
page.on('pageerror', (e) => console.log(`[pageerror] ${e}`));
await page.goto(`${url}?test=1&seed=3&size=128&cheat=1`);
await page.waitForFunction(() => (window as any).__hydro, null, { timeout: 120_000 });
await page.waitForSelector('#loading.done', { state: 'attached', timeout: 120_000 });
const site = await page.evaluate(() => {
  const h = (window as any).__hydro;
  const m = h.mirror;
  const depth: Float32Array = h.renderer.heights.depth;
  const vel: Float32Array = h.renderer.flow.vel;
  const W = m.width;
  const { startX, startY } = h.data.info;
  let best: any = null;
  for (let y = 3; y < m.height - 3; y++)
    for (let x = 3; x < W - 3; x++) {
      const i = y * W + x;
      if (depth[i]! < 0.3 || Math.hypot(vel[2 * i]!, vel[2 * i + 1]!) < 0.6) continue;
      const surf = m.terrain(i) + depth[i]!;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]])
        for (const k of [1, 2]) {
          const hx = x + dx! * k;
          const hy = y + dy! * k;
          const j = hy * W + hx;
          if (depth[j]! >= 0.1) continue;
          const lift = m.terrain(j) - surf;
          const d = Math.hypot(x - startX, y - startY);
          // The bank across the current (as a player draws it).
          const sp = Math.hypot(vel[2 * i]!, vel[2 * i + 1]!);
          if (Math.abs(dx! * vel[2 * i]! + dy! * vel[2 * i + 1]!) > 0.3 * sp) break;
          if (lift > 0.5 && lift < 4.5 && (!best || d < best.d)) best = { x, y, hx, hy, d };
          break;
        }
    }
  return best;
});
console.log('site', JSON.stringify(site));
await page.evaluate((s) => (window as any).__hydro.client.command({ type: 'placeWheel', points: [[s.x, s.y], [s.hx, s.hy]] }), site);
await page.waitForFunction(() => (window as any).__hydro.renderer.structures.structures.some((s: any) => s.kind === 'wheel'), null, { timeout: 30_000 });
await page.evaluate(() => (window as any).__hydro.client.runDays(1));
await page.waitForFunction(() => (window as any).__hydro.renderer.structures.structures.find((s: any) => s.kind === 'wheel')?.progress === 1, null, { timeout: 60_000 });
await page.waitForTimeout(1500);
const info = await page.evaluate(
  ([yawOpt]) => {
    const r = (window as any).__hydro.renderer;
    const st = r.structures;
    const w = st.structures.find((s: any) => s.kind === 'wheel');
    const v: [number, number] = [0, 0];
    r.flow.velocityAt(w.x, w.y, v);
    // Look across the flow, from the far side of the river (the bank on the right or left).
    const yaw = yawOpt === '' ? 0.6 : Number(yawOpt);
    r.camera.limits.minViewHeight = 1;
    r.camera.setState({ x: w.x + 0.5, y: w.y + 0.5, viewHeight: 2.6, pitch: 0.25, yaw }, true);
    return { x: w.x, y: w.y, x2: w.x2, y2: w.y2, rot: w.rot, speed: w.speed, v, dir: st.spinDir.get(w.id) };
  },
  [yawOpt],
);
console.log('wheel', JSON.stringify(info));
// Freeze the wheel; step it by hand in the renderer's own direction.
// Let the renderer turn it a moment at 1× (as in play), then freeze it.
const turn = await page.evaluate(() => {
  const st = (window as any).__hydro.renderer.structures;
  const w = st.structures.find((s: any) => s.kind === 'wheel');
  const piece = st.pieces.noria;
  const bottom = () => {
    const e = piece.mesh.instanceMatrix.array;
    // Instance 0 applied to the unit wheel's bottom (0, −0.5, 0).
    return [e[12] - 0.5 * e[4], e[14] - 0.5 * e[6]];
  };
  st.gameSpeed = 1;
  const a0 = st.spin.get(w.id) ?? 0;
  st.update(0.02);
  const b0 = bottom();
  st.update(0.02);
  const b1 = bottom();
  const a1 = st.spin.get(w.id);
  st.gameSpeed = 0;
  return { a0, a1, dir: st.spinDir.get(w.id), bottomMoves: [b1[0] - b0[0], b1[1] - b0[1]] };
});
console.log('turn', JSON.stringify(turn), 'bottom·current =', turn.bottomMoves[0] * info.v[0] + turn.bottomMoves[1] * info.v[1]);
info.dir = turn.dir;
const base = turn.a1;
for (let k = 0; k < 3; k++) {
  await page.evaluate(
    ([a, info]: any) => {
      const h = (window as any).__hydro;
      const r = h.renderer;
      const st = r.structures;
      const w = st.structures.find((s: any) => s.kind === 'wheel');
      st.gameSpeed = 0;
      st.spin.set(w.id, a);
      st.layoutNorias();
      // The current as an arrow (DOM overlay), drawn just upstream → downstream of the wheel, on the water.
      const cam = r.camera.camera;
      cam.updateMatrixWorld();
      const proj = (cx: number, cy: number, yy: number) => {
        const p = { x: cx + 0.5, y: yy, z: cy + 0.5 };
        const e1 = cam.matrixWorldInverse.elements;
        const e2 = cam.projectionMatrix.elements;
        const mul = (e: number[], q: any) => {
          const ww = e[3]! * q.x + e[7]! * q.y + e[11]! * q.z + e[15]!;
          return { x: (e[0]! * q.x + e[4]! * q.y + e[8]! * q.z + e[12]!) / ww, y: (e[1]! * q.x + e[5]! * q.y + e[9]! * q.z + e[13]!) / ww, z: 0 };
        };
        const n = mul(e2, mul(e1, p));
        const rect = (document.querySelector('#view') as HTMLElement).getBoundingClientRect();
        return [rect.left + ((n.x + 1) / 2) * rect.width, rect.top + ((1 - n.y) / 2) * rect.height];
      };
      const y0 = (r.heights.terrainAt(w.x, w.y) + r.heights.depthAt(w.x, w.y)) / 5 * 2 + 0.02;
      const s = Math.hypot(info.v[0], info.v[1]);
      const ux = info.v[0] / s;
      const uy = info.v[1] / s;
      // Offset to the river side of the wheel (away from the trough) so the arrow is not hidden.
      const ox = -Math.cos(w.rot) * 0.7;
      const oy = -Math.sin(w.rot) * 0.7;
      const a0 = proj(w.x + ox - ux * 1.2, w.y + oy - uy * 1.2, y0);
      const a1 = proj(w.x + ox + ux * 1.2, w.y + oy + uy * 1.2, y0);
      let svg: any = document.getElementById('noria-arrow');
      if (!svg) {
        svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.id = 'noria-arrow';
        svg.setAttribute('style', 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:99');
        document.body.appendChild(svg);
      }
      svg.innerHTML = `<defs><marker id="ah" markerWidth="8" markerHeight="8" refX="5" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#06c"/></marker></defs>
        <line x1="${a0[0]}" y1="${a0[1]}" x2="${a1[0]}" y2="${a1[1]}" stroke="#06c" stroke-width="5" marker-end="url(#ah)"/>
        <text x="20" y="40" font-size="22" fill="#000" style="font-family:sans-serif">frame, spin angle ${a.toFixed(2)} rad (blue: current)</text>`;
    },
    [base + k * step * (info.dir ?? 1), info],
  );
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const path = `${out}/noria-${k}.png`;
  await page.screenshot({ path });
  console.log(`wrote ${path}`);
}
await browser.close();
