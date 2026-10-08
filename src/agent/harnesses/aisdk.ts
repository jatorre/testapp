import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { jsonSchema, stepCountIs, streamText, tool, type ModelMessage, type ToolSet } from 'ai';
import type { ChatMessage, Harness, RunOptions, ToolModelOutput, Usage } from '../types';
import { ZERO_USAGE, addUsage, dataUrlBase64 } from '../types';
import { errorMessage, runTool, toolJsonSchema } from './common';

/** User images become file parts (the provider turns them into image_url data URLs). */
function toModelMessage(m: ChatMessage): ModelMessage {
  if (m.role === 'assistant' || !m.images?.length) return { role: m.role, content: m.content };
  return {
    role: 'user',
    content: [
      { type: 'text', text: m.content },
      ...m.images.map((i) => ({ type: 'file' as const, data: { type: 'data' as const, data: dataUrlBase64(i.dataUrl) }, mediaType: i.mime })),
    ],
  };
}

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
      // Tool results with images are sent as content parts in the tool message (verified: CARTO LiteLLM accepts
      // image_url inside role:"tool" for Claude and Gemini). Without this flag the SDK JSON-stringifies them.
      supportsMultiPartToolContent: true,
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
          toModelOutput: ({ output }: { output: ToolModelOutput }) =>
            output.images.length
              ? {
                  type: 'content' as const,
                  value: [
                    { type: 'text' as const, text: output.text },
                    ...output.images.map((i) => ({ type: 'file' as const, data: { type: 'data' as const, data: dataUrlBase64(i.dataUrl) }, mediaType: i.mime })),
                  ],
                }
              : { type: 'text' as const, value: output.text },
        }),
      ]),
    );

    const result = streamText({
      model: provider.chatModel(llm.model),
      instructions: system,
      messages: messages.map(toModelMessage),
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
