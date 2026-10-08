/**
 * Semantic model registry + the system-prompt section the runner injects for demos with `semantic: <model id>`.
 * Models are JSON files in ./models (imported as raw text so no tsconfig change is needed).
 */
import thelookRaw from './models/thelook_ecommerce.json?raw';
import usGeoRaw from './models/us_geo.json?raw';
import { loadCatalog } from './catalog';
import { estimateTokens, renderSemanticPrompt, resolveModel, type RenderOptions } from './render';
import type { Catalog, ResolvedModel, SemanticModel } from './types';

export type { Catalog, ResolvedModel, SemanticModel } from './types';

export const SEMANTIC_MODELS: Record<string, SemanticModel> = Object.fromEntries(
  [thelookRaw, usGeoRaw].map((raw) => {
    const m = JSON.parse(raw) as SemanticModel;
    return [m.id, m];
  }),
);

export function getSemanticModel(id: string): ResolvedModel {
  return resolveModel(id, SEMANTIC_MODELS);
}

/** Every registered model merged (what the semantic tools search). */
export function getAllSources(): ResolvedModel {
  const ids = Object.keys(SEMANTIC_MODELS);
  return resolveModel('__all__', { ...SEMANTIC_MODELS, __all__: { id: '__all__', version: '0', title: 'all', sources: [], includes: ids } });
}

export interface SemanticPrompt {
  text: string;
  estTokens: number;
  catalog: Catalog;
}

/**
 * Semantic model + cached catalog rendered for the system prompt. The catalog load is bounded to `timeoutMs`.
 * `id` may carry a render mode suffix: "thelook_ecommerce:lite".
 */
export async function buildSemanticPrompt(id: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<SemanticPrompt> {
  const [modelId, mode] = id.split(':') as [string, RenderOptions['mode']?];
  const model = getSemanticModel(modelId);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 10_000);
  const onAbort = () => ctl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const catalog = await loadCatalog(model, { signal: ctl.signal });
    const text = renderSemanticPrompt(model, catalog, { mode });
    return { text, estTokens: estimateTokens(text), catalog };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** Convenience for the runner: just the text. */
export async function semanticPromptFor(id: string, signal?: AbortSignal): Promise<string> {
  return (await buildSemanticPrompt(id, { signal })).text;
}
