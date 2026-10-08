import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

const PORT = 5173;
// Prefer Playwright's own browser lookup (PLAYWRIGHT_BROWSERS_PATH); fall back to the preinstalled binary.
const fallbackChromium = '/opt/pw-browsers/chromium';
const executablePath = process.env.PW_CHROMIUM_PATH ?? (existsSync(fallbackChromium) && !process.env.PLAYWRIGHT_BROWSERS_PATH ? fallbackChromium : undefined);

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}/`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1400, height: 900 },
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    // Set PW_REUSE=1 to reuse a dev server you started yourself (it must have the env below).
    reuseExistingServer: process.env.PW_REUSE === '1',
    timeout: 120_000,
    env: {
      VITE_CARTO_TOKEN: 'test-token',
      VITE_CARTO_AI_BASE_URL: 'http://mock-llm.test/v1',
      VITE_DEFAULT_MODEL: 'mock-model',
      VITE_CARTO_CONNECTION: 'carto_dw',
    },
  },
});
