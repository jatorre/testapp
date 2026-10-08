import { z } from 'zod';
import { compile } from 'vega-lite';
import { read } from 'vega';
import type { AgentTool } from '../agent/types';
import { fs, readText } from '../vfs/vfs';

/**
 * render_chart: the model sends a Vega-Lite spec; we validate + compile it (returning precise errors so the
 * model can fix them), check data references, and emit a UI-only artifact. The model only gets a tiny ack.
 *
 * Data may be inline (`data.values`, ≤ MAX_INLINE_ROWS) or a VFS path (`data.url: "/work/x.csv"`), which the
 * UI resolves with resolveSpecData() right before rendering — the data never goes through the model.
 */

export const MAX_INLINE_ROWS = 5000;
export const MAX_URL_ROWS = 50_000;

const MARKS = new Set([
  'arc', 'area', 'bar', 'image', 'line', 'point', 'rect', 'rule', 'text', 'tick', 'trail', 'circle', 'square',
  'geoshape', 'boxplot', 'errorband', 'errorbar',
]);
const TYPES = new Set(['quantitative', 'nominal', 'ordinal', 'temporal', 'geojson']);
const COMPOSITE_KEYS = ['layer', 'concat', 'hconcat', 'vconcat'] as const;

type Json = Record<string, any>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** Normalize a data.url to a VFS absolute path, or null if it is not a VFS reference. */
export function vfsPathOf(url: string): string | null {
  if (/^[a-z]+:\/\//i.test(url) || url.startsWith('data:')) return null;
  const p = url.startsWith('/') ? url : `/work/${url.replace(/^\.\//, '')}`;
  return p.replace(/\/+/g, '/');
}

function formatOf(path: string, data: Json): 'csv' | 'tsv' | 'json' | 'unsupported' {
  const t = data.format?.type as string | undefined;
  if (t === 'csv' || t === 'tsv' || t === 'json') return t;
  if (/\.csv$/i.test(path)) return 'csv';
  if (/\.tsv$/i.test(path)) return 'tsv';
  if (/\.(geo)?json$/i.test(path)) return 'json';
  return 'unsupported';
}

/** Visit every object in the spec that has a `data` property (views, layers, lookup.from, …). */
function visitData(node: unknown, fn: (holder: Json, path: string) => void, path = 'spec') {
  if (Array.isArray(node)) {
    node.forEach((n, i) => visitData(n, fn, `${path}[${i}]`));
    return;
  }
  if (!isObj(node)) return;
  if (isObj(node.data)) fn(node, `${path}.data`);
  for (const [k, v] of Object.entries(node)) {
    if (k === 'data' || k === 'encoding' || k === 'config') continue;
    if (v && typeof v === 'object') visitData(v, fn, `${path}.${k}`);
  }
}

const NUM_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
/** CSV/TSV → rows. Numbers and booleans are typed; dates stay strings (Vega-Lite parses temporal fields). */
export function parseDelimited(text: string, type: 'csv' | 'tsv'): Json[] {
  const rows = read(text, { type }) as Json[];
  if (!rows.length) return rows;
  for (const col of Object.keys(rows[0])) {
    let numeric = true;
    let bool = true;
    let any = false;
    for (const r of rows) {
      const v = r[col];
      if (v === '' || v == null) continue;
      any = true;
      if (numeric && !NUM_RE.test(v)) numeric = false;
      if (bool && v !== 'true' && v !== 'false') bool = false;
      if (!numeric && !bool) break;
    }
    if (!any) continue;
    if (numeric) for (const r of rows) r[col] = r[col] === '' || r[col] == null ? null : Number(r[col]);
    else if (bool) for (const r of rows) r[col] = r[col] === '' || r[col] == null ? null : r[col] === 'true';
  }
  return rows;
}

export interface ResolvedSpec {
  /** Deep copy of the spec with every VFS data.url replaced by data.values. */
  spec: Json;
  /** Rows in the first (top-level/primary) dataset; sum of all datasets in `totalRows`. */
  rows: number;
  totalRows: number;
  /** Columns of each resolved dataset, keyed by VFS path. */
  columns: Record<string, string[]>;
}

/**
 * Load every `data.url` that points into the VFS (/work/x.csv, /data/y.json, or relative → /work) into
 * inline `data.values`. Remote http(s) URLs are left alone. Throws a model-readable Error if a file is
 * missing, in an unsupported format (e.g. parquet), or too big.
 *
 * UI usage (ChartView):  const { spec } = await resolveSpecData(artifact.spec); vegaEmbed(el, spec)
 */
export async function resolveSpecData(spec: unknown, opts: { maxRows?: number } = {}): Promise<ResolvedSpec> {
  const maxRows = opts.maxRows ?? MAX_URL_ROWS;
  const copy: Json = structuredClone(typeof spec === 'string' ? JSON.parse(spec) : (spec as Json));
  const holders: { holder: Json; path: string }[] = [];
  visitData(copy, (holder, path) => holders.push({ holder, path }));
  const cache = new Map<string, Json[]>();
  const columns: Record<string, string[]> = {};
  let rows = -1;
  let totalRows = 0;
  for (const { holder } of holders) {
    const data = holder.data as Json;
    let n: number | undefined;
    if (typeof data.url === 'string') {
      const p = vfsPathOf(data.url);
      if (!p) continue;
      let values = cache.get(p);
      if (!values) {
        if (!(await fs.exists(p))) throw new Error(`data.url "${data.url}" → ${p} does not exist in the virtual filesystem. Write the file first (e.g. DuckDB COPY ... TO '${p}' (HEADER)).`);
        const fmt = formatOf(p, data);
        if (fmt === 'unsupported') throw new Error(`data.url "${p}": only .csv, .tsv and .json files can be charted. Convert it first (e.g. DuckDB COPY (SELECT ...) TO '/work/x.csv' (HEADER)).`);
        const text = await readText(p);
        if (fmt === 'json') {
          const parsed = JSON.parse(text);
          const prop = data.format?.property as string | undefined;
          const v = prop ? prop.split('.').reduce((o: any, k) => o?.[k], parsed) : parsed;
          values = Array.isArray(v) ? v : isObj(v) && Array.isArray(v.features) ? v.features : [v];
        } else values = parseDelimited(text, fmt);
        if (values.length > maxRows) throw new Error(`${p} has ${values.length} rows; charts are limited to ${maxRows}. Aggregate first.`);
        cache.set(p, values);
        if (isObj(values[0])) columns[p] = Object.keys(values[0]);
      }
      const { url: _url, format, ...rest } = data;
      const keep = isObj(format) && format.parse ? { format: { parse: format.parse } } : {};
      holder.data = { ...rest, ...keep, values };
      n = values.length;
    } else if (Array.isArray(data.values)) n = data.values.length;
    if (n !== undefined) {
      if (rows < 0) rows = n;
      totalRows += n;
    }
  }
  return { spec: copy, rows: Math.max(rows, 0), totalRows, columns };
}

// ---------------------------------------------------------------------------------------------------
// Validation

/** Cheap structural checks that give clearer messages than vega-lite's compile errors. */
export function lintSpec(spec: Json): string[] {
  const errs: string[] = [];
  if (Array.isArray(spec.marks) || Array.isArray(spec.signals)) {
    errs.push('This looks like a full Vega spec (marks/signals). Send a Vega-Lite spec (mark + encoding) instead.');
    return errs;
  }
  const walk = (v: Json, path: string) => {
    const comp = COMPOSITE_KEYS.find((k) => Array.isArray(v[k]));
    if (comp) {
      (v[comp] as Json[]).forEach((c, i) => isObj(c) && walk(c, `${path}.${comp}[${i}]`));
      return;
    }
    if (isObj(v.spec) && (v.facet || v.repeat)) {
      walk(v.spec, `${path}.spec`);
      return;
    }
    if (v.mark === undefined) {
      errs.push(`${path}: a view needs "mark" (or layer/concat/hconcat/vconcat, or facet/repeat + spec).`);
      return;
    }
    const mt = typeof v.mark === 'string' ? v.mark : v.mark?.type;
    if (!MARKS.has(mt)) errs.push(`${path}.mark: unknown mark type "${mt}". Use one of ${[...MARKS].join(', ')}.`);
    if (isObj(v.encoding)) {
      for (const [ch, def] of Object.entries(v.encoding)) {
        const defs = Array.isArray(def) ? def : [def]; // tooltip/detail arrays
        for (const d of defs) {
          if (!isObj(d)) continue;
          if (d.type !== undefined && !TYPES.has(d.type)) {
            errs.push(`${path}.encoding.${ch}.type: "${d.type}" is invalid; use quantitative | nominal | ordinal | temporal.`);
          }
          if (d.field !== undefined && typeof d.field !== 'string' && !isObj(d.field)) errs.push(`${path}.encoding.${ch}.field must be a string.`);
        }
      }
    }
  };
  walk(spec, 'spec');
  return errs;
}

function collectFields(spec: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(spec)) spec.forEach((s) => collectFields(s, out));
  else if (isObj(spec)) {
    if (isObj(spec.encoding)) {
      for (const def of Object.values(spec.encoding)) {
        for (const d of Array.isArray(def) ? def : [def]) if (isObj(d) && typeof d.field === 'string') out.add(d.field.split('.')[0].replace(/\\/g, ''));
      }
    }
    for (const [k, v] of Object.entries(spec)) if (k !== 'encoding' && k !== 'data' && v && typeof v === 'object') collectFields(v, out);
  }
  return out;
}
/** Field names created by transforms/aggregates (`as`, fold, etc.) — excluded from the missing-field check. */
function collectDerived(spec: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(spec)) spec.forEach((s) => collectDerived(s, out));
  else if (isObj(spec)) {
    for (const [k, v] of Object.entries(spec)) {
      if (k === 'as') (Array.isArray(v) ? v : [v]).forEach((a) => typeof a === 'string' && out.add(a));
      else if (k === 'data') continue;
      else if (v && typeof v === 'object') collectDerived(v, out);
    }
    if (Array.isArray(spec.fold) && !spec.as) ['key', 'value'].forEach((f) => out.add(f));
    if (spec.repeat) out.add('repeat');
  }
  return out;
}

export interface ChartCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
  rows: number;
}

/** Full validation used by render_chart (exported for tests). */
export async function checkChartSpec(raw: unknown): Promise<ChartCheck & { spec?: Json }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  let spec: Json;
  try {
    spec = typeof raw === 'string' ? JSON.parse(raw) : (raw as Json);
  } catch (e) {
    return { ok: false, errors: [`spec is not valid JSON: ${(e as Error).message}`], warnings, rows: 0 };
  }
  if (!isObj(spec)) return { ok: false, errors: ['spec must be a JSON object (a Vega-Lite spec).'], warnings, rows: 0 };
  spec = structuredClone(spec);
  errors.push(...lintSpec(spec));

  // Data references.
  visitData(spec, (holder, path) => {
    const d = holder.data as Json;
    if (Array.isArray(d.values) && d.values.length > MAX_INLINE_ROWS) {
      errors.push(`${path}.values has ${d.values.length} rows; inline data is limited to ${MAX_INLINE_ROWS}. Write the (aggregated) data to /work/*.csv and use data.url.`);
    }
    if (typeof d.url === 'string') {
      const p = vfsPathOf(d.url);
      if (!p) errors.push(`${path}.url "${d.url}": remote URLs are not allowed; use a file in /work or /data.`);
      else d.url = p; // normalize relative paths for the UI
    }
  });
  const hasData = (() => {
    let found = false;
    visitData(spec, () => (found = true));
    return found || isObj(spec.datasets);
  })();
  if (!hasData) errors.push('spec has no data. Add {"data": {"url": "/work/file.csv"}} or {"data": {"values": [...]}}.');
  if (errors.length) return { ok: false, errors, warnings, rows: 0 };

  let resolved: ResolvedSpec;
  try {
    resolved = await resolveSpecData(spec);
  } catch (e) {
    return { ok: false, errors: [(e as Error).message], warnings, rows: 0 };
  }

  // Compile (catches structural errors); collect vega-lite warnings.
  const logger: any = {
    level() { return logger; },
    error(...a: unknown[]) { errors.push(a.map(String).join(' ')); return logger; },
    warn(...a: unknown[]) { warnings.push(a.map(String).join(' ')); return logger; },
    info() { return logger; },
    debug() { return logger; },
  };
  try {
    compile(resolved.spec as any, { logger });
  } catch (e) {
    errors.push(`Vega-Lite compile error: ${(e as Error).message}`);
  }

  // Field names vs data columns (only when we know the columns of a single dataset).
  const colSets = Object.values(resolved.columns);
  const inline = visitInlineColumns(resolved.spec);
  const allCols = new Set([...colSets.flat(), ...inline]);
  if (allCols.size) {
    const derived = collectDerived(resolved.spec);
    const missing = [...collectFields(resolved.spec)].filter((f) => !allCols.has(f) && !derived.has(f));
    if (missing.length) warnings.push(`Fields not found in data: ${missing.join(', ')}. Available columns: ${[...allCols].slice(0, 40).join(', ')}.`);
  }
  return { ok: errors.length === 0, errors, warnings: [...new Set(warnings)].slice(0, 10), rows: resolved.rows, spec };
}

function visitInlineColumns(spec: Json): string[] {
  const cols = new Set<string>();
  visitData(spec, (h) => {
    const v = (h.data as Json).values;
    if (Array.isArray(v)) v.slice(0, 50).forEach((r) => isObj(r) && Object.keys(r).forEach((k) => cols.add(k)));
  });
  return [...cols];
}

// ---------------------------------------------------------------------------------------------------

export function createChartTools(): AgentTool[] {
  const renderChart: AgentTool<{ spec: unknown; title?: string }> = {
    name: 'render_chart',
    description:
      'Render a chart for the user from a Vega-Lite (v5/v6) spec. The chart is shown in the UI; you only get an ' +
      'acknowledgement (or validation errors to fix). Data: prefer {"data":{"url":"/work/agg.csv"}} pointing at a ' +
      `CSV/JSON file you wrote (≤ ${MAX_URL_ROWS} rows), or inline {"data":{"values":[...]}} (≤ ${MAX_INLINE_ROWS} rows). ` +
      'Aggregate before charting. Supports layer/concat/facet/repeat. Do not include width:"container" tricks; ' +
      'set "title" in the spec or via the title argument.',
    inputSchema: z.object({
      spec: z
        .union([z.record(z.string(), z.any()), z.string()])
        .describe('Vega-Lite spec object (mark, encoding, data, transform, ...). A JSON string is also accepted.'),
      title: z.string().optional().describe('Short chart title shown above the chart'),
    }),
    async execute({ spec, title }, ctx) {
      const r = await checkChartSpec(spec);
      if (!r.ok || !r.spec) {
        return { ok: false, errors: r.errors.slice(0, 10), warnings: r.warnings.length ? r.warnings : undefined, hint: 'Fix the spec and call render_chart again.' };
      }
      const finalTitle = title ?? (typeof r.spec.title === 'string' ? r.spec.title : r.spec.title?.text) ?? 'Chart';
      ctx.emitArtifact({ kind: 'vega-lite', title: finalTitle, spec: r.spec });
      return { ok: true, rendered: finalTitle, rows: r.rows, ...(r.warnings.length ? { warnings: r.warnings } : {}) };
    },
  };
  return [renderChart];
}
