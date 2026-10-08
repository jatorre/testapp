import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

// Run: npx playwright test -c tests/semantic/playwright.semantic.config.ts   (mock LLM + mocked CARTO API)
const PORT = 5179;
const fallbackChromium = '/opt/pw-browsers/chromium';
const executablePath = process.env.PW_CHROMIUM_PATH ?? (existsSync(fallbackChromium) && !process.env.PLAYWRIGHT_BROWSERS_PATH ? fallbackChromium : undefined);

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}/`,
    ...devices['Desktop Chrome'],
    launchOptions: { ...(executablePath && { executablePath }) },
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    cwd: '../..',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      VITE_CARTO_TOKEN: 'test-token',
      VITE_CARTO_AI_BASE_URL: 'http://mock-llm.test/v1',
      VITE_CARTO_API_BASE_URL: 'https://api.mock-carto.test',
      VITE_DEFAULT_MODEL: 'mock-model',
      VITE_CARTO_CONNECTION: 'carto_dw',
      VITE_NO_OVERLAY: '1',
    },
  },
});
