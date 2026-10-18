import { expect, type Page } from '@playwright/test';

/** Open the game in test mode and wait until the world is ready. */
export async function openGame(page: Page, query = '', base = './?test=1&seed=1'): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}${query}`);
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

/**
 * Record every text that elements matching `selector` show while visible, from
 * now on. Passing messages (hints, toasts) go away on a timer, and a slow CI
 * machine can miss that window between the action and the check; asserting on
 * the recording instead keeps the check exact without racing the timer.
 */
export async function recordTexts(page: Page, selector: string): Promise<() => Promise<string[]>> {
  const key = `__seen_${Math.random().toString(36).slice(2)}`;
  await page.evaluate(
    ([sel, k]) => {
      const seen: string[] = [];
      (window as any)[k] = seen;
      const look = () => {
        for (const el of document.querySelectorAll<HTMLElement>(sel)) {
          const t = el.textContent ?? '';
          if (el.checkVisibility() && seen[seen.length - 1] !== t) seen.push(t);
        }
      };
      look();
      new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    },
    [selector, key] as const,
  );
  return () => page.evaluate((k) => [...(window as any)[k]] as string[], key);
}
