/**
 * Physical catalog for the sources of a semantic model, fetched from the FREE path and cached.
 *
 * Free path (verified 2026-10-08): GET {apiBaseUrl}/v3/connections/{connection}/resources/{project.dataset.table}
 *   → {id, name, type, nrows, size, lastModified, geomField?, schema:[{name,type}] (CARTO types),
 *      originalSchema:[{name,type}] (BigQuery types), tableRegion}
 * It is the Workspace data-explorer / `carto connections describe` API (the CLI reaches it through the MCP
 * `list_resources` tool). ~0.4–0.6 s per table (2 s cold), CORS reflects the Origin, and it reads table
 * metadata, so no BigQuery bytes are billed (unlike INFORMATION_SCHEMA, ≥10 MB per query).
 * Fallback per table: `dataset.__TABLES__` via the SQL API (rows + bytes, 0 bytes billed, no columns).
 *
 * Cache: memory, then localStorage (per connection; each entry tagged with its model version; TTL 24 h).
 */
import { cartoGetJson, runSql } from '../carto/sql';
import { getConnectionName } from '../carto/info';
import type { Catalog, CatalogEntry, ResolvedModel } from './types';

export const CATALOG_TTL_MS = 24 * 3600 * 1000;
const STORAGE_PREFIX = 'semantic-catalog:v1:';
const memory = new Map<string, CatalogEntry>(); // `${connection}|${table}`

function readStorage(conn: string): Record<string, CatalogEntry> {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + conn);
    return raw ? (JSON.parse(raw) as Record<string, CatalogEntry>) : {};
  } catch {
    return {};
  }
}
function writeStorage(conn: string, entries: Record<string, CatalogEntry>) {
  try {
    localStorage.setItem(STORAGE_PREFIX + conn, JSON.stringify(entries));
  } catch {
    /* storage full / blocked: memory cache still works */
  }
}

const fresh = (e: CatalogEntry | undefined, version: string, now: number) =>
  !!e && e.version === version && e.via !== 'none' && now - e.fetchedAt < CATALOG_TTL_MS;

async function fetchEntry(conn: string, table: string, version: string, signal?: AbortSignal): Promise<CatalogEntry> {
  const now = Date.now();
  try {
    const r: any = await cartoGetJson(`/v3/connections/${encodeURIComponent(conn)}/resources/${encodeURIComponent(table)}`, signal);
    const cols = (Array.isArray(r.originalSchema) && r.originalSchema.length ? r.originalSchema : r.schema ?? []) as { name: string; type: string }[];
    return {
      table,
      rows: Number.isFinite(Number(r.nrows)) ? Number(r.nrows) : null,
      bytes: Number.isFinite(Number(r.size)) ? Number(r.size) : null,
      columns: cols.map((c) => ({ name: String(c.name), type: String(c.type) })),
      geomField: r.geomField ?? undefined,
      lastModified: r.lastModified ?? undefined,
      via: 'connections-api',
      fetchedAt: now,
      version,
    };
  } catch (e) {
    const apiError = e instanceof Error ? e.message : String(e);
    try {
      const [p, d, t] = table.split('.');
      const r = await runSql(`SELECT row_count, size_bytes FROM \`${p}.${d}.__TABLES__\` WHERE table_id = @t`, {
        signal, kind: 'metadata', queryParameters: { t },
      });
      const row: any = r.rows[0];
      return {
        table, rows: row ? Number(row.row_count) : null, bytes: row ? Number(row.size_bytes) : null, columns: [],
        via: '__TABLES__', fetchedAt: now, version, error: `connections API failed: ${apiError}`,
      };
    } catch (e2) {
      return { table, rows: null, bytes: null, columns: [], via: 'none', fetchedAt: now, version, error: `${apiError}; __TABLES__: ${e2 instanceof Error ? e2.message : e2}` };
    }
  }
}

const inflight = new Map<string, Promise<Catalog>>();

/** Catalog entries for every source of the model (memory → localStorage → free API). Never throws. */
export function loadCatalog(model: ResolvedModel, opts: { signal?: AbortSignal; force?: boolean } = {}): Promise<Catalog> {
  const conn = getConnectionName();
  const key = `${conn}|${model.key}|${opts.force ? 'force' : ''}`;
  let p = inflight.get(key);
  if (!p) {
    p = load(model, conn, opts).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

async function load(model: ResolvedModel, conn: string, opts: { signal?: AbortSignal; force?: boolean }): Promise<Catalog> {
  const t0 = performance.now();
  const now = Date.now();
  const stats = { fromMemory: 0, fromStorage: 0, fetched: 0, failed: 0, ms: 0 };
  const entries: Record<string, CatalogEntry> = {};
  const stored = readStorage(conn);
  const missing: { table: string; version: string }[] = [];
  for (const s of model.sources) {
    const version = model.sourceVersions[s.name] ?? model.version;
    const m = memory.get(`${conn}|${s.table}`);
    if (!opts.force && fresh(m, version, now)) {
      entries[s.table] = m!;
      stats.fromMemory++;
    } else if (!opts.force && fresh(stored[s.table], version, now)) {
      entries[s.table] = stored[s.table];
      memory.set(`${conn}|${s.table}`, stored[s.table]);
      stats.fromStorage++;
    } else missing.push({ table: s.table, version });
  }
  if (missing.length) {
    const got = await Promise.all(missing.map((m) => fetchEntry(conn, m.table, m.version, opts.signal)));
    for (const e of got) {
      entries[e.table] = e;
      if (e.via === 'none') stats.failed++;
      else {
        stats.fetched++;
        memory.set(`${conn}|${e.table}`, e);
        stored[e.table] = e;
      }
    }
    writeStorage(conn, stored);
  }
  stats.ms = Math.round(performance.now() - t0);
  return { connection: conn, entries, stats };
}

/** Drop the cached catalog (memory + storage) for the current connection. */
export function clearCatalogCache() {
  memory.clear();
  try {
    localStorage.removeItem(STORAGE_PREFIX + getConnectionName());
  } catch {
    /* ignore */
  }
}
