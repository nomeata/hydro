import { expect, test, type Page } from '@playwright/test';
import { findWeir, openGame, runDays, settleFrames, toScreen, touchPath } from './helpers';

/**
 * Selecting and editing structures (ui/selection.ts, DESIGN.md §4): tap a
 * weir in Look mode, raise and lower its crest, drag an end out, take it
 * down; tap a pole and remove it. Mouse on the desktop project, real touch
 * (CDP) on the phone project.
 */

type Weir = { id: number; x: number; y: number; x2: number; y2: number; top: number; sill: number; progress: number };
const weirs = (page: Page): Promise<Weir[]> =>
  page.evaluate(() => (window as any).__hydro.renderer.structures.structures.filter((s: any) => s.kind === 'weir'));

async function tap(page: Page, phone: boolean, p: [number, number]): Promise<void> {
  if (phone) await touchPath(page, [p]);
  else await page.mouse.click(p[0], p[1]);
}

async function press(page: Page, phone: boolean, sel: string): Promise<void> {
  if (phone) await page.locator(sel).tap();
  else await page.locator(sel).click();
}

/** Drag from a to b in steps (mouse or touch). */
async function drag(page: Page, phone: boolean, a: [number, number], b: [number, number]): Promise<void> {
  const pts: [number, number][] = [];
  for (let k = 0; k <= 8; k++) pts.push([a[0] + ((b[0] - a[0]) * k) / 8, a[1] + ((b[1] - a[1]) * k) / 8]);
  if (phone) return touchPath(page, pts);
  await page.mouse.move(a[0], a[1]);
  await page.mouse.down();
  for (const p of pts.slice(1)) await page.mouse.move(p[0], p[1]);
  await page.mouse.up();
}

test('a weir is selected with a tap, its crest raised and lowered, an end dragged out, and removed', async ({ page }, info) => {
  test.setTimeout(400_000);
  const phone = info.project.name === 'phone';
  const errors = await openGame(page, '&size=128&cheat=1', './?test=1&seed=3');
  const site = await findWeir(page);
  expect(site).not.toBeNull();
  const { a, b } = site!;
  await page.evaluate(([pa, pb]) => (window as any).__hydro.client.command({ type: 'planWeir', points: [pa, pb], height: 1.5 }), [a, b]);
  await runDays(page, 3);
  await expect.poll(async () => (await weirs(page))[0]?.progress ?? 0, { timeout: 30_000 }).toBeGreaterThan(0.999);
  const w0 = (await weirs(page))[0]!;
  const mx = (w0.x + w0.x2) / 2;
  const my = (w0.y + w0.y2) / 2;
  await page.evaluate(([cx, cy, vh]) => (window as any).__hydro.renderer.camera.setState({ x: cx, y: cy, viewHeight: vh }, true), [mx, my, phone ? 16 : 14]);
  await settleFrames(page);

  // Look mode: a tap on the weir selects it.
  await expect(page.locator('button[data-tool=look]')).toHaveAttribute('aria-pressed', 'true');
  await tap(page, phone, await toScreen(page, Math.round(mx), Math.round(my)));
  const panel = page.locator('[data-testid=selection]');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Weir');
  await expect(panel.locator('.sel-crest output')).toHaveText('1.5 m');
  await expect(page.locator('.sel-handle').first()).toBeVisible();
  await settleFrames(page);
  await page.screenshot({ path: `test-results/weir-selected-${info.project.name}.png` });

  // + raises the crest a quarter metre; the crew rebuilds it.
  await press(page, phone, '.sel-raise');
  await expect.poll(async () => (await weirs(page))[0]!.top, { timeout: 15_000 }).toBeCloseTo(w0.top + 0.25, 2);
  await expect(panel.locator('.sel-crest output')).toHaveText('1.75 m');
  await press(page, phone, '.sel-lower');
  await press(page, phone, '.sel-lower');
  await expect.poll(async () => (await weirs(page))[0]!.top, { timeout: 15_000 }).toBeCloseTo(w0.top - 0.25, 2);
  await expect(panel.locator('.sel-crest output')).toHaveText('1.25 m');
  expect(await page.evaluate(() => (window as any).__hydro.client.latest.stats)).toBeTruthy();

  // Drag the far end two cells further out along the line.
  const len = Math.hypot(w0.x2 - w0.x, w0.y2 - w0.y);
  const ux = (w0.x2 - w0.x) / len;
  const uy = (w0.y2 - w0.y) / len;
  const handle = page.locator('.sel-handle[data-end="1"]');
  const box = (await handle.boundingBox())!;
  const from: [number, number] = [box.x + box.width / 2, box.y + box.height / 2];
  const to = await toScreen(page, Math.round(w0.x2 + ux * 2), Math.round(w0.y2 + uy * 2));
  await drag(page, phone, from, to);
  await expect
    .poll(async () => {
      const w = (await weirs(page))[0]!;
      return Math.hypot(w.x2 - w.x, w.y2 - w.y);
    }, { timeout: 15_000 })
    .toBeGreaterThan(len + 1);
  const w1 = (await weirs(page))[0]!;
  expect(w1.id).toBe(w0.id);
  expect(Math.hypot(w1.x - w0.x, w1.y - w0.y)).toBeLessThan(0.01);
  // The crew builds the longer weir.
  await runDays(page, 3);
  await settleFrames(page);
  await page.screenshot({ path: `test-results/weir-edited-${info.project.name}.png` });

  // Remove asks once, then takes it down.
  await expect(panel).toBeVisible();
  await press(page, phone, '.sel-remove');
  await expect(panel.locator('.sel-remove')).toHaveText('Remove?');
  await press(page, phone, '.sel-remove');
  await expect.poll(async () => (await weirs(page)).length, { timeout: 15_000 }).toBe(0);
  await expect(panel).toBeHidden();
  expect(errors).toEqual([]);
});

test('with the weir tool a tap on a weir selects it; a pole is selected and removed', async ({ page }, info) => {
  test.setTimeout(300_000);
  const phone = info.project.name === 'phone';
  const errors = await openGame(page, '&size=128&cheat=1', './?test=1&seed=3');
  const site = await findWeir(page);
  const { a, b } = site!;
  await page.evaluate(([pa, pb]) => (window as any).__hydro.client.command({ type: 'planWeir', points: [pa, pb], height: 1.5 }), [a, b]);
  await runDays(page, 1);
  await expect.poll(async () => (await weirs(page)).length).toBe(1);
  const w0 = (await weirs(page))[0]!;
  const mx = Math.round((w0.x + w0.x2) / 2);
  const my = Math.round((w0.y + w0.y2) / 2);
  await page.evaluate(([cx, cy]) => (window as any).__hydro.renderer.camera.setState({ x: cx, y: cy, viewHeight: 16 }, true), [mx, my]);
  await settleFrames(page);
  await press(page, phone, 'button[data-tool=weir]');
  // The weir tool has no width, only the crest height.
  await expect(page.locator('.options input[data-k=size]').locator('xpath=..')).toBeHidden();
  await expect(page.locator('.options [data-k=amountLabel]')).toHaveText('Height');
  await tap(page, phone, await toScreen(page, mx, my));
  await expect(page.locator('[data-testid=selection]')).toContainText('Weir');
  expect((await weirs(page)).length).toBe(1);
  // Back in Look mode.
  await expect(page.locator('button[data-tool=look]')).toHaveAttribute('aria-pressed', 'true');

  // A pole on dry land beside the start.
  const { startX, startY } = await page.evaluate(() => (window as any).__hydro.data.info);
  await page.evaluate(([x, y]) => (window as any).__hydro.client.command({ type: 'placePoles', points: [[x + 3, y + 3]] }), [startX, startY]);
  await expect.poll(async () => (await page.evaluate(() => (window as any).__hydro.renderer.power.state?.poles.length ?? 0))).toBe(1);
  const pole = await page.evaluate(() => (window as any).__hydro.renderer.power.state.poles[0]);
  await page.evaluate(([cx, cy]) => (window as any).__hydro.renderer.camera.setState({ x: cx, y: cy, viewHeight: 16 }, true), [pole.x, pole.y]);
  await settleFrames(page);
  await tap(page, phone, await toScreen(page, pole.x, pole.y));
  await expect(page.locator('[data-testid=selection]')).toContainText('Power pole');
  await expect(page.locator('.sel-crest')).toBeHidden();
  await press(page, phone, '.sel-remove');
  await press(page, phone, '.sel-remove');
  await expect.poll(async () => (await page.evaluate(() => (window as any).__hydro.renderer.power.state?.poles.length ?? 0))).toBe(0);
  // A tap on empty ground closes nothing open and selects nothing.
  await tap(page, phone, await toScreen(page, pole.x + 4, pole.y + 4));
  await expect(page.locator('[data-testid=selection]')).toBeHidden();
  expect(errors).toEqual([]);
});
