import { expect, test } from '@playwright/test';
import { openGame, settleFrames } from './helpers';

const state = (page: import('@playwright/test').Page) => page.evaluate(() => (window as any).__hydro.sound.state as string);

test('sound starts at the first gesture, the menu mutes it (persisted), no errors', async ({ page: first, context }) => {
  test.setTimeout(300_000);
  let page = first;
  const errors = await openGame(page, '&sound=1');
  // Autoplay rules: nothing before a gesture.
  expect(await state(page)).toBe('none');
  await page.locator('#view').click({ position: { x: 200, y: 300 } });
  await expect.poll(() => state(page)).toBe('running');
  // The mixer ticks with the snapshots and plays the river and the land around it.
  await settleFrames(page, 20);

  await page.locator('.menu-button').click();
  const toggle = page.locator('[data-testid=sound-toggle]');
  await expect(toggle).toHaveText('Sound on');
  await toggle.click();
  await expect(toggle).toHaveText('Sound off');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('[data-testid=sound-volume]')).toBeDisabled();
  await expect.poll(() => state(page)).toBe('suspended');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('hydro.sound')!).muted)).toBe(true);

  // Muted in a new page of the same browser profile: a gesture starts nothing.
  await first.close();
  page = await context.newPage();
  errors.push(...(await openGame(page, '&sound=1')));
  await page.locator('#view').click({ position: { x: 200, y: 300 } });
  expect(await state(page)).toBe('none');
  await page.locator('.menu-button').click();
  const toggle2 = page.locator('[data-testid=sound-toggle]');
  await expect(toggle2).toHaveText('Sound off');
  // Unmuting is a gesture of its own: sound starts.
  await toggle2.click();
  await expect.poll(() => state(page)).toBe('running');
  await page.locator('[data-testid=sound-volume]').fill('30');
  expect(await page.evaluate(() => (window as any).__hydro.sound.volume)).toBeCloseTo(0.3);
  // UI sounds play without errors (a tool pick, a chime).
  await page.keyboard.press('Escape');
  await page.locator('button[data-tool=dig]').click();
  await page.evaluate(() => (window as any).__hydro.sound.ui('chime'));
  await settleFrames(page, 10);
  expect(errors).toEqual([]);
});

test('sound stays off in tests unless asked for', async ({ page }) => {
  const errors = await openGame(page);
  await page.locator('#view').click({ position: { x: 200, y: 300 } });
  expect(await state(page)).toBe('none');
  // The menu still shows the controls.
  await page.locator('.menu-button').click();
  await expect(page.locator('[data-testid=sound-toggle]')).toBeVisible();
  expect(errors).toEqual([]);
});
