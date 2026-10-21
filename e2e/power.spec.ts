import { expect, test, type Page } from '@playwright/test';
import { findWeir, openGame, recordTexts, runDays, settleFrames, toScreen } from './helpers';

const power = (page: Page) => page.evaluate(() => (window as any).__hydro.renderer.power.state);

test('the turbine: tapped onto a weir, built, and making power from the water falling through it', async ({ page }) => {
  test.setTimeout(420_000);
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
  await expect.poll(hints, { timeout: 60_000 }).toContainEqual(expect.stringMatching(/head|No head/));
  await expect.poll(async () => (await power(page))?.turbines.length ?? 0, { timeout: 15_000 }).toBe(1);
  // The tool stays selected after placing.
  await expect(page.locator('button[data-tool=power]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.modes button[data-mode=turbine]')).toHaveAttribute('aria-pressed', 'true');
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
  // Its runner turns.
  await settleFrames(page, 2);
  expect((await page.evaluate(() => (window as any).__hydro.renderer.power.runnerSpeeds))[0].speed).toBeGreaterThan(0);
  // Selected (Look mode, a tap), it shows its head and power.
  await page.keyboard.press('Escape');
  await expect(page.locator('button[data-tool=look]')).toHaveAttribute('aria-pressed', 'true');
  const tp = await toScreen(page, t.x, t.y);
  await page.mouse.click(tp[0], tp[1]);
  const readout = page.locator('[data-testid=power-readout]');
  await expect(readout).toBeVisible({ timeout: 15_000 });
  await expect(readout).toContainText('kW');
  await expect(readout).toContainText('m of head');
  await expect(readout).toHaveClass(/running/);
  await page.keyboard.press('Escape');

  // The power tool has no pole mode: the villagers put the line up themselves.
  await page.locator('button[data-tool=power]').click();
  await expect(page.locator('.modes button')).toHaveCount(2);
  await expect(page.locator('.modes button[data-mode=poles]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  const { startX, startY } = await page.evaluate(() => (window as any).__hydro.data.info);
  const houses = await page.evaluate(() => (window as any).__hydro.renderer.buildingList.filter((b: any) => b.kind === 'house' && b.progress >= 1).length);
  expect(houses).toBeGreaterThan(0);
  // A few poles a day, from the turbine to the village, until its houses light up.
  for (let d = 0; d < 12 && ((await power(page)).lit.length ?? 0) < 2 * houses; d++) await runDays(page, 1);
  const st = await power(page);
  expect(st.poles.filter((p: any) => p.progress >= 1).length).toBeGreaterThan(1);
  expect(st.wires.length).toBeGreaterThan(0);
  expect(st.lit.length).toBeGreaterThan(0);
  // A pole stands near the village (the line came to it).
  expect(st.poles.some((p: any) => Math.hypot(p.x - startX, p.y - startY) <= 10)).toBe(true);
  await page.evaluate(([cx, cy]) => (window as any).__hydro.renderer.camera.setState({ x: cx, y: cy, viewHeight: 40 }, true), [(t.x + startX) / 2, (t.y + startY) / 2]);
  await settleFrames(page, 3);
  expect(await page.evaluate(() => (window as any).__hydro.renderer.power.litHouses)).toBeGreaterThan(0);
  // A pole selected shows the line it is on, and cannot be removed (it is the villagers').
  const pole = st.poles.find((p: any) => p.progress >= 1);
  await page.evaluate(([cx, cy]) => (window as any).__hydro.renderer.camera.setState({ x: cx, y: cy, viewHeight: 14 }, true), [pole.x, pole.y]);
  await settleFrames(page, 3);
  const pp = await toScreen(page, pole.x, pole.y);
  await page.mouse.click(pp[0], pp[1]);
  await expect(page.locator('[data-testid=selection]')).toContainText('Power pole', { timeout: 15_000 });
  await expect(page.locator('.sel-remove')).toBeHidden();
  expect(errors).toEqual([]);
});

test('a turbine tapped on flat ground is refused with a reason', async ({ page }) => {
  await openGame(page, '&size=128&cheat=1');
  await page.locator('button[data-tool=power]').click();
  await expect(page.locator('button[data-tool=power]')).toHaveAttribute('aria-pressed', 'true');
  await settleFrames(page, 3);
  const { startX, startY } = await page.evaluate(() => (window as any).__hydro.data.info);
  const q = await toScreen(page, startX + 2, startY + 2);
  const hints = await recordTexts(page, '.tools .hint');
  await page.mouse.move(q[0], q[1]);
  await page.mouse.down();
  await page.mouse.up();
  // (The first hover and tap can stall a slow CI machine's frames for seconds: the record keeps the
  // passing refusal, and the poll gives the tap time to be handled.)
  await expect.poll(hints, { timeout: 60_000 }).toContainEqual(expect.stringContaining('Tap the crest'));
  await page.waitForTimeout(500);
  expect((await power(page))?.turbines.length ?? 0).toBe(0);
});

test('the electric pump: drawn from the river up the bank, it lifts water on the turbine’s spare power', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = await openGame(page, '&size=128&cheat=1', './?test=1&seed=3');
  const site = await findWeir(page);
  expect(site).not.toBeNull();
  const { x, y, a, b } = site!;
  await page.evaluate(([pa, pb]) => (window as any).__hydro.client.command({ type: 'planWeir', points: [pa, pb], width: 2, height: 2 }), [a, b]);
  await runDays(page, 2);
  await page.evaluate(([cx, cy]) => (window as any).__hydro.client.command({ type: 'placeTurbine', points: [[cx, cy]] }), [x, y]);
  await runDays(page, 2);
  const t = (await power(page)).turbines[0];
  expect(t.progress).toBe(1);
  // From the water by the turbine to dry ground a few cells off, within the powerhouse's reach.
  const ends = await page.evaluate(([tx, ty]) => {
    const h = (window as any).__hydro;
    const m = h.mirror;
    const depth: Float32Array = h.renderer.heights.depth;
    const W = m.width;
    let wet: [number, number] | null = null;
    let dry: [number, number] | null = null;
    for (let r = 1; r <= 7 && (!wet || !dry); r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const i = (ty! + dy) * W + tx! + dx;
          if (!m.isRevealed(tx! + dx, ty! + dy)) continue;
          // (Right by the wall too: a pump there no longer stops the turbine.)
          if (!wet && depth[i]! > 0.4) wet = [tx! + dx, ty! + dy];
          // Up on the bank, above the water.
          if (wet && !dry && r >= 3 && Math.hypot(tx! + dx - wet[0], ty! + dy - wet[1]) >= 2.5 && depth[i]! < 0.01 && m.terrain(i) > m.terrain(wet[1] * W + wet[0]) + depth[wet[1] * W + wet[0]]! + 0.5) dry = [tx! + dx, ty! + dy];
        }
    return wet && dry ? [wet, dry] : null;
  }, [t.x, t.y]);
  expect(ends).not.toBeNull();
  const [from, to] = ends!;
  await page.evaluate(([cx, cy]) => (window as any).__hydro.renderer.camera.setState({ x: cx, y: cy, viewHeight: 16 }, true), [t.x, t.y]);
  await settleFrames(page);
  await page.locator('button[data-tool=power]').click();
  await page.locator('.modes button[data-mode=pump]').click();
  await expect(page.locator('.tools .hint')).toContainText('spare power');
  const p0 = await toScreen(page, from[0], from[1]);
  const p1 = await toScreen(page, to[0], to[1]);
  await page.mouse.move(p0[0], p0[1]);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) await page.mouse.move(p0[0] + ((p1[0] - p0[0]) * k) / 8, p0[1] + ((p1[1] - p0[1]) * k) / 8);
  // The ghost pump shows; the hint stays the tool's own (no live text).
  await expect.poll(() => page.evaluate(() => (window as any).__hydro.renderer.powerGhost.state?.pumps.length ?? 0)).toBe(1);
  await expect(page.locator('.tools .hint')).toContainText('spare power');
  await page.mouse.up();
  await expect.poll(async () => (await power(page))?.pumps.length ?? 0, { timeout: 15_000 }).toBe(1);
  // Still the pump.
  await expect(page.locator('.modes button[data-mode=pump]')).toHaveAttribute('aria-pressed', 'true');
  await runDays(page, 1);
  const pump = (await power(page)).pumps[0];
  expect(pump.progress).toBe(1);
  await expect.poll(async () => (await power(page)).pumps[0].flow, { timeout: 20_000 }).toBeGreaterThan(0);
  // The pump beside it does not stop the turbine.
  await runDays(page, 1);
  expect((await power(page)).turbines[0].power).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
