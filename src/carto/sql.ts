/**
 * CARTO SQL API client (+ Exports API) and the read-only / cost safety layer.
 *
 * Verified against the real API (see tests/data/FINDINGS.md):
 *  - POST {apiBaseUrl}/v3/sql/{connection}/query  body {q, queryParameters}
 *    → {rows: [...], schema: [{name, type}], meta: {cacheHit, totalBytesProcessed, location}}
 *    schema types are CARTO-normalized: number | bigint | string | geometry | timestamp |
 *    object | boolean | variant | unknown | array (DATE/DATETIME come back as "timestamp",
 *    INT64 as "number" — and as a JSON number, so > 2^53 loses precision server-side).
 *  - Results are SILENTLY capped at 200,000 rows. Synchronous timeout 60 s (HTTP 408
 *    "ProviderTimeoutError"). Errors: {status, error, rows: []} (+ code/title/detail on catalog errors).
 *  - Multi-statement scripts ARE executed (the last statement's rows are returned), so DML/DDL
 *    is only bounded by the viewer's warehouse permissions → assertReadOnlySelect() is essential.
 *  - No way to pass maximumBytesBilled / dryRun on /query. meta.totalBytesProcessed is reported
 *    AFTER the fact; we track it per session and enforce a session budget.
 *  - CORS: any Origin is reflected on api.carto.com; export download URLs (GCS) send ACAO: *.
 */
import { getCartoInfo, getConnectionName } from './info';

// ───────────────────────────── configuration ─────────────────────────────

export const SQL_CONFIG = {
  /** Hard cap enforced by the CARTO SQL API (silent truncation). */
  apiRowCap: 200_000,
  /** Our own cap: we append LIMIT maxRows+1 so truncation is detectable. Must be < apiRowCap. */
  maxRows: 100_000,
  /** Client-side timeout (server gives up at 60 s with 408). */
  timeoutMs: 75_000,
  /** Upper-bound pre-flight: refuse if referenced tables' total size exceeds this and there is no WHERE. */
  preflight: true,
  maxScanUpperBoundBytes: 50 * 1024 ** 3,
  /** Hard stop once the session has processed this many bytes (post-hoc, from meta.totalBytesProcessed). */
  sessionBytesBudget: 200 * 1024 ** 3,
};

// ───────────────────────────── session accounting ─────────────────────────────

export interface QueryLogEntry {
  at: number;
  sql: string;
  bytesProcessed: number;
  cacheHit?: boolean;
  rows: number;
  elapsedMs: number;
  transport: 'sql' | 'export' | 'metadata';
}
const queryLog: QueryLogEntry[] = [];
let sessionBytes = 0;
const bytesListeners = new Set<() => void>();

/** Total BigQuery bytes processed in this page session (for the UI). */
export function getSessionBytesProcessed(): number {
  return sessionBytes;
}
export function getQueryLog(): readonly QueryLogEntry[] {
  return queryLog;
}
export function onSessionBytesChange(l: () => void) {
  bytesListeners.add(l);
  return () => bytesListeners.delete(l);
}
export function resetSessionBytes() {
  sessionBytes = 0;
  queryLog.length = 0;
  bytesListeners.forEach((l) => l());
}
function record(e: QueryLogEntry) {
  sessionBytes += e.bytesProcessed;
  queryLog.push(e);
  bytesListeners.forEach((l) => l());
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

// ───────────────────────────── errors ─────────────────────────────

export class CartoSqlError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'CartoSqlError';
    this.status = status;
    this.body = body;
  }
}

function explainStatus(status: number, apiMsg: string): string {
  switch (status) {
    case 400:
      return `BigQuery rejected the query: ${apiMsg}`;
    case 401:
      return `CARTO token rejected (expired or missing) — reload the app. ${apiMsg}`;
    case 403:
      return `Permission denied: ${apiMsg}`;
    case 404:
      return `Not found (check the connection name): ${apiMsg}`;
    case 408:
      return `Query exceeded the CARTO SQL API 60 s limit (${apiMsg}). Aggregate more in SQL, filter on partition/date columns, or select fewer columns.`;
    case 429:
      return `Rate limited by CARTO: ${apiMsg}`;
    default:
      return `CARTO SQL API HTTP ${status}: ${apiMsg}`;
  }
}

async function readError(res: Response): Promise<CartoSqlError> {
  const text = await res.text().catch(() => '');
  let body: any = text;
  let msg = text.slice(0, 1000) || res.statusText;
  try {
    body = JSON.parse(text);
    msg = [body.error, body.title, body.detail].filter(Boolean).join(' — ') || msg;
  } catch {
    /* not JSON */
  }
  return new CartoSqlError(explainStatus(res.status, msg), res.status, body);
}

// ───────────────────────────── fetch plumbing ─────────────────────────────

/** Combine an external AbortSignal with a timeout. */
function withTimeout(signal: AbortSignal | undefined, ms: number) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new DOMException(`Timed out after ${ms} ms`, 'TimeoutError')), ms);
  const onAbort = () => ctl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) ctl.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctl.signal,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

async function cartoFetch(path: string, init: RequestInit & { timeoutMs?: number; signal?: AbortSignal }) {
  const info = await getCartoInfo();
  const url = `${info.apiBaseUrl.replace(/\/+$/, '')}${path}`;
  const t = withTimeout(init.signal ?? undefined, init.timeoutMs ?? SQL_CONFIG.timeoutMs);
  try {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        ...init,
        signal: t.signal,
        headers: {
          Authorization: `Bearer ${info.accessToken}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers as Record<string, string>),
        },
      });
      // One retry on transient errors that cannot have run the query to completion twice.
      if ((res.status === 429 || res.status === 503) && attempt === 0) {
        const ra = Number(res.headers.get('retry-after')) || 2;
        await new Promise((r) => setTimeout(r, Math.min(ra, 10) * 1000));
        continue;
      }
      return res;
    }
  } catch (e: any) {
    if (t.signal.aborted) {
      const reason = t.signal.reason;
      if (reason?.name === 'TimeoutError') throw new CartoSqlError(String(reason.message), 0);
      throw new CartoSqlError('Query aborted', 0);
    }
    throw new CartoSqlError(`Network error calling CARTO API (${e?.message ?? e}). Check connectivity/CORS.`, 0);
  } finally {
    t.done();
  }
}

/** GET a CARTO API path (e.g. /v3/connections/{c}/resources) as JSON. */
export async function cartoGetJson<T = any>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await cartoFetch(path, { method: 'GET', signal });
  if (!res.ok) throw await readError(res);
  return res.json() as Promise<T>;
}
/** POST JSON to a CARTO API path (e.g. /v3/imports) and return the JSON reply. */
export async function cartoPostJson<T = any>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await cartoFetch(path, { method: 'POST', body: JSON.stringify(body), signal });
  if (!res.ok) throw await readError(res);
  return res.json() as Promise<T>;
}

// ───────────────────────────── SQL API ─────────────────────────────

export interface SqlSchemaField {
  name: string;
  type: string;
}
export interface SqlMeta {
  cacheHit?: boolean;
  totalBytesProcessed?: string | number;
  location?: string;
  [k: string]: unknown;
}
export interface SqlResult {
  rows: Record<string, unknown>[];
  schema: SqlSchemaField[];
  meta: SqlMeta;
  bytesProcessed: number;
  elapsedMs: number;
  /** Size of the JSON response body (characters ≈ bytes). */
  responseChars: number;
}
export interface RunSqlOptions {
  connection?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  queryParameters?: Record<string, unknown> | unknown[];
  /** Internal: classify for the session log. */
  kind?: 'sql' | 'metadata';
}

/** Low-level: run SQL as-is (no guard, no cap). Prefer runReadOnlyQuery(). */
export async function runSql(sql: string, opts: RunSqlOptions = {}): Promise<SqlResult> {
  const conn = opts.connection ?? getConnectionName();
  const t0 = performance.now();
  const res = await cartoFetch(`/v3/sql/${encodeURIComponent(conn)}/query`, {
    method: 'POST',
    body: JSON.stringify({ q: sql, queryParameters: opts.queryParameters ?? {} }),
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
  });
  if (!res.ok) throw await readError(res);
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CartoSqlError(`CARTO SQL API returned non-JSON (${text.slice(0, 200)})`, res.status);
  }
  const elapsedMs = Math.round(performance.now() - t0);
  const meta: SqlMeta = json.meta ?? {};
  const bytesProcessed = Number(meta.totalBytesProcessed ?? 0) || 0;
  const rows = Array.isArray(json.rows) ? json.rows : [];
  record({ at: Date.now(), sql, bytesProcessed, cacheHit: meta.cacheHit, rows: rows.length, elapsedMs, transport: opts.kind ?? 'sql' });
  return { rows, schema: Array.isArray(json.schema) ? json.schema : [], meta, bytesProcessed, elapsedMs, responseChars: text.length };
}

// ───────────────────────────── read-only guard ─────────────────────────────

/**
 * Same-length "skeleton" of a BigQuery statement: comments → spaces, string/bytes literal
 * contents and backtick identifier contents → 'x' (quotes kept), so keyword and paren scans
 * are not fooled and character offsets still line up with the original.
 */
export function sqlSkeleton(sql: string): string {
  const out = sql.split('');
  const n = sql.length;
  let i = 0;
  const blank = (a: number, b: number, ch = ' ') => {
    for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ch;
  };
  while (i < n) {
    const c = sql[i];
    const c2 = sql.slice(i, i + 2);
    if (c2 === '--' || c === '#') {
      const e = sql.indexOf('\n', i);
      const end = e < 0 ? n : e;
      blank(i, end);
      i = end;
    } else if (c2 === '/*') {
      const e = sql.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      blank(i, end);
      i = end;
    } else if (c === '`') {
      const e = sql.indexOf('`', i + 1);
      const end = e < 0 ? n : e;
      blank(i + 1, end, 'x');
      i = end + 1;
    } else if (c === "'" || c === '"') {
      // raw prefix?  r'..' / rb'..' / br'..'
      let p = i - 1;
      let raw = false;
      while (p >= 0 && /[rRbB]/.test(sql[p])) {
        if (/[rR]/.test(sql[p])) raw = true;
        p--;
      }
      if (p >= 0 && /[A-Za-z0-9_]/.test(sql[p])) raw = false; // part of an identifier, not a prefix
      const triple = sql.slice(i, i + 3) === c.repeat(3);
      const q = triple ? c.repeat(3) : c;
      let j = i + q.length;
      while (j < n) {
        if (!raw && sql[j] === '\\') {
          j += 2;
          continue;
        }
        if (sql.slice(j, j + q.length) === q) break;
        if (!triple && sql[j] === '\n') break;
        j++;
      }
      blank(i + q.length, Math.min(j, n), 'x');
      i = Math.min(j + q.length, n);
    } else i++;
  }
  return out.join('');
}

const FORBIDDEN: [RegExp, string][] = [
  [/\bINSERT\s+(INTO\b|`|\w)/i, 'INSERT'],
  [/\bDELETE\s+(FROM\b|`)/i, 'DELETE'],
  [/\bUPDATE\s+\S+\s+(\w+\s+)?SET\b/i, 'UPDATE'],
  [/\bMERGE\s+(INTO\b|`)/i, 'MERGE'],
  [/\b(CREATE|DROP|ALTER|UNDROP)\s+(OR\s+REPLACE\s+)?(TEMP\w*\s+)?(TABLE|VIEW|SCHEMA|FUNCTION|PROCEDURE|MODEL|MATERIALIZED|EXTERNAL|SNAPSHOT|ROW|SEARCH|VECTOR|CAPACITY|RESERVATION|ASSIGNMENT|DATABASE|AGGREGATE)\b/i, 'DDL'],
  [/\bTRUNCATE\s+TABLE\b/i, 'TRUNCATE'],
  [/\bEXPORT\s+(DATA|MODEL)\b/i, 'EXPORT'],
  [/\bLOAD\s+DATA\b/i, 'LOAD DATA'],
  [/\bCALL\s+[\w`]/i, 'CALL'],
  [/\bEXECUTE\s+IMMEDIATE\b/i, 'EXECUTE IMMEDIATE'],
  [/\bDECLARE\s+\w/i, 'DECLARE'],
  [/\bSET\s+@@/i, 'SET system variable'],
  [/\b(GRANT|REVOKE)\s+\w/i, 'GRANT/REVOKE'],
  [/\bBEGIN\s+(TRANSACTION\b|$)/i, 'transaction'],
  [/\bEXTERNAL_QUERY\s*\(/i, 'EXTERNAL_QUERY'],
];

export class ReadOnlyViolation extends Error {
  constructor(msg: string) {
    super(`Rejected by read-only guard: ${msg}. Only a single SELECT (or WITH … SELECT) statement is allowed.`);
    this.name = 'ReadOnlyViolation';
  }
}

/** Throws ReadOnlyViolation unless `sql` is a single read-only SELECT/WITH statement. Returns the trimmed SQL. */
export function assertReadOnlySelect(sql: string): string {
  if (typeof sql !== 'string' || !sql.trim()) throw new ReadOnlyViolation('empty query');
  const sk = sqlSkeleton(sql);
  // drop trailing semicolons/whitespace
  let end = sk.length;
  while (end > 0 && /[\s;]/.test(sk[end - 1])) end--;
  const body = sk.slice(0, end);
  if (body.includes(';')) throw new ReadOnlyViolation('multiple statements (";") are not allowed');
  const first = body.replace(/^[\s(]+/, '').match(/^[A-Za-z_]+/)?.[0]?.toUpperCase();
  if (first !== 'SELECT' && first !== 'WITH')
    throw new ReadOnlyViolation(`statement starts with ${first ?? 'an unexpected token'}`);
  for (const [re, label] of FORBIDDEN) if (re.test(body)) throw new ReadOnlyViolation(`${label} is not allowed`);
  let depth = 0;
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) throw new ReadOnlyViolation('unbalanced parentheses');
  }
  return sql.slice(0, end).trim();
}

/**
 * Enforce a row cap that is detectable: returns SQL that yields at most cap+1 rows.
 * - no top-level trailing LIMIT → append `LIMIT cap+1` (keeps ORDER BY semantics, valid BigQuery)
 * - trailing LIMIT n with n > cap → rewrite n to cap+1
 * NOTE: LIMIT does NOT reduce bytes scanned/billed in BigQuery (verified: a LIMIT 10000 over
 * order_items still processed the full 10.5 MB of the selected columns).
 */
export function applyRowCap(sql: string, cap: number): { sql: string; limit: number } {
  const clean = assertReadOnlySelect(sql);
  const sk = sqlSkeleton(clean);
  const m = sk.match(/\bLIMIT\s+(\d+)(\s+OFFSET\s+\d+)?\s*$/i);
  if (m && m.index !== undefined) {
    const depth = [...sk.slice(0, m.index)].reduce((d, ch) => d + (ch === '(' ? 1 : ch === ')' ? -1 : 0), 0);
    if (depth === 0) {
      const n = Number(m[1]);
      if (n <= cap) return { sql: clean, limit: n };
      const numStart = m.index + m[0].indexOf(m[1]);
      return { sql: clean.slice(0, numStart) + String(cap + 1) + clean.slice(numStart + m[1].length), limit: cap + 1 };
    }
  }
  return { sql: `${clean}\nLIMIT ${cap + 1}`, limit: cap + 1 };
}

// ───────────────────────────── cost pre-flight ─────────────────────────────

/** Fully-qualified `project.dataset.table` references in FROM/JOIN clauses (best effort). */
export function extractTableRefs(sql: string): string[] {
  const refs = new Set<string>();
  const sk = sqlSkeleton(sql);
  const re = /\b(?:FROM|JOIN)\s+((?:`[^`]*`|[A-Za-z0-9_\-*]+)(?:\s*\.\s*(?:`[^`]*`|[A-Za-z0-9_\-*]+)){0,3})/gi;
  for (let m; (m = re.exec(sk)); ) {
    const raw = sql.slice(m.index + m[0].length - m[1].length, m.index + m[0].length);
    const parts = raw
      .split(/`\s*\.\s*`|`\s*\.|\.\s*`|\./)
      .join('.')
      .replace(/`/g, '')
      .split('.')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 3 && !/^INFORMATION_SCHEMA$/i.test(parts[2]) && !/^__TABLES__$/.test(parts[2])) refs.add(parts.join('.'));
  }
  return [...refs];
}

const tableSizeCache = new Map<string, { size: number; rows: number } | null>();

/** Sizes via the free `dataset.__TABLES__` meta-table (0 bytes processed, verified). */
export async function getTableSizes(tables: string[], opts: RunSqlOptions = {}) {
  const byDataset = new Map<string, string[]>();
  for (const t of tables) {
    if (tableSizeCache.has(t)) continue;
    const [p, d, n] = t.split('.');
    const k = `${p}.${d}`;
    byDataset.set(k, [...(byDataset.get(k) ?? []), n]);
  }
  await Promise.all(
    [...byDataset].map(async ([ds, names]) => {
      try {
        const r = await runSql(`SELECT table_id, size_bytes, row_count FROM \`${ds}.__TABLES__\``, { ...opts, kind: 'metadata' });
        const all = new Map(r.rows.map((x: any) => [String(x.table_id), { size: Number(x.size_bytes), rows: Number(x.row_count) }]));
        for (const n of names) {
          if (n.includes('*')) {
            const re = new RegExp('^' + n.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
            const hits = [...all].filter(([k]) => re.test(k));
            tableSizeCache.set(`${ds}.${n}`, { size: hits.reduce((a, [, v]) => a + v.size, 0), rows: hits.reduce((a, [, v]) => a + v.rows, 0) });
          } else tableSizeCache.set(`${ds}.${n}`, all.get(n) ?? null);
        }
      } catch {
        for (const n of names) tableSizeCache.set(`${ds}.${n}`, null);
      }
    }),
  );
  return Object.fromEntries(tables.map((t) => [t, tableSizeCache.get(t) ?? null]));
}

export interface Preflight {
  upperBoundBytes: number | null;
  tables: Record<string, { size: number; rows: number } | null>;
  warning?: string;
}

/**
 * Best available pre-flight without a BigQuery dry run: an UPPER BOUND on bytes scanned =
 * total size of referenced tables (real scans are smaller with column pruning / partition filters).
 * Throws when the bound exceeds the cap and the query has no WHERE (nothing can prune partitions).
 */
export async function preflight(sql: string, opts: RunSqlOptions = {}): Promise<Preflight> {
  if (sessionBytes >= SQL_CONFIG.sessionBytesBudget)
    throw new CartoSqlError(
      `Session BigQuery budget exhausted (${formatBytes(sessionBytes)} processed ≥ ${formatBytes(SQL_CONFIG.sessionBytesBudget)}). Work with the files already in /data.`,
      0,
    );
  const refs = extractTableRefs(sql);
  if (!SQL_CONFIG.preflight || !refs.length) return { upperBoundBytes: null, tables: {} };
  const tables = await getTableSizes(refs, opts);
  const known = Object.values(tables).filter(Boolean) as { size: number }[];
  const upper = known.length ? known.reduce((a, b) => a + b.size, 0) : null;
  const res: Preflight = { upperBoundBytes: upper, tables };
  if (upper !== null && upper > SQL_CONFIG.maxScanUpperBoundBytes) {
    const hasWhere = /\bWHERE\b/i.test(sqlSkeleton(sql));
    const msg = `referenced tables total ${formatBytes(upper)} (cap ${formatBytes(SQL_CONFIG.maxScanUpperBoundBytes)})`;
    if (!hasWhere)
      throw new CartoSqlError(
        `Refused: ${msg} and the query has no WHERE clause. Filter on the partition/date column and select only needed columns.`,
        0,
      );
    res.warning = `${msg}; relying on WHERE/partition pruning — cost unknown until it runs.`;
  }
  return res;
}

export interface ReadOnlyQueryResult extends SqlResult {
  truncated: boolean;
  executedSql: string;
  preflight: Preflight;
}

/** Guard + pre-flight + row cap + run. This is what tools should call. */
export async function runReadOnlyQuery(sql: string, opts: RunSqlOptions & { maxRows?: number } = {}): Promise<ReadOnlyQueryResult> {
  const cap = Math.min(opts.maxRows ?? SQL_CONFIG.maxRows, SQL_CONFIG.apiRowCap - 1);
  const { sql: executedSql } = applyRowCap(sql, cap);
  const pf = await preflight(executedSql, opts);
  const r = await runSql(executedSql, opts);
  const truncated = r.rows.length > cap || r.rows.length >= SQL_CONFIG.apiRowCap;
  if (r.rows.length > cap) r.rows.length = cap;
  return { ...r, truncated, executedSql, preflight: pf };
}

// ───────────────────────────── Exports API (bulk path) ─────────────────────────────

export interface ExportResult {
  bytes: Uint8Array;
  rowCount: number;
  fileSize: number;
  elapsedMs: number;
  jobId: string;
}

/**
 * Bulk path: POST /v3/exports {type:'query', format:'geoparquet'} → poll → fetch the signed GCS
 * URL (ACAO: *). Verified via the CLI with a table source: 181k rows → 2.2 MB parquet in ~11 s
 * (vs 27 MB JSON / 19 s through /query) and no 200k row cap. `type:'query'` is documented but
 * not yet verified live. bytesProcessed is not reported by this API.
 */
export async function exportQueryToParquet(
  sql: string,
  opts: { connection?: string; signal?: AbortSignal; pollMs?: number; maxWaitMs?: number; onStatus?: (s: string) => void } = {},
): Promise<ExportResult> {
  const clean = assertReadOnlySelect(sql);
  await preflight(clean, opts);
  const t0 = performance.now();
  const conn = opts.connection ?? getConnectionName();
  const res = await cartoFetch('/v3/exports', {
    method: 'POST',
    body: JSON.stringify({ connection: conn, type: 'query', source: clean, format: 'geoparquet', name: 'agent_export' }),
    signal: opts.signal,
  });
  if (!res.ok) throw await readError(res);
  const { jobId } = (await res.json()) as { jobId: string };
  const deadline = Date.now() + (opts.maxWaitMs ?? 10 * 60_000);
  let job: any;
  for (;;) {
    if (opts.signal?.aborted) {
      void cartoFetch(`/v3/exports/${jobId}/cancel`, { method: 'POST' }).catch(() => {});
      throw new CartoSqlError('Export aborted', 0);
    }
    const r = await cartoFetch(`/v3/exports/${jobId}`, { method: 'GET', signal: opts.signal });
    if (!r.ok) throw await readError(r);
    job = await r.json();
    opts.onStatus?.(job.status);
    if (job.status === 'success') break;
    if (job.status === 'failure' || job.status === 'cancelled')
      throw new CartoSqlError(`Export ${job.status}: ${job.error || 'unknown error'}`, 0, job);
    if (Date.now() > deadline) throw new CartoSqlError('Export did not finish in time', 0, job);
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 1500));
  }
  const url = job.result?.downloadUrl;
  if (!url) throw new CartoSqlError('Export finished without a downloadUrl', 0, job);
  const dl = await fetch(url, { signal: opts.signal });
  if (!dl.ok) throw new CartoSqlError(`Downloading export failed: HTTP ${dl.status}`, dl.status);
  const bytes = new Uint8Array(await dl.arrayBuffer());
  const elapsedMs = Math.round(performance.now() - t0);
  const rowCount = Number(job.result?.rowCount ?? -1);
  record({ at: Date.now(), sql: clean, bytesProcessed: 0, rows: rowCount, elapsedMs, transport: 'export' });
  return { bytes, rowCount, fileSize: bytes.byteLength, elapsedMs, jobId };
}
