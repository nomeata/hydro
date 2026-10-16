import { expect, type Page } from '@playwright/test';

/** Open the game in test mode and wait until the world is ready. */
export async function openGame(page: Page, query = ''): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`./?test=1&seed=1${query}`);
  await page.waitForFunction(() => (window as any).__hydro !== undefined, null, { timeout: 90_000 });
  await expect(page.locator('#loading')).toHaveClass(/done/);
  return errors;
}

/** Run the simulation for n game days (as fast as possible) and wait for the next snapshot. */
export async function runDays(page: Page, days: number): Promise<void> {
  await page.evaluate(async (d) => {
    const h = (window as any).__hydro;
    await h.client.runDays(d);
    await new Promise((r) => setTimeout(r, 300));
  }, days);
}

/** Wait a few animation frames so the renderer has drawn the latest state. */
export async function settleFrames(page: Page, frames = 10): Promise<void> {
  await page.evaluate(
    (n) =>
      new Promise<void>((resolve) => {
        let k = 0;
        const f = () => (++k >= n ? resolve() : requestAnimationFrame(f));
        requestAnimationFrame(f);
      }),
    frames,
  );
}
