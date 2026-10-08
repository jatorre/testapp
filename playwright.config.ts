import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

const PORT = 5173;
// REAL_LLM=1: run only the real smoke tests (tests/e2e/real-*.spec.ts) against the CARTO LiteLLM proxy,
// using credentials from .env.local (read by Vite; never printed). Default: mock-LLM suite only.
const REAL = process.env.REAL_LLM === '1';
const mockEnv = {
  VITE_CARTO_TOKEN: 'test-token',
  VITE_CARTO_AI_BASE_URL: 'http://mock-llm.test/v1',
  VITE_DEFAULT_MODEL: 'mock-model',
  VITE_CARTO_CONNECTION: 'carto_dw',
};
// Prefer Playwright's own browser lookup (PLAYWRIGHT_BROWSERS_PATH); fall back to the preinstalled binary.
const fallbackChromium = '/opt/pw-browsers/chromium';
const executablePath = process.env.PW_CHROMIUM_PATH ?? (existsSync(fallbackChromium) && !process.env.PLAYWRIGHT_BROWSERS_PATH ? fallbackChromium : undefined);

// In the cloud container outbound traffic must use the agent proxy; loopback (the Vite server) must not.
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
let proxy: { server: string; username?: string; password?: string; bypass?: string } | undefined;
if (proxyUrl) {
  const u = new URL(proxyUrl);
  proxy = {
    server: `${u.protocol}//${u.host}`,
    ...(u.username && { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }),
    bypass: 'localhost,127.0.0.1',
  };
  process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = '1';
}

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: REAL ? /real-.*\.spec\.ts$/ : /\.spec\.ts$/,
  testIgnore: REAL ? [] : [/real-.*\.spec\.ts$/],
  timeout: REAL ? 300_000 : 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}/`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1400, height: 900 },
    launchOptions: { ...(executablePath && { executablePath }), ...(proxy && { proxy }) },
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    // Set PW_REUSE=1 to reuse a dev server you started yourself (it must have the env below).
    reuseExistingServer: process.env.PW_REUSE === '1',
    timeout: 120_000,
    env: { ...(REAL ? {} : mockEnv), VITE_NO_OVERLAY: '1' },
  },
});
