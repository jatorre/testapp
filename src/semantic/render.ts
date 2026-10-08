/**
 * Pure functions over a semantic model + catalog (no browser or warehouse access, so they also run under
 * plain Node for tests): resolve includes, render the compact system-prompt section, and build the detail
 * objects returned by the semantic tools.
 */
import type { Catalog, CatalogEntry, MetricSpec, RelationshipSpec, ResolvedModel, SemanticModel, SourceSpec } from './types';

// ───────────────────────────── resolve ─────────────────────────────

/** Merge a model with its includes (depth-first, each model once). Later duplicates are ignored. */
export function resolveModel(id: string, models: Record<string, SemanticModel>): ResolvedModel {
  const seen = new Set<string>();
  const order: SemanticModel[] = [];
  const visit = (mid: string) => {
    if (seen.has(mid)) return;
    const m = models[mid];
    if (!m) throw new Error(`Unknown semantic model "${mid}". Known: ${Object.keys(models).join(', ')}`);
    seen.add(mid);
    order.push(m);
    (m.includes ?? []).forEach(visit);
  };
  visit(id);
  const root = order[0];
  const sources: SourceSpec[] = [];
  const sourceVersions: Record<string, string> = {};
  for (const m of order)
    for (const s of m.sources)
      if (!sourceVersions[s.name]) {
        sources.push(s);
        sourceVersions[s.name] = m.version;
      }
  return {
    ...root,
    key: order.map((m) => `${m.id}@${m.version}`).join('+'),
    rules: order.flatMap((m) => m.rules ?? []),
    sources,
    sourceVersions,
    relationships: order.flatMap((m) => m.relationships ?? []),
    dimensions: order.flatMap((m) => m.dimensions ?? []),
    metrics: order.flatMap((m) => m.metrics ?? []),
  };
}

export function findSource(model: ResolvedModel, name: string): SourceSpec | undefined {
  const n = name.trim().replace(/`/g, '').toLowerCase();
  return model.sources.find((s) => s.name.toLowerCase() === n || s.table.toLowerCase() === n || s.table.toLowerCase().endsWith(`.${n}`));
}

// ───────────────────────────── formatting helpers ─────────────────────────────

const TYPE_ABBR: Record<string, string> = {
  INTEGER: 'int', INT64: 'int', FLOAT: 'float', FLOAT64: 'float', NUMERIC: 'num', BIGNUMERIC: 'num', STRING: 'str',
  TIMESTAMP: 'ts', DATETIME: 'datetime', DATE: 'date', TIME: 'time', BOOLEAN: 'bool', BOOL: 'bool', GEOGRAPHY: 'geo',
  BYTES: 'bytes', JSON: 'json',
};
export const abbrType = (t: string) => TYPE_ABBR[t.toUpperCase()] ?? t.toLowerCase().replace(/\s+/g, '');

export function humanBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}
export function humanCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '?';
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}

const CARD: Record<string, string> = { many_to_one: 'N:1', one_to_one: '1:1', one_to_many: '1:N', many_to_many: 'N:N' };
const relLine = (r: RelationshipSpec) => `${r.from} → ${r.to} (${CARD[r.cardinality] ?? r.cardinality}${r.note ? `; ${r.note}` : ''})`;

/** Rough token estimate (~4 chars/token for English + SQL); real numbers come from the LLM usage. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

const entryFor = (catalog: Catalog | undefined, s: SourceSpec): CatalogEntry | undefined => catalog?.entries[s.table];

// ───────────────────────────── prompt section ─────────────────────────────

export interface RenderOptions {
  /** List every catalog column (compact) for sources with at most this many columns; else only declared ones. */
  allColumnsUpTo?: number;
  /** 'lite': no per-column type lists (the model calls describe_source for them). ~40% smaller. */
  mode?: 'full' | 'lite';
}

/**
 * Compact system-prompt section: rules, sources (table, size, grain, keys, columns with types, notes),
 * joins, dimensions and metrics. Target ≤ ~2.5k tokens.
 */
export function renderSemanticPrompt(model: ResolvedModel, catalog?: Catalog, opts: RenderOptions = {}): string {
  const maxAll = opts.allColumnsUpTo ?? 16;
  const lite = opts.mode === 'lite';
  const out: string[] = [];
  out.push(`## Semantic model: ${model.title}`);
  out.push(
    'Use only these sources. Their schemas, sizes, joins and metric definitions are below and already verified: do NOT query ' +
      'INFORMATION_SCHEMA or run probe queries (SELECT * … LIMIT, SELECT DISTINCT) to rediscover them. describe_source(name) ' +
      'returns full detail, get_metric(name) the exact SQL; both are free (no warehouse query).',
  );
  if (model.rules?.length) {
    out.push('', 'Rules:');
    for (const r of model.rules) out.push(`- ${r}`);
  }
  out.push('', lite ? 'Sources (notes for key columns; describe_source lists every column with its type):' : 'Sources (columns as name:type; notes for key columns):');
  for (const s of model.sources) {
    const e = entryFor(catalog, s);
    const size = e && (e.rows != null || e.bytes != null) ? ` — ${humanCount(e.rows)} rows, ${humanBytes(e.bytes)}` : '';
    const meta = [
      s.grain && `grain: ${s.grain}`,
      s.primary_key && `PK ${s.primary_key}`,
      s.time_column && `time ${s.time_column}`,
      s.geo && `geo ${[s.geo.lat && s.geo.lon ? `${s.geo.lat}/${s.geo.lon}` : '', s.geo.geography].filter(Boolean).join(', ')}`,
    ].filter(Boolean);
    out.push(`- ${s.name} = \`${s.table}\`${size}. ${s.description}${meta.length ? ` (${meta.join('; ')})` : ''}`);
    const declared = s.columns ?? {};
    if (lite) {
      /* column lists come from describe_source */
    } else if (e?.columns.length && e.columns.length <= maxAll) {
      out.push(`  cols: ${e.columns.map((c) => `${c.name}:${abbrType(c.type)}`).join(', ')}`);
    } else if (e?.columns.length) {
      const typeOf = new Map(e.columns.map((c) => [c.name, abbrType(c.type)]));
      out.push(`  key cols: ${Object.keys(declared).map((c) => `${c}:${typeOf.get(c) ?? '?'}`).join(', ')} (+${e.columns.length - Object.keys(declared).length} more: describe_source)`);
    }
    const notes = Object.entries(declared)
      .filter(([, c]) => c.description || c.values || c.unit)
      .map(([n, c]) => {
        const bits = [c.description, c.values && `values: ${c.values.join('|')}`, c.unit].filter(Boolean);
        return `${n}: ${bits.join('; ')}`;
      });
    if (notes.length) out.push(`  notes: ${notes.join(' · ')}`);
    if (s.gotchas?.length) out.push(`  gotchas: ${s.gotchas.join(' ')}`);
  }
  if (model.relationships?.length) {
    out.push('', 'Joins:');
    out.push(model.relationships.map(relLine).map((l) => `- ${l}`).join('\n'));
  }
  if (model.dimensions?.length) {
    out.push('', 'Dimensions:');
    for (const d of model.dimensions) out.push(`- ${d.name} = ${d.sql}${d.description ? ` — ${d.description}` : ''}`);
  }
  if (model.metrics?.length) {
    out.push('', 'Metrics (source-qualified SQL; FILTER is part of the definition):');
    for (const m of model.metrics)
      out.push(
        `- ${m.name} = ${m.sql}${m.filter ? ` FILTER ${m.filter}` : ''}${m.joins?.length ? ` [joins ${m.joins.join(', ')}]` : ''}` +
          `${m.description ? ` — ${m.description}` : ''}${m.unit ? ` (${m.unit})` : ''}`,
      );
  }
  return out.join('\n');
}

// ───────────────────────────── tool payloads ─────────────────────────────

export function listSourcesPayload(model: ResolvedModel, catalog?: Catalog) {
  return {
    model: model.key,
    sources: model.sources.map((s) => {
      const e = entryFor(catalog, s);
      return { name: s.name, table: s.table, description: s.description, rows: e?.rows ?? null, size: humanBytes(e?.bytes) };
    }),
    metrics: (model.metrics ?? []).map((m) => m.name),
    dimensions: (model.dimensions ?? []).map((d) => d.name),
  };
}

export function describeSourcePayload(model: ResolvedModel, name: string, catalog?: Catalog) {
  const s = findSource(model, name);
  if (!s) throw new Error(`Unknown source "${name}". Sources: ${model.sources.map((x) => x.name).join(', ')}`);
  const e = entryFor(catalog, s);
  const declared = s.columns ?? {};
  const names = e?.columns.length ? e.columns.map((c) => c.name) : Object.keys(declared);
  const typeOf = new Map((e?.columns ?? []).map((c) => [c.name, c.type]));
  return {
    name: s.name,
    table: s.table,
    description: s.description,
    grain: s.grain,
    primary_key: s.primary_key,
    time_column: s.time_column,
    geo: s.geo,
    rows: e?.rows ?? null,
    size: humanBytes(e?.bytes),
    catalog: e ? { via: e.via, fetchedAt: new Date(e.fetchedAt).toISOString(), ...(e.error ? { error: e.error } : {}) } : null,
    columns: names.map((n) => ({ name: n, type: typeOf.get(n) ?? null, ...declared[n] })),
    gotchas: s.gotchas ?? [],
    joins: (model.relationships ?? []).filter((r) => r.from.startsWith(`${s.name}.`) || r.to.startsWith(`${s.name}.`)).map(relLine),
    metrics: (model.metrics ?? []).filter((m) => m.source === s.name || m.joins?.includes(s.name)).map((m) => m.name),
    dimensions: (model.dimensions ?? []).filter((d) => d.source === s.name).map((d) => ({ name: d.name, sql: d.sql })),
  };
}

/** JOIN clause from `base` to `target` using a declared relationship (either direction). */
function joinClause(model: ResolvedModel, base: string, target: string): string | null {
  const t = findSource(model, target);
  if (!t) return null;
  for (const r of model.relationships ?? []) {
    const [fs, fc] = r.from.split('.');
    const [ts, tc] = r.to.split('.');
    if (fs === base && ts === target) return `JOIN \`${t.table}\` AS ${target} ON ${target}.${tc} = ${base}.${fc}`;
    if (ts === base && fs === target) return `JOIN \`${t.table}\` AS ${target} ON ${target}.${fc} = ${base}.${tc}`;
  }
  return null;
}

export function metricPayload(model: ResolvedModel, name: string) {
  const n = name.trim().toLowerCase();
  const m: MetricSpec | undefined = (model.metrics ?? []).find((x) => x.name.toLowerCase() === n);
  if (!m) throw new Error(`Unknown metric "${name}". Metrics: ${(model.metrics ?? []).map((x) => x.name).join(', ')}`);
  const base = findSource(model, m.source);
  const joins = (m.joins ?? []).map((j) => joinClause(model, m.source, j) ?? `-- join ${j}: see describe_source`);
  const time = base?.time_column ? `${m.source}.${base.time_column}` : null;
  const where = [time && `${time} >= '2023-01-01' AND ${time} < '2024-01-01'`, m.filter].filter(Boolean).join('\n  AND ');
  const example = base
    ? [
        `SELECT ${time ? `DATE_TRUNC(DATE(${time}), MONTH) AS month, ` : ''}${m.sql} AS ${m.name}`,
        `FROM \`${base.table}\` AS ${m.source}`,
        ...joins,
        where && `WHERE ${where}`,
        time && 'GROUP BY month ORDER BY month',
      ].filter(Boolean).join('\n')
    : null;
  return { ...m, example_sql: example };
}
