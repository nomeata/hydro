import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { openGame, recordTexts } from './helpers';

/** Distinct colours (quantised) in a screenshot: a blank canvas has one or two. */
async function colourCount(page: Page, selector: string): Promise<number> {
  const png = PNG.sync.read(await page.locator(selector).screenshot());
  const seen = new Set<number>();
  for (let i = 0; i < png.data.length; i += 4) seen.add(((png.data[i]! >> 4) << 8) | ((png.data[i + 1]! >> 4) << 4) | (png.data[i + 2]! >> 4));
  return seen.size;
}

test('welcome panels show live scenes, navigate, and clean up', async ({ page }) => {
  // Two workers and two renderers: slow on loaded CI runners.
  test.setTimeout(360_000);
  const errors = await openGame(page, '&size=64');
  const workers = () => page.evaluate(() => (window as any).__hydro.SimClient.live as number);
  expect(await workers()).toBe(1);

  await page.evaluate(() => (window as any).__hydro.showIntro());
  const intro = page.locator('.intro');
  await expect(intro).toBeVisible();
  await expect(intro.locator('h2')).toHaveText('Water shapes the land');
  // A second worker runs the scene; its first frames fade in over the drawing.
  expect(await workers()).toBe(2);
  await expect(page.locator('.intro-art.live-on')).toHaveCount(1, { timeout: 90_000 });
  // The live frames fade in over the drawing (a handful of colours); on CI's
  // software GL the first rendered frames can take a long while.
  try {
    await expect.poll(() => colourCount(page, '.intro-live'), { timeout: 90_000, intervals: [1000, 2000, 3000] }).toBeGreaterThan(20);
  } catch (e) {
    // Diagnose CI-only failures: keep a screenshot and the scene's state.
    await page.screenshot({ path: test.info().outputPath('intro-live.png') }).catch(() => {});
    const state = await page
      .evaluate(() => ({
        liveOn: document.querySelectorAll('.intro-art.live-on').length,
        canvases: document.querySelectorAll('canvas').length,
        live: document.querySelectorAll('.intro-live').length,
        workers: (window as any).__hydro.SimClient.live,
      }))
      .catch((err) => String(err));
    throw new Error(`${String(e)}\nstate: ${JSON.stringify(state)}\nconsole errors: ${JSON.stringify(errors)}`);
  }

  // Next: the same canvas switches to the next scene.
  await intro.locator('.next').click();
  await expect(intro.locator('h2')).toHaveText('You shape the water');
  await expect(intro).toHaveAttribute('data-page', '1');
  await expect(page.locator('.intro-art.live-on')).toHaveCount(1, { timeout: 60_000 });
  await expect(page.locator('.intro-tools')).toBeVisible();
  // The scripted hand draws a real trench: the scene's sim gets a plan.
  // (It is built within seconds, so look for the plan or the dug ground.)
  const t0 = await page.evaluate(() => {
    const m = (window as any).__hydro.intro.scenes.mirror;
    return m.terrainH[m.idx(58, 51)] as number;
  });
  await page.waitForFunction(
    (h0) => {
      const m = (window as any).__hydro.intro.scenes?.mirror;
      return !!m && (m.plan.some((v: number) => !Number.isNaN(v)) || m.terrainH[m.idx(58, 51)] < h0 - 0.5);
    },
    t0,
    { timeout: 60_000 },
  );
  expect(await page.locator('canvas').count()).toBe(2);

  await intro.locator('.next').click();
  await expect(intro.locator('h2')).toHaveText('People find their place');
  await expect(intro.locator('.next')).toHaveText('Let’s go!');

  // Skip closes the dialog and stops the scene's worker and canvas.
  await intro.locator('.skip').click();
  await expect(intro).toBeHidden();
  expect(await workers()).toBe(1);
  expect(await page.locator('canvas').count()).toBe(1);
  expect(errors).toEqual([]);
});

test('a first visit waits behind the welcome panels: no play, no toasts until they close', async ({ page }) => {
  test.setTimeout(240_000);
  // Not test mode: a fresh browser sees the intro (stats=1 shows the requested speed).
  await page.goto('./?seed=1&size=64&stats=1');
  const intro = page.locator('.intro');
  await expect(intro).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('#loading')).toHaveClass(/done/, { timeout: 90_000 });
  const stats = page.locator('div.stats');
  await expect(stats).toContainText('/ 0×', { timeout: 30_000 });
  await expect(page.locator('.speed button[data-speed="0"]')).toHaveAttribute('aria-pressed', 'true');
  await intro.locator('.skip').click();
  await expect(intro).toBeHidden();
  await expect(stats).toContainText('/ 1×', { timeout: 30_000 });
});

test('achievement toasts wait while the welcome panels are open', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await openGame(page, '&size=64');
  const toasts = await recordTexts(page, '[data-testid=achievement-toast]');
  await page.evaluate(() => (window as any).__hydro.showIntro());
  const intro = page.locator('.intro');
  await expect(intro).toBeVisible();
  // Earn First Spade behind the panels (runDays works even while paused).
  await page.evaluate(async () => {
    const h = (window as any).__hydro;
    const { startX: x, startY: y } = h.data.info;
    h.client.command({ type: 'shapeLine', tool: 'dig', points: [[x - 6, y + 8], [x + 6, y + 8]], width: 2, amount: 1.5 });
    await h.client.runDays(1.2);
  });
  await page.waitForFunction(() => (window as any).__hydro.achievements.list.some((e: { id: string }) => e.id === 'firstSpade'), null, { timeout: 30_000 });
  await page.waitForTimeout(1500);
  expect(await toasts()).toEqual([]);
  await intro.locator('.skip').click();
  await expect(intro).toBeHidden();
  await expect.poll(toasts, { timeout: 15_000 }).toContainEqual(expect.stringContaining('First Spade'));
  expect(errors).toEqual([]);
});
