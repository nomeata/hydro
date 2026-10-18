import { test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { openGame, runDays, settleFrames } from './helpers';
import { OG, makeOgScene, showOgScene } from '../tools/og-image';

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

  // The link preview (index.html's og:image): published at /og.png, over the
  // committed fallback copy from public/.
  test('og image', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'one image is enough');
    test.setTimeout(480_000);
    const scene = await makeOgScene();
    const page = await browser.newPage({ viewport: { width: OG.width, height: OG.height }, baseURL: info.project.use.baseURL });
    await showOgScene(page, './', scene);
    await page.screenshot({ path: 'dist/og.png', timeout: 120_000 });
    await page.close();
  });
});
