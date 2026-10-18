import { expect, test } from '@playwright/test';
import { openGame, settleFrames } from './helpers';

test('newcomers camp at the village edge (cart, tent, family), and ?stats=1 shows each village’s growth limit', async ({ page }, info) => {
  test.setTimeout(300_000);
  const errors = await openGame(page, '&size=128&stats=1');
  const camp = await page.evaluate(async () => {
    const h = (window as any).__hydro;
    for (let k = 0; k < 20 && !h.client.latest?.stats.village; k++) {
      await h.client.runDays(1);
      await new Promise((r) => setTimeout(r, 100));
    }
    h.client.command({ type: 'debugVillage', index: 0, camp: true });
    await h.client.runDays(1);
    await new Promise((r) => setTimeout(r, 400));
    return h.renderer.buildingList.find((b: any) => b.kind === 'camp') ?? null;
  });
  expect(camp).not.toBeNull();
  await expect(page.locator('div.stats')).toContainText(/v1: \d+ ppl, w [\d.]+, limit \w+/);
  await page.evaluate(([cx, cy]) => (window as any).__hydro.renderer.camera.setState({ x: cx, y: cy, viewHeight: 12 }, true), [camp.x, camp.y]);
  await settleFrames(page, 20);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `test-results/camp-${info.project.name}.png`, animations: 'disabled' });
  expect(errors).toEqual([]);
});
