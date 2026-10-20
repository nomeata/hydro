import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { clipShot, openGame, runDays, settleFrames } from './helpers';

/** Pixels (of the game view) that differ between two screenshots. */
function diffPixels(a: Buffer, b: Buffer): number {
  return diffInfo(a, b).n;
}

/** Changed pixels and where they are (for diagnosing a failure). */
function diffInfo(a: Buffer, b: Buffer): { n: number; where: string } {
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  expect([pb.width, pb.height]).toEqual([pa.width, pa.height]);
  let n = 0;
  const at: string[] = [];
  for (let i = 0; i < pa.data.length; i += 4) {
    if (
      Math.abs(pa.data[i]! - pb.data[i]!) > 2 ||
      Math.abs(pa.data[i + 1]! - pb.data[i + 1]!) > 2 ||
      Math.abs(pa.data[i + 2]! - pb.data[i + 2]!) > 2
    ) {
      n++;
      const p = i / 4;
      if (at.length < 12) at.push(`${p % pa.width},${Math.floor(p / pa.width)}`);
    }
  }
  return { n, where: at.join(' ') };
}

// (A clip, not locator.screenshot: no wait for the element to be "stable"
// over animation frames, which software GL draws a second or more apart.)
const shot = (page: Page) => clipShot(page, '#view');

// A small view: software GL (CI) draws and screenshots it several times
// faster, and a village close up still fills it with moving things.
test.use({ viewport: { width: 640, height: 400 } });

test('pausing freezes every animation (people, animals, smoke, water, wheels)', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'one viewport is enough');
  test.setTimeout(480_000);
  const errors = await openGame(page, '&size=128');
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
  await page.waitForFunction(() => (window as any).__hydro.renderer.clock.gameSpeed > 0, null, { timeout: 180_000 });
  await settleFrames(page, 8);
  const live1 = await shot(page);
  await page.waitForTimeout(1000);
  const live2 = await shot(page);
  const live = diffPixels(live1, live2);
  // Pause, and let the last snapshot arrive and the camera settle.
  await page.evaluate(() => (window as any).__hydro.client.setSpeed(0));
  await page.waitForFunction(() => (window as any).__hydro.renderer.clock.gameSpeed === 0, null, { timeout: 180_000 });
  // Flecks renew for a few seconds after a camera move (render/flow.ts).
  await page.waitForTimeout(3500);
  // Compare the game view itself: the HTML HUD over it (whose text and
  // borders CI's software compositor re-rasters a few levels differently
  // from frame to frame) is not part of what pausing freezes.
  await page.evaluate(() => ((document.getElementById('ui') as HTMLElement).style.visibility = 'hidden'));
  await settleFrames(page, 5);
  const a = await shot(page);
  await page.waitForTimeout(1000);
  await settleFrames(page, 5);
  const b = await shot(page);
  const { n: paused, where } = diffInfo(a, b);
  if (process.env.HYDRO_PAUSE_DUMP || paused >= 20) {
    // (test-results/ is kept by CI: the two frames show what still moved.)
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.env.HYDRO_PAUSE_DUMP ? `${process.env.HYDRO_PAUSE_DUMP}/a.png` : info.outputPath('paused-a.png'), a);
    writeFileSync(process.env.HYDRO_PAUSE_DUMP ? `${process.env.HYDRO_PAUSE_DUMP}/b.png` : info.outputPath('paused-b.png'), b);
    if (paused) console.log(`paused changes at ${where}`);
  }
  await info.attach('paused', { body: a, contentType: 'image/png' });
  console.log(`changed pixels: running ${live}, paused ${paused}`);
  expect(live).toBeGreaterThan(200);
  expect(paused).toBeLessThan(20);
  expect(errors).toEqual([]);
});
