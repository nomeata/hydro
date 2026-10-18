import { expect, test } from '@playwright/test';
import { openGame } from './helpers';

test('ideas for this valley: a flood by the village suggests a dike, with a dot on the menu and a Show me', async ({ page }, info) => {
  // A few simulated days: slow on CI machines.
  test.setTimeout(300_000);
  const errors = await openGame(page, '&size=128');
  // Wait for the first village, then flood its land and let a few days pass (ideas are looked for every two days).
  const spot = await page.evaluate(async () => {
    const h = (window as any).__hydro;
    for (let k = 0; k < 20 && !h.client.latest?.stats.village; k++) {
      await h.client.runDays(1);
      await new Promise((r) => setTimeout(r, 100));
    }
    const v = h.client.latest.stats.village;
    h.client.command({ type: 'debugWater', x: v.x, y: v.y + 4, radius: 7, depth: 1.2 });
    await h.client.runDays(5);
    await new Promise((r) => setTimeout(r, 400));
    return { x: v.x, y: v.y };
  });
  // No popup, only a dot on the menu button.
  await expect(page.locator('.menu-button')).toHaveClass(/news/);
  await expect(page.locator('[data-testid=achievements]')).toBeHidden();
  await page.locator('.menu-button').click();
  await expect(page.locator('.menu button', { hasText: 'Achievements' })).toHaveClass(/news/);
  await page.locator('.menu button', { hasText: 'Achievements' }).click();
  const card = page.locator('[data-testid=achievements]');
  const ideas = card.locator('[data-testid=ideas]');
  await expect(ideas).toBeVisible();
  await expect(ideas.locator('h3')).toHaveText('Ideas for this valley');
  const items = ideas.locator('.idea');
  expect(await items.count()).toBeLessThanOrEqual(3);
  const flood = ideas.locator('.idea[data-kind=flood]');
  await expect(flood).toContainText('a bank of raised earth could keep it dry');
  await expect(flood).toContainText('Towards Weathered the Storm');
  // Seen: the dot goes.
  await expect(page.locator('.menu-button')).not.toHaveClass(/news/);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `test-results/ideas-card-${info.project.name}.png`, animations: 'disabled' });

  // Show me: the card closes, the camera glides there and the spot is ringed for a moment.
  await flood.locator('[data-testid=idea-show]').click();
  await expect(card).toBeHidden();
  await expect(page.locator('[data-testid=area-highlight]')).toBeVisible();
  const goal = await page.evaluate(() => (window as any).__hydro.renderer.camera.getState());
  expect(Math.hypot(goal.x - spot.x, goal.y - spot.y)).toBeLessThan(25);
  await expect(page.locator('[data-testid=area-highlight]')).toBeHidden({ timeout: 20_000 });
  // The history chart (where a falling prosperity bar leads) shows the first idea too.
  await page.locator('[data-testid=statsbar]').click();
  await expect(page.locator('[data-testid=history-idea] .idea')).toBeVisible();
  await page.locator('[data-testid=history-idea] [data-testid=idea-show]').click();
  await expect(page.locator('[data-testid=history]')).toBeHidden();
  await expect(page.locator('[data-testid=area-highlight]')).toBeVisible();
  expect(errors).toEqual([]);
});
