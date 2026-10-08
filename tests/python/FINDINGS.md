# Pyodide `run_python` — findings

Pyodide 314.0.7 from jsDelivr (`https://cdn.jsdelivr.net/pyodide/v314.0.7/full/`, CORS `*`, 1-year max-age), in a
module Web Worker. Measured in headless Chromium (Playwright). Raw numbers: `tests/python/measurements.json`.

## Decisions
- **Parquet:** pyarrow 22.0.0 ships in the distribution (fastparquet doesn't). It must be loaded **before** the first
  `import pandas` (pandas 3 caches pyarrow availability at import; loading later breaks `read_parquet`), so the
  worker preloads `numpy, pyarrow, pandas`. Cost: ~10 MB and ~2 s of cold start.
- **Timeout/abort = terminate the worker and respawn** (interrupting Python needs SharedArrayBuffer → COOP/COEP
  headers, which we don't control on hosted apps). Globals are lost; the next result carries a `note`.
- **FS sync:** before each run, only /data and /work files changed by size/mtime (plus deletions) are pushed into
  Pyodide's MEMFS; after the run, changed/deleted files are pushed back to the VFS.

## Cold load (empty cache): 13.7–15.7 s, 23.8 MB transferred
| Phase | Time |
|---|---|
| Interpreter core | 3.5 s |
| numpy | 0.7–0.9 s |
| pyarrow (+ pandas, pytz, dateutil, six wheels) | 3.8–5.9 s |
| `import pandas` (CPU) | 5.3–5.6 s |

Without pyarrow: ~10 s. Largest transfers: pyarrow 9.9 MB, pandas 4.2 MB, `pyodide.asm.wasm` 3.4 MB (brotli; 9.6 MB
raw), numpy 2.9 MB, stdlib 2.5 MB.

**Second load (same browser context): 11.7–12.1 s.** Everything is cached except the 9.9 MB pyarrow wheel (likely
an in-memory cache limit of Playwright's ephemeral contexts; not verified on a real Chrome profile, and Cache
Storage would make caching deterministic). The rest is CPU (~2.7 s interpreter + ~5 s `import pandas`).
Restarting the worker in-page takes ~11.5 s. Mitigation: `prewarmPython()` while the user types.

## Warm latency
- Trivial run: median 8 ms, p95 13 ms.
- 1k-row parquet read + groupby: ~250 ms.
- 1M-row parquet (13.9 MB): sync ~1 ms out / 8.5 ms in, `read_parquet` 480 ms.

## Memory & max DataFrame size (8 mixed columns)
| Rows | DataFrame | WASM heap | Groupby | Sort |
|---|---|---|---|---|
| 100k | 6 MB | 156 MB | 0.1 s | 0.1 s |
| 1M | 63 MB | 323 MB | 0.2 s | 0.5 s |
| 5M | 315 MB | 950 MB | 0.8 s | 4 s |
| 10M | 630 MB | 2.1 GB | 1.6 s | 8.5 s |
| 20M | 1.26 GB | 4.0 GB | 2.8 s | 20 s |
| 30M | — | 4.17 GB | MemoryError | — |

The baseline heap after loading is ~130 MB. The heap never shrinks; peak is ~3× the DataFrame size. The 4 GB
wasm32 limit is the hard ceiling, and hitting it gives a clean `MemoryError` (the worker survives). **Practical
interactive limit ≈ 5M rows × 8 columns.** Aggregate in BigQuery/DuckDB first.

## Hosted-app size limits (25 MB/file, 50 MB total)
Self-hosted Pyodide plus these packages is ~31.5 MB in 12 files (largest is the 10 MB pyarrow wheel), which fits
alone. But the DuckDB-wasm binary is 35.9 MB, so **both can't be self-hosted in one bundle** → load both from the
CDN (the default). To self-host Pyodide: copy the files to `public/pyodide/` (with the matching
`pyodide-lock.json`) and set `VITE_PYODIDE_INDEX_URL=./pyodide/`.

## Test environment note
Playwright needs `launchOptions.proxy` from `HTTPS_PROXY` and `PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK=1`
in this container, otherwise localhost requests go through the proxy and get a 405.
