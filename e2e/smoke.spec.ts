import { expect, test } from '@playwright/test';
import { openGame, recordTexts, settleFrames } from './helpers';

test('loads, renders and has no console errors', async ({ page }) => {
  const errors = await openGame(page);
  await settleFrames(page);
  // The canvas shows something other than a flat colour.
  const shot = await page.locator('#view').screenshot();
  expect(shot.length).toBeGreaterThan(20_000);
  expect(errors).toEqual([]);
});

test('HUD shows the date and speed controls work', async ({ page }) => {
  await openGame(page);
  await expect(page.locator('[data-testid=date]')).toContainText('Spring');
  await page.locator('.speed button[data-speed="3"]').click();
  await expect(page.locator('.speed button[data-speed="3"]')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => (window as any).__hydro.client.getSpeed())).toBe(3);
});

test('brushing with Dig lowers the ground at once, and the brush stays selected', async ({ page }) => {
  // A small world keeps start-up quick on slow CI machines.
  await openGame(page, '&size=128');
  await page.locator('button[data-tool=dig]').click();
  const before = await page.evaluate(() => Float32Array.from((window as any).__hydro.mirror.terrainH));
  const box = (await page.locator('#view').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx - 80, cy);
  await page.mouse.down();
  for (let k = 1; k <= 16; k++) {
    await page.mouse.move(cx - 80 + k * 10, cy + k * 2);
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  // The sim confirms it in the next snapshots (the game is paused: no time needed).
  await page.waitForTimeout(500);
  const dug = await page.evaluate((b) => {
    const t: Float32Array = (window as any).__hydro.mirror.terrainH;
    let n = 0;
    for (let i = 0; i < t.length; i++) if (t[i]! < b[i]! - 0.05) n++;
    return n;
  }, Array.from(before));
  expect(dug).toBeGreaterThan(5);
  await expect(page.locator('button[data-tool=dig]')).toHaveAttribute('aria-pressed', 'true');
});

test('digit keys pick tools, Escape returns to Look', async ({ page }) => {
  await openGame(page);
  await page.keyboard.press('2');
  await expect(page.locator('button[data-tool=raise]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('button[data-tool=raise]')).toHaveAttribute('title', 'Raise (2)');
  await page.keyboard.press('Escape');
  await expect(page.locator('button[data-tool=look]')).toHaveAttribute('aria-pressed', 'true');
  // A locked tool (Weir, 6) only says when it unlocks, for a moment.
  const lookHint = await page.locator('.tools .hint').textContent();
  const hints = await recordTexts(page, '.tools .hint');
  await page.keyboard.press('6');
  await expect(page.locator('button[data-tool=look]')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(hints).toContainEqual(expect.stringContaining('Unlocks at'));
  await expect(page.locator('.tools .hint')).toHaveText(lookHint!, { timeout: 10_000 });
});

test('mouse wheel zooms and drag pans the camera', async ({ page }) => {
  await openGame(page);
  const state0 = await page.evaluate(() => JSON.stringify((window as any).__hydro.renderer.camera.getState()));
  const box = (await page.locator('#view').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -400);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 60, { steps: 6 });
  await page.mouse.up();
  await settleFrames(page, 5);
  const state1 = await page.evaluate(() => JSON.stringify((window as any).__hydro.renderer.camera.getState()));
  expect(state1).not.toEqual(state0);
});

test('tool hints say why; a tool card shows at unlock and again from the ⓘ', async ({ page }) => {
  await openGame(page, '&size=64&cards=1');
  await page.locator('button[data-tool=raise]').click();
  await expect(page.locator('.tools .hint')).toContainText('flood');
  await expect(page.locator('.tools .hint-info')).toBeHidden();
  // Reaching 15 villagers unlocks the gate: the next pick of a tool opens its card.
  await page.evaluate(() => (window as any).__hydro.tools.setPopulation(15));
  await page.locator('button[data-tool=gate]').click();
  await expect(page.locator('.tool-card')).toBeVisible();
  await expect(page.locator('.tool-card h2')).toHaveText('Gate');
  expect(await page.evaluate(() => (window as any).__hydro.client.getSpeed())).toBe(0);
  await page.locator('.tool-card .next').click();
  await expect(page.locator('.tool-card')).toBeHidden();
  // Shown once; the ⓘ on the hint line brings it back.
  await page.locator('button[data-tool=gate]').click();
  await expect(page.locator('.tool-card')).toBeHidden();
  await page.locator('.tools .hint-info').click();
  await expect(page.locator('.tool-card')).toBeVisible();
});
