/**
 * CARTO SQL API JSON rows → typed Apache Arrow table (→ DuckDB → Parquet).
 *
 * The SQL API only gives CARTO-normalized types, so we refine from the values
 * (verified with a probe query against carto_dw / BigQuery):
 *   INT64 → "number" (JSON number; > 2^53 already lost server-side)
 *   FLOAT64 / NUMERIC / BIGNUMERIC → "number" (JSON number)
 *   TIMESTAMP → "timestamp" "2026-10-08T08:05:01.786Z"   (ms precision)
 *   DATETIME  → "timestamp" "2024-01-02T03:04:05"          (no zone)
 *   DATE      → "timestamp" "2026-10-08"
 *   TIME / ARRAY / JSON → "unknown"   ("10:11:12", [1,2], "{\"k\":1}")
 *   STRUCT → "object" ({…}), INTERVAL → "object" ("0-0 1 0:0:0"), BYTES → "string" (base64)
 *   GEOGRAPHY → "geometry" (WKT string, e.g. "POINT(1 2)")
 *   BOOL → "boolean"
 */
import {
  Bool,
  DateDay,
  Float64,
  Int64,
  Table,
  TimestampMillisecond,
  Utf8,
  makeData,
  makeVector,
  vectorFromArray,
  type Vector,
} from 'apache-arrow';
import type { SqlSchemaField } from '../carto/sql';

export type ColumnKind = 'DOUBLE' | 'BIGINT' | 'BOOLEAN' | 'VARCHAR' | 'TIMESTAMP' | 'DATE' | 'JSON';

export interface ColumnPlan {
  name: string;
  /** Type as reported by the CARTO SQL API. */
  apiType: string;
  /** DuckDB / Parquet type we store. TIMESTAMP is UTC (naive), JSON is stored as VARCHAR text. */
  kind: ColumnKind;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TS_TZ_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)$/;
const TS_NAIVE_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/** Some drivers wrap scalars as {value: "..."} (BigQuery node client); unwrap defensively. */
function unwrap(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === 'value') return (v as any).value;
  }
  return v;
}

export function planColumns(schema: SqlSchemaField[], rows: Record<string, unknown>[]): ColumnPlan[] {
  const names = schema.length ? schema : Object.keys(rows[0] ?? {}).map((name) => ({ name, type: 'unknown' }));
  return names.map(({ name, type }) => ({ name, apiType: type, kind: inferKind(type, name, rows) }));
}

function inferKind(apiType: string, name: string, rows: Record<string, unknown>[]): ColumnKind {
  let nonNull = 0;
  let allInt = true;
  let allNum = true;
  let allStr = true;
  let allBool = true;
  let allDate = true;
  let allTsTz = true;
  let allTsNaive = true;
  for (let i = 0; i < rows.length; i++) {
    const v = unwrap(rows[i][name]);
    if (v === null || v === undefined) continue;
    nonNull++;
    const t = typeof v;
    if (t === 'number') {
      if (!Number.isInteger(v) || Math.abs(v as number) > Number.MAX_SAFE_INTEGER) allInt = false;
    } else if (t === 'string' && apiType === 'bigint' && /^-?\d+$/.test(v as string)) {
      /* integer string */
    } else allNum = allInt = false;
    if (t !== 'string') allStr = allDate = allTsTz = allTsNaive = false;
    else if (apiType === 'timestamp' || apiType === 'unknown' || apiType === 'string') {
      const s = v as string;
      if (allDate && !DATE_RE.test(s)) allDate = false;
      if (allTsTz && !TS_TZ_RE.test(s)) allTsTz = false;
      if (allTsNaive && !TS_NAIVE_RE.test(s)) allTsNaive = false;
    }
    if (t !== 'boolean') allBool = false;
  }
  if (nonNull === 0) {
    // keep the API's intent for all-null columns
    return apiType === 'number' ? 'DOUBLE' : apiType === 'bigint' ? 'BIGINT' : apiType === 'boolean' ? 'BOOLEAN' : apiType === 'timestamp' ? 'TIMESTAMP' : 'VARCHAR';
  }
  switch (apiType) {
    case 'number':
    case 'bigint':
      return allNum ? (allInt ? 'BIGINT' : 'DOUBLE') : 'VARCHAR';
    case 'boolean':
      return allBool ? 'BOOLEAN' : 'VARCHAR';
    case 'timestamp':
      if (allDate) return 'DATE';
      if (allTsTz || allTsNaive) return 'TIMESTAMP';
      return 'VARCHAR';
    case 'string':
    case 'geometry':
      return allStr ? 'VARCHAR' : 'JSON';
    default: // object | variant | array | unknown
      if (allBool) return 'BOOLEAN';
      if (allNum) return allInt ? 'BIGINT' : 'DOUBLE';
      if (allStr) return 'VARCHAR';
      return 'JSON';
  }
}

function parseTs(s: string): number {
  // DATETIME has no zone → treat as UTC (Date.parse would use local time otherwise).
  const iso = s.replace(' ', 'T');
  return Date.parse(TS_TZ_RE.test(iso) ? iso : iso + 'Z');
}

function buildColumn(plan: ColumnPlan, rows: Record<string, unknown>[]): Vector {
  const n = rows.length;
  const name = plan.name;
  const bitmap = new Uint8Array((n + 7) >> 3);
  let nulls = 0;
  const valid = (i: number) => (bitmap[i >> 3] |= 1 << (i & 7));
  switch (plan.kind) {
    case 'DOUBLE': {
      const data = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const v = unwrap(rows[i][name]);
        if (v === null || v === undefined) nulls++;
        else {
          data[i] = Number(v);
          valid(i);
        }
      }
      return makeVector(makeData({ type: new Float64(), length: n, nullCount: nulls, nullBitmap: bitmap, data }));
    }
    case 'BIGINT': {
      const data = new BigInt64Array(n);
      for (let i = 0; i < n; i++) {
        const v = unwrap(rows[i][name]);
        if (v === null || v === undefined) nulls++;
        else {
          data[i] = BigInt(v as number | string);
          valid(i);
        }
      }
      return makeVector(makeData({ type: new Int64(), length: n, nullCount: nulls, nullBitmap: bitmap, data }));
    }
    case 'TIMESTAMP': {
      const data = new BigInt64Array(n);
      for (let i = 0; i < n; i++) {
        const v = unwrap(rows[i][name]);
        const ms = v === null || v === undefined ? NaN : parseTs(String(v));
        if (Number.isNaN(ms)) nulls++;
        else {
          data[i] = BigInt(Math.round(ms));
          valid(i);
        }
      }
      return makeVector(makeData({ type: new TimestampMillisecond(), length: n, nullCount: nulls, nullBitmap: bitmap, data }));
    }
    case 'DATE': {
      const data = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        const v = unwrap(rows[i][name]);
        const ms = v === null || v === undefined ? NaN : Date.parse(String(v));
        if (Number.isNaN(ms)) nulls++;
        else {
          data[i] = Math.floor(ms / 86_400_000);
          valid(i);
        }
      }
      return makeVector(makeData({ type: new DateDay(), length: n, nullCount: nulls, nullBitmap: bitmap, data }));
    }
    case 'BOOLEAN': {
      const vals = new Array<boolean | null>(n);
      for (let i = 0; i < n; i++) {
        const v = unwrap(rows[i][name]);
        vals[i] = v === null || v === undefined ? null : v === true || v === 'true';
      }
      return vectorFromArray(vals, new Bool());
    }
    case 'JSON':
    case 'VARCHAR':
    default: {
      const vals = new Array<string | null>(n);
      for (let i = 0; i < n; i++) {
        const v = unwrap(rows[i][name]);
        vals[i] = v === null || v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v);
      }
      return vectorFromArray(vals, new Utf8());
    }
  }
}

export function rowsToArrow(plans: ColumnPlan[], rows: Record<string, unknown>[]): Table {
  const cols: Record<string, Vector> = {};
  for (const p of plans) cols[p.name] = buildColumn(p, rows);
  return new Table(cols);
}
