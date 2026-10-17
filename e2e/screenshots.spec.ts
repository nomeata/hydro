import { test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { openGame, runDays, settleFrames } from './helpers';

/**
 * Showcase screenshots for the README. CI publishes dist/screenshots/ with
 * the Pages deploy; README.md links to them there.
 */
const OUT = 'dist/screenshots';

test.describe('@readme', () => {

  test('showcase', async ({ page }, info) => {
    // CI renders with slow software GL: allow plenty of time.
    test.setTimeout(480_000);
    mkdirSync(OUT, { recursive: true });
    await openGame(page);
    await runDays(page, 1);
    await settleFrames(page, 3);
    const suffix = info.project.name === 'phone' ? '-phone' : '';
    await page.screenshot({ path: `${OUT}/overview${suffix}.png`, timeout: 120_000 });
    if (info.project.name === 'desktop') {
      await page.evaluate(() => {
        const cam = (window as any).__hydro.renderer.camera;
        cam.zoomBy(2.2);
        cam.rotateBy(0.6);
      });
      await settleFrames(page, 3);
      await page.screenshot({ path: `${OUT}/closeup.png`, timeout: 120_000 });
    }
  });
});
