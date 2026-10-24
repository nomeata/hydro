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

/**
 * What `js` (an expression of `h` = window.__hydro) reads right after the
 * next pointerup reaches the tools (a listener on window, after the canvas's
 * own), and how many frames had been drawn by then. A state shown "for a
 * moment" after letting go (a refused gate's or wheel's red ghost, held 1.8 s
 * of wall time) can be gone before a poll gets through on CI's software GL,
 * where one phone-sized frame takes seconds; the recording checks it without
 * racing that timer.
 */
export async function recordOnRelease(page: Page, js: string): Promise<() => Promise<{ value: any; frames: number } | null>> {
  const key = `__up_${Math.random().toString(36).slice(2)}`;
  await page.evaluate(
    ([s, k]) => {
      const h = (window as any).__hydro;
      (window as any)[k] = null;
      const read = new Function('h', `return ${s}`);
      window.addEventListener('pointerup', () => ((window as any)[k] = { value: read(h), frames: h.renderer.framesDrawn }), { once: true });
    },
    [js, key] as const,
  );
  return () => page.evaluate((k) => (window as any)[k], key);
}

/**
 * A spot for a weir near the start: a known river cell flowing at ≥ 0.4 m/s,
 * and the line across the flow through it, out to dry land on both sides.
 */
export async function findWeir(page: Page): Promise<{ x: number; y: number; a: [number, number]; b: [number, number] } | null> {
  return page.evaluate(() => {
    const h = (window as any).__hydro;
    const m = h.mirror;
    const depth: Float32Array = h.renderer.heights.depth;
    const vel: Float32Array = h.renderer.flow.vel;
    const W = m.width;
    const { startX, startY } = h.data.info;
    let best: { x: number; y: number; a: [number, number]; b: [number, number]; d: number } | null = null;
    for (let y = 8; y < m.height - 8; y++)
      for (let x = 8; x < W - 8; x++) {
        const i = y * W + x;
        const vx = vel[2 * i]!;
        const vy = vel[2 * i + 1]!;
        const sp = Math.hypot(vx, vy);
        if (depth[i]! < 0.3 || sp < 0.4 || !m.isRevealed(x, y)) continue;
        // Across the flow: out to the first dry cell on each side.
        const ends: [number, number][] = [];
        for (const s of [-1, 1]) {
          let e: [number, number] | null = null;
          for (let k = 1; k <= 7; k++) {
            const px = Math.round(x - (vy / sp) * k * s);
            const py = Math.round(y + (vx / sp) * k * s);
            if (!m.isRevealed(px, py)) break;
            if (depth[py * W + px]! < 0.05) {
              e = [x - (vy / sp) * (k + 1) * s, y + (vx / sp) * (k + 1) * s];
              break;
            }
          }
          if (e) ends.push(e);
        }
        if (ends.length < 2) continue;
        const d = Math.hypot(x - startX, y - startY);
        if (d > 6 && (!best || d < best.d)) best = { x, y, a: ends[0]!, b: ends[1]!, d };
      }
    return best;
  });
}

/** Screen position (page pixels) of cell (x, y) on the terrain. */
export async function toScreen(page: Page, x: number, y: number): Promise<[number, number]> {
  return page.evaluate(
    ([cx, cy]) => {
      const h = (window as any).__hydro;
      const r = h.renderer;
      const cam = r.camera.camera;
      cam.updateMatrixWorld();
      const v = { x: cx! + 0.5, y: (r.heights.terrainAt(cx, cy) / 5) * 2, z: cy! + 0.5 };
      const mul = (e: number[], p: { x: number; y: number; z: number }) => {
        const w = e[3]! * p.x + e[7]! * p.y + e[11]! * p.z + e[15]!;
        return {
          x: (e[0]! * p.x + e[4]! * p.y + e[8]! * p.z + e[12]!) / w,
          y: (e[1]! * p.x + e[5]! * p.y + e[9]! * p.z + e[13]!) / w,
          z: (e[2]! * p.x + e[6]! * p.y + e[10]! * p.z + e[14]!) / w,
        };
      };
      const p = mul(cam.projectionMatrix.elements, mul(cam.matrixWorldInverse.elements, v));
      const rect = (document.querySelector('#view') as HTMLElement).getBoundingClientRect();
      return [rect.left + ((p.x + 1) / 2) * rect.width, rect.top + ((1 - p.y) / 2) * rect.height] as [number, number];
    },
    [x, y],
  );
}


/** Touch input through CDP (real touch pointer events, as on a phone). */
export async function touchPath(page: Page, pts: [number, number][], stepMs = 30): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const at = (p: [number, number]) => [{ x: p[0], y: p[1], id: 1, radiusX: 4, radiusY: 4, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(pts[0]!) });
  for (const p of pts.slice(1)) {
    await page.waitForTimeout(stepMs);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(p) });
  }
  await page.waitForTimeout(stepMs);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

/** Keep the welcome/tool-card scenes on screen instead of looping them (IntroScenes.hold). */
export async function holdScenes(page: Page): Promise<void> {
  await page.evaluate(() => ((window as any).__hydro.IntroScenes.hold = true));
}

/**
 * Screenshot of the page region an element covers. Unlike locator.screenshot
 * this does not wait for the element to be "stable" over animation frames,
 * which on CI's software GL (a frame every second or more) can take minutes.
 */
export async function clipShot(page: Page, selector: string, timeout = 120_000): Promise<Buffer> {
  const r = await page.evaluate((sel) => {
    const b = document.querySelector(sel)!.getBoundingClientRect();
    return { x: b.left, y: b.top, width: b.width, height: b.height };
  }, selector);
  return page.screenshot({ clip: r, timeout });
}

/**
 * Screenshot of the whole page with the game's last frame held. The render
 * loop stops drawing first (__hydro.render.hold): on CI's software GL a busy
 * loop (a terrain frame every second or more) starves the screenshot's own
 * compositor frame, so page.screenshot took minutes or timed out; held, it
 * takes a fraction of a second. Rendering resumes afterwards.
 */
export async function stillShot(page: Page, path: string, timeout = 120_000): Promise<Buffer> {
  await page.evaluate(() => ((window as any).__hydro.render.hold = true));
  try {
    // Let the frame in flight finish.
    await settleFrames(page, 2);
    return await page.screenshot({ path, timeout, caret: 'hide' });
  } finally {
    await page.evaluate(() => ((window as any).__hydro.render.hold = false));
  }
}
