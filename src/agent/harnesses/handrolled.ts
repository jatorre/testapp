import type { ChatMessage, Harness, RunOptions, Usage } from '../types';
import { ZERO_USAGE, addUsage } from '../types';
import { imageFollowUpText, runTool, toolJsonSchema } from './common';

/**
 * Minimal hand-written agent loop: fetch + SSE against /chat/completions.
 * Baseline for "how little does a harness actually need".
 */
type Msg = Record<string, unknown>;
type PendingCall = { id: string; name: string; args: string };

async function* sse(res: Response): AsyncGenerator<any> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += value;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      yield JSON.parse(data);
    }
  }
}

/** User images become OpenAI-compatible content parts: [{type:'text'}, {type:'image_url', image_url:{url}}]. */
function toChatMessage(m: ChatMessage): Msg {
  if (!m.images?.length) return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: [{ type: 'text', text: m.content }, ...m.images.map((i) => ({ type: 'image_url', image_url: { url: i.dataUrl } }))],
  };
}

export const handrolledHarness: Harness = {
  id: 'handrolled',
  label: 'Hand-rolled (fetch + SSE)',
  async run({ llm, system, messages, tools, maxSteps, signal, onEvent }: RunOptions) {
    const t0 = Date.now();
    const byName = new Map(tools.map((t) => [t.name, t]));
    const toolDefs = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: toolJsonSchema(t) },
    }));
    const history: Msg[] = [{ role: 'system', content: system }, ...messages.map(toChatMessage)];
    let total: Usage = { ...ZERO_USAGE };
    let finalText = '';
    let step = 0;

    while (step < maxSteps) {
      const stepStart = Date.now();
      const res = await fetch(`${llm.baseURL}/chat/completions`, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` },
        body: JSON.stringify({
          model: llm.model,
          messages: history,
          tools: toolDefs.length ? toolDefs : undefined,
          stream: true,
          stream_options: { include_usage: true },
        }),
      });
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);

      let text = '';
      let usage: Usage = { ...ZERO_USAGE };
      const calls: PendingCall[] = [];
      for await (const chunk of sse(res)) {
        if (chunk.error) throw new Error(`LLM error: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
            // LiteLLM reports both OpenAI-style and Anthropic-style cache fields.
            cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? chunk.usage.cache_read_input_tokens ?? 0,
          };
        }
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          text += delta.content;
          onEvent({ type: 'text-delta', text: delta.content });
        }
        // Tool calls arrive as fragments keyed by index; id/name only on the first fragment.
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? calls.length;
          const c = (calls[idx] ??= { id: '', name: '', args: '' });
          if (tc.id) c.id = tc.id;
          if (tc.function?.name) c.name += tc.function.name;
          if (tc.function?.arguments) c.args += tc.function.arguments;
        }
      }
      step++;
      total = addUsage(total, usage);
      finalText = text;
      const toolCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${step}_${i}` }));
      history.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length && {
          tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })),
        }),
      });

      // Execute all tool calls of this step in parallel.
      const results = await Promise.all(
        toolCalls.map(async (c) => {
          let input: unknown;
          try {
            input = JSON.parse(c.args || '{}');
          } catch {
            input = { _raw: c.args };
          }
          const out = await runTool(byName.get(c.name), c.name, c.id, input, signal, onEvent);
          const content = out.images.length ? `${out.text}\n${imageFollowUpText(c.name, out.images.length)}` : out.text;
          return { msg: { role: 'tool', tool_call_id: c.id, content }, name: c.name, images: out.images };
        }),
      );
      history.push(...results.map((r) => r.msg));
      // Tool messages are text-only in the Chat Completions spec, so images a tool returned go in ONE follow-up user
      // message after all tool results of the step (a user message between tool results would break the sequence).
      const withImages = results.filter((r) => r.images.length);
      if (withImages.length) {
        history.push({
          role: 'user',
          content: withImages.flatMap((r) => [
            { type: 'text', text: `[images returned by ${r.name} (${r.msg.tool_call_id})]` },
            ...r.images.map((i) => ({ type: 'image_url', image_url: { url: i.dataUrl } })),
          ]),
        });
      }
      onEvent({ type: 'step-finish', step, usage, durationMs: Date.now() - stepStart });
      if (!toolCalls.length) break;
    }

    onEvent({ type: 'finish', totalUsage: total, steps: step, durationMs: Date.now() - t0 });
    return finalText;
  },
};
