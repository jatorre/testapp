import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Minimal dev server for the run_python test page: independent of the app's vite.config.ts and
// with HMR/watching off so concurrent edits elsewhere in the repo don't reload the page mid-test.
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  server: { port: 5175, strictPort: true, hmr: false, watch: null },
  worker: { format: 'es' },
});
