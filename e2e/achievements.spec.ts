import { expect, test } from '@playwright/test';
import { openGame, recordTexts } from './helpers';

test('digging a canal earns First Spade: a toast, and the Achievements card lists it', async ({ page }) => {
  // A small world keeps the simulated day quick on slow CI machines.
  const errors = await openGame(page, '&size=128');
  // The toast stays only a few seconds: record it rather than race it.
  const toasts = await recordTexts(page, '[data-testid=achievement-toast][data-id=firstSpade]');
  // Dig a little canal by the start (at once) and let a day pass.
  await page.evaluate(async () => {
    const h = (window as any).__hydro;
    const { startX: x, startY: y } = h.data.info;
    h.client.command({ type: 'shapeLine', tool: 'dig', points: [[x - 6, y + 8], [x + 6, y + 8]], width: 2, amount: 1.5 });
    await h.client.runDays(1.2);
  });
  const toast = page.locator('[data-testid=achievement-toast][data-id=firstSpade]');
  await expect.poll(toasts, { timeout: 15_000 }).toContainEqual(expect.stringContaining('First Spade'));
  // The toasts go away on their own.
  await expect(toast).toBeHidden({ timeout: 15_000 });

  // The menu's Achievements card lists it as earned, with the others dimmed.
  await page.locator('.menu-button').click();
  await page.locator('.menu button', { hasText: 'Achievements' }).click();
  const card = page.locator('[data-testid=achievements]');
  await expect(card).toBeVisible();
  const item = card.locator('.ach-item[data-id=firstSpade]');
  await expect(item).not.toHaveClass(/locked/);
  await expect(item).toContainText('Year 1');
  await expect(card.locator('.ach-item.locked[data-id=decade]')).toBeVisible();
  await page.locator('[data-testid=achievements-close]').click();
  await expect(card).toBeHidden();

  // The history chart marks it with a medal.
  await page.locator('[data-testid=statsbar]').click();
  await expect(page.locator('[data-testid=history] .medal-mark').first()).toBeAttached();
  expect(errors).toEqual([]);
});
