import { useEffect, useRef, useState } from 'react';
import { fs, readText } from '../vfs/vfs';

/**
 * Replace any `data: {url: "/work/x.csv"}` that points into the VFS with inline values
 * (vega can't fetch from the in-memory FS). Recurses into layer/concat/facet specs.
 */
export async function inlineVfsData(spec: unknown): Promise<unknown> {
  if (Array.isArray(spec)) return Promise.all(spec.map(inlineVfsData));
  if (!spec || typeof spec !== 'object') return spec;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(spec)) {
    const url = k === 'data' && v && typeof v === 'object' ? (v as { url?: unknown }).url : undefined;
    if (typeof url === 'string' && url.startsWith('/')) {
      if (!(await fs.exists(url))) throw new Error(`Chart data file not found in VFS: ${url}`);
      const ext = url.split('.').pop()?.toLowerCase();
      if (ext === 'parquet') throw new Error(`Parquet chart data not supported (${url}); write a CSV/JSON aggregate instead`);
      const text = await readText(url);
      const { url: _u, format, ...rest } = v as Record<string, unknown>;
      const type = ext === 'json' ? 'json' : ext === 'tsv' ? 'tsv' : 'csv';
      out[k] = { ...rest, values: type === 'json' ? JSON.parse(text) : text, format: { ...(format as object), type } };
      if (type === 'json') delete (out[k] as Record<string, unknown>).format;
    } else {
      out[k] = await inlineVfsData(v);
    }
  }
  return out;
}

export function ChartView({ spec, title }: { spec: unknown; title?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let finalize: (() => void) | undefined;
    (async () => {
      try {
        const [{ default: embed }, resolved] = await Promise.all([import('vega-embed'), inlineVfsData(spec)]);
        if (cancelled || !ref.current) return;
        const res = await embed(ref.current, resolved as any, { actions: { export: true, source: true, compiled: false, editor: false } });
        finalize = () => res.finalize();
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      finalize?.();
    };
  }, [spec]);
  return (
    <div className="chart" data-testid="chart">
      {title && <div className="chart-title">{title}</div>}
      {error && <div className="error">Chart error: {error}</div>}
      <div ref={ref} />
    </div>
  );
}
