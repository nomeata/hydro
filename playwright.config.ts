import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

// In the dev container a Chromium is pre-installed; CI installs its own.
const localChromium = '/opt/pw-browsers/chromium';
const launchOptions = {
  executablePath: existsSync(localChromium) ? localChromium : undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
};

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.02, threshold: 0.2 } },
  use: { baseURL: 'http://localhost:4173/', launchOptions },
  webServer: { command: 'npx vite preview --port 4173 --strictPort', port: 4173, reuseExistingServer: true },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, launchOptions } },
    { name: 'phone', use: { ...devices['Pixel 7'], launchOptions } },
  ],
});
