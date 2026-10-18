import { expect, test, type Page } from '@playwright/test';
import { openGame, toScreen } from './helpers';

/** A dry, free spot near the start (nothing fixed or wet within 5 cells), with the camera on it. */
async function dryspot(page: Page): Promise<{ x: number; y: number }> {
  const p = await page.evaluate(() => {
    const h = (window as any).__hydro;
    const m = h.mirror;
    const depth: Float32Array = h.renderer.heights.depth;
    const W = m.width;
    const { startX, startY } = h.data.info;
    for (let r = 4; r < 40; r++)
      for (let k = 0; k < 16; k++) {
        const x = Math.round(startX + Math.cos((k / 16) * Math.PI * 2) * r);
        const y = Math.round(startY + Math.sin((k / 16) * Math.PI * 2) * r);
        let ok = true;
        for (let dy = -5; dy <= 5 && ok; dy++)
          for (let dx = -5; dx <= 5 && ok; dx++) {
            const i = (y + dy) * W + x + dx;
            if (m.isFixed(i) || depth[i]! > 0.01) ok = false;
          }
        if (ok) return { x, y };
      }
    return null;
  });
  expect(p).not.toBeNull();
  await page.evaluate(({ x, y }) => {
    const h = (window as any).__hydro;
    h.renderer.camera.focus(x, y);
    h.renderer.camera.setState({ viewHeight: 40 }, true);
  }, p!);
  await page.waitForTimeout(400);
  return p!;
}

const height = (page: Page, x: number, y: number) =>
  page.evaluate(([cx, cy]) => {
    const h = (window as any).__hydro;
    return h.mirror.terrainH[cy! * h.mirror.width + cx!] as number;
  }, [x, y]);

/** Wait until the sim has applied every stroke sent (the snapshot's sculptSeq), and one more snapshot. */
async function caughtUp(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const h = (window as any).__hydro;
    return (h.sculptor.pending as unknown[]).length === 0;
  });
  await page.waitForTimeout(300);
}

test('the Dig brush digs at once while held, stays selected, and Undo brings the ground back', async ({ page }, info) => {
  test.skip(info.project.name === 'phone', 'touch has its own test');
  const errors = await openGame(page);
  const s = await dryspot(page);
  const z0 = await height(page, s.x, s.y);
  await page.click('[data-tool=dig]');
  await expect(page.locator('.options .brushes')).toBeVisible();
  const [px, py] = await toScreen(page, s.x, s.y);
  await page.mouse.move(px, py);
  await page.mouse.down();
  // Held (paused game: the sim still applies it), with a little wiggle.
  for (let k = 0; k < 12; k++) {
    await page.mouse.move(px + (k % 2) * 2, py);
    await page.waitForTimeout(60);
  }
  await page.mouse.up();
  const predicted = await height(page, s.x, s.y);
  expect(predicted).toBeLessThan(z0 - 0.3);
  await caughtUp(page);
  // The sim's terrain agrees (the snapshot rows replaced the prediction).
  const z1 = await height(page, s.x, s.y);
  expect(z1).toBeLessThan(z0 - 0.3);
  await expect(page.locator('[data-tool=dig]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-testid=undo]')).toBeEnabled();
  // Ctrl+Z.
  await page.keyboard.press('Control+z');
  await page.waitForFunction(([x, y, z]) => {
    const h = (window as any).__hydro;
    return Math.abs(h.mirror.terrainH[y! * h.mirror.width + x!] - z!) < 0.01;
  }, [s.x, s.y, z0]);
  // The button: raise, then undo with a click.
  await page.click('[data-tool=raise]');
  await page.mouse.move(px, py);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.mouse.up();
  await caughtUp(page);
  expect(await height(page, s.x, s.y)).toBeGreaterThan(z0 + 0.2);
  await page.click('[data-testid=undo]');
  await page.waitForFunction(([x, y, z]) => {
    const h = (window as any).__hydro;
    return Math.abs(h.mirror.terrainH[y! * h.mirror.width + x!] - z!) < 0.01;
  }, [s.x, s.y, z0]);
  expect(errors).toEqual([]);
});

test('touch: one finger brushes, two fingers pan and zoom without brushing', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'phone only');
  const errors = await openGame(page);
  const s = await dryspot(page);
  const z0 = await height(page, s.x, s.y);
  await page.locator('[data-tool=dig]').tap();
  const [px, py] = await toScreen(page, s.x, s.y);
  const cdp = await page.context().newCDPSession(page);
  const pt = (x: number, y: number, id: number) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 });
  // Two fingers at once: a pinch, no digging.
  const cam0 = await page.evaluate(() => (window as any).__hydro.renderer.camera.getCurrentState().viewHeight);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt(px - 40, py, 1), pt(px + 40, py, 2)] });
  for (let k = 1; k <= 8; k++) {
    await page.waitForTimeout(40);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [pt(px - 40 - k * 10, py, 1), pt(px + 40 + k * 10, py, 2)] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(400);
  expect(Math.abs((await height(page, s.x, s.y)) - z0)).toBeLessThan(0.02);
  const cam1 = await page.evaluate(() => (window as any).__hydro.renderer.camera.getCurrentState().viewHeight);
  expect(cam1).not.toBeCloseTo(cam0, 1);
  // One finger held: it digs.
  const [qx, qy] = await toScreen(page, s.x, s.y);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt(qx, qy, 3)] });
  for (let k = 0; k < 10; k++) {
    await page.waitForTimeout(60);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [pt(qx + (k % 2), qy, 3)] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  await caughtUp(page);
  expect(await height(page, s.x, s.y)).toBeLessThan(z0 - 0.2);
  // Undo on the phone: the button.
  await page.locator('[data-testid=undo]').tap();
  await page.waitForFunction(([x, y, z]) => {
    const h = (window as any).__hydro;
    return Math.abs(h.mirror.terrainH[y! * h.mirror.width + x!] - z!) < 0.01;
  }, [s.x, s.y, z0]);
  expect(errors).toEqual([]);
});
