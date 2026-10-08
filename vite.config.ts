import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Served by CARTO under /app/<slug>/ — all asset URLs must be relative.
  base: './',
  // Workers (Pyodide, DuckDB) are ES modules.
  worker: { format: 'es' },
  // WASM-heavy packages ship their own loaders; don't let the dep optimizer rewrite them.
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm', 'pyodide'] },
  build: { target: 'es2023', chunkSizeWarningLimit: 2000 },
  server: { port: 5173 },
});
