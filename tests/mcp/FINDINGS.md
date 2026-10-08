# MCP from the browser — findings

Endpoint: `https://ai-gcp-us-east1.api.carto.com/mcp/<accountId>` (Streamable HTTP, `Authorization: Bearer <CARTO token>`).
Tested from headless Chromium (origin `http://localhost:5176`) with a real user OAuth token, plus a local mock server in 3 modes.

## Results
- **CORS:** works with auth. `access-control-allow-origin: *` on every response. Preflight allows
  `authorization, content-type, mcp-session-id, mcp-protocol-version` — but **not** `last-event-id`
  (SSE resumability across a dropped stream would fail preflight; irrelevant for short calls).
- **Sessions:** the server is **stateless** — `mcp-session-id` is never issued, so the missing
  `Access-Control-Expose-Headers: mcp-session-id` is harmless today. Mock test shows the failure mode if a
  server issues session ids without exposing the header: both SDK and raw clients fail with
  `400 No valid session ID`. (Ask CARTO to expose it anyway, for future-proofing.)
- **Streaming:** POST responses are `text/event-stream`. The SDK's standalone GET SSE stream gets 405, which
  the SDK tolerates.
- **Latency:** connect ≈ 1.7 s (SDK) / 2.3 s (raw JSON-RPC); `tools/list` ≈ 1.1 s.
- **Tool surface (`tools/list`, 80 tools):** 35 built-in (`explore_data`, `execute_query`,
  `execute_async_query`, `read_workflows`, `run_workflow`, `geocode`, `route`, `manage_*`, `admin_carto`,
  `delete`, …), 2 async-job tools (`async_workflow_job_get_status_v1_0_0`, `..._get_results_v1_0_0`) and ~43
  published workflow tools. The CLI's `list_workflow_mcp_tools` is not in `tools/list`; the CLI does a single
  `tools/call` without `initialize`.
- **Calls:** `execute_query` (`SELECT 1` on `carto_dw`) works, 1.2 s. `explore_data` (connections) returned
  >320K chars → capped to 6K. `DROP` blocked client-side by our SQL guard.
- **`destructiveHint` is not useful:** the server sets it on `execute_query` and every workflow tool, so the
  client filters by name (denylist of write/admin tools, max 60 exposed; override `VITE_CARTO_MCP_TOOLS`).

## Auth model
- User OAuth token (auth.carto.com, PKCE public client — what CLI and hosted apps use) → **full** tool surface,
  including admin/delete. In a client-side agent this means a prompt injection could invoke destructive tools
  with the viewer's privileges; client-side filtering is a mitigation, not a boundary.
- CARTO API access tokens → reduced subset (≤ 14 tools), no workflow execution.
- Hosted-app viewer token (`carto-info.json`) not yet verified on a deploy; expected to behave like the user token.

## Third-party BigQuery MCP
- Google's managed BigQuery MCP: **not browser-viable** — `OPTIONS` preflight returns 404 (no CORS), and it
  needs per-user Google OAuth. MCP Toolbox for Databases is a server you'd host. Either requires a proxy.

## Recommendation
Use CARTO's MCP with the viewer token via the SDK Streamable HTTP transport (raw JSON-RPC fallback), with a
tight tool allowlist per app. Prefer the CARTO SQL API directly for the bulk-data path (`bq_query` → Parquet),
since MCP tool results are text meant for the model's context.

## Open
- Async workflow result shape unverified (not invoked: workflow tools write tables).
- ~60 tools by default is token-heavy; demo 2 should use an allowlist.
- SDK pulls ajv into the bundle (~100 KB+).
