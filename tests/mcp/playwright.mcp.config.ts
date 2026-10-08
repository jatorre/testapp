import { defineConfig, devices } from '@playwright/test';

// Run: npx playwright test -c tests/mcp/playwright.mcp.config.ts
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  timeout: 60_000,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:5176', ...devices['Desktop Chrome'] },
  webServer: [
    { command: 'node tests/mcp/mock-server.mjs 5177', url: 'http://localhost:5177/health', cwd: '../..', reuseExistingServer: false, timeout: 30_000 },
    { command: 'npx vite --port 5176 --strictPort', url: 'http://localhost:5176/tests/pages/mcp.html', cwd: '../..', reuseExistingServer: true, timeout: 60_000 },
  ],
});
