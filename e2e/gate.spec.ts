import { expect, test, type Page } from '@playwright/test';
import { findWeir, openGame, recordTexts, runDays, settleFrames, toScreen } from './helpers';

/**
 * The gate tool (DESIGN.md §4): while it is held, the cells of a raised
 * bank that hold water above lower ground are marked; a tap on one puts a
 * gate in (the crew builds it); a tap on flat ground shows a red ghost and
 * places nothing, with no text.
 */

const R = (page: Page, js: string) => page.evaluate((s) => new Function('h', `return ${s}`)((window as any).__hydro), js);

async function tap(page: Page, phone: boolean, p: [number, number]): Promise<void> {
  if (phone) await page.touchscreen.tap(p[0], p[1]);
  else {
    await page.mouse.move(p[0], p[1]);
    await page.mouse.down();
    await page.mouse.up();
  }
}

test('the gate tool marks the sites on a bank, taps a gate in, and refuses flat ground', async ({ page }, info) => {
  test.setTimeout(400_000);
  const phone = info.project.name === 'phone';
  const errors = await openGame(page, '&size=128&cheat=1', './?test=1&seed=3');
  // A bank heaped across the river: the water backs up behind it.
  const site = (await findWeir(page))!;
  expect(site).not.toBeNull();
  await page.evaluate(
    ([a, b]) => (window as any).__hydro.client.command({ type: 'shapeLine', tool: 'raise', points: [a, b], width: 2, amount: 2.5 }),
    [site.a, site.b],
  );
  await runDays(page, 1);
  await page.evaluate(([x, y, v]) => (window as any).__hydro.renderer.camera.setState({ x, y, viewHeight: v }, true), [site.x, site.y, phone ? 14 : 20]);
  await settleFrames(page, 5);

  if (phone) await page.locator('button[data-tool=gate]').tap();
  else await page.locator('button[data-tool=gate]').click();
  await expect(page.locator('.tools .hint')).toContainText('gold marks');
  // No width or height to set.
  await expect(page.locator('.tools .options input[data-k=size]')).toBeHidden();
  await expect(page.locator('.tools .options input[data-k=amount]')).toBeHidden();
  await expect.poll(() => R(page, 'h.renderer.gateSites.siteCount'), { timeout: 60_000 }).toBeGreaterThan(0);
  await settleFrames(page, 5);
  await page.screenshot({ path: info.outputPath(`gate-sites-${info.project.name}.png`) });

  // The site nearest the river's middle.
  const sites: { x: number; y: number }[] = await R(page, 'h.renderer.gateSites.sites');
  const best = sites.reduce((p, q) => (Math.hypot(q.x - site.x, q.y - site.y) < Math.hypot(p.x - site.x, p.y - site.y) ? q : p));
  const at = await toScreen(page, best.x, best.y);
  if (!phone) {
    // Hovering shows the ghost gate, good, along the bank.
    await page.mouse.move(at[0] + 2, at[1]);
    await page.mouse.move(at[0], at[1]);
    await expect.poll(() => R(page, 'h.renderer.gatePreview.ghostState?.ok'), { timeout: 30_000 }).toBe(true);
    await page.screenshot({ path: info.outputPath(`gate-ghost-${info.project.name}.png`) });
  }
  await tap(page, phone, at);
  const gates = () => R(page, 'h.renderer.structures.structures.filter((s) => s.kind === "gate")');
  await expect.poll(async () => (await gates()).length, { timeout: 30_000 }).toBe(1);
  const g = (await gates())[0];
  expect(g.width).toBe(1);
  expect(Math.hypot(g.x - best.x, g.y - best.y)).toBeLessThan(1.5);
  await expect(page.locator('button[data-tool=gate]')).toHaveAttribute('aria-pressed', 'true');

  // Flat dry ground: a red ghost, nothing placed, no text.
  const flat: [number, number] = await page.evaluate(([sx, sy]) => {
    const h = (window as any).__hydro;
    const depth: Float32Array = h.renderer.heights.depth;
    const m = h.mirror;
    const W = m.width;
    for (let r = 5; r < 30; r++)
      for (let k = 0; k < 24; k++) {
        const x = Math.round(sx + Math.cos(k / 3.8) * r);
        const y = Math.round(sy + Math.sin(k / 3.8) * r);
        let ok = m.isRevealed(x, y);
        for (let dy = -2; dy <= 2 && ok; dy++) for (let dx = -2; dx <= 2 && ok; dx++) ok = depth[(y + dy) * W + x + dx]! < 0.01 && !m.isWall((y + dy) * W + x + dx);
        if (ok) return [x, y] as [number, number];
      }
    return [sx, sy] as [number, number];
  }, [site.x, site.y]);
  const hint = await page.locator('.tools .hint').textContent();
  const hints = await recordTexts(page, '.tools .hint');
  await tap(page, phone, await toScreen(page, flat[0], flat[1]));
  await expect.poll(() => R(page, 'h.renderer.gatePreview.ghostState?.ok'), { timeout: 10_000 }).toBe(false);
  await page.waitForTimeout(800);
  expect((await hints()).every((t) => t === hint)).toBe(true);
  expect((await gates()).length).toBe(1);
  await expect(page.locator('button[data-tool=gate]')).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});
