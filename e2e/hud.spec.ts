import { expect, test, type Page } from '@playwright/test';
import { openGame } from './helpers';

/** Positions of the top bar's pieces, after putting `date` into the date panel. */
async function topbar(page: Page, date: string | null) {
  return page.evaluate((html) => {
    const el = document.querySelector<HTMLElement>('[data-testid=date]')!;
    if (html) el.innerHTML = html;
    const box = (sel: string) => {
      const r = document.querySelector(sel)!.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    return { date: box('[data-testid=date]'), speed: box('.topbar .speed'), menu: box('.menu-button'), stats: box('[data-testid=statsbar]'), vw: innerWidth };
  }, date);
}

test('the top bar keeps one row and does not move when the date gets longer', async ({ page }, info) => {
  const errors = await openGame(page);
  const sizes = info.project.name === 'phone' ? [null, { width: 360, height: 760 }] : [null];
  for (const size of sizes) {
    if (size) await page.setViewportSize(size);
    const short = await topbar(page, '<span class="icon"></span><span>Spring, day 1<small>Year 1 · 2°C</small></span>');
    const long = await topbar(page, '<span class="icon"></span><span>Autumn, day 12<small>Year 12 · -12°C</small></span>');
    for (const t of [short, long]) {
      // Date, speed controls and menu button on one row, inside the screen.
      expect(Math.abs(t.speed.top - t.date.top)).toBeLessThan(6);
      expect(Math.abs(t.menu.top - t.date.top)).toBeLessThan(6);
      expect(t.date.right).toBeLessThanOrEqual(t.speed.left);
      expect(t.speed.right).toBeLessThanOrEqual(t.menu.left);
      expect(t.menu.right).toBeLessThanOrEqual(t.vw);
    }
    // Nothing but the date panel itself changes.
    expect(long.speed).toEqual(short.speed);
    expect(long.menu).toEqual(short.menu);
    expect(long.stats).toEqual(short.stats);
  }
  expect(errors).toEqual([]);
});

test('phones: a held tool shows a one-line hint (tap for the rest) and a slim options strip', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'phone layout');
  const errors = await openGame(page);
  await page.locator('button[data-tool=raise]').tap();
  const hint = page.locator('.tools .hint');
  await expect(hint).toBeVisible();
  const h1 = (await hint.boundingBox())!.height;
  expect(h1).toBeLessThan(30);
  const opts = (await page.locator('.tools .options').boundingBox())!.height;
  expect(opts).toBeLessThan(48);
  // The ⓘ stays on the line.
  const i = page.locator('.tools .hint-info');
  if (await i.isVisible()) expect((await i.boundingBox())!.y).toBeGreaterThanOrEqual((await hint.boundingBox())!.y);
  await hint.locator('span').first().tap();
  expect((await hint.boundingBox())!.height).toBeGreaterThan(h1 * 1.8);
  await hint.locator('span').first().tap();
  expect((await hint.boundingBox())!.height).toBeLessThan(30);
  expect(errors).toEqual([]);
});
