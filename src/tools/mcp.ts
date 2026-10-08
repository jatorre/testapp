import { z } from 'zod';
import type { AgentTool } from '../agent/types';
import { getCartoInfo } from '../carto/info';
import {
  connectMcp,
  resolveMcpUrls,
  type McpCallResult,
  type McpConnection,
  type McpDiagnostics,
  type McpToolInfo,
  type McpTransportKind,
} from '../carto/mcp';

/**
 * Wraps every tool listed by the remote MCP server as an AgentTool named `mcp__<name>`.
 * If the connection fails, returns a single `mcp_status` tool that reports why, so the demo still runs
 * and the failure is visible to both the model and the UI (getMcpDiagnostics()).
 */

const MAX_RESULT_CHARS = 6000;
const MAX_TOOLS = 60;

/**
 * Write/admin tools hidden by default. The CARTO CLI-facing server exposes ~95 granular tools (create_/
 * delete_/share_… plus admin), the documented server ~25 consolidated ones (explore_data, execute_query,
 * manage_*). An analysis agent only needs the read side. Override with VITE_CARTO_MCP_TOOLS or ?mcpTools=
 * ('*' = all, or a comma list of exact names / name prefixes ending in '*').
 */
const WRITE_TOOL_RE =
  /^(create|update|delete|remove|share|unshare|invite|cancel|apply|transfer|batch|publish|unpublish|subscribe|unsubscribe|add|move|rename|resend|submit|import|export|manage)_/;

/** Consolidated admin/write tools on the real CARTO server (tools/list, Oct 2026). */
const ADMIN_TOOLS = new Set([
  'delete', 'admin_carto', 'superadmin_carto_resources', 'manage_users', 'manage_api_access_tokens', 'manage_oauth_clients',
  'organize_projects', 'export_activity_data', 'schedule_workflow', 'run_workflow', 'transfer_data',
]);

let diagnostics: McpDiagnostics = { ok: false, error: 'not connected yet', attempts: [], calls: [] };
let current: { key: string; promise: Promise<{ conn: McpConnection; tools: McpToolInfo[] }> } | null = null;

/** Latest connection diagnostics, for the UI (endpoint, transport, latency, session, attempts, calls). */
export function getMcpDiagnostics(): McpDiagnostics {
  return diagnostics;
}

/** Drop the cached connection (e.g. after the token changed). */
export async function resetMcp() {
  const c = current;
  current = null;
  diagnostics = { ok: false, error: 'not connected yet', attempts: [], calls: [] };
  if (c) await c.promise.then((r) => r.conn.close()).catch(() => {});
}

export interface CreateMcpToolsOptions {
  /** Explicit endpoints (tests). Default: resolved from carto-info.json / env. */
  urls?: string[];
  token?: string;
  transports?: McpTransportKind[];
  /** Tool filter, see WRITE_TOOL_RE. */
  allow?: string;
  timeoutMs?: number;
  /** Reject non-SELECT SQL passed to execute_query-like tools (default true). */
  readOnlySql?: boolean;
  /**
   * Async published workflows return a job; CARTO then registers async_workflow_job_get_status_v1_0_0 /
   * async_workflow_job_get_results_v1_0_0. When true (default) the wrapper polls those itself and returns
   * the rows, saving the model 3+ round trips. Falls back to returning the job if the shape is unexpected.
   */
  autoPollAsync?: boolean;
}

const ASYNC_STATUS_TOOL = 'async_workflow_job_get_status_v1_0_0';
const ASYNC_RESULTS_TOOL = 'async_workflow_job_get_results_v1_0_0';
let asyncTimeoutMs = 120_000;
let asyncPollIntervalMs = 2000;
/** Test hook. */
export function setAsyncPolling(intervalMs: number, timeoutMs: number) {
  asyncPollIntervalMs = intervalMs;
  asyncTimeoutMs = timeoutMs;
}

function firstJson(r: McpCallResult): Record<string, any> | undefined {
  if (r.structuredContent && typeof r.structuredContent === 'object') return r.structuredContent as Record<string, any>;
  const t = r.content?.find((c) => c.type === 'text')?.text;
  if (!t) return undefined;
  try {
    const j = JSON.parse(t);
    // CLI's unwrapMcpPayload: some tools wrap payloads in {data: ...}
    const o = j && typeof j === 'object' && j.data && typeof j.data === 'object' && !Array.isArray(j.data) ? { ...j, ...j.data } : j;
    return o && typeof o === 'object' && !Array.isArray(o) ? o : undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

async function maybePollAsyncJob(conn: McpConnection, names: Set<string>, r: McpCallResult, signal?: AbortSignal): Promise<McpCallResult> {
  const job = firstJson(r);
  const jobId = job?.jobId ?? job?.job_id ?? job?.externalId;
  const connectionName = job?.connectionName ?? job?.connection_name ?? job?.connection;
  if (!job || typeof jobId !== 'string' || typeof connectionName !== 'string' || !names.has(ASYNC_STATUS_TOOL)) return r;
  const deadline = Date.now() + asyncTimeoutMs;
  let status = String(job.status ?? 'pending');
  const t0 = Date.now();
  while (!['success', 'failure', 'failed', 'cancelled', 'error'].includes(status)) {
    if (Date.now() > deadline) {
      return textResult({
        ...job,
        status,
        note: `Still ${status} after ${Math.round((Date.now() - t0) / 1000)}s. Poll mcp__${ASYNC_STATUS_TOOL} with {jobId, connectionName}, then mcp__${ASYNC_RESULTS_TOOL}.`,
      });
    }
    await sleep(asyncPollIntervalMs, signal);
    const s = await conn.callTool(ASYNC_STATUS_TOOL, { jobId, connectionName }, signal);
    if (s.isError) return s;
    status = String(firstJson(s)?.status ?? 'unknown').toLowerCase();
    if (status === 'unknown') return s;
  }
  if (status !== 'success') return { content: [{ type: 'text', text: JSON.stringify({ jobId, status }) }], isError: true };
  const providerId = job.providerId ?? job.provider_id ?? job.provider;
  const workflowOutputTableName = job.workflowOutputTableName ?? job.outputTableName ?? job.output_table;
  if (!names.has(ASYNC_RESULTS_TOOL) || !providerId || !workflowOutputTableName) {
    return textResult({ ...job, status, note: `Job succeeded; fetch rows with mcp__${ASYNC_RESULTS_TOOL}.` });
  }
  return conn.callTool(ASYNC_RESULTS_TOOL, { jobId, providerId, connectionName, workflowOutputTableName }, signal);
}

function textResult(o: unknown): McpCallResult {
  return { content: [{ type: 'text', text: JSON.stringify(o) }] };
}

function allowSpec(o?: string): string | undefined {
  if (o !== undefined) return o;
  let q: string | null = null;
  try {
    q = new URLSearchParams(globalThis.location?.search ?? '').get('mcpTools');
  } catch {
    /* ignore */
  }
  return q || (import.meta.env?.VITE_CARTO_MCP_TOOLS as string | undefined) || undefined;
}

export function filterMcpTools(tools: McpToolInfo[], allow?: string): McpToolInfo[] {
  if (allow === '*') return tools;
  if (allow) {
    const pats = allow.split(',').map((s) => s.trim()).filter(Boolean);
    return tools.filter((t) => pats.some((p) => (p.endsWith('*') ? t.name.startsWith(p.slice(0, -1)) : t.name === p)));
  }
  // Not filtering on annotations.destructiveHint: on the real server it is set on execute_query and on every
  // published workflow tool, which are exactly what an analysis agent needs (SQL is guarded below).
  return tools.filter((t) => !WRITE_TOOL_RE.test(t.name) && !ADMIN_TOOLS.has(t.name));
}

/**
 * JSON Schema → zod. The harnesses turn inputSchema back into JSON Schema with z.toJSONSchema, so the
 * round trip must preserve what the model sees. z.fromJSONSchema (zod 4) handles typical MCP schemas;
 * if it throws (e.g. $ref to definitions), fall back to a passthrough object that carries the original
 * schema as metadata (toJSONSchema emits it verbatim) and lets the server validate.
 */
export function jsonSchemaToZod(schema: Record<string, unknown> | undefined): z.ZodType<Record<string, unknown>> {
  const s = { type: 'object', properties: {}, ...schema } as Record<string, any>;
  delete s.$schema;
  try {
    const zs = z.fromJSONSchema(s as any) as z.ZodType<Record<string, unknown>>;
    z.toJSONSchema(zs, { target: 'draft-7', io: 'input' }); // make sure it round-trips
    return zs;
  } catch {
    const { type: _t, additionalProperties: _a, ...rest } = s;
    return z.looseObject({}).meta(rest) as unknown as z.ZodType<Record<string, unknown>>;
  }
}

/** Pretty-printed JSON wastes ~30% of the model's budget: re-serialize compactly. */
function compactJson(t: string): string {
  const c = t.trimStart()[0];
  if (c !== '{' && c !== '[') return t;
  try {
    return JSON.stringify(JSON.parse(t));
  } catch {
    return t;
  }
}

/** MCP tool result → compact model-facing value. Throws on isError so the harness reports a tool error. */
export function formatMcpResult(r: McpCallResult): unknown {
  const parts: string[] = [];
  for (const c of r.content ?? []) {
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else if (c.type === 'resource' && (c as any).resource?.text) parts.push(String((c as any).resource.text));
    else parts.push(`[${c.type} content omitted]`);
  }
  let text = parts.map(compactJson).join('\n');
  if (!text && r.structuredContent !== undefined) text = JSON.stringify(r.structuredContent);
  if (text.length > MAX_RESULT_CHARS) {
    text = `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated ${text.length - MAX_RESULT_CHARS} chars; ask for less data, e.g. LIMIT / aggregate]`;
  }
  if (r.isError) throw new Error(text || 'MCP tool returned isError without content');
  return text || '(empty result)';
}

const SQL_TOOL_RE = /(^|_)(execute_query|execute_async_query|query|sql)$/;
function assertReadOnlySql(toolName: string, args: Record<string, unknown>) {
  if (!SQL_TOOL_RE.test(toolName)) return;
  const sql = (args.sql ?? (args.body as any)?.query ?? args.query) as unknown;
  if (typeof sql !== 'string') return;
  const stripped = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim();
  if (!/^(select|with)\b/i.test(stripped) || /;\s*\S/.test(stripped)) {
    throw new Error('Only a single read-only SELECT/WITH statement is allowed through MCP SQL tools in this app.');
  }
}

function statusTool(err: string): AgentTool<Record<string, never>> {
  return {
    name: 'mcp_status',
    description:
      'The CARTO MCP server could not be reached when tools were built, so no mcp__ tools are available. ' +
      'Call this to get the connection diagnostics and report them to the user.',
    inputSchema: z.object({}),
    async execute() {
      const d = getMcpDiagnostics();
      return { ok: false, error: err, attempts: d.attempts.map((a) => ({ ...a, error: a.error?.slice(0, 300) })) };
    },
  };
}

export async function createMcpTools(opts: CreateMcpToolsOptions = {}): Promise<AgentTool[]> {
  let urls = opts.urls;
  let token = opts.token;
  try {
    if (!urls || !token) {
      const info = await getCartoInfo();
      token ??= info.accessToken;
      urls ??= resolveMcpUrls(info);
    }
  } catch (e) {
    const msg = `CARTO credentials unavailable: ${e instanceof Error ? e.message : String(e)}`;
    diagnostics = { ok: false, error: msg, attempts: [], calls: [] };
    return [statusTool(msg)];
  }

  const key = JSON.stringify([urls, token, opts.transports]);
  if (!current || current.key !== key) {
    if (current) await resetMcp();
    current = { key, promise: connectMcp({ urls, token, transports: opts.transports, timeoutMs: opts.timeoutMs }) };
  }
  let conn: McpConnection;
  let remote: McpToolInfo[];
  try {
    ({ conn, tools: remote } = await current.promise);
    diagnostics = conn.diagnostics;
  } catch (e) {
    current = null; // retry next time
    diagnostics = (e as any).diagnostics ?? { ok: false, error: String(e), attempts: [], calls: [] };
    return [statusTool(e instanceof Error ? e.message : String(e))];
  }

  const exposed = filterMcpTools(remote, allowSpec(opts.allow)).slice(0, MAX_TOOLS);
  diagnostics.exposedToolCount = exposed.length;
  const readOnlySql = opts.readOnlySql ?? true;
  const autoPoll = opts.autoPollAsync ?? true;
  const remoteNames = new Set(remote.map((t) => t.name));

  return exposed.map((t): AgentTool<Record<string, unknown>> => {
    const desc = (t.description ?? t.title ?? '').trim();
    return {
      name: `mcp__${t.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
      description: `[CARTO MCP] ${desc.length > 1000 ? desc.slice(0, 1000) + '…' : desc}`,
      inputSchema: jsonSchemaToZod(t.inputSchema),
      async execute(input, ctx) {
        const t0 = Date.now();
        try {
          if (readOnlySql) assertReadOnlySql(t.name, input ?? {});
          let r = await conn.callTool(t.name, input ?? {}, ctx.signal);
          if (autoPoll && !r.isError) r = await maybePollAsyncJob(conn, remoteNames, r, ctx.signal);
          const out = formatMcpResult(r);
          diagnostics.calls.push({ name: t.name, ms: Date.now() - t0, ok: true });
          return out;
        } catch (e) {
          diagnostics.calls.push({ name: t.name, ms: Date.now() - t0, ok: false, error: e instanceof Error ? e.message : String(e) });
          throw e;
        }
      },
    };
  });
}
