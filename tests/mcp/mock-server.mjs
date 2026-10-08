// Mock CARTO MCP server (Streamable HTTP) for browser tests. Plain JS so it runs with `node` (no tsx).
//
// Modelled on the real https://ai-<region>.api.carto.com/mcp/<accountId>:
//  - Bearer auth; 401 JSON body + WWW-Authenticate resource_metadata, like CARTO.
//  - CORS: Access-Control-Allow-Origin *, allow-headers authorization,content-type,mcp-session-id,mcp-protocol-version.
//  - Workflow-backed tools: one sync (nyc_collision_hotspots_getis_ord_gi), one async (filter_pois_1) that
//    returns a job, plus async_workflow_job_get_status_v1_0_0 / async_workflow_job_get_results_v1_0_0 pollers,
//    a CLI-style list_workflow_mcp_tools, execute_query (to test the read-only guard) and delete_connection
//    (to test the write-tool filter).
//
// Modes (path prefix):
//   /stateful-exposed/mcp/<acct>  session ids, mcp-session-id in Access-Control-Expose-Headers (works)
//   /stateful-hidden/mcp/<acct>   session ids, header NOT exposed (browser can't see it → fails after initialize)
//   /stateless/mcp/<acct>         no sessions (CARTO CLI style: tools/call works without initialize)
//
// Usage: node tests/mcp/mock-server.mjs [port]   (default 5177)
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PORT = Number(process.argv[2] || process.env.MOCK_MCP_PORT || 5177);
const TOKEN = 'test-token';
const jobs = new Map();

function buildServer() {
  const server = new McpServer({ name: 'mock-carto-mcp', version: '0.0.1' });
  const text = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }] });

  server.registerTool(
    'nyc_collision_hotspots_getis_ord_gi',
    {
      description: 'Finds statistically significant collision hotspots in New York City (H3 res 9, Getis-Ord Gi*).',
      inputSchema: {
        date_from: z.string().describe('YYYY-MM-DD').default('2013-01-01'),
        date_to: z.string().describe('YYYY-MM-DD').default('2021-12-31'),
        road_user: z.string().describe("'all' or a road user class").default('all'),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) =>
      text({
        rows: [
          { h3: '892a100d2c3ffff', gi: 7.1, p_value: 0.0001, collisions: 412 },
          { h3: '892a1072b5bffff', gi: 6.4, p_value: 0.0003, collisions: 371 },
        ],
        meta: { args: a, totalRows: 2 },
      }),
  );

  server.registerTool(
    'filter_pois_1',
    {
      description: '[async] Filters points of interest by category inside a radius. Returns a job to poll.',
      inputSchema: { category: z.string(), radius_m: z.number().int().positive() },
    },
    async (a) => {
      const jobId = `job_${randomUUID().slice(0, 8)}`;
      jobs.set(jobId, { polls: 0, args: a });
      return text({
        jobId,
        status: 'pending',
        connectionName: 'carto_dw',
        providerId: 'bigquery',
        workflowOutputTableName: `carto-dw.shared.wf_out_${jobId}`,
      });
    },
  );

  server.registerTool(
    'async_workflow_job_get_status_v1_0_0',
    {
      description: 'Get the status of an async workflow job. Poll until status is success or failure.',
      inputSchema: { jobId: z.string(), connectionName: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ jobId }) => {
      const j = jobs.get(jobId);
      if (!j) return { ...text(`Unknown job ${jobId}`), isError: true };
      j.polls++;
      return text({ jobId, status: j.polls >= 2 ? 'success' : 'running' });
    },
  );

  server.registerTool(
    'async_workflow_job_get_results_v1_0_0',
    {
      description: 'Get results of a finished async workflow job.',
      inputSchema: {
        jobId: z.string(),
        providerId: z.enum(['bigquery', 'snowflake', 'databricks', 'postgres', 'redshift', 'oracle']),
        connectionName: z.string(),
        workflowOutputTableName: z.string(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ jobId }) => {
      const j = jobs.get(jobId);
      return text({
        rows: [
          { name: 'Cafe A', category: j?.args.category, distance_m: 120 },
          { name: 'Cafe B', category: j?.args.category, distance_m: 340 },
        ],
        schema: [
          { name: 'name', type: 'STRING' },
          { name: 'category', type: 'STRING' },
          { name: 'distance_m', type: 'FLOAT64' },
        ],
      });
    },
  );

  server.registerTool(
    'list_workflow_mcp_tools',
    { description: 'List workflows published as MCP tools.', inputSchema: {} },
    async () => text({ data: [{ name: 'nyc_collision_hotspots_getis_ord_gi', async: false }, { name: 'filter_pois_1', async: true }] }),
  );

  server.registerTool(
    'execute_query',
    {
      description: 'Run a SQL query synchronously on a connection.',
      inputSchema: { connection_name: z.string(), sql: z.string(), queryParameters: z.record(z.string(), z.any()).optional() },
    },
    async ({ sql }) => text({ rows: [{ n: 42 }], schema: [{ name: 'n', type: 'INT64' }], sql }),
  );

  server.registerTool(
    'delete_connection',
    { description: 'Delete a connection.', inputSchema: { id: z.string() } },
    async () => text('deleted'),
  );

  server.registerTool(
    'big_output',
    { description: 'Returns a very large text payload (truncation test).', inputSchema: { n: z.number().int().default(50000) } },
    async ({ n }) => text('x'.repeat(n)),
  );

  server.registerTool(
    'failing_tool',
    { description: 'Always returns isError.', inputSchema: {} },
    async () => ({ content: [{ type: 'text', text: 'boom: warehouse said no' }], isError: true }),
  );

  return server;
}

const sessions = new Map(); // sid -> transport

function cors(res, exposeSession) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,GET,POST,PUT,PATCH,DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type,mcp-session-id,mcp-protocol-version,x-carto-mcp-tool-test');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (exposeSession) res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const m = url.pathname.match(/^\/(stateful-exposed|stateful-hidden|stateless)\/mcp\/([^/]+)$/);
  const mode = m?.[1];
  cors(res, mode === 'stateful-exposed');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  if (!m) {
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"Not Found","status":404}');
    return;
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.setHeader('www-authenticate', `Bearer resource_metadata="http://localhost:${PORT}${url.pathname}/.well-known/oauth-protected-resource" scope="read:workflows write:workflows"`);
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' }).end('{"error":"Authentication failed","status":401,"message":"Authentication failed"}');
    return;
  }
  try {
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    if (mode === 'stateless') {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: url.searchParams.has('json') });
      const server = buildServer();
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    const sid = req.headers['mcp-session-id'];
    let transport = sid ? sessions.get(sid) : undefined;
    if (!transport) {
      const isInit = body && !Array.isArray(body) && body.method === 'initialize';
      if (!isInit) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: No valid session ID provided' }, id: null }),
        );
        return;
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => sessions.set(id, transport),
      });
      transport.onclose = () => transport.sessionId && sessions.delete(transport.sessionId);
      await buildServer().connect(transport);
    }
    await transport.handleRequest(req, res, body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(e) }));
  }
});

httpServer.listen(PORT, () => console.log(`mock MCP server on http://localhost:${PORT}`));
