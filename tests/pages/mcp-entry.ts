// Browser test harness for src/carto/mcp.ts + src/tools/mcp.ts. Driven by tests/mcp/mcp.spec.ts.
import { createMcpTools, getMcpDiagnostics, resetMcp, setAsyncPolling } from '../../src/tools/mcp';
import { connectMcp, type McpTransportKind } from '../../src/carto/mcp';

const MOCK = 'http://localhost:5177';
const artifacts: unknown[] = [];
const ctx = { emitArtifact: (a: unknown) => artifacts.push(a) } as any;

async function call(tools: Awaited<ReturnType<typeof createMcpTools>>, name: string, input: unknown) {
  const t = tools.find((x) => x.name === name);
  if (!t) return { error: `no tool ${name}` };
  const parsed = t.inputSchema.safeParse(input);
  if (!parsed.success) return { error: `invalid input: ${parsed.error.message}` };
  const t0 = performance.now();
  try {
    return { ok: true, out: await t.execute(parsed.data, ctx), ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { ok: false, error: (e as Error).message, ms: Math.round(performance.now() - t0) };
  }
}

async function scenario(opts: { mode?: string; urls?: string[]; token?: string; transports?: McpTransportKind[]; full?: boolean }) {
  await resetMcp();
  setAsyncPolling(100, 5000);
  const urls = opts.urls ?? [`${MOCK}/${opts.mode}/mcp/ac_test`];
  const tools = await createMcpTools({ urls, token: opts.token ?? 'test-token', transports: opts.transports });
  const res: Record<string, unknown> = { tools: tools.map((t) => t.name) };
  if (opts.full && tools.length > 1) {
    res.sync = await call(tools, 'mcp__nyc_collision_hotspots_getis_ord_gi', { road_user: 'Bicycle' });
    res.async = await call(tools, 'mcp__filter_pois_1', { category: 'cafe', radius_m: 500 });
    res.sqlRead = await call(tools, 'mcp__execute_query', { connection_name: 'carto_dw', sql: 'select 1 as n' });
    res.sqlWrite = await call(tools, 'mcp__execute_query', { connection_name: 'carto_dw', sql: 'DELETE FROM t' });
    res.failing = await call(tools, 'mcp__failing_tool', {});
    res.big = await call(tools, 'mcp__big_output', { n: 50000 });
    res.badArgs = await call(tools, 'mcp__filter_pois_1', { category: 1 });
  } else if (tools[0]?.name === 'mcp_status') {
    res.status = await call(tools, 'mcp_status', {});
  }
  res.diagnostics = structuredClone(getMcpDiagnostics());
  return res;
}

/** Raw SDK-vs-raw comparison without the AgentTool layer. */
async function connectOnly(mode: string, transports: McpTransportKind[]) {
  try {
    const { conn, tools } = await connectMcp({ urls: [`${MOCK}/${mode}/mcp/ac_test`], token: 'test-token', transports });
    const r = await conn.callTool('list_workflow_mcp_tools', {});
    await conn.close();
    return { ok: true, tools: tools.length, call: r.content?.[0]?.text, diag: conn.diagnostics };
  } catch (e) {
    return { ok: false, error: (e as Error).message, diag: (e as any).diagnostics };
  }
}

(window as any).__mcp = { scenario, connectOnly };
document.getElementById('out')!.textContent = 'ready';
