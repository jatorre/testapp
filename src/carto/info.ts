/**
 * Runtime bootstrap. When hosted via `carto app deploy`, CARTO serves
 * ./carto-info.json next to index.html with the *viewer's* token, the API base
 * URL and (if the tenant has AI configured) an OpenAI-compatible LiteLLM base URL.
 * No secret ever ships in the bundle.
 *
 * In local dev (`npm run dev`) there is no carto-info.json, so we fall back to
 * VITE_CARTO_* env vars from .env.local (never committed).
 */
export interface CartoInfo {
  accessToken: string;
  apiBaseUrl: string;
  /** OpenAI-compatible, ends with /v1 after normalization. */
  aiBaseUrl?: string;
  expiresAt?: number;
  user: { id: string; accountId: string; email: string | null } | null;
  source: 'carto-info.json' | 'env';
}

let cached: Promise<CartoInfo> | null = null;

export function getCartoInfo(): Promise<CartoInfo> {
  cached ??= load();
  return cached;
}

function normalizeAiBase(u?: string) {
  if (!u) return undefined;
  const t = u.replace(/\/+$/, '');
  return t.endsWith('/v1') ? t : `${t}/v1`;
}

async function load(): Promise<CartoInfo> {
  try {
    // Never cache: token is viewer-specific.
    const res = await fetch('./carto-info.json', { cache: 'no-store' });
    if (res.ok && res.headers.get('content-type')?.includes('json')) {
      const j = await res.json();
      return { ...j, aiBaseUrl: normalizeAiBase(j.aiBaseUrl), source: 'carto-info.json' };
    }
  } catch {
    /* fall through to env */
  }
  // Dev-only fallback. Guarded by import.meta.env.DEV so production builds dead-code-eliminate it and can never
  // inline a token (the token lives in .env.development.local, which `vite build` does not load).
  if (!import.meta.env.DEV) {
    throw new Error('No ./carto-info.json: open this app through CARTO (carto app deploy), not as a static file.');
  }
  const env = import.meta.env;
  const token = env.VITE_CARTO_TOKEN as string | undefined;
  if (!token) {
    throw new Error(
      'No ./carto-info.json (not running as a CARTO hosted app) and VITE_CARTO_TOKEN is not set. ' +
        'For local dev, create .env.local — see .env.example.',
    );
  }
  return {
    accessToken: token,
    apiBaseUrl: (env.VITE_CARTO_API_BASE_URL as string) || 'https://gcp-us-east1.api.carto.com',
    aiBaseUrl: normalizeAiBase((env.VITE_CARTO_AI_BASE_URL as string) || undefined),
    user: null,
    source: 'env',
  };
}

/** Name of the CARTO connection (BigQuery) the demos query through. */
export function getConnectionName(): string {
  return (
    new URLSearchParams(location.search).get('connection') ||
    (import.meta.env.VITE_CARTO_CONNECTION as string) ||
    'carto_dw'
  );
}
