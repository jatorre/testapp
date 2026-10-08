import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

// Own config for the run_python tests (port 5175). Run:
//   npx playwright test -c tests/python/playwright.python.config.ts
// Pyodide is fetched from the jsDelivr CDN; in sandboxes with an egress proxy, HTTPS_PROXY is passed to Chromium.
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
// Playwright otherwise forces loopback through the proxy (<-loopback>), breaking the local dev server.
process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = '1';
const pwChromium = '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  timeout: 300_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5175',
    browserName: 'chromium',
    headless: true,
    launchOptions: {
      ...(process.env.PW_CHROMIUM_PATH || (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(pwChromium))
        ? { executablePath: process.env.PW_CHROMIUM_PATH || pwChromium }
        : {}),
      ...(proxyUrl ? { proxy: { server: proxyUrl, bypass: 'localhost,127.0.0.1' } } : {}),
    },
  },
  webServer: {
    command: 'npx vite --config tests/python/vite.python.config.ts',
    cwd: '../..',
    url: 'http://localhost:5175/tests/pages/python.html',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
