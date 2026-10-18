import { expect, test } from '@playwright/test';
import { openGame, settleFrames } from './helpers';

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

test('drawing a trench creates a plan that gets built', async ({ page }) => {
  // A small world keeps the simulated days quick on slow CI machines.
  await openGame(page, '&size=128');
  await page.locator('button[data-tool=trench]').click();
  const box = (await page.locator('#view').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx - 80, cy);
  await page.mouse.down();
  for (let k = 1; k <= 16; k++) await page.mouse.move(cx - 80 + k * 10, cy + k * 2);
  await page.mouse.up();
  // The sim confirms the plan in the next snapshot.
  await page.waitForFunction(() => {
    const plan: Float32Array = (window as any).__hydro.mirror.plan;
    return plan.some((v) => !Number.isNaN(v));
  });
  // Builders finish it within a few days.
  await page.evaluate(() => (window as any).__hydro.client.runDays(2));
  await page.waitForFunction(() => {
    const plan: Float32Array = (window as any).__hydro.mirror.plan;
    return !plan.some((v) => !Number.isNaN(v));
  });
});

test('digit keys pick tools, Escape returns to Look', async ({ page }) => {
  await openGame(page);
  await page.keyboard.press('2');
  await expect(page.locator('button[data-tool=trench]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('button[data-tool=trench]')).toHaveAttribute('title', 'Trench (2)');
  await page.keyboard.press('Escape');
  await expect(page.locator('button[data-tool=look]')).toHaveAttribute('aria-pressed', 'true');
  // A locked tool (Gate, 6) only shows when it unlocks.
  await page.keyboard.press('6');
  await expect(page.locator('button[data-tool=look]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.tools .hint')).toContainText('Unlocks at');
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
  await page.locator('button[data-tool=dike]').click();
  await expect(page.locator('.tools .hint')).toContainText('flood');
  await expect(page.locator('.tools .hint-info')).toBeHidden();
  // Reaching 15 villagers unlocks the weir: the next pick of a tool opens its card.
  await page.evaluate(() => (window as any).__hydro.tools.setPopulation(15));
  await page.locator('button[data-tool=weir]').click();
  await expect(page.locator('.tool-card')).toBeVisible();
  await expect(page.locator('.tool-card h2')).toHaveText('Weir');
  expect(await page.evaluate(() => (window as any).__hydro.client.getSpeed())).toBe(0);
  await page.locator('.tool-card .next').click();
  await expect(page.locator('.tool-card')).toBeHidden();
  // Shown once; the ⓘ on the hint line brings it back.
  await page.locator('button[data-tool=weir]').click();
  await expect(page.locator('.tool-card')).toBeHidden();
  await page.locator('.tools .hint-info').click();
  await expect(page.locator('.tool-card')).toBeVisible();
});
