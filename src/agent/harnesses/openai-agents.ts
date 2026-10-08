import {
  Agent,
  MaxTurnsExceededError,
  OpenAIChatCompletionsModel,
  assistant,
  run,
  setTracingDisabled,
  tool,
  user,
} from '@openai/agents';
import OpenAI from 'openai';
import type { Harness, RunOptions, Usage } from '../types';
import { ZERO_USAGE, addUsage } from '../types';
import { runTool, toolJsonSchema } from './common';

// Tracing would otherwise try to export spans to api.openai.com with our CARTO token.
setTracingDisabled(true);

/** OpenAI Agents SDK (JS) over Chat Completions against the LiteLLM proxy. */
export const openAiAgentsHarness: Harness = {
  id: 'openai-agents',
  label: 'OpenAI Agents SDK',
  async run({ llm, system, messages, tools, maxSteps, signal, onEvent }: RunOptions) {
    const t0 = Date.now();
    const client = new OpenAI({ baseURL: llm.baseURL, apiKey: llm.apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 });
    const model = new OpenAIChatCompletionsModel(client, llm.model);

    let callSeq = 0;
    const agentTools = tools.map((t) =>
      tool({
        name: t.name,
        description: t.description,
        // Non-strict JSON schema: arguments are JSON-parsed but not validated by the SDK,
        // runTool validates with zod (same behaviour as the other harnesses).
        parameters: toolJsonSchema(t) as any,
        strict: false,
        errorFunction: null,
        execute: (input, _ctx, details) =>
          runTool(t, t.name, details?.toolCall?.callId ?? `call_${++callSeq}`, input, details?.signal ?? signal, onEvent),
      }),
    );

    const agent = new Agent({ name: 'analyst', instructions: system, model, tools: agentTools });
    const input = messages.map((m) => (m.role === 'user' ? user(m.content) : assistant(m.content)));

    let total: Usage = { ...ZERO_USAGE };
    let steps = 0;
    let stepStart = Date.now();
    let stepText = '';
    try {
      const stream = await run(agent, input, { stream: true, maxTurns: maxSteps, signal });
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
