import type { z } from 'zod';

/**
 * Harness-agnostic tool definition. Every harness adapter (AI SDK, OpenAI Agents,
 * hand-rolled loop) converts these into its own tool format, so the same tools
 * and the same demos can be run through different agent loops.
 */
export interface AgentTool<I = any> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  /** Returns what the MODEL sees. Keep it small: never full datasets. */
  execute: (input: I, ctx: ToolContext) => Promise<unknown>;
}

export interface ToolContext {
  signal?: AbortSignal;
  /** Push UI-only artifacts (e.g. a chart spec) without sending them to the model. */
  emitArtifact: (a: Artifact) => void;
}

export type Artifact = { kind: 'vega-lite'; title?: string; spec: unknown };

/** An image as sent to the model (OpenAI-compatible `image_url` with a data URL). */
export interface ModelImage {
  mime: string;
  dataUrl: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** User messages only: images sent alongside the text as content parts. */
  images?: ModelImage[];
}

/**
 * A tool returns this (via toolImages()) to show the model images, e.g. view_image. Chat Completions tool
 * messages are text-only in the OpenAI spec, so each harness decides how the images reach the model.
 */
export interface ToolImageOutput {
  type: 'tool-images';
  text: string;
  images: ModelImage[];
}
export const toolImages = (text: string, images: ModelImage[]): ToolImageOutput => ({ type: 'tool-images', text, images });
export function isToolImageOutput(v: unknown): v is ToolImageOutput {
  return !!v && typeof v === 'object' && (v as ToolImageOutput).type === 'tool-images';
}

/** What runTool hands back to a harness: capped text for the model, plus any images. */
export interface ToolModelOutput {
  text: string;
  images: ModelImage[];
}

/** Raw base64 payload of a data URL. */
export const dataUrlBase64 = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(',') + 1);

/** Events streamed from a harness to the UI. */
export type AgentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; id: string; name: string; input: unknown; startedAt: number }
  | { type: 'tool-result'; id: string; name: string; output: unknown; error?: string; durationMs: number; outputChars: number }
  | { type: 'step-finish'; step: number; usage: Usage; durationMs: number }
  | { type: 'artifact'; artifact: Artifact }
  | { type: 'finish'; totalUsage: Usage; steps: number; durationMs: number }
  | { type: 'error'; message: string };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export interface LlmConfig {
  /** OpenAI-compatible base URL ending in /v1 (CARTO LiteLLM proxy). */
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface RunOptions {
  llm: LlmConfig;
  system: string;
  messages: ChatMessage[];
  tools: AgentTool[];
  maxSteps: number;
  signal?: AbortSignal;
  onEvent: (e: AgentEvent) => void;
}

/** One agent-loop implementation. Returns the final assistant text. */
export interface Harness {
  id: string;
  label: string;
  run: (opts: RunOptions) => Promise<string>;
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
export function addUsage(a: Usage, b: Partial<Usage> | undefined): Usage {
  return {
    inputTokens: a.inputTokens + (b?.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b?.outputTokens ?? 0),
    cachedInputTokens: (a.cachedInputTokens ?? 0) + (b?.cachedInputTokens ?? 0),
  };
}

/** Serialize a tool result for the model, with a hard cap so a tool can never flood context. */
export const MAX_TOOL_OUTPUT_CHARS = 8000;
export function toModelString(output: unknown): string {
  const s = typeof output === 'string' ? output : JSON.stringify(output, null, 1);
  return s.length > MAX_TOOL_OUTPUT_CHARS
    ? s.slice(0, MAX_TOOL_OUTPUT_CHARS) + `\n…[truncated ${s.length - MAX_TOOL_OUTPUT_CHARS} chars]`
    : s;
}
