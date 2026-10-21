import { test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { openGame, runDays, settleFrames, stillShot } from './helpers';
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
    // (The game is paused in test mode: a still scene.)
    await settleFrames(page, 3);
    const suffix = info.project.name === 'phone' ? '-phone' : '';
    await stillShot(page, `${OUT}/overview${suffix}.png`);
    if (info.project.name === 'desktop') {
      await page.evaluate(() => {
        const cam = (window as any).__hydro.renderer.camera;
        cam.zoomBy(2.2);
        cam.rotateBy(0.6);
        // Jump to the goal: the damped glide would otherwise end wherever the
        // (slow, uneven) frames leave it when the frame is held.
        cam.setState(cam.getState(), true);
      });
      await settleFrames(page, 3);
      await stillShot(page, `${OUT}/closeup.png`);
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
    // (Frames, not just time: on a busy software GL a 5 s wait can be a
    // couple of frames, and the held frame must show the settled scene.)
    await settleFrames(page, 10);
    await stillShot(page, 'dist/og.png');
    await page.close();
  });
});
