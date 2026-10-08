import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Served by CARTO under /app/<slug>/ — all asset URLs must be relative.
  base: './',
  // Workers (Pyodide, DuckDB) are ES modules.
  worker: { format: 'es' },
  optimizeDeps: {
    // WASM-heavy packages ship their own loaders; don't let the dep optimizer rewrite them.
    exclude: ['@duckdb/duckdb-wasm', 'pyodide'],
    // Lazily-imported deps: pre-bundle up front so the dev server doesn't reload the page mid-run.
    include: ['ai', '@ai-sdk/openai-compatible', '@openai/agents', 'openai', 'zod', 'vega-embed', 'just-bash/browser'],
  },
  build: { target: 'es2023', chunkSizeWarningLimit: 2000 },
  server: {
    port: 5173,
    // e2e tests set VITE_NO_OVERLAY=1 so a compile error in an unrelated module can't block clicks.
    hmr: process.env.VITE_NO_OVERLAY ? { overlay: false } : undefined,
  },
});
