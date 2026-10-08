import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Dev server for the data-layer test page (port 5174), independent of the app's vite.config.ts.
// HMR/watch off so concurrent edits elsewhere don't reload the page mid-test. .env.development.local is
// loaded from the repo root (real CARTO token for the opt-in real-API spec; never logged).
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  server: { port: 5174, strictPort: true, hmr: false, watch: null },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'], include: ['apache-arrow', 'zod', 'just-bash/browser'] },
});
