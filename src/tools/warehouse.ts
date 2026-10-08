import { z } from 'zod';
import type { AgentTool } from '../agent/types';
import { getAttachment, getSheet } from '../attachments/store';
import { getConnectionName } from '../carto/info';
import { cartoGetJson, runSql } from '../carto/sql';
import { planColumns, type ColumnKind } from '../data/ingest';

/**
 * upload_to_warehouse: the ONLY write path in the app (run_sql stays read-only). It turns an attachment sheet into a
 * scratch table in the viewer's own CARTO Data Warehouse dataset with one CREATE TABLE … AS SELECT FROM UNNEST(…)
 * over the synchronous SQL API (measured: 2 rows 1.8 s, 20k rows / 0.8 MB of SQL 5.9 s). The statement is built here
 * from the data, never from model SQL; the table name is forced to `agent_tmp_*` and the table expires after 24 h.
 * Alternative we did not use: the Imports API (POST workspace /storage/sign → PUT signed GCS URL → submit import →
 * poll), ~20 s even for 2 rows, but no 1 MB SQL limit (5 GB files).
 */
export const SCRATCH_PREFIX = 'agent_tmp_';
const MAX_SQL_CHARS = 900_000; // BigQuery's query text limit is 1 MB
const EXPIRY_HOURS = 24;

let scratch: Promise<string> | null = null;
/** The viewer's private CARTO DW dataset (`carto-dw-<account>.private_<user>`), discovered via the connection resources API. */
export function getScratchDataset(): Promise<string> {
  const override = new URLSearchParams(location.search).get('scratch_dataset') || (import.meta.env.VITE_CARTO_SCRATCH_DATASET as string);
  if (override) return Promise.resolve(override);
  scratch ??= (async () => {
    const conn = encodeURIComponent(getConnectionName());
    const root = await cartoGetJson(`/v3/connections/${conn}/resources`);
    const project = (root.children ?? []).find((c: any) => c.type === 'project' && String(c.id).startsWith('carto-dw-'));
    if (!project) throw new Error(`Connection ${getConnectionName()} is not a CARTO Data Warehouse (no carto-dw-* project)`);
    const p = await cartoGetJson(`/v3/connections/${conn}/resources/${encodeURIComponent(project.id)}`);
    const ds = (p.children ?? []).find((c: any) => c.type === 'dataset' && c.name === 'private');
    if (!ds) throw new Error(`No private dataset found in ${project.id}`);
    return String(ds.id);
  })().catch((e) => {
    scratch = null;
    throw e;
  });
  return scratch;
}

const BQ_TYPE: Record<ColumnKind, string> = {
  DOUBLE: 'FLOAT64', BIGINT: 'INT64', BOOLEAN: 'BOOL', VARCHAR: 'STRING', TIMESTAMP: 'TIMESTAMP', DATE: 'DATE', JSON: 'STRING',
};
const str = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
function literal(v: unknown, type: string): string {
  if (v === null || v === undefined || v === '') return 'NULL';
  if (type === 'BOOL') return v === true || v === 'true' ? 'TRUE' : 'FALSE';
  if ((type === 'INT64' || type === 'FLOAT64') && typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (type === 'DATE' || type === 'TIMESTAMP') return `${type} ${str(String(v))}`;
  return str(typeof v === 'object' ? JSON.stringify(v) : String(v));
}

/** Build the CTAS statement (exported for tests). */
export function buildUploadSql(table: string, rows: Record<string, unknown>[], description: string): { sql: string; columns: { name: string; type: string }[] } {
  const plans = planColumns([], rows);
  const used = new Set<string>();
  const columns = plans.map((p) => {
    let name = p.name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^(\d)/, '_$1').slice(0, 128) || 'col';
    while (used.has(name.toLowerCase())) name += '_';
    used.add(name.toLowerCase());
    return { source: p.name, name, type: BQ_TYPE[p.kind] };
  });
  const struct = `ARRAY<STRUCT<${columns.map((c) => `\`${c.name}\` ${c.type}`).join(', ')}>>`;
  const values = rows.map((r) => `STRUCT(${columns.map((c) => literal(r[c.source], c.type)).join(', ')})`).join(',\n');
  const sql =
    `CREATE OR REPLACE TABLE \`${table}\`\n` +
    `OPTIONS(expiration_timestamp = TIMESTAMP_ADD(CURRENT_TIMESTAMP(), INTERVAL ${EXPIRY_HOURS} HOUR), description = ${str(description)})\n` +
    `AS SELECT * FROM UNNEST(${struct}[\n${values}])`;
  return { sql, columns: columns.map(({ name, type }) => ({ name, type })) };
}

export function createWarehouseTools(): AgentTool[] {
  const upload: AgentTool<{ id: string; sheet?: string; table_name: string }> = {
    name: 'upload_to_warehouse',
    description:
      `Copy a spreadsheet/CSV attachment (one sheet) into a temporary BigQuery table in your private CARTO Data Warehouse ` +
      `dataset, so run_sql can JOIN it with other tables. The table is named ${SCRATCH_PREFIX}<table_name>, replaced if it ` +
      `exists, and expires after ${EXPIRY_HOURS} h. Returns the fully-qualified table name to use in run_sql.`,
    inputSchema: z.object({
      id: z.string().describe('Attachment id, e.g. "a1"'),
      sheet: z.string().optional().describe('Sheet name (default: first sheet)'),
      table_name: z.string().describe('Short name, letters/digits/underscore, e.g. "targets"'),
    }),
    async execute({ id, sheet, table_name }, ctx) {
      const a = getAttachment(id);
      if (!a) throw new Error(`No attachment "${id}". Call list_attachments.`);
      const s = getSheet(a, sheet);
      if (!s.rows.length) throw new Error(`Sheet ${s.name} is empty`);
      const short = table_name.toLowerCase().replace(new RegExp(`^${SCRATCH_PREFIX}`), '');
      if (!/^[a-z0-9_]{1,50}$/.test(short)) throw new Error('table_name must be 1-50 chars of a-z, 0-9, _');
      const table = `${await getScratchDataset()}.${SCRATCH_PREFIX}${short}`;
      const { sql, columns } = buildUploadSql(table, s.rows, `Uploaded by the client-side agent from ${a.name} / ${s.name}`);
      if (sql.length > MAX_SQL_CHARS)
        throw new Error(`Sheet too large for an inline upload (${sql.length} chars of SQL > ${MAX_SQL_CHARS}). Use fewer rows/columns.`);
      const t0 = performance.now();
      await runSql(sql, { signal: ctx.signal });
      return { table, rows: s.rows.length, columns, expiresInHours: EXPIRY_HOURS, elapsedMs: Math.round(performance.now() - t0) };
    },
  };
  return [upload];
}
