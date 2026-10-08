import { z } from 'zod';
import type { AgentTool } from '../agent/types';
import { formatBytes, getSessionBytesProcessed, runReadOnlyQuery } from '../carto/sql';

/**
 * Ablation baseline: no files, no DuckDB, no Python. One tool runs read-only SQL in BigQuery (via the CARTO
 * SQL API) and returns the rows straight into the model's context as CSV (capped like every tool output).
 * All analysis has to happen in BigQuery SQL or in the model's head.
 */
const MAX_ROWS = 500;

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
}

export function createSqlDirectTools(): AgentTool[] {
  const runSqlTool: AgentTool<{ sql: string }> = {
    name: 'run_sql',
    description:
      `Run one read-only BigQuery SELECT (standard SQL) and get the result rows back directly as CSV (max ${MAX_ROWS} rows; ` +
      'long outputs are truncated). Aggregate in SQL: you cannot store results anywhere.',
    inputSchema: z.object({ sql: z.string().describe('A single SELECT/WITH statement') }),
    async execute({ sql }, ctx) {
      const r = await runReadOnlyQuery(sql, { maxRows: MAX_ROWS, signal: ctx.signal });
      return `rows=${r.rows.length}${r.truncated ? ' (TRUNCATED)' : ''} bytesProcessed=${formatBytes(r.bytesProcessed)} ` +
        `sessionTotal=${formatBytes(getSessionBytesProcessed())}\n${toCsv(r.rows)}`;
    },
  };
  return [runSqlTool];
}
