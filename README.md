# Client-side agent eval

Evaluates whether a data-analysis AI agent can run **entirely in the browser**: agent loop, virtual FS,
DuckDB-WASM, Pyodide and Vega-Lite, with only CARTO's LiteLLM proxy and SQL API on the other end. It is deployed
as a CARTO Hosted App.

**Results: [EVALUATION.md](EVALUATION.md)** · per-component findings in `tests/*/FINDINGS.md` · run logs in `eval-results/`.

## Run
```bash
npm install
cp .env.example .env.development.local   # dev only; fill VITE_CARTO_TOKEN etc. Never used by `vite build`.
npm run dev                              # six demo tabs
npx playwright test                      # mock-LLM e2e suite
REAL_LLM=1 EVAL=d6-e2e:aisdk:carto::claude-opus-5.5 npx playwright test real-eval   # real stack
```

## Deploy
```bash
npx vite build && carto app deploy dist --slug client-side-agent-eval
```
Hosted, the app reads the viewer's token from `./carto-info.json`; no secret ships in the bundle.

## Layout
`src/agent` (contracts + 3 harnesses) · `src/tools` (fs, bigquery, duckdb, python, chart, mcp) · `src/carto` (SQL, MCP, bootstrap) ·
`src/attachments` (in-memory upload store + chart capture) · `src/data` (DuckDB + ingest) · `src/workers` (Pyodide) · `src/ui` · `src/demos.ts` (the six demos).
