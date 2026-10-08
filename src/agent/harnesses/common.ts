import { z } from 'zod';
import type { AgentEvent, AgentTool, Artifact, ToolModelOutput } from '../types';
import { isToolImageOutput, toModelString } from '../types';

/**
 * Shared tool execution wrapper used by every harness so that timing / output-size
 * measurements are identical regardless of the agent loop. Emits tool-call and
 * tool-result events and returns the capped string the model will see, plus any images
 * the tool returned (toolImages()); each harness decides how images reach the model.
 * Errors are converted into a model-visible error string (the loop continues).
 */
export async function runTool(
  tool: AgentTool | undefined,
  name: string,
  id: string,
  input: unknown,
  signal: AbortSignal | undefined,
  onEvent: (e: AgentEvent) => void,
): Promise<ToolModelOutput> {
  const startedAt = Date.now();
  onEvent({ type: 'tool-call', id, name, input, startedAt });
  let output: unknown;
  let error: string | undefined;
  try {
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) throw new Error(`Invalid arguments for ${name}: ${z.prettifyError(parsed.error)}`);
    output = await tool.execute(parsed.data, {
      signal,
      emitArtifact: (artifact: Artifact) => onEvent({ type: 'artifact', artifact }),
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    error = e instanceof Error ? e.message : String(e);
    output = `Error: ${error}`;
  }
  let modelText: unknown = output ?? '(no output)';
  let images: ToolModelOutput['images'] = [];
  if (isToolImageOutput(output)) {
    images = output.images;
    modelText = output.text;
    // Never log or stringify base64 payloads: keep the text and a short description of each image.
    output = { text: output.text, images: images.map((i) => `${i.mime}, ${Math.round((i.dataUrl.length * 3) / 4 / 1024)} KB`) };
  }
  const s = toModelString(modelText);
  onEvent({ type: 'tool-result', id, name, output, error, durationMs: Date.now() - startedAt, outputChars: s.length });
  return { text: s, images };
}

/** Text shown to the model in place of the image(s) when the harness delivers them in a follow-up user message. */
export function imageFollowUpText(toolName: string, count: number) {
  return `[${count} image${count > 1 ? 's' : ''} returned by ${toolName}, attached below]`;
}

/** JSON schema for a tool's input, OpenAI function-calling flavour. */
export function toolJsonSchema(t: AgentTool): Record<string, unknown> {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(t.inputSchema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
  return schema;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : JSON.stringify(e);
}
