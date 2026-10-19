import { expect, test } from '@playwright/test';
import { openGame, runDays } from './helpers';

test('stats bar is visible and opens the history chart, which closes again', async ({ page }) => {
  const errors = await openGame(page);
  const bar = page.locator('[data-testid=statsbar]');
  await expect(bar).toBeVisible();
  // The population bar is just villagers; no tool icon on it.
  await expect(bar.locator('.pop .ico')).toHaveCount(2);
  await expect(bar.locator('.pop .ico svg')).toHaveCount(2);
  await runDays(page, 3);
  await bar.click();
  const panel = page.locator('[data-testid=history]');
  await expect(panel).toBeVisible();
  // The chart is drawn from the sim's daily history.
  await expect(panel.locator('.history-chart svg')).toBeVisible();
  // Milestone stars sit on the villagers' right-hand axis; tapping one names its tools.
  const star = panel.locator('.star').first();
  await expect(star).toBeVisible();
  // (The chart is redrawn every few seconds, replacing the star: click where
  // it is, and look again if a redraw swapped it out under us.)
  await expect(async () => {
    const box = await star.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect(panel.locator('.history-readout')).toContainText('villagers', { timeout: 2000 });
  }).toPass({ timeout: 30_000 });
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

test('the next locked tool shows its unlock progress on the palette and pulses at unlock', async ({ page }) => {
  const errors = await openGame(page, '&size=64');
  const weir = page.locator('.tools .toolrow button[data-tool=weir]');
  const gate = page.locator('.tools .toolrow button[data-tool=gate]');
  // Only the next tool (the Weir at 15) carries the ring; later ones are plainly locked.
  await expect(weir).toHaveClass(/locked/);
  await expect(weir).toHaveClass(/next/);
  await expect(weir.locator('.ring')).toBeVisible();
  await expect(weir.locator('.lock')).toBeVisible();
  await expect(gate).toHaveClass(/locked/);
  await expect(gate).not.toHaveClass(/next/);
  await expect(gate.locator('.ring')).toBeHidden();
  const progress = () => weir.evaluate((b) => Number((b as HTMLElement).style.getPropertyValue('--progress')));
  await page.evaluate(() => (window as any).__hydro.tools.setPopulation(10));
  // Log scale from 1 to 15: 10 villagers are most of the way.
  expect(await progress()).toBeCloseTo(Math.log(10) / Math.log(15), 2);
  // (Read the class right away: the pulse lasts only two seconds.)
  const cls = await page.evaluate(() => {
    (window as any).__hydro.tools.setPopulation(15);
    return document.querySelector('.tools .toolrow button[data-tool=weir]')!.className;
  });
  expect(cls).toContain('unlock-pulse');
  await expect(weir).not.toHaveClass(/\blocked\b/);
  await expect(gate).toHaveClass(/next/);
  await expect(page.locator('.tools .toolrow button.next')).toHaveCount(1);
  await expect(weir).not.toHaveClass(/unlock-pulse/, { timeout: 8000 });
  expect(errors).toEqual([]);
});
