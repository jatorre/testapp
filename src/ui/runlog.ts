import type { AgentEvent, Artifact, Usage } from '../agent/types';
import { ZERO_USAGE, addUsage } from '../agent/types';

export interface ToolRow {
  id: string;
  name: string;
  input: unknown;
  output?: unknown;
  error?: string;
  startedAt: number;
  durationMs?: number;
  outputChars?: number;
}
export interface StepRow {
  step: number;
  usage: Usage;
  durationMs: number;
  at: number;
}
export interface RunTotals {
  usage: Usage;
  steps: number;
  toolCalls: number;
  toolErrors: number;
  wallMs: number;
  /** Union of tool-execution intervals (parallel calls are not double counted). */
  toolMs: number;
  /** wall − tool time: model latency + harness overhead. */
  llmMs: number;
  outputChars: number;
}
export interface RunLog {
  id: string;
  demoId: string;
  harnessId: string;
  model: string;
  prompt: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'done' | 'error' | 'aborted';
  error?: string;
  finalText?: string;
  tools: ToolRow[];
  steps: StepRow[];
  /** Raw event stream (text deltas coalesced) for offline analysis. */
  events: { t: number; type: AgentEvent['type']; data?: unknown }[];
  totals: RunTotals;
}

export type ChatPart =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string }
  | { kind: 'artifact'; artifact: Artifact };

export interface UiMessage {
  role: 'user' | 'assistant';
  text: string; // user prompt, or concatenated assistant text (for history)
  parts: ChatPart[];
  runId?: string;
}

export function newRun(p: Pick<RunLog, 'demoId' | 'harnessId' | 'model' | 'prompt'>): RunLog {
  const now = Date.now();
  return {
    ...p,
    id: `run_${now.toString(36)}`,
    startedAt: now,
    status: 'running',
    tools: [],
    steps: [],
    events: [],
    totals: computeTotals([], [], now, now),
  };
}

function unionMs(intervals: [number, number][]): number {
  const s = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curS = -1;
  let curE = -1;
  for (const [a, b] of s) {
    if (a > curE) {
      if (curE > curS) total += curE - curS;
      curS = a;
      curE = b;
    } else curE = Math.max(curE, b);
  }
  if (curE > curS) total += curE - curS;
  return total;
}

export function computeTotals(tools: ToolRow[], steps: StepRow[], start: number, end: number): RunTotals {
  const usage = steps.reduce<Usage>((u, s) => addUsage(u, s.usage), { ...ZERO_USAGE });
  const toolMs = unionMs(tools.filter((t) => t.durationMs != null).map((t) => [t.startedAt, t.startedAt + t.durationMs!]));
  const wallMs = end - start;
  return {
    usage,
    steps: steps.length,
    toolCalls: tools.length,
    toolErrors: tools.filter((t) => t.error).length,
    wallMs,
    toolMs,
    llmMs: Math.max(0, wallMs - toolMs),
    outputChars: tools.reduce((n, t) => n + (t.outputChars ?? 0), 0),
  };
}

/** Pure reducer: apply one harness event to the run log. */
export function applyEvent(run: RunLog, e: AgentEvent): RunLog {
  const t = Date.now();
  const r: RunLog = { ...run };
  const last = r.events[r.events.length - 1];
  if (e.type === 'text-delta' && last?.type === 'text-delta') {
    r.events = [...r.events.slice(0, -1), { ...last, data: String(last.data) + e.text }];
  } else if (e.type === 'text-delta') {
    r.events = [...r.events, { t: t - run.startedAt, type: e.type, data: e.text }];
  } else {
    const { type, ...data } = e;
    r.events = [...r.events, { t: t - run.startedAt, type, data }];
  }
  switch (e.type) {
    case 'tool-call':
      r.tools = [...r.tools, { id: e.id, name: e.name, input: e.input, startedAt: e.startedAt }];
      break;
    case 'tool-result':
      r.tools = r.tools.map((x) =>
        x.id === e.id ? { ...x, output: e.output, error: e.error, durationMs: e.durationMs, outputChars: e.outputChars } : x,
      );
      break;
    case 'step-finish':
      r.steps = [...r.steps, { step: e.step, usage: e.usage, durationMs: e.durationMs, at: t }];
      break;
    case 'error':
      r.status = 'error';
      r.error = e.message;
      break;
    default:
      break;
  }
  r.totals = computeTotals(r.tools, r.steps, r.startedAt, r.endedAt ?? t);
  return r;
}

export function finishRun(run: RunLog, status: RunLog['status'], finalText?: string, error?: string): RunLog {
  const endedAt = Date.now();
  return {
    ...run,
    status,
    finalText,
    error: error ?? run.error,
    endedAt,
    totals: computeTotals(run.tools, run.steps, run.startedAt, endedAt),
  };
}

/** Apply an event to the assistant message's ordered parts. */
export function applyEventToMessage(m: UiMessage, e: AgentEvent): UiMessage {
  const parts = [...m.parts];
  const last = parts[parts.length - 1];
  switch (e.type) {
    case 'text-delta':
      if (last?.kind === 'text') parts[parts.length - 1] = { kind: 'text', text: last.text + e.text };
      else parts.push({ kind: 'text', text: e.text });
      return { ...m, parts, text: m.text + e.text };
    case 'tool-call':
      parts.push({ kind: 'tool', id: e.id });
      return { ...m, parts };
    case 'artifact':
      parts.push({ kind: 'artifact', artifact: e.artifact });
      return { ...m, parts };
    default:
      return m;
  }
}

export function downloadBlob(name: string, data: BlobPart, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function fmtMs(ms: number) {
  return ms >= 10000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}
export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
