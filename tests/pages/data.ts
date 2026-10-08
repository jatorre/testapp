// Test harness page for the data layer (CARTO SQL API client, DuckDB-WASM, bq_* / duckdb_query tools).
// Exposes window.__dataTest for Playwright (tests/data/*.spec.ts). Never logs the CARTO token.
import {
  SQL_CONFIG,
  applyRowCap,
  assertReadOnlySelect,
  extractTableRefs,
  getQueryLog,
  getSessionBytesProcessed,
  resetSessionBytes,
  runSql,
} from '../../src/carto/sql';
import { getCartoInfo, getConnectionName } from '../../src/carto/info';
import {
  configureDuckDb,
  getDuckDb,
  getDuckDbTimings,
  ingestRowsToParquet,
  query,
  registerVfsFiles,
} from '../../src/data/duckdb';
import { createBigQueryTools } from '../../src/tools/bigquery';
import { createDuckDbTools } from '../../src/tools/duckdb';
import { listFiles, readBytes, readText, writeFile } from '../../src/vfs/vfs';

const params = new URLSearchParams(location.search);
if (params.get('duckBase')) configureDuckDb({ kind: 'base-url', baseUrl: params.get('duckBase')!, gz: params.get('gz') === '1' });

const tools = Object.fromEntries([...createBigQueryTools(), ...createDuckDbTools()].map((t) => [t.name, t]));
const ctx = { emitArtifact: () => {} };

const heap = () => {
  const m = (performance as any).memory;
  return m ? { usedMB: Math.round(m.usedJSHeapSize / 1e6), totalMB: Math.round(m.totalJSHeapSize / 1e6), limitMB: Math.round(m.jsHeapSizeLimit / 1e6) } : null;
};

const STATUSES = ['Complete', 'Shipped', 'Processing', 'Cancelled', 'Returned'];
const CATS = ['Jeans', 'Tops & Tees', 'Sweaters', 'Shorts', 'Swim', 'Accessories', 'Outerwear & Coats', 'Intimates'];
/** order_items-like rows exactly as the CARTO SQL API serializes BigQuery values. */
function synthRows(n: number, seed = 1) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const base = Date.UTC(2022, 0, 1);
  const rows = new Array(n);
  for (let i = 0; i < n; i++) {
    const ts = base + Math.floor(rnd() * 3 * 365 * 86400_000);
    rows[i] = {
      id: i + 1,
      order_id: Math.floor(i / 2) + 1,
      user_id: Math.floor(rnd() * 100_000),
      status: STATUSES[Math.floor(rnd() * STATUSES.length)],
      category: CATS[Math.floor(rnd() * CATS.length)],
      created_at: new Date(ts).toISOString(),
      shipped_at: rnd() < 0.3 ? null : new Date(ts + 86400_000 * 2).toISOString(),
      order_date: new Date(ts).toISOString().slice(0, 10),
      sale_price: Math.round(rnd() * 20000) / 100,
      is_first: rnd() < 0.2,
    };
  }
  const schema = [
    { name: 'id', type: 'number' },
    { name: 'order_id', type: 'number' },
    { name: 'user_id', type: 'number' },
    { name: 'status', type: 'string' },
    { name: 'category', type: 'string' },
    { name: 'created_at', type: 'timestamp' },
    { name: 'shipped_at', type: 'timestamp' },
    { name: 'order_date', type: 'timestamp' },
    { name: 'sale_price', type: 'number' },
    { name: 'is_first', type: 'boolean' },
  ];
  return { rows, schema };
}

const api = {
  ready: true,
  config: () => ({ ...SQL_CONFIG }),
  setSqlConfig: (patch: Partial<typeof SQL_CONFIG>) => Object.assign(SQL_CONFIG, patch),
  heap,
  coldStart: async () => {
    const t0 = performance.now();
    await getDuckDb();
    return { wallMs: Math.round(performance.now() - t0), ...getDuckDbTimings() };
  },
  timings: getDuckDbTimings,
  guard: (sql: string) => {
    try {
      return { ok: true, sql: assertReadOnlySelect(sql) };
    } catch (e: any) {
      return { ok: false, error: String(e.message) };
    }
  },
  rowCap: (sql: string, cap: number) => applyRowCap(sql, cap),
  tableRefs: (sql: string) => extractTableRefs(sql),
  tool: async (name: string, input: unknown) => {
    try {
      const out = await tools[name].execute(input as any, ctx);
      return { ok: true, out, chars: JSON.stringify(out).length };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  },
  toolMeta: () => Object.values(tools).map((t) => ({ name: t.name, description: t.description })),
  duck: (sql: string, maxRows = 50) => registerVfsFiles().then(() => query(sql, { maxRows })),
  files: () => listFiles('/'),
  readText,
  fileSize: async (p: string) => (await readBytes(p)).byteLength,
  fileBase64: async (p: string) => {
    const b = await readBytes(p);
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s);
  },
  writeFile: (p: string, s: string) => writeFile(p, s),
  sessionBytes: getSessionBytesProcessed,
  queryLog: () => getQueryLog().map((q) => ({ ...q, sql: q.sql.slice(0, 120) })),
  resetSessionBytes,
  connection: getConnectionName,
  infoSource: async () => (await getCartoInfo()).source,

  /** Scaling benchmark: synth rows → JSON text (≈ API response) → parse → Arrow → DuckDB → Parquet → aggregate. */
  bench: async (n: number) => {
    const out: Record<string, unknown> = { n };
    let t = performance.now();
    let { rows, schema } = synthRows(n);
    out.genMs = Math.round(performance.now() - t);
    t = performance.now();
    let text: string | null = JSON.stringify({ rows, schema, meta: { cacheHit: false, totalBytesProcessed: '0' } });
    out.jsonMB = +(text.length / 1e6).toFixed(1);
    out.stringifyMs = Math.round(performance.now() - t);
    rows = null as any;
    t = performance.now();
    const parsed = JSON.parse(text);
    out.parseMs = Math.round(performance.now() - t);
    out.heapAfterParse = heap();
    text = null;
    t = performance.now();
    const ing = await ingestRowsToParquet(parsed.rows, parsed.schema, `/data/bench_${n}.parquet`);
    out.ingestMs = Math.round(performance.now() - t);
    out.ingestBreakdown = ing.timings;
    out.parquetMB = +(ing.bytesInFile / 1e6).toFixed(2);
    out.columns = ing.columns.map((c) => `${c.name}:${c.type}`).join(',');
    parsed.rows.length = 0;
    t = performance.now();
    const agg = await query(
      `SELECT category, date_trunc('month', created_at) m, count(*) n, sum(sale_price) rev
       FROM '/data/bench_${n}.parquet' WHERE status <> 'Cancelled' GROUP BY ALL ORDER BY rev DESC`,
      { maxRows: 5 },
    );
    out.aggMs = Math.round(performance.now() - t);
    out.aggRows = agg.rowCount;
    out.heapEnd = heap();
    return out;
  },

  /** Raw POST to the SQL API (real-API probes of extra body params). Returns status + clipped body only. */
  rawSql: async (body: Record<string, unknown>, path = 'query') => {
    const info = await getCartoInfo();
    const t0 = performance.now();
    const res = await fetch(`${info.apiBaseUrl}/v3/sql/${getConnectionName()}/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${info.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, ms: Math.round(performance.now() - t0), chars: text.length, body: text.slice(0, 1500) };
  },
  rawGet: async (path: string) => {
    const info = await getCartoInfo();
    const res = await fetch(`${info.apiBaseUrl}${path}`, { headers: { Authorization: `Bearer ${info.accessToken}` } });
    const text = await res.text();
    return { status: res.status, body: text.slice(0, 3000) };
  },
  /** Real SQL API timing: fetch + parse only (no ingest). */
  realFetch: async (sql: string) => {
    const t0 = performance.now();
    const r = await runSql(sql);
    const fetchMs = Math.round(performance.now() - t0);
    const h = heap();
    const t1 = performance.now();
    const ing = await ingestRowsToParquet(r.rows, r.schema, '/data/real_probe.parquet');
    return {
      rows: r.rows.length,
      responseMB: +(r.responseChars / 1e6).toFixed(1),
      fetchAndParseMs: fetchMs,
      serverElapsedMs: r.elapsedMs,
      ingestMs: Math.round(performance.now() - t1),
      parquetMB: +(ing.bytesInFile / 1e6).toFixed(2),
      bytesProcessed: r.bytesProcessed,
      cacheHit: r.meta.cacheHit,
      heapAfterParse: h,
      columns: ing.columns.map((c) => `${c.name}:${c.type}`).join(','),
      apiSchema: r.schema.map((c) => `${c.name}:${c.type}`).join(','),
    };
  },
};

(window as any).__dataTest = api;
document.getElementById('status')!.textContent = 'ready';
