import { z } from 'zod';
import type { AgentTool } from '../agent/types';
import { exportToVfs, formatFromPath, query, registerVfsFiles } from '../data/duckdb';

const MAX_ROWS_SHOWN = 50;
const MAX_CELL = 100;

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (s.length > MAX_CELL) s = s.slice(0, MAX_CELL) + '…';
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(columns: { name: string }[], rows: Record<string, unknown>[]): string {
  return [columns.map((c) => csvCell(c.name)).join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c.name])).join(','))].join('\n');
}

/**
 * Heuristic guard: local DuckDB can reach the network (httpfs, extension installs). Data in the
 * files is untrusted, so block remote URLs / extension loading / attaching from model SQL.
 */
function assertLocalOnly(sql: string) {
  if (/\b(https?|s3|gcs|gs|r2|az|azure|hf):\/\//i.test(sql)) throw new Error('Remote URLs are not allowed; query files in /data or /work.');
  if (/\b(INSTALL|LOAD|ATTACH|DETACH|EXPORT\s+DATABASE|IMPORT\s+DATABASE)\b/i.test(sql))
    throw new Error('INSTALL/LOAD/ATTACH/EXPORT DATABASE are not allowed.');
  if (/\bCOPY\b[\s\S]*\bTO\b/i.test(sql)) throw new Error('Use the save_as parameter instead of COPY … TO.');
}

export function createDuckDbTools(): AgentTool[] {
  const tool: AgentTool<{ sql: string; save_as?: string }> = {
    name: 'duckdb_query',
    description:
      'Run DuckDB SQL locally in the browser over the files in the virtual filesystem (no BigQuery cost). ' +
      "Files are addressed by absolute path: FROM '/data/x.parquet' (or read_parquet('/data/*.parquet')), " +
      "read_csv_auto('/work/y.csv'), read_json_auto('/work/z.json'). Returns at most 50 rows as CSV plus the total row count. " +
      'Pass save_as ("/work/name.csv" or "/work/name.parquet") to write the FULL result to a file (e.g. for charts or Python). ' +
      'TEMP tables/views you CREATE persist for the session. DuckDB dialect: date_trunc, strftime, QUALIFY, PIVOT, SUMMARIZE.',
    inputSchema: z.object({
      sql: z.string().describe('DuckDB SQL (one statement).'),
      save_as: z.string().optional().describe('Optional output path in /work (or /data), .csv or .parquet.'),
    }),
    async execute({ sql, save_as }) {
      assertLocalOnly(sql);
      await registerVfsFiles();
      let saved: { path: string; bytes: number } | undefined;
      if (save_as) {
        const p = save_as.startsWith('/') ? save_as : `/work/${save_as}`;
        if (!/^\/(work|data)\/[\w\-./]+$/.test(p) || p.includes('..')) throw new Error('save_as must be a path under /work or /data');
        const fmt = formatFromPath(p);
        if (fmt === 'json') throw new Error('save_as must end in .csv or .parquet');
        const r = await exportToVfs(sql, p, fmt);
        saved = { path: r.path, bytes: r.bytes };
        const shown = await query(`SELECT * FROM ${fmt === 'csv' ? `read_csv_auto('${p}')` : `read_parquet('${p}')`}`, {
          maxRows: MAX_ROWS_SHOWN,
        });
        return {
          rowCount: r.rowCount,
          columns: shown.columns.map((c) => `${c.name} ${c.type}`).join(', '),
          rows: toCsv(shown.columns, shown.rows),
          ...(r.rowCount > MAX_ROWS_SHOWN ? { note: `showing first ${MAX_ROWS_SHOWN} of ${r.rowCount} rows` } : {}),
          saved,
        };
      }
      const r = await query(sql, { maxRows: MAX_ROWS_SHOWN });
      return {
        rowCount: r.rowCount,
        columns: r.columns.map((c) => `${c.name} ${c.type}`).join(', '),
        rows: toCsv(r.columns, r.rows),
        ...(r.rowCount > MAX_ROWS_SHOWN ? { note: `showing first ${MAX_ROWS_SHOWN} of ${r.rowCount} rows; use save_as for the full result` } : {}),
        elapsedMs: r.elapsedMs,
      };
    },
  };
  return [tool];
}
