import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

// In the dev container a Chromium is pre-installed; CI installs its own.
const localChromium = '/opt/pw-browsers/chromium';
const launchOptions = {
  executablePath: existsSync(localChromium) ? localChromium : undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
};

// HYDRO_PW_PORT: a preview port of one's own (parallel agents in one container).
const port = Number(process.env.HYDRO_PW_PORT ?? 4173);

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.02, threshold: 0.2 } },
  use: { baseURL: `http://localhost:${port}/`, launchOptions },
  webServer: { command: `npx vite preview --port ${port} --strictPort`, port, reuseExistingServer: true },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, launchOptions } },
    { name: 'phone', use: { ...devices['Pixel 7'], launchOptions } },
  ],
});
