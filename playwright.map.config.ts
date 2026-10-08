import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * Demo 10 (map workspace) tests: the base config plus software WebGL for headless Chromium, on its own port so it
 * can run next to another dev server.
 *   npx playwright test -c playwright.map.config.ts                 # mock LLM (tests/e2e/map.spec.ts)
 *   REAL_LLM=1 npx playwright test -c playwright.map.config.ts      # real runs (tests/e2e/real-map.spec.ts)
 */
const REAL = process.env.REAL_LLM === '1';
const PORT = Number(process.env.MAP_PORT ?? 5175);
const GL_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'];
const webServer = Array.isArray(base.webServer) ? base.webServer[0] : base.webServer!;

export default defineConfig({
  ...base,
  testMatch: REAL ? /real-map\.spec\.ts$/ : /(^|[\\/])map\.spec\.ts$/,
  testIgnore: [],
  use: {
    ...base.use,
    baseURL: `http://localhost:${PORT}/`,
    launchOptions: { ...base.use?.launchOptions, args: [...(base.use?.launchOptions?.args ?? []), ...GL_ARGS] },
  },
  webServer: { ...webServer, command: `npx vite --port ${PORT} --strictPort`, url: `http://localhost:${PORT}/` },
});
