import { expect, test } from '@playwright/test';
import { openGame } from './helpers';

test('the world survives a reload', async ({ page }) => {
  // No seed in the URL, so the reload resumes the autosave (test mode defaults to seed 1).
  // A small world keeps start-up and the simulated half day quick on slow CI machines.
  test.setTimeout(240_000);
  await openGame(page, '', './?test=1&persist=1&size=128');
  await page.evaluate(async () => {
    const h = (window as any).__hydro;
    h.client.command({ type: 'shapeLine', tool: 'dig', points: [[50, 50], [70, 60]], width: 2, amount: 1 });
    await h.client.runDays(0.5);
    await h.autosave();
  });
  const before = await page.evaluate(() => (window as any).__hydro.client.stateHash());
  await page.reload();
  await page.waitForFunction(() => (window as any).__hydro !== undefined, null, { timeout: 90_000 });
  const after = await page.evaluate(() => (window as any).__hydro.client.stateHash());
  expect(after).toBe(before);
});
