import { expect, test, type Page } from '@playwright/test';
import { openGame, recordTexts, runDays, settleFrames } from './helpers';

/**
 * A spot for a weir near the start: a known river cell flowing at ≥ 0.4 m/s,
 * and the line across the flow through it, out to dry land on both sides.
 */
async function findWeir(page: Page): Promise<{ x: number; y: number; a: [number, number]; b: [number, number] } | null> {
  return page.evaluate(() => {
    const h = (window as any).__hydro;
    const m = h.mirror;
    const depth: Float32Array = h.renderer.heights.depth;
    const vel: Float32Array = h.renderer.flow.vel;
    const W = m.width;
    const { startX, startY } = h.data.info;
    let best: { x: number; y: number; a: [number, number]; b: [number, number]; d: number } | null = null;
    for (let y = 8; y < m.height - 8; y++)
      for (let x = 8; x < W - 8; x++) {
        const i = y * W + x;
        const vx = vel[2 * i]!;
        const vy = vel[2 * i + 1]!;
        const sp = Math.hypot(vx, vy);
        if (depth[i]! < 0.3 || sp < 0.4 || !m.isRevealed(x, y)) continue;
        // Across the flow: out to the first dry cell on each side.
        const ends: [number, number][] = [];
        for (const s of [-1, 1]) {
          let e: [number, number] | null = null;
          for (let k = 1; k <= 7; k++) {
            const px = Math.round(x - (vy / sp) * k * s);
            const py = Math.round(y + (vx / sp) * k * s);
            if (!m.isRevealed(px, py)) break;
            if (depth[py * W + px]! < 0.05) {
              e = [x - (vy / sp) * (k + 1) * s, y + (vx / sp) * (k + 1) * s];
              break;
            }
          }
          if (e) ends.push(e);
        }
        if (ends.length < 2) continue;
        const d = Math.hypot(x - startX, y - startY);
        if (d > 6 && (!best || d < best.d)) best = { x, y, a: ends[0]!, b: ends[1]!, d };
      }
    return best;
  });
}

/** Screen position (page pixels) of cell (x, y) on the terrain. */
async function toScreen(page: Page, x: number, y: number): Promise<[number, number]> {
  return page.evaluate(
    ([cx, cy]) => {
      const h = (window as any).__hydro;
      const r = h.renderer;
      const cam = r.camera.camera;
      cam.updateMatrixWorld();
      const v = { x: cx! + 0.5, y: (r.heights.terrainAt(cx, cy) / 5) * 2, z: cy! + 0.5 };
      const mul = (e: number[], p: { x: number; y: number; z: number }) => {
        const w = e[3]! * p.x + e[7]! * p.y + e[11]! * p.z + e[15]!;
        return {
          x: (e[0]! * p.x + e[4]! * p.y + e[8]! * p.z + e[12]!) / w,
          y: (e[1]! * p.x + e[5]! * p.y + e[9]! * p.z + e[13]!) / w,
          z: (e[2]! * p.x + e[6]! * p.y + e[10]! * p.z + e[14]!) / w,
        };
      };
      const p = mul(cam.projectionMatrix.elements, mul(cam.matrixWorldInverse.elements, v));
      const rect = (document.querySelector('#view') as HTMLElement).getBoundingClientRect();
      return [rect.left + ((p.x + 1) / 2) * rect.width, rect.top + ((1 - p.y) / 2) * rect.height] as [number, number];
    },
    [x, y],
  );
}

const power = (page: Page) => page.evaluate(() => (window as any).__hydro.renderer.power.state);

test('the turbine: tapped onto a weir, built, and making power from the water falling through it', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = await openGame(page, '&size=128&cheat=1', './?test=1&seed=3');
  const site = await findWeir(page);
  expect(site).not.toBeNull();
  const { x, y, a, b } = site!;
  // A weir across the river (as the weir tool would), built by the crew.
  await page.evaluate(([pa, pb]) => (window as any).__hydro.client.command({ type: 'planWeir', points: [pa, pb], width: 2, height: 2 }), [a, b]);
  await runDays(page, 2);
  await page.evaluate(([cx, cy]) => (window as any).__hydro.renderer.camera.setState({ x: cx, y: cy, viewHeight: 10 }, true), [x, y]);
  await settleFrames(page);

  await page.locator('button[data-tool=power]').click();
  await expect(page.locator('button[data-tool=power]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.tools .hint')).toContainText('crest of a weir');
  const hints = await recordTexts(page, '.tools .hint');
  const p = await toScreen(page, x, y);
  await page.mouse.move(p[0], p[1]);
  await page.mouse.down();
  await page.mouse.up();
  // The tap shows the head before it places the turbine.
  await expect.poll(hints).toContainEqual(expect.stringMatching(/head|No head/));
  await expect.poll(async () => (await power(page))?.turbines.length ?? 0, { timeout: 15_000 }).toBe(1);
  await runDays(page, 2);
  await expect.poll(async () => (await power(page))?.turbines[0].progress, { timeout: 30_000 }).toBe(1);
  // The pool fills up to the crest, then the turbine runs with the river.
  for (let d = 0; d < 6 && (await power(page)).turbines[0].power <= 1000; d++) await runDays(page, 1);
  const t = (await power(page)).turbines[0];
  expect(Math.hypot(t.x - x, t.y - y)).toBeLessThan(2.5);
  // The water falls through it: flow and power.
  expect(Math.abs(t.flow)).toBeGreaterThan(0);
  expect(t.power).toBeGreaterThan(1000);
  const stats = await page.evaluate(() => (window as any).__hydro.client.latest.stats.power);
  expect(stats.produced).toBeGreaterThan(1000);
  expect(errors).toEqual([]);
});

test('a turbine tapped on flat ground is refused with a reason', async ({ page }) => {
  await openGame(page, '&size=128&cheat=1');
  await page.locator('button[data-tool=power]').click();
  const { startX, startY } = await page.evaluate(() => (window as any).__hydro.data.info);
  const q = await toScreen(page, startX + 2, startY + 2);
  const hints = await recordTexts(page, '.tools .hint');
  await page.mouse.move(q[0], q[1]);
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(hints).toContainEqual(expect.stringContaining('Tap the crest'));
  await page.waitForTimeout(500);
  expect((await power(page))?.turbines.length ?? 0).toBe(0);
});
