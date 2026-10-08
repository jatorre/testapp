import {
  Agent,
  MaxTurnsExceededError,
  OpenAIChatCompletionsModel,
  assistant,
  run,
  setTracingDisabled,
  tool,
  user,
  type AgentInputItem,
  type CallModelInputFilter,
} from '@openai/agents';
import OpenAI from 'openai';
import type { ChatMessage, Harness, ModelImage, RunOptions, Usage } from '../types';
import { ZERO_USAGE, addUsage } from '../types';
import { imageFollowUpText, runTool, toolJsonSchema } from './common';

// Tracing would otherwise try to export spans to api.openai.com with our CARTO token.
setTracingDisabled(true);

const userItem = (text: string, images: ModelImage[] = []) =>
  images.length ? user([{ type: 'input_text', text }, ...images.map((i) => ({ type: 'input_image' as const, image: i.dataUrl }))]) : user(text);

const toInputItem = (m: ChatMessage) => (m.role === 'user' ? userItem(m.content, m.images) : assistant(m.content));

/**
 * Over Chat Completions the SDK drops image tool outputs (text only, placeholder + warning). So tools return text and
 * we re-insert their images as ONE user message after each run of tool results, right before every model call.
 */
function injectToolImages(images: Map<string, { name: string; images: ModelImage[] }>): CallModelInputFilter {
  return ({ modelData }) => {
    const input: AgentInputItem[] = [];
    let pending: AgentInputItem[] = [];
    const flush = () => {
      input.push(...pending);
      pending = [];
    };
    for (const item of modelData.input) {
      if (item.type !== 'function_call_result') flush();
      input.push(item);
      const hit = item.type === 'function_call_result' ? images.get(item.callId) : undefined;
      if (hit) pending.push(userItem(`[images returned by ${hit.name} (${(item as { callId: string }).callId})]`, hit.images));
    }
    flush();
    return { ...modelData, input };
  };
}

/** OpenAI Agents SDK (JS) over Chat Completions against the LiteLLM proxy. */
export const openAiAgentsHarness: Harness = {
  id: 'openai-agents',
  label: 'OpenAI Agents SDK',
  async run({ llm, system, messages, tools, maxSteps, signal, onEvent }: RunOptions) {
    const t0 = Date.now();
    const client = new OpenAI({ baseURL: llm.baseURL, apiKey: llm.apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 });
    const model = new OpenAIChatCompletionsModel(client, llm.model);

    let callSeq = 0;
    const toolImages = new Map<string, { name: string; images: ModelImage[] }>();
    const agentTools = tools.map((t) =>
      tool({
        name: t.name,
        description: t.description,
        // Non-strict JSON schema: arguments are JSON-parsed but not validated by the SDK,
        // runTool validates with zod (same behaviour as the other harnesses).
        parameters: toolJsonSchema(t) as any,
        strict: false,
        errorFunction: null,
        execute: async (input, _ctx, details) => {
          const id = details?.toolCall?.callId ?? `call_${++callSeq}`;
          const out = await runTool(t, t.name, id, input, details?.signal ?? signal, onEvent);
          if (!out.images.length) return out.text;
          toolImages.set(id, { name: t.name, images: out.images });
          return `${out.text}\n${imageFollowUpText(t.name, out.images.length)}`;
        },
      }),
    );

    const agent = new Agent({ name: 'analyst', instructions: system, model, tools: agentTools });
    const input = messages.map(toInputItem);

    let total: Usage = { ...ZERO_USAGE };
    let steps = 0;
    let stepStart = Date.now();
    let stepText = '';
    try {
      const stream = await run(agent, input, {
        stream: true,
        maxTurns: maxSteps,
        signal,
        callModelInputFilter: injectToolImages(toolImages),
      });
      for await (const ev of stream) {
        if (ev.type !== 'raw_model_stream_event') continue;
        const d = ev.data;
        if (d.type === 'response_started') {
          stepStart = Date.now();
          stepText = '';
        } else if (d.type === 'output_text_delta') {
          stepText += d.delta;
          onEvent({ type: 'text-delta', text: d.delta });
        } else if (d.type === 'response_done') {
          steps++;
          const u = d.response.usage;
          const details = Array.isArray(u.inputTokensDetails) ? u.inputTokensDetails[0] : u.inputTokensDetails;
          const usage: Usage = {
            inputTokens: u.inputTokens ?? 0,
            outputTokens: u.outputTokens ?? 0,
            cachedInputTokens: details?.cached_tokens ?? 0,
          };
          total = addUsage(total, usage);
          onEvent({ type: 'step-finish', step: steps, usage, durationMs: Date.now() - stepStart });
        }
      }
      await stream.completed;
      if (stream.error) throw stream.error;
    } catch (e) {
      // Hitting maxTurns is a normal stop condition for the other harnesses; match that.
      if (!(e instanceof MaxTurnsExceededError)) throw e;
    }
    onEvent({ type: 'finish', totalUsage: total, steps, durationMs: Date.now() - t0 });
    return stepText;
  },
};
