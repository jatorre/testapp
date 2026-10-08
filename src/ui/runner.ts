import { HARNESSES, getHarness } from '../agent/harnesses';
import type { AgentEvent, AgentTool, ChatMessage, LlmConfig } from '../agent/types';
import { toUserMessage } from '../attachments/store';
import { getCartoInfo } from '../carto/info';
import { DEMOS, type Demo } from '../demos';
import type { ToolGroup } from '../tools';
import { applyEvent, finishRun, newRun, type RunLog } from './runlog';

export interface ToolLoad {
  tools: AgentTool[];
  /** Per tool group build errors (e.g. missing credentials). Other groups still load. */
  errors: Partial<Record<ToolGroup, string>>;
}

const toolCache = new Map<string, Promise<ToolLoad>>();

/** Build tools group by group so one failing module doesn't take the whole demo down. */
export function loadDemoTools(demo: Demo): Promise<ToolLoad> {
  const key = demo.tools.join(',');
  if (!toolCache.has(key)) {
    const p = (async () => {
      const errors: ToolLoad['errors'] = {};
      // fs tools are loaded directly; the registry (which statically imports every tool module)
      // is only needed for the other groups, so a broken module can't take fs down with it.
      let registry: Promise<(g: ToolGroup[]) => Promise<AgentTool[]>> | null = null;
      const getRegistry = () =>
        (registry ??= import('../tools').then(
          (m) => m.buildTools,
          (e) => Promise.reject(new Error(`tool registry (src/tools/index.ts) failed to load: ${msg(e)}`)),
        ));
      const results = await Promise.allSettled(
        demo.tools.map(async (g) =>
          g === 'fs' ? (await import('../tools/fs')).createFsTools() : (await getRegistry())([g]),
        ),
      );
      const tools: AgentTool[] = [];
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') tools.push(...r.value);
        else errors[demo.tools[i]] = msg(r.reason);
      });
      return { tools, errors };
    })();
    toolCache.set(key, p);
    // Don't cache failures forever: allow a retry on next selection.
    p.then((r) => Object.keys(r.errors).length && toolCache.delete(key));
  }
  return toolCache.get(key)!;
}

export function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function resolveLlm(model: string): Promise<LlmConfig> {
  const info = await getCartoInfo();
  if (!info.aiBaseUrl) throw new Error('No AI base URL configured (carto-info.json aiBaseUrl / VITE_CARTO_AI_BASE_URL)');
  return { baseURL: info.aiBaseUrl, apiKey: info.accessToken, model };
}

export interface ExecuteRunOptions {
  demo: Demo;
  harnessId: string;
  model: string;
  prompt: string;
  /** Attachment ids sent with this prompt (images as image parts, tables/text announced by id). */
  attachments?: string[];
  history?: ChatMessage[];
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
  onRun?: (run: RunLog) => void;
}

/** Run one prompt through a harness and return the full run log. Never throws. */
export async function executeRun(o: ExecuteRunOptions): Promise<RunLog> {
  let run = newRun({ demoId: o.demo.id, harnessId: o.harnessId, model: o.model, prompt: o.prompt });
  o.onRun?.(run);
  const onEvent = (e: AgentEvent) => {
    run = applyEvent(run, e);
    o.onEvent?.(e);
    o.onRun?.(run);
  };
  try {
    const [llm, { tools }] = await Promise.all([resolveLlm(o.model), loadDemoTools(o.demo)]);
    const text = await getHarness(o.harnessId).run({
      llm,
      system: o.demo.system,
      messages: [...(o.history ?? []), toUserMessage(o.prompt, o.attachments)],
      tools,
      maxSteps: o.demo.maxSteps,
      signal: o.signal,
      onEvent,
    });
    run = finishRun(run, 'done', text);
  } catch (e) {
    const aborted = o.signal?.aborted || (e instanceof Error && e.name === 'AbortError');
    if (!aborted) onEvent({ type: 'error', message: msg(e) });
    run = finishRun(run, aborted ? 'aborted' : 'error', undefined, aborted ? 'aborted by user' : msg(e));
  }
  o.onRun?.(run);
  return run;
}

export interface EvalRequest {
  demoId: string;
  harnessId: string;
  model: string;
  prompt: string;
  attachments?: string[];
  /** Optional per-run timeout in ms. */
  timeoutMs?: number;
}

/** Headless helper for batch evaluation (exposed as window.__runEval). */
export async function runEval(req: EvalRequest, onRun?: (r: RunLog) => void): Promise<RunLog> {
  const demo = DEMOS.find((d) => d.id === req.demoId);
  if (!demo) throw new Error(`Unknown demo ${req.demoId}. Known: ${DEMOS.map((d) => d.id).join(', ')}`);
  if (!HARNESSES.some((h) => h.id === req.harnessId)) {
    throw new Error(`Unknown harness ${req.harnessId}. Known: ${HARNESSES.map((h) => h.id).join(', ')}`);
  }
  const ctrl = new AbortController();
  const timer = req.timeoutMs ? setTimeout(() => ctrl.abort(), req.timeoutMs) : undefined;
  try {
    return await executeRun({
      demo, harnessId: req.harnessId, model: req.model, prompt: req.prompt, attachments: req.attachments, signal: ctrl.signal, onRun,
    });
  } finally {
    clearTimeout(timer);
  }
}
