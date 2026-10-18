import { expect, test } from '@playwright/test';
import { openGame, runDays } from './helpers';

test('stats bar is visible and opens the history chart, which closes again', async ({ page }) => {
  const errors = await openGame(page);
  const bar = page.locator('[data-testid=statsbar]');
  await expect(bar).toBeVisible();
  await runDays(page, 3);
  await bar.click();
  const panel = page.locator('[data-testid=history]');
  await expect(panel).toBeVisible();
  // The chart is drawn from the sim's daily history.
  await expect(panel.locator('.history-chart svg')).toBeVisible();
  // Milestone stars sit on the villagers' right-hand axis; tapping one names its tools.
  const star = panel.locator('.star').first();
  await expect(star).toBeVisible();
  await star.click();
  await expect(panel.locator('.history-readout')).toContainText('villagers');
  await expect(panel.locator('.history-readout')).toContainText('unlock');
  const days = await page.evaluate(async () => (await (window as any).__hydro.client.history()).samples.length);
  expect(days).toBeGreaterThanOrEqual(3);
  await page.locator('[data-testid=history-close]').click();
  await expect(panel).toBeHidden();
  // Escape closes it too.
  await bar.click();
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  expect(errors).toEqual([]);
});
