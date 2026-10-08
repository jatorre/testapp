# CARTO SQL API + DuckDB-WASM — findings

Raw numbers: `tests/data/measurements.json`. Tests: 12 mocked, plus real `carto_dw` from headless Chromium.

## CARTO SQL API (`POST /v3/sql/{conn}/query`, body `{q, queryParameters}`)
- **Response:** `{rows, schema:[{name,type}], meta:{cacheHit, totalBytesProcessed (string), location}}`. Errors
  look like `{status, error, rows:[]}`. GET with `?q=` is cached by the CDN; POST is not.
- **Errors seen:**
  - 400: BigQuery syntax error.
  - 403: DML on public data (`bigquery.tables.updateData denied`).
  - 404: missing table.
  - 401: missing token.
  - 408: `ProviderTimeoutError` at ~59 s.
- **Limits:**
  - **Results are silently truncated at 200,000 rows** — no flag, so the client caps itself below 200k.
  - 60 s query timeout; 2,500 requests/min/IP.
  - No documented byte limit; the practical limits are JSON size and parse memory (the browser's max string
    length is ~512 MB).
- **Types are coarse:**
  - All numeric types come back as `number`, so INT64 above 2^53 loses precision server-side.
  - TIMESTAMP, DATETIME and DATE all come back as `timestamp` (ms precision).
  - TIME, ARRAY and JSON → `unknown`; STRUCT and INTERVAL → `object`; BYTES → base64 text; GEOGRAPHY → WKT.
  - Ingest infers real types from the values.
- CARTO prepends a `/* CARTO/3.0 … */` comment to every query, so BigQuery error positions are offset by ~200
  columns.
- **CORS:** `Access-Control-Allow-Origin: *` for any origin (localhost, workspace app domains). Export download
  links are CORS-open too.

## Safety
- **Multi-statement scripts run**, and the last statement's rows are returned. The viewer can write to their own
  `carto_dw` datasets. So the client-side read-only guard (single SELECT/WITH) is essential, but it is a
  heuristic, not a security boundary.
- A viewer token (`app deploy`) can run any SQL the user could. An `app package` (public) token only allows
  named sources; raw SQL gets 403.

## Cost control
- `maximumBytesBilled`, `dryRun`, `options` and `queryOptions` are **silently ignored** on `/query`: a 1-byte cap
  still returned 200 after processing 1.4 MB. On the job endpoint, `dryRun` returns 500 and a 1-byte cap still
  succeeds.
- `LIMIT` does not reduce bytes billed (LIMIT 10k still processed the full 10.5 MB).
- INFORMATION_SCHEMA column lookups are billed at least 10 MB each; `__TABLES__` sizes are free.
- **Implemented client-side:**
  - read-only guard
  - row cap (`LIMIT cap+1`, default 100k)
  - free pre-flight size check via `__TABLES__` (refuses unfiltered scans over 50 GB)
  - per-session bytes-processed budget (hard stop at 200 GB), reported in every `bq_query` result
- **A real cap must live in BigQuery** (a custom quota on the billing project, or a service-account default),
  or come from restricting the app to CARTO named sources.

## Measurements (headless Chromium)
DuckDB-WASM cold start from jsDelivr: **1.6–2.2 s** (wasm fetch + instantiate 1.4–2.0 s).

JSON → Parquet ingest (synthetic, 10 columns):

| Rows | JSON size | Parse | Ingest | Parquet | Aggregate | JS heap |
|---|---|---|---|---|---|---|
| 10k | 2.2 MB | 8 ms | 1.0 s | 0.22 MB | 71 ms | 39 MB |
| 100k | 22 MB | 74 ms | 2.0 s | 0.68 MB | 98 ms | 88 MB |
| 200k | 45 MB | 153 ms | 2.5 s | 1.3 MB | 135 ms | 142 MB |
| 1M | 226 MB | 0.9 s | 10.6 s | 5.7 MB | 174 ms | 580 MB |
| 2M | 454 MB | 1.7 s | 28.8 s | 11 MB | 321 ms | 822 MB |

3M rows fails (the JSON exceeds the max string length). Local DuckDB queries stay under 0.5 s throughout.

Real API, from the browser:

| Query | Rows | Response | Time | Parquet |
|---|---|---|---|---|
| 2023 order_items ⋈ products (6.8 MB processed) | 19,770 | 2.6 MB JSON | 5.0 s end to end | 187 KB |
| Full order_items, 7 columns (10.5 MB processed) | 181,162 | 27.3 MB JSON | 14.6 s fetch + 0.9 s ingest | 2.9 MB |
| Bulk path (Exports API → Parquet) | 166k | — | 4.7 s | 1.6 MB |

**The JSON transfer from the SQL API is the bottleneck, not DuckDB.**

## Bulk path (Exports API → Parquet download)
- No 200k cap, and the payload is ~10× smaller than JSON. 5–11 s for 166–181k rows.
- Doesn't report bytes processed.
- **Decimal precision bug:** FLOAT/NUMERIC values come back slightly altered (0.02 → 0.0199999995529651).
- Opt-in only.

## Bundling
- DuckDB wasm files are 35.6–41.3 MB, over the 25 MB/file hosted-app limit → default is jsDelivr (pinned
  version).
- To self-host: a gzipped `duckdb-eh.wasm.gz` (~8 MB, estimated) with `gz:true`. Untested.
- Don't import the `.wasm` through Vite's `?url` — that copies 36 MB into `dist`.
