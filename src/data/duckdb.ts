/**
 * Lazy DuckDB-WASM singleton (runs in its own Web Worker) bridged to the shared VFS.
 *
 * Bundling: duckdb-eh.wasm is ~36 MB (mvp 41 MB) — over the 25 MB/file CARTO Hosted App limit —
 * so the default is jsDelivr (CORS-enabled, immutable-cached). Alternative: 'base-url' pointing at
 * any host serving the dist files; with gz:true it fetches `<file>.wasm.gz` (~8 MB, fits the
 * hosted-app limit) and inflates it in the browser with DecompressionStream.
 */
import * as duckdb from '@duckdb/duckdb-wasm';
import { tableToIPC } from 'apache-arrow';
import { fs, writeFile } from '../vfs/vfs';
import { planColumns, rowsToArrow, type ColumnPlan } from './ingest';
import type { SqlSchemaField } from '../carto/sql';

// ───────────────────────────── config ─────────────────────────────

export type DuckDbBundleSource =
  | { kind: 'jsdelivr' }
  /** Directory serving duckdb-browser-{eh,mvp}.worker.js and duckdb-{eh,mvp}.wasm[.gz] */
  | { kind: 'base-url'; baseUrl: string; gz?: boolean };

export const DUCKDB_CONFIG: { source: DuckDbBundleSource; parquetCompression: string } = {
  source: { kind: 'jsdelivr' },
  parquetCompression: 'zstd',
};

export function configureDuckDb(source: DuckDbBundleSource) {
  if (dbPromise) throw new Error('DuckDB already initialised; configure before first use');
  DUCKDB_CONFIG.source = source;
}

export interface DuckDbTimings {
  bundle?: string;
  source?: string;
  /** fetch + compile + instantiate the wasm (includes network). */
  instantiateMs?: number;
  openMs?: number;
  firstQueryMs?: number;
  totalColdStartMs?: number;
  wasmBytes?: number;
}
const timings: DuckDbTimings = {};
export function getDuckDbTimings(): DuckDbTimings {
  return { ...timings };
}

// ───────────────────────────── singleton ─────────────────────────────

interface Handle {
  db: duckdb.AsyncDuckDB;
  conn: duckdb.AsyncDuckDBConnection;
}
let dbPromise: Promise<Handle> | null = null;

export function getDuckDb(): Promise<Handle> {
  dbPromise ??= init().catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}
export function isDuckDbReady() {
  return timings.totalColdStartMs !== undefined;
}

async function resolveBundle(): Promise<{ bundle: duckdb.DuckDBBundle; cleanup: string[] }> {
  const src = DUCKDB_CONFIG.source;
  if (src.kind === 'jsdelivr') return { bundle: await duckdb.selectBundle(duckdb.getJsDelivrBundles()), cleanup: [] };
  const base = new URL(src.baseUrl.replace(/\/?$/, '/'), location.href).href;
  const ext = src.gz ? '.wasm.gz' : '.wasm';
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: `${base}duckdb-mvp${ext}`, mainWorker: `${base}duckdb-browser-mvp.worker.js` },
    eh: { mainModule: `${base}duckdb-eh${ext}`, mainWorker: `${base}duckdb-browser-eh.worker.js` },
  });
  if (!src.gz) return { bundle, cleanup: [] };
  const res = await fetch(bundle.mainModule);
  if (!res.ok || !res.body) throw new Error(`Failed to fetch ${bundle.mainModule}: HTTP ${res.status}`);
  const inflated = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).blob();
  const url = URL.createObjectURL(new Blob([inflated], { type: 'application/wasm' }));
  timings.wasmBytes = inflated.size;
  return { bundle: { ...bundle, mainModule: url }, cleanup: [url] };
}

async function init(): Promise<Handle> {
  const t0 = performance.now();
  const { bundle, cleanup } = await resolveBundle();
  timings.bundle = bundle.mainModule.includes('-eh') || bundle.mainWorker?.includes('-eh') ? 'eh' : 'mvp';
  timings.source = DUCKDB_CONFIG.source.kind + ((DUCKDB_CONFIG.source as any).gz ? '+gz' : '');
  // Cross-origin worker scripts are not allowed directly → Blob trampoline.
  const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker!}");`], { type: 'text/javascript' }));
  const worker = new Worker(workerUrl);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  cleanup.forEach((u) => URL.revokeObjectURL(u));
  const t1 = performance.now();
  timings.instantiateMs = Math.round(t1 - t0);
  await db.open({ query: { castDecimalToDouble: true, castBigIntToDouble: false } });
  const conn = await db.connect();
  const t2 = performance.now();
  timings.openMs = Math.round(t2 - t1);
  await conn.query('SELECT 42');
  const t3 = performance.now();
  timings.firstQueryMs = Math.round(t3 - t2);
  timings.totalColdStartMs = Math.round(t3 - t0);
  return { db, conn };
}

/** Serialize all DuckDB work (single connection; register/drop file races otherwise). */
let chain: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: (h: Handle) => Promise<T>): Promise<T> {
  const run = chain.then(async () => fn(await getDuckDb()));
  chain = run.catch(() => {});
  return run;
}

// ───────────────────────────── VFS ↔ DuckDB files ─────────────────────────────

const DATA_EXT = /\.(parquet|csv|tsv|json|jsonl|ndjson|txt|arrow)$/i;
const registered = new Map<string, string>(); // path → signature (size:mtime)

async function walk(dir: string, out: string[]) {
  if (!(await fs.exists(dir))) return;
  for (const name of await fs.readdir(dir)) {
    const p = `${dir}/${name}`;
    const st = await fs.stat(p);
    if (st.isDirectory) await walk(p, out);
    else if (DATA_EXT.test(p)) out.push(p);
  }
}

async function registerBytes(db: duckdb.AsyncDuckDB, path: string, bytes: Uint8Array, sig: string) {
  if (registered.has(path)) await db.dropFile(path).catch(() => {});
  // registerFileBuffer TRANSFERS the buffer to the worker → always hand over a copy.
  await db.registerFileBuffer(path, bytes.slice());
  registered.set(path, sig);
}

/**
 * Make every data file under /data and /work visible to DuckDB under the same absolute path,
 * so SQL can say FROM '/data/orders.parquet'. Incremental (size+mtime signature).
 */
export function registerVfsFiles(roots = ['/data', '/work']): Promise<{ registered: number; changed: string[] }> {
  return exclusive(async ({ db }) => {
    const paths: string[] = [];
    for (const r of roots) await walk(r, paths);
    const changed: string[] = [];
    for (const p of paths) {
      const st = await fs.stat(p);
      const sig = `${st.size}:${+st.mtime}`;
      if (registered.get(p) === sig) continue;
      await registerBytes(db, p, await fs.readFileBuffer(p), sig);
      changed.push(p);
    }
    const live = new Set(paths);
    for (const p of [...registered.keys()])
      if (roots.some((r) => p.startsWith(r + '/')) && !live.has(p)) {
        await db.dropFile(p).catch(() => {});
        registered.delete(p);
      }
    return { registered: registered.size, changed };
  });
}

async function writeVfsAndRegister(db: duckdb.AsyncDuckDB, path: string, bytes: Uint8Array) {
  await writeFile(path, bytes);
  const st = await fs.stat(path);
  await registerBytes(db, path, bytes, `${st.size}:${+st.mtime}`);
}

// ───────────────────────────── queries ─────────────────────────────

export interface QueryColumn {
  name: string;
  type: string;
}
export interface QueryResult {
  columns: QueryColumn[];
  rows: Record<string, unknown>[];
  rowCount: number;
  elapsedMs: number;
}

function arrowTypeName(t: any): string {
  const s = String(t);
  return s
    .replace(/^Timestamp<(\w+)(, .*)?>$/, 'TIMESTAMP')
    .replace(/^Date32<DAY>$|^Date64<.*>$/, 'DATE')
    .replace(/^Int64$/, 'BIGINT')
    .replace(/^Int32$/, 'INTEGER')
    .replace(/^Float64$/, 'DOUBLE')
    .replace(/^Utf8$|^LargeUtf8$/, 'VARCHAR')
    .replace(/^Bool$/, 'BOOLEAN');
}

/** JSON-friendly scalar for the model/UI. */
function toPlain(v: unknown, type: string): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (type === 'TIMESTAMP' && typeof v === 'number') return new Date(v).toISOString().replace('.000Z', 'Z');
  if (type === 'DATE' && typeof v === 'number') return new Date(v).toISOString().slice(0, 10);
  if (v instanceof Uint8Array) return `<${v.byteLength} bytes>`;
  if (typeof v === 'object') {
    const j = (v as any).toJSON ? (v as any).toJSON() : v;
    return JSON.parse(JSON.stringify(j, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
  }
  return v;
}

/** Structural type: duckdb-wasm bundles its own apache-arrow (v17) so its Tables are a different class. */
export interface ArrowLike {
  numRows: number;
  schema: { fields: { name: string; type: unknown }[] };
  getChild(name: string): { get(i: number): unknown } | null;
}

export function tableToRows(t: ArrowLike, limit = Infinity): { columns: QueryColumn[]; rows: Record<string, unknown>[] } {
  const columns = t.schema.fields.map((f) => ({ name: f.name, type: arrowTypeName(f.type) }));
  const n = Math.min(t.numRows, limit);
  const vecs = t.schema.fields.map((_f, j) => (t as any).getChildAt?.(j) ?? t.getChild(columns[j].name)!);
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < n; i++) {
    const r: Record<string, unknown> = {};
    columns.forEach((c, j) => (r[c.name] = toPlain(vecs[j].get(i), c.type)));
    rows.push(r);
  }
  return { columns, rows };
}

const TABULAR = /^\s*(\(\s*)*(SELECT|WITH|FROM|VALUES|TABLE|PIVOT|UNPIVOT)\b/i;

/**
 * Run SQL locally. Tabular statements are materialized once into a temp table so we can count
 * rows and return only `maxRows`; other statements (CREATE, COPY, DESCRIBE, SUMMARIZE…) run as-is.
 */
export function query(sql: string, opts: { maxRows?: number } = {}): Promise<QueryResult> {
  const maxRows = opts.maxRows ?? 50;
  return exclusive(async ({ conn }) => {
    const t0 = performance.now();
    const body = sql.trim().replace(/;\s*$/, '');
    if (TABULAR.test(body) && !body.includes(';')) {
      await conn.query(`CREATE OR REPLACE TEMP TABLE __last_result AS ${body}`);
      const cnt = await conn.query('SELECT count(*)::DOUBLE AS n FROM __last_result');
      const rowCount = Number(cnt.getChildAt(0)?.get(0) ?? 0);
      const t = await conn.query(`SELECT * FROM __last_result LIMIT ${maxRows}`);
      return { ...tableToRows(t), rowCount, elapsedMs: Math.round(performance.now() - t0) };
    }
    const t = await conn.query(body);
    return { ...tableToRows(t, maxRows), rowCount: t.numRows, elapsedMs: Math.round(performance.now() - t0) };
  });
}

/** Low-level escape hatch (no row cap): returns the Arrow table. */
export function queryArrow(sql: string): Promise<ArrowLike> {
  return exclusive(({ conn }) => conn.query(sql));
}

export type ExportFormat = 'parquet' | 'csv' | 'json';
export function formatFromPath(path: string): ExportFormat {
  const m = path.toLowerCase().match(/\.(parquet|csv|json|jsonl|ndjson)$/);
  if (!m) throw new Error(`Unsupported output extension for ${path} (use .parquet, .csv or .json)`);
  return m[1] === 'parquet' ? 'parquet' : m[1] === 'csv' ? 'csv' : 'json';
}
function copyOptions(f: ExportFormat) {
  return f === 'parquet'
    ? `(FORMAT parquet, COMPRESSION ${DUCKDB_CONFIG.parquetCompression})`
    : f === 'csv'
      ? '(FORMAT csv, HEADER true)'
      : '(FORMAT json)';
}

let tmpCounter = 0;
async function copyToVfs(h: Handle, selectSql: string, path: string, format: ExportFormat): Promise<number> {
  const tmp = `/__tmp_export_${++tmpCounter}.${format}`;
  await h.db.registerEmptyFileBuffer(tmp);
  try {
    await h.conn.query(`COPY (${selectSql}) TO '${tmp}' ${copyOptions(format)}`);
    const bytes = await h.db.copyFileToBuffer(tmp);
    await writeVfsAndRegister(h.db, path, bytes);
    return bytes.byteLength;
  } finally {
    await h.db.dropFile(tmp).catch(() => {});
  }
}

/** Run `sql` and write the FULL result to the VFS at `path` (format from extension unless given). */
export function exportToVfs(sql: string, path: string, format?: ExportFormat): Promise<{ path: string; bytes: number; rowCount: number }> {
  const f = format ?? formatFromPath(path);
  return exclusive(async (h) => {
    const body = sql.trim().replace(/;\s*$/, '');
    await h.conn.query(`CREATE OR REPLACE TEMP TABLE __export_src AS ${body}`);
    const cnt = await h.conn.query('SELECT count(*)::DOUBLE FROM __export_src');
    const bytes = await copyToVfs(h, 'SELECT * FROM __export_src', path, f);
    await h.conn.query('DROP TABLE IF EXISTS __export_src');
    return { path, bytes, rowCount: Number(cnt.getChildAt(0)?.get(0) ?? 0) };
  });
}

// ───────────────────────────── JSON rows → Parquet ─────────────────────────────

export interface IngestResult {
  path: string;
  rowCount: number;
  columns: QueryColumn[];
  plans: ColumnPlan[];
  bytesInFile: number;
  timings: { arrowMs: number; insertMs: number; parquetMs: number };
}

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** Rows from the CARTO SQL API → typed Arrow → DuckDB temp table → Parquet in the VFS (and registered in DuckDB). */
export function ingestRowsToParquet(rows: Record<string, unknown>[], schema: SqlSchemaField[], path: string): Promise<IngestResult> {
  return exclusive(async (h) => {
    const t0 = performance.now();
    const plans = planColumns(schema, rows);
    const tbl = '__ingest';
    await h.conn.query(`DROP TABLE IF EXISTS ${tbl}`);
    let arrowMs = 0;
    if (rows.length === 0 || plans.length === 0) {
      const cols = plans.map((p) => `${quoteIdent(p.name)} ${p.kind === 'JSON' ? 'VARCHAR' : p.kind}`).join(', ');
      await h.conn.query(`CREATE TEMP TABLE ${tbl} (${cols || 'empty_result BOOLEAN'})`);
    } else {
      const ipc = tableToIPC(rowsToArrow(plans, rows), 'stream');
      arrowMs = performance.now() - t0;
      await h.conn.insertArrowFromIPCStream(ipc, { name: tbl, create: true });
    }
    const t1 = performance.now();
    const bytesInFile = await copyToVfs(h, `SELECT * FROM ${tbl}`, path, 'parquet');
    const t2 = performance.now();
    await h.conn.query(`DROP TABLE IF EXISTS ${tbl}`);
    const d = await h.conn.query(`DESCRIBE SELECT * FROM read_parquet('${path}')`);
    const columns = d
      .toArray()
      .map((r: any) => ({ name: String(r.column_name), type: String(r.column_type) }));
    return {
      path,
      rowCount: rows.length,
      columns,
      plans,
      bytesInFile,
      timings: { arrowMs: Math.round(arrowMs), insertMs: Math.round(t1 - t0 - arrowMs), parquetMs: Math.round(t2 - t1) },
    };
  });
}

/**
 * Rows → typed Arrow → a DuckDB table `name` (replaced if it exists). No file is written: used for attachments
 * (att_<id>) and BigQuery results that are only joined locally. Empty schema = infer types from the values.
 */
export function loadRowsAsTable(name: string, rows: Record<string, unknown>[], schema: SqlSchemaField[] = []): Promise<{ table: string; rowCount: number; columns: QueryColumn[] }> {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)) throw new Error(`Invalid table name "${name}" (letters, digits, _)`);
  return exclusive(async (h) => {
    await h.conn.query(`DROP TABLE IF EXISTS ${quoteIdent(name)}`);
    const plans = planColumns(schema, rows);
    if (!rows.length || !plans.length) {
      const cols = plans.map((p) => `${quoteIdent(p.name)} ${p.kind === 'JSON' ? 'VARCHAR' : p.kind}`).join(', ');
      await h.conn.query(`CREATE TABLE ${quoteIdent(name)} (${cols || 'empty_result BOOLEAN'})`);
    } else await h.conn.insertArrowFromIPCStream(tableToIPC(rowsToArrow(plans, rows), 'stream'), { name, create: true });
    const d = await h.conn.query(`DESCRIBE ${quoteIdent(name)}`);
    const columns = d.toArray().map((r: any) => ({ name: String(r.column_name), type: String(r.column_type) }));
    return { table: name, rowCount: rows.length, columns };
  });
}

/** Bulk path: store a parquet file (e.g. from the CARTO Exports API) in the VFS and describe it. */
export function storeParquet(bytes: Uint8Array, path: string): Promise<{ path: string; rowCount: number; columns: QueryColumn[]; bytesInFile: number }> {
  return exclusive(async (h) => {
    await writeVfsAndRegister(h.db, path, bytes);
    const d = await h.conn.query(`DESCRIBE SELECT * FROM read_parquet('${path}')`);
    const cnt = await h.conn.query(`SELECT count(*)::DOUBLE FROM read_parquet('${path}')`);
    return {
      path,
      rowCount: Number(cnt.getChildAt(0)?.get(0) ?? 0),
      columns: d.toArray().map((r: any) => ({ name: String(r.column_name), type: String(r.column_type) })),
      bytesInFile: bytes.byteLength,
    };
  });
}
