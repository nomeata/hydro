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

/** Console warnings about the live scenes giving up (the drawings stay instead). */
function recordFallbacks(page: Page): string[] {
  const out: string[] = [];
  page.on('console', (m) => {
    const t = m.text();
    if (/unavailable|keeping the drawings|scene worker failed/i.test(t)) out.push(t);
  });
  return out;
}

/**
 * Wait until `art` (an .intro-art) shows its live scene, not the drawing: the
 * canvas is there and faded in, the drawing hidden. Fails at once if the
 * scenes fall back to the drawing (canvas removed or a fallback warning),
 * and only waits long for slow software GL.
 */
async function expectLive(page: Page, art: string, fallbacks: string[], timeout = 90_000): Promise<void> {
  await expect
    .poll(
      async () => {
        if (fallbacks.length) return `fallback: ${fallbacks.join(' | ')}`;
        return page.evaluate((sel) => {
          const a = document.querySelector(sel);
          if (!a) return 'no art';
          if (!a.querySelector('canvas.intro-live')) return 'fallback: no live canvas';
          return a.classList.contains('live') && a.classList.contains('live-on') ? 'live' : 'waiting';
        }, art);
      },
      { timeout, intervals: [500, 1000, 2000] },
    )
    .not.toMatch(/^(waiting|no art)$/);
  if (fallbacks.length) throw new Error(`live scene fell back to the drawing: ${fallbacks.join(' | ')}`);
  expect(await page.evaluate((sel) => (document.querySelector(sel)!.classList.contains('live') ? 'live' : 'not live'), art)).toBe('live');
  await expect(page.locator(`${art} canvas.intro-live`)).toBeVisible();
  await expect(page.locator(`${art} .intro-svg svg`)).toBeHidden();
}

test('welcome panels show live scenes, navigate, and clean up', async ({ page }) => {
  // Two workers and two renderers: slow on loaded CI runners.
  test.setTimeout(360_000);
  const fallbacks = recordFallbacks(page);
  const errors = await openGame(page, '&size=64');
  const workers = () => page.evaluate(() => (window as any).__hydro.SimClient.live as number);
  expect(await workers()).toBe(1);

  await page.evaluate(() => (window as any).__hydro.showIntro());
  const intro = page.locator('.intro');
  await expect(intro).toBeVisible();
  await expect(intro.locator('h2')).toHaveText('Water shapes the land');
  // A second worker runs the scene; its first frames fade in over the drawing.
  expect(await workers()).toBe(2);
  // The live scene, not the drawing (which shows only when the scenes cannot run).
  await expectLive(page, '.intro .intro-art', fallbacks);
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

  const t0 = await page.evaluate(() => {
    const m = (window as any).__hydro.intro.scenes.mirror;
    return m.terrainH[m.idx(58, 51)] as number;
  });
  // Next: the same canvas switches to the next scene.
  await intro.locator('.next').click();
  await expect(intro.locator('h2')).toHaveText('You shape the water');
  await expect(intro).toHaveAttribute('data-page', '1');
  await expectLive(page, '.intro .intro-art', fallbacks, 60_000);
  await expect(page.locator('.intro-tools')).toBeVisible();
  // The scripted hand brushes a real channel with Dig: the scene's ground
  // drops below the untouched land's (read on the first page, the same land:
  // on a slow machine this scene may have dug, or restarted, by now).
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
  expect(fallbacks).toEqual([]);
});

test('live scenes survive a new deploy while the game is open (worker script gone from the server)', async ({ page }) => {
  test.setTimeout(360_000);
  const fallbacks = recordFallbacks(page);
  const errors = await openGame(page, '&size=64&cards=1');
  // The game keeps the worker script once it has started its own worker.
  await page.waitForFunction(() => (window as any).__hydro.SimClient.scriptKept, null, { timeout: 30_000 });
  // Every deploy replaces the hashed assets: the old worker file is gone.
  await page.route(/\/assets\/worker-[^/]*\.js/, (r) => r.fulfill({ status: 404, body: 'gone' }));
  await page.evaluate(() => (window as any).__hydro.showIntro());
  await expectLive(page, '.intro .intro-art', fallbacks);
  await page.locator('.intro .skip').click();
  await expect(page.locator('.intro')).toBeHidden();
  // The tool cards use the same machinery.
  await page.evaluate(() => (window as any).__hydro.showCard('weir'));
  await expectLive(page, '.tool-card .intro-art', fallbacks);
  await page.locator('.tool-card .next').click();
  await expect(page.locator('.tool-card')).toBeHidden();
  expect(await page.evaluate(() => (window as any).__hydro.SimClient.live as number)).toBe(1);
  expect(errors.filter((e) => !/404|Failed to load resource/.test(e))).toEqual([]);
  expect(fallbacks).toEqual([]);
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
