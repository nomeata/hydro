import { test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { writeFileSync } from 'node:fs';
import { openGame, runDays, settleFrames } from './helpers';

function diff(a: Buffer, b: Buffer) {
  const pa = PNG.sync.read(a), pb = PNG.sync.read(b);
  let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let i = 0; i < pa.data.length; i += 4) {
    if (Math.abs(pa.data[i]! - pb.data[i]!) > 2 || Math.abs(pa.data[i + 1]! - pb.data[i + 1]!) > 2 || Math.abs(pa.data[i + 2]! - pb.data[i + 2]!) > 2) {
      n++; const p = i / 4, x = p % pa.width, y = Math.floor(p / pa.width);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  return `${n} box ${x0},${y0}-${x1},${y1}`;
}
const shot = (page: Page) => page.locator('#view').screenshot({ timeout: 120_000 });
test('diag', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop');
  test.setTimeout(1_800_000);
  await openGame(page);
  await runDays(page, 1);
  await page.evaluate(() => {
    const h = (window as any).__hydro;
    let sx = 0, sy = 0, k = 0;
    for (const t of h.crowd.tracks.tracks.values()) { sx += t.x; sy += t.y; k++; }
    if (k) h.renderer.camera.setState({ x: sx / k, y: sy / k, viewHeight: 18 }, true);
  });
  for (let it = 0; it < 10; it++) {
    await page.evaluate(() => (window as any).__hydro.client.setSpeed(1));
    await page.waitForFunction(() => (window as any).__hydro.renderer.clock.gameSpeed > 0);
    await page.waitForTimeout(2000 + it * 700);
    await page.evaluate(() => (window as any).__hydro.client.setSpeed(0));
    await page.waitForFunction(() => (window as any).__hydro.renderer.clock.gameSpeed === 0);
    await page.waitForTimeout(3500);
    await settleFrames(page, 5);
    const a = await shot(page);
    await page.evaluate(() => ((document.getElementById('ui') as HTMLElement).style.visibility = 'hidden'));
    await settleFrames(page, 2);
    const a2 = await shot(page);
    await page.waitForTimeout(1000);
    await settleFrames(page, 5);
    const b2 = await shot(page);
    await page.evaluate(() => ((document.getElementById('ui') as HTMLElement).style.visibility = ''));
    await settleFrames(page, 2);
    const b = await shot(page);
    const dh = diff(a2, b2);
    console.log(`it ${it} nohud: ${dh}`);
    if (!dh.startsWith('0 ')) { writeFileSync(info.outputPath(`h${it}a.png`), a2); writeFileSync(info.outputPath(`h${it}b.png`), b2); }
    const day = await page.evaluate(() => (window as any).__hydro.client.latest.time.day);
    const d = diff(a, b);
    console.log(`it ${it} day ${day}: ${d}`);
    if (!d.startsWith('0 ')) { writeFileSync(info.outputPath(`a${it}.png`), a); writeFileSync(info.outputPath(`b${it}.png`), b); }
  }
});
