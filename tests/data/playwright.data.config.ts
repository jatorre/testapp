import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

// Data-layer tests (port 5174). Run:
//   npx playwright test -c tests/data/playwright.data.config.ts                 # mocked CARTO API + DuckDB
//   BENCH=1 npx playwright test -c tests/data/playwright.data.config.ts bench   # scaling measurements
//   REAL_CARTO=1 npx playwright test -c tests/data/playwright.data.config.ts real  # real SQL API (.env.development.local)
// DuckDB-WASM is fetched from jsDelivr; behind an egress proxy HTTPS_PROXY is passed to Chromium.
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = '1';
const pwChromium = '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  timeout: 600_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5174',
    browserName: 'chromium',
    headless: true,
    launchOptions: {
      args: ['--enable-precise-memory-info', '--js-flags=--max-old-space-size=4096'],
      ...(process.env.PW_CHROMIUM_PATH || (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(pwChromium))
        ? { executablePath: process.env.PW_CHROMIUM_PATH || pwChromium }
        : {}),
      ...(proxyUrl ? { proxy: { server: proxyUrl, bypass: 'localhost,127.0.0.1' } } : {}),
    },
  },
  webServer: {
    command: 'npx vite --config tests/data/vite.data.config.ts',
    cwd: '../..',
    url: 'http://localhost:5174/tests/pages/data.html',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
