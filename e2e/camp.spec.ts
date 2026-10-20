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

test('a founding party walks to its new village with an ox and a loaded cart', async ({ page }, info) => {
  test.setTimeout(300_000);
  const errors = await openGame(page, '&size=128', './?test=1&seed=3');
  const cart = await page.evaluate(async () => {
    const h = (window as any).__hydro;
    await h.client.runDays(4);
    h.client.command({ type: 'debugVillage', index: 0, emigrate: 3 });
    await h.client.runDays(0.15);
    await new Promise((r) => setTimeout(r, 800));
    const ts = [...h.crowd.tracks.tracks.values()].filter((t: any) => t.kind === 7 && t.carry > 0);
    return ts.length ? { x: ts[0].x, y: ts[0].y, villages: h.client.latest?.stats.villages?.length ?? 0 } : null;
  });
  expect(cart).not.toBeNull();
  expect(cart!.villages).toBe(2);
  await page.evaluate(([cx, cy]) => (window as any).__hydro.renderer.camera.setState({ x: cx, y: cy, viewHeight: 8 }, true), [cart!.x, cart!.y]);
  await settleFrames(page, 20);
  await page.screenshot({ path: `test-results/caravan-${info.project.name}.png`, animations: 'disabled' });
  expect(errors).toEqual([]);
});
