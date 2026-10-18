import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { openGame, runDays, settleFrames } from './helpers';

/** Pixels (of the game view) that differ between two screenshots. */
function diffPixels(a: Buffer, b: Buffer): number {
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  expect([pb.width, pb.height]).toEqual([pa.width, pa.height]);
  let n = 0;
  for (let i = 0; i < pa.data.length; i += 4) {
    if (
      Math.abs(pa.data[i]! - pb.data[i]!) > 2 ||
      Math.abs(pa.data[i + 1]! - pb.data[i + 1]!) > 2 ||
      Math.abs(pa.data[i + 2]! - pb.data[i + 2]!) > 2
    )
      n++;
  }
  return n;
}

const shot = (page: Page) => page.locator('#view').screenshot({ timeout: 120_000 });

test('pausing freezes every animation (people, animals, smoke, water, wheels)', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'one viewport is enough');
  test.setTimeout(480_000);
  const errors = await openGame(page);
  await runDays(page, 1);
  // Look closely at the village: the mean position of its people.
  const n = await page.evaluate(() => {
    const h = (window as any).__hydro;
    let sx = 0;
    let sy = 0;
    let k = 0;
    for (const t of h.crowd.tracks.tracks.values()) {
      sx += t.x;
      sy += t.y;
      k++;
    }
    if (k) h.renderer.camera.setState({ x: sx / k, y: sy / k, viewHeight: 18 }, true);
    return k;
  });
  expect(n).toBeGreaterThan(0);
  // Play a little so that people walk, smoke rises and wheels turn.
  await page.evaluate(() => (window as any).__hydro.client.setSpeed(1));
  // (Software GL draws few frames a second: wait for some play time.)
  await page.waitForFunction(() => (window as any).__hydro.renderer.clock.playSec > 1, null, { timeout: 60_000 });
  const live1 = await shot(page);
  await page.waitForTimeout(1000);
  const live2 = await shot(page);
  const live = diffPixels(live1, live2);
  // Pause, and let the last snapshot arrive and the camera settle.
  await page.evaluate(() => (window as any).__hydro.client.setSpeed(0));
  await page.waitForFunction(() => (window as any).__hydro.renderer.clock.gameSpeed === 0, null, { timeout: 60_000 });
  // Flecks renew for a few seconds after a camera move (render/flow.ts).
  await page.waitForTimeout(3500);
  await settleFrames(page, 5);
  const a = await shot(page);
  await page.waitForTimeout(1000);
  await settleFrames(page, 5);
  const b = await shot(page);
  const paused = diffPixels(a, b);
  if (process.env.HYDRO_PAUSE_DUMP) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${process.env.HYDRO_PAUSE_DUMP}/a.png`, a);
    writeFileSync(`${process.env.HYDRO_PAUSE_DUMP}/b.png`, b);
  }
  await info.attach('paused', { body: a, contentType: 'image/png' });
  console.log(`changed pixels: running ${live}, paused ${paused}`);
  expect(live).toBeGreaterThan(200);
  expect(paused).toBeLessThan(20);
  expect(errors).toEqual([]);
});
