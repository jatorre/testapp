/**
 * Browser MCP client for the CARTO MCP Server (Streamable HTTP, JSON-RPC 2.0).
 *
 * Two transports:
 *  - 'sdk': @modelcontextprotocol/sdk Client + StreamableHTTPClientTransport (initialize handshake,
 *    session id, protocol version header, SSE or JSON responses).
 *  - 'raw': a minimal fetch-based JSON-RPC client modelled on the CARTO CLI (which POSTs `tools/call`
 *    directly, without `initialize` — i.e. the CARTO server tolerates session-less calls). It still
 *    tries `initialize` first and uses a session id if the browser can read one.
 *
 * Endpoint candidates (first that works wins):
 *  1. VITE_CARTO_MCP_URL / ?mcp=<url>  (may contain `{accountId}`)
 *  2. `https://ai-<region>.api.carto.com/mcp/${accountId}` — what the CARTO CLI calls (verified)
 *  3. `${apiBaseUrl}/mcp/${accountId}`               — documented URL (docs.carto.com/carto-for-agents/mcp-server)
 *
 * Browser-specific gotcha: the `mcp-session-id` response header is only readable cross-origin if the server
 * lists it in Access-Control-Expose-Headers. If a server is stateful and does NOT expose it, the
 * browser silently drops the session id and every request after `initialize` fails (typically 400
 * "No valid session ID"). The diagnostics record `sessionIdVisible` so this is observable.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CartoInfo } from './info';

export type McpTransportKind = 'sdk' | 'raw';

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; [k: string]: unknown };
}

export interface McpContent {
  type: string;
  text?: string;
  [k: string]: unknown;
}
export interface McpCallResult {
  content?: McpContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpAttempt {
  url: string;
  transport: McpTransportKind;
  ok: boolean;
  status?: number;
  error?: string;
  ms: number;
}

export interface McpDiagnostics {
  ok: boolean;
  url?: string;
  transport?: McpTransportKind;
  /** initialize handshake (or first successful request) latency. */
  connectMs?: number;
  listMs?: number;
  toolCount?: number;
  exposedToolCount?: number;
  sessionId?: string;
  /** false = no session id visible to JS (stateless server, or header not CORS-exposed). */
  sessionIdVisible?: boolean;
  protocolVersion?: string;
  serverInfo?: { name?: string; version?: string };
  initialized?: boolean;
  error?: string;
  attempts: McpAttempt[];
  calls: { name: string; ms: number; ok: boolean; error?: string }[];
}

export interface McpConnection {
  url: string;
  transport: McpTransportKind;
  listTools(signal?: AbortSignal): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>;
  close(): Promise<void>;
  diagnostics: McpDiagnostics;
}

export class McpHttpError extends Error {
  status: number;
  body?: string;
  constructor(status: number, message: string, body?: string) {
    super(message);
    this.name = 'McpHttpError';
    this.status = status;
    this.body = body;
  }
}

// ---------------------------------------------------------------------------------------------------
// URL / account resolution

/** Decode a JWT payload without verifying it (only used to read the account id claim). */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    return JSON.parse(atob(b64));
  } catch {
    return null;
  }
}

export function resolveAccountId(info: Pick<CartoInfo, 'accessToken' | 'user'>): string | undefined {
  if (info.user?.accountId) return info.user.accountId;
  const claim = decodeJwtPayload(info.accessToken)?.['http://app.carto.com/account_id'];
  if (typeof claim === 'string' && claim) return claim;
  // Local dev (env mode has no user object).
  return (import.meta.env?.VITE_CARTO_ACCOUNT_ID as string | undefined) || undefined;
}

/** 'https://gcp-us-east1.api.carto.com' → 'https://ai-gcp-us-east1.api.carto.com' (CLI convention). */
export function deriveAiApiUrl(apiBaseUrl: string): string | undefined {
  try {
    const u = new URL(apiBaseUrl);
    const m = u.hostname.match(/^([^.]+)\.api\.carto\.com$/);
    if (!m || m[1].startsWith('ai-')) return undefined;
    return `https://ai-${m[1]}.api.carto.com`;
  } catch {
    return undefined;
  }
}

function envOverride(): string | undefined {
  let fromQuery: string | null = null;
  try {
    fromQuery = new URLSearchParams(globalThis.location?.search ?? '').get('mcp');
  } catch {
    /* not in a browser */
  }
  return fromQuery || ((import.meta.env?.VITE_CARTO_MCP_URL as string | undefined) ?? undefined) || undefined;
}

/** Ordered list of candidate MCP endpoints for this viewer. */
export function resolveMcpUrls(info: Pick<CartoInfo, 'accessToken' | 'user' | 'apiBaseUrl'>, override = envOverride()): string[] {
  const accountId = resolveAccountId(info);
  const out: string[] = [];
  if (override) {
    if (override.includes('{accountId}')) {
      if (accountId) out.push(override.replace('{accountId}', encodeURIComponent(accountId)));
    } else out.push(override);
  }
  if (accountId) {
    const base = info.apiBaseUrl.replace(/\/+$/, '');
    // CLI endpoint first (verified working with a user OAuth token), then the documented one.
    const ai = deriveAiApiUrl(base);
    if (ai) out.push(`${ai}/mcp/${encodeURIComponent(accountId)}`);
    out.push(`${base}/mcp/${encodeURIComponent(accountId)}`);
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------------------------------
// Raw JSON-RPC client (CLI-style)

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'carto-browser-agent-eval', version: '0.1.0' };

/** Parse a Streamable HTTP response body (JSON or SSE) into JSON-RPC messages. Same logic as the CLI. */
export function parseMcpBody(contentType: string | null, body: string): any[] {
  if (contentType?.includes('text/event-stream')) {
    const msgs: any[] = [];
    for (const evt of body.split(/\r?\n\r?\n/)) {
      const data = evt
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart());
      if (!data.length) continue;
      try {
        msgs.push(JSON.parse(data.join('\n')));
      } catch {
        /* ignore keep-alives / partial events */
      }
    }
    return msgs;
  }
  if (!body.trim()) return [];
  return [JSON.parse(body)];
}

class RawMcpClient {
  private nextId = 1;
  sessionId?: string;
  protocolVersion?: string;
  serverInfo?: { name?: string; version?: string };
  initialized = false;
  private url: string;
  private token: string;
  private fetchFn: typeof fetch;
  constructor(url: string, token: string, fetchFn: typeof fetch) {
    this.url = url;
    this.token = token;
    this.fetchFn = fetchFn;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    if (this.protocolVersion) h['mcp-protocol-version'] = this.protocolVersion;
    return h;
  }

  async notify(method: string, params?: unknown, signal?: AbortSignal) {
    const res = await this.fetchFn(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }),
      signal,
    });
    await res.text().catch(() => '');
  }

  async request<T = any>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    const id = this.nextId++;
    const res = await this.fetchFn(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }),
      signal,
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    const text = await res.text();
    if (!res.ok) {
      let hint = '';
      if ((res.status === 400 || res.status === 404) && !this.sessionId && /session/i.test(text)) {
        hint =
          ' (server wants a session id but none is visible to the browser — is mcp-session-id listed in Access-Control-Expose-Headers?)';
      }
      throw new McpHttpError(res.status, `HTTP ${res.status} from MCP ${method}: ${text.slice(0, 300)}${hint}`, text);
    }
    const msgs = parseMcpBody(res.headers.get('content-type'), text);
    const msg =
      msgs.find((m) => m && m.id === id && (m.result !== undefined || m.error !== undefined)) ??
      msgs.find((m) => m && (m.result !== undefined || m.error !== undefined));
    if (!msg) throw new Error(`No JSON-RPC response for ${method}`);
    if (msg.error) throw new McpHttpError(200, `MCP error ${msg.error.code}: ${msg.error.message}`);
    return msg.result as T;
  }

  /** Best effort: a session-less server (like the CLI assumes) may not need this. */
  async initialize(signal?: AbortSignal) {
    const r = await this.request<any>(
      'initialize',
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
      signal,
    );
    this.protocolVersion = r?.protocolVersion ?? PROTOCOL_VERSION;
    this.serverInfo = r?.serverInfo;
    this.initialized = true;
    await this.notify('notifications/initialized', undefined, signal).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------------
// Connect

export interface ConnectOptions {
  urls: string[];
  token: string;
  /** Transports to try per URL, in order. Default ['sdk', 'raw']. */
  transports?: McpTransportKind[];
  timeoutMs?: number;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, rej) => {
      t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms);
    }),
  ]);
}

function statusOf(e: unknown): number | undefined {
  const c = (e as { code?: unknown; status?: unknown })?.status ?? (e as { code?: unknown })?.code;
  return typeof c === 'number' && c >= 100 && c < 600 ? c : undefined;
}
function msgOf(e: unknown): string {
  if (e instanceof TypeError && /fetch/i.test(e.message)) {
    return `${e.message} (network error or CORS rejection — check the browser console)`;
  }
  return e instanceof Error ? e.message : String(e);
}
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

async function listAll(page: (cursor?: string) => Promise<{ tools: McpToolInfo[]; nextCursor?: string }>) {
  const out: McpToolInfo[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const r = await page(cursor);
    out.push(...(r.tools ?? []));
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  return out;
}

async function connectSdk(url: string, token: string, fetchFn: typeof fetch | undefined, diag: McpDiagnostics, timeoutMs: number): Promise<McpConnection> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    ...(fetchFn ? { fetch: fetchFn } : {}),
  });
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  const t0 = now();
  try {
    await withTimeout(client.connect(transport), timeoutMs, 'MCP initialize');
  } catch (e) {
    await client.close().catch(() => {});
    throw e;
  }
  diag.connectMs = Math.round(now() - t0);
  diag.sessionId = transport.sessionId;
  diag.sessionIdVisible = !!transport.sessionId;
  diag.protocolVersion = transport.protocolVersion;
  diag.serverInfo = client.getServerVersion();
  diag.initialized = true;
  return {
    url,
    transport: 'sdk',
    diagnostics: diag,
    listTools: (signal) =>
      listAll(async (cursor) => (await client.listTools(cursor ? { cursor } : undefined, { signal })) as any),
    callTool: async (name, args, signal) =>
      (await client.callTool({ name, arguments: args }, undefined, { signal, timeout: 120_000 })) as McpCallResult,
    close: () => client.close(),
  };
}

async function connectRaw(url: string, token: string, fetchFn: typeof fetch, diag: McpDiagnostics, timeoutMs: number): Promise<McpConnection> {
  const rc = new RawMcpClient(url, token, fetchFn);
  const t0 = now();
  try {
    await withTimeout(rc.initialize(), timeoutMs, 'MCP initialize');
  } catch (e) {
    const s = statusOf(e);
    if (s === 401 || s === 403 || !(e instanceof McpHttpError)) throw e;
    // Server refused initialize but may still accept session-less calls (CARTO CLI style): carry on.
  }
  diag.connectMs = Math.round(now() - t0);
  diag.sessionId = rc.sessionId;
  diag.sessionIdVisible = !!rc.sessionId;
  diag.protocolVersion = rc.protocolVersion;
  diag.serverInfo = rc.serverInfo;
  diag.initialized = rc.initialized;
  return {
    url,
    transport: 'raw',
    diagnostics: diag,
    listTools: (signal) => listAll((cursor) => rc.request('tools/list', cursor ? { cursor } : {}, signal)),
    callTool: (name, args, signal) => rc.request('tools/call', { name, arguments: args }, signal),
    close: async () => {
      if (rc.sessionId) {
        await fetchFn(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'mcp-session-id': rc.sessionId } }).catch(() => {});
      }
    },
  };
}

/**
 * Try every (url × transport) until one can initialize AND list tools. Returns the connection plus
 * the tool list. Throws an Error whose `diagnostics` property has every attempt.
 */
export async function connectMcp(opts: ConnectOptions): Promise<{ conn: McpConnection; tools: McpToolInfo[] }> {
  const transports = opts.transports ?? ['sdk', 'raw'];
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const attempts: McpAttempt[] = [];
  if (!opts.urls.length) {
    const err = new Error('No MCP endpoint could be resolved (missing account id and VITE_CARTO_MCP_URL).');
    (err as any).diagnostics = { ok: false, error: err.message, attempts, calls: [] } satisfies McpDiagnostics;
    throw err;
  }
  for (const url of opts.urls) {
    for (const kind of transports) {
      opts.signal?.throwIfAborted();
      const diag: McpDiagnostics = { ok: false, url, transport: kind, attempts, calls: [] };
      const t0 = now();
      let conn: McpConnection | undefined;
      try {
        conn = kind === 'sdk' ? await connectSdk(url, opts.token, opts.fetch, diag, timeoutMs) : await connectRaw(url, opts.token, fetchFn, diag, timeoutMs);
        const tl = now();
        const tools = await withTimeout(conn.listTools(opts.signal), timeoutMs, 'MCP tools/list');
        diag.listMs = Math.round(now() - tl);
        diag.toolCount = tools.length;
        diag.ok = true;
        attempts.push({ url, transport: kind, ok: true, ms: Math.round(now() - t0) });
        return { conn, tools };
      } catch (e) {
        await conn?.close().catch(() => {});
        const status = statusOf(e);
        let error = msgOf(e);
        if (status === 400 && /session/i.test(error) && !/Expose-Headers/.test(error)) {
          error += ' (server wants a session id but none is visible to the browser — is mcp-session-id listed in Access-Control-Expose-Headers?)';
        }
        attempts.push({ url, transport: kind, ok: false, status, error, ms: Math.round(now() - t0) });
        // Auth failures will not be fixed by switching transport: go to the next URL.
        if (status === 401 || status === 403) break;
      }
    }
  }
  const last = attempts[attempts.length - 1];
  const err = new Error(`Could not connect to any MCP endpoint. Last error: ${last?.error ?? 'unknown'}`);
  (err as any).diagnostics = { ok: false, error: err.message, attempts, calls: [] } satisfies McpDiagnostics;
  throw err;
}
