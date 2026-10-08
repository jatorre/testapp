import { z } from 'zod';
import type { AgentTool } from '../agent/types';
import {
  SQL_CONFIG,
  exportQueryToParquet,
  formatBytes,
  getSessionBytesProcessed,
  runReadOnlyQuery,
  runSql,
} from '../carto/sql';
import { ingestRowsToParquet, storeParquet, query as duckQuery } from '../data/duckdb';
import { writeFile } from '../vfs/vfs';

const SAMPLE_ROWS = 5;
const MAX_CELL = 80;

function clip(v: unknown): unknown {
  if (typeof v === 'string' && v.length > MAX_CELL) return v.slice(0, MAX_CELL) + '…';
  if (v && typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > MAX_CELL ? s.slice(0, MAX_CELL) + '…' : v;
  }
  return v;
}
const clipRows = (rows: Record<string, unknown>[]) =>
  rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, clip(v)])));

const safeName = (s: string) =>
  s
    .replace(/^\/?data\//, '')
    .replace(/\.parquet$/i, '')
    .replace(/[^A-Za-z0-9_\-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'result';

const DATASET_RE = /^[A-Za-z0-9_\-]+\.[A-Za-z0-9_]+$/;
const TABLE_RE = /^[A-Za-z0-9_\-]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_$*\-]+$/;
const stripTicks = (s: string) => s.trim().replace(/`/g, '');

export function createBigQueryTools(): AgentTool[] {
  const bqQuery: AgentTool<{ sql: string; save_as: string; description?: string; mode?: 'sql' | 'bulk' }> = {
    name: 'bq_query',
    description:
      'Run ONE read-only BigQuery SELECT (standard SQL; fully-qualified `project.dataset.table` names) through the CARTO SQL API. ' +
      'The FULL result is saved to /data/<save_as>.parquet; you only get back row count, column types and a 5-row sample. ' +
      `Results are capped at ${SQL_CONFIG.maxRows.toLocaleString()} rows (truncated=true when hit) and the query must finish in 60 s, ` +
      'so aggregate/filter in SQL. LIMIT does not reduce cost: filter on date/partition columns and select only needed columns. ' +
      'mode "bulk" uses the CARTO Exports API (Parquet, no row cap, slower start ~10 s) for large extracts. ' +
      'Then analyse the file with duckdb_query (FROM \'/data/<save_as>.parquet\').',
    inputSchema: z.object({
      sql: z.string().describe('A single SELECT or WITH … SELECT statement. No DML/DDL/scripts.'),
      save_as: z.string().describe('File name (no extension) for the result in /data, e.g. "orders_2023".'),
      description: z.string().optional().describe('One line describing what this extract contains (stored next to the file).'),
      mode: z.enum(['sql', 'bulk']).optional().describe('"sql" (default) or "bulk" for >100k-row extracts.'),
    }),
    async execute({ sql, save_as, description, mode }, ctx) {
      const name = safeName(save_as);
      const path = `/data/${name}.parquet`;
      const t0 = performance.now();
      let out: Record<string, unknown>;
      if (mode === 'bulk') {
        const ex = await exportQueryToParquet(sql, { signal: ctx.signal });
        const st = await storeParquet(ex.bytes, path);
        const sample = await duckQuery(`SELECT * FROM read_parquet('${path}') LIMIT ${SAMPLE_ROWS}`, { maxRows: SAMPLE_ROWS });
        out = {
          path,
          rowCount: st.rowCount,
          columns: st.columns,
          sample: clipRows(sample.rows),
          bytesInFile: st.bytesInFile,
          truncated: false,
          transport: 'exports-api',
        };
      } else {
        const r = await runReadOnlyQuery(sql, { signal: ctx.signal });
        const ing = await ingestRowsToParquet(r.rows, r.schema, path);
        out = {
          path,
          rowCount: ing.rowCount,
          columns: ing.columns,
          sample: clipRows(
            (await duckQuery(`SELECT * FROM read_parquet('${path}') LIMIT ${SAMPLE_ROWS}`, { maxRows: SAMPLE_ROWS })).rows,
          ),
          bytesInFile: ing.bytesInFile,
          truncated: r.truncated,
          ...(r.truncated
            ? { note: `Result hit the ${SQL_CONFIG.maxRows.toLocaleString()}-row cap; aggregate more in SQL or use mode "bulk".` }
            : {}),
          bytesProcessed: r.bytesProcessed,
          bytesProcessedHuman: formatBytes(r.bytesProcessed),
          cacheHit: r.meta.cacheHit ?? null,
          responseMB: +(r.responseChars / 1e6).toFixed(2),
          ...(r.preflight.warning ? { warning: r.preflight.warning } : {}),
        };
        // Free the JSON rows ASAP (they can be 100+ MB of JS objects).
        r.rows.length = 0;
      }
      await writeFile(
        `/data/${name}.sql`,
        `-- ${description ?? name}\n-- saved ${new Date().toISOString()} → ${path}\n${sql.trim()}\n`,
      );
      return {
        ...out,
        elapsedMs: Math.round(performance.now() - t0),
        sessionBytesProcessed: formatBytes(getSessionBytesProcessed()),
      };
    },
  };

  const listTables: AgentTool<{ dataset: string }> = {
    name: 'bq_list_tables',
    description: 'List tables in a BigQuery dataset ("project.dataset") with row counts and sizes. Free metadata query.',
    inputSchema: z.object({ dataset: z.string().describe('e.g. "bigquery-public-data.thelook_ecommerce"') }),
    async execute({ dataset }, ctx) {
      const ds = stripTicks(dataset);
      if (!DATASET_RE.test(ds)) throw new Error('dataset must look like "project.dataset"');
      try {
        const r = await runSql(
          `SELECT table_id, type, row_count, size_bytes FROM \`${ds}.__TABLES__\` ORDER BY table_id LIMIT 500`,
          { signal: ctx.signal, kind: 'metadata' },
        );
        return {
          dataset: ds,
          tables: r.rows.map((t: any) => ({
            table: t.table_id,
            kind: t.type === 2 ? 'VIEW' : t.type === 3 ? 'EXTERNAL' : 'TABLE',
            rows: Number(t.row_count),
            size: formatBytes(Number(t.size_bytes)),
          })),
        };
      } catch {
        const r = await runSql(
          `SELECT table_name, table_type FROM \`${ds}\`.INFORMATION_SCHEMA.TABLES ORDER BY table_name LIMIT 500`,
          { signal: ctx.signal, kind: 'metadata' },
        );
        return { dataset: ds, tables: r.rows.map((t: any) => ({ table: t.table_name, kind: t.table_type })) };
      }
    },
  };

  const describeTable: AgentTool<{ table: string }> = {
    name: 'bq_describe_table',
    description:
      'Columns, types, partitioning/clustering, row count and size of a BigQuery table ("project.dataset.table"). Cheap metadata query.',
    inputSchema: z.object({ table: z.string().describe('e.g. "bigquery-public-data.thelook_ecommerce.orders"') }),
    async execute({ table }, ctx) {
      const fq = stripTicks(table);
      if (!TABLE_RE.test(fq)) throw new Error('table must look like "project.dataset.table"');
      const [p, d, t] = fq.split('.');
      const [cols, size] = await Promise.all([
        runSql(
          `SELECT column_name, data_type, is_partitioning_column, clustering_ordinal_position
           FROM \`${p}.${d}\`.INFORMATION_SCHEMA.COLUMNS WHERE table_name = @t ORDER BY ordinal_position`,
          { signal: ctx.signal, kind: 'metadata', queryParameters: { t } },
        ),
        runSql(`SELECT row_count, size_bytes FROM \`${p}.${d}.__TABLES__\` WHERE table_id = @t`, {
          signal: ctx.signal,
          kind: 'metadata',
          queryParameters: { t },
        }).catch(() => null),
      ]);
      if (!cols.rows.length) throw new Error(`Table ${fq} not found or not accessible`);
      const s: any = size?.rows[0];
      const rows = cols.rows as any[];
      return {
        table: fq,
        rows: s ? Number(s.row_count) : null,
        size: s ? formatBytes(Number(s.size_bytes)) : null,
        partitionedBy: rows.filter((c) => c.is_partitioning_column === 'YES').map((c) => c.column_name),
        clusteredBy: rows
          .filter((c) => c.clustering_ordinal_position != null)
          .sort((a, b) => a.clustering_ordinal_position - b.clustering_ordinal_position)
          .map((c) => c.column_name),
        columns: rows.map((c) => `${c.column_name} ${String(c.data_type).length > 120 ? String(c.data_type).slice(0, 120) + '…' : c.data_type}`),
      };
    },
  };

  return [bqQuery, listTables, describeTable];
}
