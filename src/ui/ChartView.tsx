import { useEffect, useRef, useState } from 'react';

/**
 * Renders a Vega-Lite artifact. VFS data.url references (/work/x.csv …) are inlined by
 * resolveSpecData from src/tools/chart.ts (vega can't fetch from the in-memory FS).
 */
export function ChartView({ spec, title }: { spec: unknown; title?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let finalize: (() => void) | undefined;
    (async () => {
      try {
        const [{ default: embed }, { resolveSpecData }] = await Promise.all([import('vega-embed'), import('../tools/chart')]);
        const { spec: resolved } = await resolveSpecData(spec);
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
