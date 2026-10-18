import { expect, test, type Page } from '@playwright/test';
import { findWeir, openGame, runDays, settleFrames, toScreen } from './helpers';

/**
 * Tools stay selected (after a placement or a tap that placed nothing,
 * until Escape or Look), and show what they would make before it is made:
 * ghost poles and wires, the gate's hover ghost, a red wheel off its sites;
 * the brushes tint the fields they would bury, the ground a stroke raised
 * or dug, and flash an undone stroke (ui/tools.ts).
 */

const pressed = (page: Page, sel: string) => expect(page.locator(sel)).toHaveAttribute('aria-pressed', 'true');

async function pick(page: Page, phone: boolean, sel: string): Promise<void> {
  if (phone) await page.locator(sel).tap();
  else await page.locator(sel).click();
}

/** Press, move through `pts`, and (unless `hold`) let go; returns a function that lets go. */
async function stroke(page: Page, phone: boolean, pts: [number, number][], hold = false): Promise<() => Promise<void>> {
  if (phone) {
    const cdp = await page.context().newCDPSession(page);
    const at = (p: [number, number]) => [{ x: p[0], y: p[1], id: 1, radiusX: 4, radiusY: 4, force: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(pts[0]!) });
    for (const p of pts.slice(1)) {
      await page.waitForTimeout(40);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(p) });
    }
    const end = async () => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    };
    if (!hold) await end();
    return end;
  }
  await page.mouse.move(pts[0]![0], pts[0]![1]);
  await page.mouse.down();
  for (const p of pts.slice(1)) await page.mouse.move(p[0], p[1]);
  const end = () => page.mouse.up();
  if (!hold) await end();
  return end;
}

const line = (a: [number, number], b: [number, number], n = 10): [number, number][] =>
  Array.from({ length: n + 1 }, (_, k) => [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);

test('tools stay selected; power lines, gates and wheels show their ghosts first', async ({ page }, info) => {
  test.setTimeout(500_000);
  const phone = info.project.name === 'phone';
  const errors = await openGame(page, '&size=128&cheat=1', './?test=1&seed=3');
  const R = (js: string) => page.evaluate((s) => new Function('h', `return ${s}`)((window as any).__hydro), js);
  const { startX, startY } = await page.evaluate(() => (window as any).__hydro.data.info);
  await page.evaluate(([x, y]) => (window as any).__hydro.renderer.camera.setState({ x, y, viewHeight: 30 }, true), [startX, startY]);
  await settleFrames(page, 3);

  // A turbine tapped on flat ground places nothing: the tool and its mode stay.
  await pick(page, phone, 'button[data-tool=power]');
  await pick(page, phone, '.modes button[data-mode=pump]');
  await pick(page, phone, '.modes button[data-mode=turbine]');
  const flat = await toScreen(page, startX + 2, startY + 2);
  await stroke(page, phone, [flat]);
  await page.waitForTimeout(300);
  await pressed(page, 'button[data-tool=power]');
  await pressed(page, '.modes button[data-mode=turbine]');

  // Drawing a power line: ghost poles and wires at once, before letting go; the mode stays after.
  await pick(page, phone, '.modes button[data-mode=poles]');
  const a = await toScreen(page, startX - 7, startY + 4);
  const b = await toScreen(page, startX + 7, startY + 4);
  const release = await stroke(page, phone, line(a, b), true);
  await expect.poll(() => R('h.renderer.powerGhost.state?.poles.length ?? 0'), { timeout: 60_000 }).toBeGreaterThan(1);
  expect(await R('h.renderer.powerGhost.state.wires.length')).toBeGreaterThan(0);
  await release();
  await expect.poll(() => R('h.renderer.power.state?.poles.length ?? 0'), { timeout: 60_000 }).toBeGreaterThan(1);
  expect(await R('h.renderer.powerGhost.state.poles.length')).toBe(0);
  await pressed(page, '.modes button[data-mode=poles]');
  // Escape goes back to looking around.
  await page.keyboard.press('Escape');
  await pressed(page, 'button[data-tool=look]');

  // A weir drawn with the weir tool: a ghost wall while drawing; the tool stays.
  const site = (await findWeir(page))!;
  await page.evaluate(([x, y]) => (window as any).__hydro.renderer.camera.setState({ x, y, viewHeight: 18 }, true), [site.x, site.y]);
  await settleFrames(page, 3);
  await pick(page, phone, 'button[data-tool=weir]');
  const wa = await toScreen(page, site.a[0], site.a[1]);
  const wb = await toScreen(page, site.b[0], site.b[1]);
  const let_go = await stroke(page, phone, line(wa, wb, 8), true);
  await expect.poll(() => R('h.renderer.weirGhost.structures.length'), { timeout: 60_000 }).toBe(1);
  await let_go();
  await expect.poll(() => R('h.renderer.structures.structures.filter((s) => s.kind === "weir").length'), { timeout: 60_000 }).toBe(1);
  await pressed(page, 'button[data-tool=weir]');
  // While the crew builds it, it stands as a ghost.
  await expect.poll(() => R('h.renderer.buildGhost.structures.length'), { timeout: 60_000 }).toBe(1);
  await runDays(page, 2);

  // The gate's hover ghost (a mouse hovers; a phone has no hover).
  const w = await R('h.renderer.structures.structures.find((s) => s.kind === "weir")');
  const mid = await toScreen(page, Math.round((w.x + w.x2) / 2), Math.round((w.y + w.y2) / 2));
  await pick(page, phone, 'button[data-tool=gate]');
  if (!phone) {
    await page.mouse.move(mid[0] + 3, mid[1]);
    await page.mouse.move(mid[0], mid[1]);
    await expect.poll(() => R('h.renderer.gatePreview.ghost'), { timeout: 60_000 }).not.toBeNull();
  }

  // A wheel dragged from dry land: the red ghost shows, also after letting go; the tool stays.
  await pick(page, phone, 'button[data-tool=wheel]');
  await expect.poll(() => R('h.renderer.wheelPreview.siteCount'), { timeout: 60_000 }).toBeGreaterThan(0);
  const dry = await page.evaluate(([x, y]) => {
    const h = (window as any).__hydro;
    const depth: Float32Array = h.renderer.heights.depth;
    const W = h.mirror.width;
    for (let r = 4; r < 20; r++) for (let k = 0; k < 16; k++) {
      const cx = Math.round(x + Math.cos(k / 2.5) * r);
      const cy = Math.round(y + Math.sin(k / 2.5) * r);
      if (depth[cy * W + cx]! < 0.01 && depth[cy * W + cx + 1]! < 0.01 && h.mirror.isRevealed(cx, cy)) return [cx, cy];
    }
    return null;
  }, [site.x, site.y]);
  const d0 = await toScreen(page, dry![0], dry![1]);
  const d1 = await toScreen(page, dry![0] + 3, dry![1]);
  await stroke(page, phone, line(d0, d1, 4));
  const ghost = await R('h.renderer.wheelPreview.ghostState');
  expect(ghost).not.toBeNull();
  expect(ghost.ok).toBe(false);
  await pressed(page, 'button[data-tool=wheel]');
  expect(await R('h.renderer.structures.structures.filter((s) => s.kind === "wheel").length')).toBe(0);
  expect(errors).toEqual([]);
});

test('brushes: distinct cursors, the fields under them tinted, the stroke tinted, an undo flashes', async ({ page }, info) => {
  test.setTimeout(400_000);
  const phone = info.project.name === 'phone';
  const errors = await openGame(page, '&cheat=1');
  const R = (js: string) => page.evaluate((s) => new Function('h', `return ${s}`)((window as any).__hydro), js);
  const field = await page.evaluate(() => {
    const h = (window as any).__hydro;
    const m = h.mirror;
    const W = m.width;
    const { startX, startY } = h.data.info;
    let best: { x: number; y: number; d: number } | null = null;
    for (let y = 0; y < m.height; y++)
      for (let x = 0; x < W; x++)
        if (m.landuse[y * W + x] === 1) {
          const d = Math.hypot(x - startX, y - startY);
          if (!best || d < best.d) best = { x, y, d };
        }
    return best;
  });
  expect(field).not.toBeNull();
  await page.evaluate(([x, y]) => (window as any).__hydro.renderer.camera.setState({ x, y, viewHeight: 24 }, true), [field!.x, field!.y]);
  await settleFrames(page, 3);
  const at = await toScreen(page, field!.x, field!.y);
  await pick(page, phone, 'button[data-tool=raise]');
  // Held over the field (a touch shows the ring once the brush bites).
  const release = await stroke(page, phone, [at, [at[0] + 2, at[1]], [at[0] + 4, at[1]]], true);
  await page.waitForTimeout(500);
  await expect.poll(() => R('h.renderer.brushCursor.shown?.tool'), { timeout: 60_000 }).toBe('raise');
  expect(await R('h.renderer.cellTint.count("fields")')).toBeGreaterThan(0);
  expect(await R('h.renderer.brushCursor.shown.contours')).toBeGreaterThan(0);
  await expect.poll(() => R('h.renderer.cellTint.count("stroke")'), { timeout: 60_000 }).toBeGreaterThan(0);
  await release();
  // It says the crop there is lost.
  await expect(page.locator('.tools .hint')).toContainText('fields', { timeout: 30_000 });
  await pressed(page, 'button[data-tool=raise]');
  // Undo: the stroke's ground flashes as it goes back.
  await pick(page, phone, '[data-testid=undo]');
  await expect.poll(() => R('h.renderer.cellTint.count("undo")'), { timeout: 60_000 }).toBeGreaterThan(0);
  await expect(page.locator('.tools .hint')).toContainText('Undone');
  // Dig's cursor is its own.
  await pick(page, phone, 'button[data-tool=dig]');
  if (!phone) {
    await page.mouse.move(at[0] + 30, at[1]);
    await page.mouse.move(at[0] + 32, at[1]);
    await expect.poll(() => R('h.renderer.brushCursor.shown?.tool'), { timeout: 60_000 }).toBe('dig');
  }
  expect(errors).toEqual([]);
});
