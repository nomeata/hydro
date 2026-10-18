import { expect, test } from '@playwright/test';

// The link-preview tags in the built index.html, and the image they point to.
test('social link preview: meta tags and og:image', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop', 'static page, one project is enough');
  await page.goto('./?test=1');
  const meta = (sel: string) => page.locator(sel).getAttribute('content');
  expect(await meta('meta[property="og:title"]')).toBe('Hydro');
  expect(await meta('meta[property="og:type"]')).toBe('website');
  expect(await meta('meta[property="og:url"]')).toBe('https://hydro.nomeata.de/');
  expect(await meta('meta[name="twitter:card"]')).toBe('summary_large_image');
  expect(await meta('meta[name="description"]')).toBeTruthy();
  expect(await meta('meta[property="og:description"]')).toBeTruthy();
  expect(await meta('meta[property="og:image:alt"]')).toBeTruthy();
  const image = (await meta('meta[property="og:image"]'))!;
  expect(image).toMatch(/^https:\/\/hydro\.nomeata\.de\//);
  // Served by this build at the same path.
  const local = await request.get(new URL(image).pathname.slice(1));
  expect(local.status()).toBe(200);
  expect(local.headers()['content-type']).toContain('image/png');
  const png = await local.body();
  expect(png.readUInt32BE(16)).toBe(Number(await meta('meta[property="og:image:width"]')));
  expect(png.readUInt32BE(20)).toBe(Number(await meta('meta[property="og:image:height"]')));
  expect((await request.get('apple-touch-icon.png')).status()).toBe(200);
});
