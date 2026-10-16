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
    mkdirSync(OUT, { recursive: true });
    await openGame(page);
    await runDays(page, 1);
    await settleFrames(page, 6);
    const suffix = info.project.name === 'phone' ? '-phone' : '';
    await page.screenshot({ path: `${OUT}/overview${suffix}.png` });
    if (info.project.name === 'desktop') {
      await page.evaluate(() => {
        const cam = (window as any).__hydro.renderer.camera;
        cam.zoomBy(2.2);
        cam.rotateBy(0.6);
      });
      await settleFrames(page, 6);
      await page.screenshot({ path: `${OUT}/closeup.png` });
    }
  });
});
