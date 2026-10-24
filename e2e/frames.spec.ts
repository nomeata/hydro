import { expect, test } from '@playwright/test';
import { openGame } from './helpers';

// Render on demand (renderer.wantsFrame, main.ts): paused and still, the game
// draws (almost) nothing; a camera move, input or play draws again.
test.use({ viewport: { width: 480, height: 320 } });

test('paused and still, no frames are drawn; moving the camera or playing draws again', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'one viewport is enough');
  test.setTimeout(300_000);
  const errors = await openGame(page, '&size=128');
  const drawn = () => page.evaluate(() => (window as any).__hydro.renderer.framesDrawn as number);
  // Settle: models load, the first snapshots arrive, flecks fill in.
  await expect
    .poll(
      async () => {
        const a = await drawn();
        await page.waitForTimeout(2500);
        return (await drawn()) - a;
      },
      { timeout: 120_000, intervals: [0] },
    )
    .toBeLessThanOrEqual(2);
  // A camera move is drawn.
  const before = await drawn();
  await page.evaluate(() => {
    const r = (window as any).__hydro.renderer;
    r.camera.setState({ viewHeight: r.camera.getState().viewHeight * 1.3 }, true);
  });
  await expect.poll(drawn, { timeout: 60_000 }).toBeGreaterThan(before);
  // Playing draws continuously.
  await page.evaluate(() => (window as any).__hydro.client.setSpeed(1));
  await page.waitForFunction(() => (window as any).__hydro.renderer.clock.gameSpeed > 0, null, { timeout: 60_000 });
  // Software GL on CI draws a frame every second or more: poll instead of a fixed wait.
  const p0 = await drawn();
  await expect.poll(async () => (await drawn()) - p0, { timeout: 60_000 }).toBeGreaterThanOrEqual(3);
  expect(errors).toEqual([]);
});
