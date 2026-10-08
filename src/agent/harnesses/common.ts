import { z } from 'zod';
import type { AgentEvent, AgentTool, Artifact } from '../types';
import { toModelString } from '../types';

/**
 * Shared tool execution wrapper used by every harness so that timing / output-size
 * measurements are identical regardless of the agent loop. Emits tool-call and
 * tool-result events and returns the capped string the model will see.
 * Errors are converted into a model-visible error string (the loop continues).
 */
export async function runTool(
  tool: AgentTool | undefined,
  name: string,
  id: string,
  input: unknown,
  signal: AbortSignal | undefined,
  onEvent: (e: AgentEvent) => void,
): Promise<string> {
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
  const s = toModelString(output ?? '(no output)');
  onEvent({ type: 'tool-result', id, name, output, error, durationMs: Date.now() - startedAt, outputChars: s.length });
  return s;
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
