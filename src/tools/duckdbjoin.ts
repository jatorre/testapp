import { z } from 'zod';
import type { AgentTool } from '../agent/types';
import { listAttachments } from '../attachments/store';
import { formatBytes, getSessionBytesProcessed, runReadOnlyQuery } from '../carto/sql';
import { loadRowsAsTable } from '../data/duckdb';
import { createDuckDbTools } from './duckdb';
import { toCsv } from './sqldirect';

/**
 * Local join path: spreadsheet attachments become DuckDB tables att_<id> (other sheets: att_<id>_<sheet>), BigQuery
 * results land in DuckDB tables via bq_to_duckdb, and the existing duckdb_query joins them. Nothing touches the
 * filesystem or writes to the warehouse.
 */
const MAX_BQ_ROWS = 100_000;
const loaded = new Set<string>();
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

async function registerAttachmentTables() {
  for (const a of listAttachments()) {
    if (a.kind !== 'table' || loaded.has(a.id)) continue;
    for (const [i, s] of a.data.entries()) await loadRowsAsTable(i === 0 ? `att_${a.id}` : `att_${a.id}_${slug(s.name)}`, s.rows);
    loaded.add(a.id);
  }
}

export function createDuckDbJoinTools(): AgentTool[] {
  const bqToDuck: AgentTool<{ sql: string; table: string }> = {
    name: 'bq_to_duckdb',
    description:
      `Run one read-only BigQuery SELECT and load the full result (≤ ${MAX_BQ_ROWS.toLocaleString()} rows) into a local DuckDB table, ` +
      'to JOIN it with attachment tables in duckdb_query. Aggregate in BigQuery first. Returns schema, row count and 5 sample rows.',
    inputSchema: z.object({
      sql: z.string().describe('A single SELECT/WITH statement (BigQuery standard SQL)'),
      table: z.string().describe('DuckDB table name to create, e.g. "bq_revenue"'),
    }),
    async execute({ sql, table }, ctx) {
      const r = await runReadOnlyQuery(sql, { maxRows: MAX_BQ_ROWS, signal: ctx.signal });
      const t = await loadRowsAsTable(table, r.rows, r.schema);
      return {
        table: t.table, rowCount: t.rowCount, truncated: r.truncated,
        columns: t.columns.map((c) => `${c.name} ${c.type}`).join(', '),
        sample: toCsv(r.rows.slice(0, 5)),
        bytesProcessed: formatBytes(r.bytesProcessed), sessionTotal: formatBytes(getSessionBytesProcessed()),
      };
    },
  };

  const [base] = createDuckDbTools();
  const duck: AgentTool<{ sql: string; save_as?: string }> = {
    ...base,
    description:
      'Run DuckDB SQL locally (no BigQuery cost) over local tables: spreadsheet attachments are tables att_<id> ' +
      '(first sheet; other sheets att_<id>_<sheet>), plus tables you created with bq_to_duckdb. Returns at most 50 rows ' +
      'as CSV plus the total row count. DuckDB dialect.',
    inputSchema: z.object({ sql: z.string().describe('DuckDB SQL (one statement).') }),
    async execute(input, ctx) {
      await registerAttachmentTables();
      return base.execute({ sql: input.sql }, ctx);
    },
  };
  return [bqToDuck, duck];
}
