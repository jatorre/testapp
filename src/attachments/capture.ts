/**
 * Things on the page that can be captured as PNG (charts and point maps rendered by ChartView register here via
 * vega's view.toImageURL). Used by the composer's "📷 capture" button and by the capture_chart tool.
 */
interface Capturable {
  title: string;
  toPng: () => Promise<string>;
}
const live = new Map<number, Capturable>();
/** Specs emitted by render_chart, so a chart can be captured even when no UI renders it (headless evals). */
const emitted: { title: string; spec: unknown }[] = [];
export function noteChartSpec(title: string, spec: unknown) {
  emitted.push({ title, spec });
  if (emitted.length > 20) emitted.shift();
}

async function renderOffscreen(spec: unknown): Promise<string> {
  const [{ default: embed }, { resolveSpecData }] = await Promise.all([import('vega-embed'), import('../tools/chart')]);
  const res = await embed(document.createElement('div'), (await resolveSpecData(spec)).spec as any, { actions: false });
  try {
    return await res.view.toImageURL('png');
  } finally {
    res.finalize();
  }
}
let seq = 0;

export function registerCapturable(c: Capturable): () => void {
  const id = ++seq;
  live.set(id, c);
  return () => live.delete(id);
}

/** Capture the most recently rendered chart (or the latest one whose title contains `match`). */
export async function captureLatest(match?: string, waitMs = 1500): Promise<{ title: string; dataUrl: string }> {
  const find = () => {
    const all = [...live.values()];
    return match ? all.filter((c) => c.title.toLowerCase().includes(match.toLowerCase())).pop() : all.pop();
  };
  // A chart emitted by render_chart in the same turn may still be rendering (vega-embed is async).
  let pick = find();
  for (let t = 0; !pick && t < waitMs; t += 100) {
    await new Promise((r) => setTimeout(r, 100));
    pick = find();
  }
  if (!pick) {
    const spec = match ? emitted.filter((c) => c.title.toLowerCase().includes(match.toLowerCase())).pop() : emitted.at(-1);
    if (spec) return { title: spec.title, dataUrl: await renderOffscreen(spec.spec) };
  }
  if (!pick) throw new Error(match ? `No rendered chart matches "${match}"` : 'No chart or map is rendered on the page');
  return { title: pick.title, dataUrl: await pick.toPng() };
}
