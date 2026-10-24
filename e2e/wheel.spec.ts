import { expect, test, type Page } from '@playwright/test';
import { openGame, recordOnRelease, recordTexts, settleFrames } from './helpers';

/**
 * Find a water-wheel site near the start: a river cell (≥ 0.3 m deep,
 * flowing at ≥ 0.6 m/s) with a dry, known bank cell 1–2 cells away,
 * 0.5–4.5 m above the water.
 */
async function findSite(page: Page): Promise<{ x: number; y: number; hx: number; hy: number } | null> {
  return page.evaluate(() => {
    const h = (window as any).__hydro;
    const m = h.mirror;
    const depth: Float32Array = h.renderer.heights.depth;
    const vel: Float32Array = h.renderer.flow.vel;
    const W = m.width;
    const { startX, startY } = h.data.info;
    let best: { x: number; y: number; hx: number; hy: number; d: number } | null = null;
    for (let y = 3; y < m.height - 3; y++)
      for (let x = 3; x < W - 3; x++) {
        const i = y * W + x;
        if (depth[i]! < 0.3 || !m.isRevealed(x, y) || Math.hypot(vel[2 * i]!, vel[2 * i + 1]!) < 0.6) continue;
        const surf = m.terrain(i) + depth[i]!;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          for (const k of [1, 2]) {
            const hx = x + dx! * k;
            const hy = y + dy! * k;
            const j = hy * W + hx;
            if (!m.isRevealed(hx, hy)) break;
            if (depth[j]! >= 0.1) continue;
            const lift = m.terrain(j) - surf;
            const d = Math.hypot(x - startX, y - startY);
            if (lift > 0.5 && lift < 4.5 && (!best || d < best.d)) best = { x, y, hx, hy, d };
            break;
          }
        }
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

test('the water wheel: drawn from the river onto the bank, built, and turning with the current', async ({ page }) => {
  // A simulated game day on a 128² world is slow under SwiftShader on CI.
  test.setTimeout(300_000);
  // Seed 3 has a lively river by the start (seed 1's are slow and lake-like).
  const errors = await openGame(page, '&size=128&cheat=1', './?test=1&seed=3');
  const site = await findSite(page);
  expect(site).not.toBeNull();
  const { x, y, hx, hy } = site!;
  await page.evaluate(([cx, cy]) => (window as any).__hydro.renderer.camera.setState({ x: cx, y: cy, viewHeight: 10 }, true), [x, y]);
  await settleFrames(page);

  await page.locator('button[data-tool=wheel]').click();
  await expect(page.locator('button[data-tool=wheel]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.tools .hint')).toContainText('lifts the river');
  // The good sites are marked on the map while the tool is held.
  await expect.poll(() => page.evaluate(() => (window as any).__hydro.renderer.wheelPreview.siteCount)).toBeGreaterThan(0);
  const a = await toScreen(page, x, y);
  // To just past the head cell (on a phone the view is only a few cells wide).
  const len = Math.hypot(hx - x, hy - y);
  const b = await toScreen(page, hx + ((hx - x) / len) * 0.4, hy + ((hy - y) / len) * 0.4);
  await page.mouse.move(a[0], a[1]);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) await page.mouse.move(a[0] + ((b[0] - a[0]) * k) / 8, a[1] + ((b[1] - a[1]) * k) / 8);
  // The preview is a ghost wheel with its trough onto the bank, a good site (no text).
  const ghost = () => page.evaluate(() => (window as any).__hydro.renderer.wheelPreview.ghostState);
  await expect.poll(async () => (await ghost())?.ok).toBe(true);
  const g = (await ghost())!;
  await expect(page.locator('.tools .hint')).toContainText('lifts the river');
  await page.mouse.up();

  // The sim places the wheel; the crew builds it within a day.
  const wheel = () =>
    page.evaluate(() => (window as any).__hydro.renderer.structures.structures.find((s: any) => s.kind === 'wheel') ?? null);
  await expect.poll(wheel, { timeout: 15_000 }).not.toBeNull();
  await page.evaluate(() => (window as any).__hydro.client.runDays(1));
  await expect.poll(async () => (await wheel())?.progress, { timeout: 30_000 }).toBe(1);
  const w = await wheel();
  // Where the ghost stood (the head may move a cell with the point where the mouse was let go).
  expect([w.x, w.y]).toEqual([g.site.x, g.site.y]);
  expect(Math.max(Math.abs(w.x2 - g.site.hx), Math.abs(w.y2 - g.site.hy))).toBeLessThanOrEqual(1);
  expect(Math.hypot(w.x - x, w.y - y)).toBeLessThan(1.5);
  // In the current it turns, and water runs in its trough.
  expect(Math.abs(w.speed)).toBeGreaterThan(0);
  expect(w.flow).toBeGreaterThan(0);
  expect(w.open).toBe(true);
  expect(errors).toEqual([]);
});

test('a wheel drawn on dry land shows a red ghost and places nothing', async ({ page }) => {
  await openGame(page, '&size=128&cheat=1');
  await page.locator('button[data-tool=wheel]').click();
  const { startX, startY } = await page.evaluate(() => (window as any).__hydro.data.info);
  // The village's own ground (dry): no wheel appears.
  let dry: [number, number] = [startX, startY];
  dry = await page.evaluate(([sx, sy]) => {
    const h = (window as any).__hydro;
    const depth: Float32Array = h.renderer.heights.depth;
    const W = h.mirror.width;
    for (let r = 0; r < 20; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          let ok = true;
          for (let ey = -2; ey <= 2; ey++) for (let ex = -2; ex <= 2; ex++) if (depth[(sy! + dy + ey) * W + sx! + dx + ex]! > 0.05) ok = false;
          if (ok) return [sx! + dx, sy! + dy] as [number, number];
        }
    return [sx!, sy!] as [number, number];
  }, dry);
  const a = await toScreen(page, dry[0], dry[1]);
  await page.mouse.move(a[0], a[1]);
  await page.mouse.down();
  await page.mouse.move(a[0] + 30, a[1] + 10);
  await page.mouse.move(a[0] + 60, a[1] + 20);
  await expect.poll(() => page.evaluate(() => (window as any).__hydro.renderer.wheelPreview.ghostState?.ok)).toBe(false);
  const hints = await recordTexts(page, '.tools .hint');
  const released = await recordOnRelease(page, 'h.renderer.wheelPreview.ghostState?.ok');
  await page.mouse.up();
  // The red ghost stays a moment and says "not here" by itself (no text); the tool stays, ready for another try.
  await expect.poll(async () => (await released())?.value).toBe(false);
  await page.waitForTimeout(600);
  expect(await hints()).not.toContainEqual(expect.stringContaining('Start in the river'));
  await expect(page.locator('.tools .hint')).toContainText('lifts the river');
  await expect(page.locator('button[data-tool=wheel]')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => (window as any).__hydro.renderer.structures.structures.some((s: any) => s.kind === 'wheel'))).toBe(false);
});
