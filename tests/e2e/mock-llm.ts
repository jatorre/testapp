import type { Page, Route } from '@playwright/test';

/**
 * Scripted fake OpenAI-compatible server (CARTO LiteLLM flavour) for Playwright.
 *
 *   const llm = await installMockLlm(page, [
 *     { toolCalls: [{ name: 'write_file', args: { path: '/work/a.txt', content: 'hi' } }] },
 *     { text: 'Done.' },
 *   ]);
 *
 * Each POST /chat/completions consumes the next turn (in order, across runs).
 * Streams SSE like LiteLLM: role chunk, content / tool_call fragments (id+name first, arguments split
 * in pieces), finish_reason chunk, then a usage-only chunk (choices: []), then [DONE].
 * Non-streaming requests get a regular JSON completion.
 */
export type MockToolCall = { name: string; args: unknown; id?: string };
export type MockTurn =
  | { toolCalls: MockToolCall[]; text?: string; usage?: Partial<MockUsage>; delayMs?: number }
  | { text: string; usage?: Partial<MockUsage>; delayMs?: number }
  | { error: { status: number; message: string } };

export interface MockUsage {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
}

export interface MockLlmOptions {
  /** Base URL the app is configured with (VITE_CARTO_AI_BASE_URL). */
  baseURL?: string;
  models?: string[];
  /** Turn returned once the script is exhausted. */
  fallback?: MockTurn;
}

export interface MockLlm {
  /** Parsed JSON bodies of every /chat/completions request, in order. */
  requests: any[];
  /** Index of the next turn to be served. */
  readonly served: number;
  /** Replace the script and reset the turn counter. */
  setScript(script: MockTurn[]): void;
}

export const MOCK_BASE_URL = 'http://mock-llm.test/v1';
/** Model ids as returned by the real CARTO LiteLLM proxy. */
export const MOCK_MODELS = [
  'carto::gemini-3.8-flash',
  'carto::gemini-3.7-flash',
  'carto::gemini-3.5-flash',
  'carto::gemini-3.1-pro',
  'carto::claude-opus-5.5',
  'carto::claude-sonnet-5',
  'carto::claude-opus-4.8',
  'carto::claude-opus-4.7',
  'carto::claude-opus-4.6',
  'carto::claude-sonnet-4.6',
  'mock-model',
];

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

/** Usage object in the shape LiteLLM returns (OpenAI + Anthropic-style cache fields). */
export function litellmUsage(u: MockUsage) {
  return {
    completion_tokens: u.completion_tokens,
    prompt_tokens: u.prompt_tokens,
    total_tokens: u.prompt_tokens + u.completion_tokens,
    completion_tokens_details: { reasoning_tokens: 0, text_tokens: u.completion_tokens },
    prompt_tokens_details: { cached_tokens: u.cached_tokens, cache_write_tokens: 0, text_tokens: u.prompt_tokens - u.cached_tokens },
    cache_read_input_tokens: u.cached_tokens,
    cache_creation_input_tokens: 0,
  };
}

/** Default usage for turn i (0-based): prompt 100*(i+1), completion 20, cached 0. */
export function defaultUsage(i: number): MockUsage {
  return { prompt_tokens: 100 * (i + 1), completion_tokens: 20, cached_tokens: 0 };
}

function splitInPieces(s: string, n: number): string[] {
  if (s.length < n) return [s];
  const size = Math.ceil(s.length / n);
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

export function sseBody(turn: Exclude<MockTurn, { error: unknown }>, turnIndex: number, model: string): string {
  const id = `chatcmpl-mock-${turnIndex}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: object, finish: string | null = null) => ({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const events: object[] = [chunk({ role: 'assistant', content: '' })];
  if (turn.text) for (const piece of turn.text.match(/\S+\s*|\s+/g) ?? []) events.push(chunk({ content: piece }));
  const calls = 'toolCalls' in turn ? turn.toolCalls : [];
  calls.forEach((c, index) => {
    const callId = c.id ?? `call_${turnIndex}_${index}`;
    events.push(chunk({ tool_calls: [{ index, id: callId, type: 'function', function: { name: c.name, arguments: '' } }] }));
    for (const piece of splitInPieces(JSON.stringify(c.args), 3)) {
      events.push(chunk({ tool_calls: [{ index, function: { arguments: piece } }] }));
    }
  });
  events.push(chunk({}, calls.length ? 'tool_calls' : 'stop'));
  const u = { ...defaultUsage(turnIndex), ...turn.usage };
  events.push({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: litellmUsage(u) });
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
}

function jsonCompletion(turn: Exclude<MockTurn, { error: unknown }>, turnIndex: number, model: string) {
  const calls = 'toolCalls' in turn ? turn.toolCalls : [];
  return {
    id: `chatcmpl-mock-${turnIndex}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      finish_reason: calls.length ? 'tool_calls' : 'stop',
      message: {
        role: 'assistant',
        content: turn.text ?? null,
        ...(calls.length && {
          tool_calls: calls.map((c, i) => ({
            id: c.id ?? `call_${turnIndex}_${i}`, type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        }),
      },
    }],
    usage: litellmUsage({ ...defaultUsage(turnIndex), ...turn.usage }),
  };
}

export async function installMockLlm(page: Page, script: MockTurn[], opts: MockLlmOptions = {}): Promise<MockLlm> {
  const base = (opts.baseURL ?? MOCK_BASE_URL).replace(/\/+$/, '');
  const models = opts.models ?? MOCK_MODELS;
  const fallback: MockTurn = opts.fallback ?? { text: '(mock LLM: script exhausted)' };
  let turns = script;
  let served = 0;
  const requests: any[] = [];

  await page.route(`${base}/models`, async (route: Route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    await route.fulfill({
      status: 200,
      headers: { ...CORS, 'content-type': 'application/json' },
      body: JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model', created: 0, owned_by: 'carto' })) }),
    });
  });

  await page.route(`${base}/chat/completions`, async (route: Route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const body = req.postDataJSON();
    requests.push(body);
    const i = served++;
    const turn = turns[i] ?? fallback;
    if ('error' in turn) {
      return route.fulfill({
        status: turn.error.status,
        headers: { ...CORS, 'content-type': 'application/json' },
        body: JSON.stringify({ error: { message: turn.error.message, type: 'mock_error', code: String(turn.error.status) } }),
      });
    }
    if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs));
    const model = body?.model ?? 'mock-model';
    if (body?.stream) {
      await route.fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: sseBody(turn, i, model),
      });
    } else {
      await route.fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'application/json' },
        body: JSON.stringify(jsonCompletion(turn, i, model)),
      });
    }
  });

  return {
    requests,
    get served() {
      return served;
    },
    setScript(s: MockTurn[]) {
      turns = s;
      served = 0;
    },
  };
}
