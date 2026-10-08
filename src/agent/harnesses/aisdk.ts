import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { jsonSchema, stepCountIs, streamText, tool, type ToolSet } from 'ai';
import type { Harness, RunOptions, Usage } from '../types';
import { ZERO_USAGE, addUsage } from '../types';
import { errorMessage, runTool, toolJsonSchema } from './common';

/** Vercel AI SDK v7: streamText + stopWhen(stepCountIs) over the OpenAI-compatible provider. */
export const aiSdkHarness: Harness = {
  id: 'aisdk',
  label: 'Vercel AI SDK v7',
  async run({ llm, system, messages, tools, maxSteps, signal, onEvent }: RunOptions) {
    const t0 = Date.now();
    const provider = createOpenAICompatible({
      name: 'carto-litellm',
      baseURL: llm.baseURL,
      apiKey: llm.apiKey,
      includeUsage: true,
    });

    // Plain JSON schema (no SDK-side validation) so invalid args reach runTool, which
    // reports them to the model the same way in every harness.
    const toolSet: ToolSet = Object.fromEntries(
      tools.map((t) => [
        t.name,
        tool({
          description: t.description,
          inputSchema: jsonSchema(toolJsonSchema(t) as any),
          execute: (input: unknown, { toolCallId, abortSignal }) =>
            runTool(t, t.name, toolCallId, input, abortSignal ?? signal, onEvent),
        }),
      ]),
    );

    const result = streamText({
      model: provider.chatModel(llm.model),
      instructions: system,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      tools: toolSet,
      stopWhen: stepCountIs(maxSteps),
      abortSignal: signal,
      maxRetries: 1,
    });

    let total: Usage = { ...ZERO_USAGE };
    let steps = 0;
    let stepStart = Date.now();
    let stepText = '';
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'start-step':
          stepStart = Date.now();
          stepText = '';
          break;
        case 'text-delta':
          stepText += part.text;
          onEvent({ type: 'text-delta', text: part.text });
          break;
        case 'finish-step': {
          steps++;
          const usage: Usage = {
            inputTokens: part.usage.inputTokens ?? 0,
            outputTokens: part.usage.outputTokens ?? 0,
            cachedInputTokens: part.usage.inputTokenDetails?.cacheReadTokens ?? 0,
          };
          total = addUsage(total, usage);
          onEvent({ type: 'step-finish', step: steps, usage, durationMs: Date.now() - stepStart });
          break;
        }
        case 'error':
          throw new Error(errorMessage(part.error));
        case 'abort':
          throw new DOMException('Aborted', 'AbortError');
        default:
          break; // tool-call / tool-result already reported by runTool
      }
    }
    onEvent({ type: 'finish', totalUsage: total, steps, durationMs: Date.now() - t0 });
    return stepText;
  },
};
