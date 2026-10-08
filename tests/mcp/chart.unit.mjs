// Node unit tests for src/tools/chart.ts + the pure helpers in src/tools/mcp.ts.
// Loads the TS sources through Vite's SSR module loader (no tsx / vitest needed).
// Run: node tests/mcp/chart.unit.mjs
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const vite = await createServer({ configFile: false, root: new URL('../..', import.meta.url).pathname, server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' });
let failed = 0;
const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (e) {
    failed++;
    results.push(`FAIL ${name}\n     ${e?.stack?.split('\n').slice(0, 3).join('\n     ')}`);
  }
}

try {
  const chart = await vite.ssrLoadModule('/src/tools/chart.ts');
  const vfs = await vite.ssrLoadModule('/src/vfs/vfs.ts');
  const mcp = await vite.ssrLoadModule('/src/tools/mcp.ts');
  const [renderChart] = chart.createChartTools();
  const artifacts = [];
  const ctx = { emitArtifact: (a) => artifacts.push(a) };

  await vfs.writeFile('/work/rev.csv', 'month,category,revenue\n2023-01,Jeans,100.5\n2023-02,Jeans,120\n2023-01,Tops,80\n2023-02,Tops,\n');
  await vfs.writeFile('/work/rows.json', JSON.stringify({ result: [{ a: 1 }, { a: 2 }, { a: 3 }] }));
  await vfs.writeFile('/data/x.parquet', new Uint8Array([1, 2, 3]));

  await test('valid url spec renders, model gets small ack, artifact emitted', async () => {
    const spec = { data: { url: '/work/rev.csv' }, mark: 'line', encoding: { x: { field: 'month', type: 'temporal' }, y: { field: 'revenue', type: 'quantitative' }, color: { field: 'category', type: 'nominal' } } };
    const out = await renderChart.execute({ spec, title: 'Revenue' }, ctx);
    assert.deepEqual(out, { ok: true, rendered: 'Revenue', rows: 4 });
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].kind, 'vega-lite');
    assert.equal(artifacts[0].spec.data.url, '/work/rev.csv');
  });

  await test('relative data.url normalized to /work', async () => {
    const out = await renderChart.execute({ spec: { data: { url: 'rev.csv' }, mark: 'bar', encoding: { x: { field: 'category', type: 'nominal' }, y: { aggregate: 'sum', field: 'revenue', type: 'quantitative' } } } }, ctx);
    assert.equal(out.ok, true);
    assert.equal(artifacts.at(-1).spec.data.url, '/work/rev.csv');
  });

  await test('JSON string spec accepted', async () => {
    const out = await renderChart.execute({ spec: JSON.stringify({ data: { values: [{ a: 1 }] }, mark: 'point', encoding: { x: { field: 'a', type: 'quantitative' } } }) }, ctx);
    assert.equal(out.ok, true);
  });

  await test('missing file → clear error', async () => {
    const out = await renderChart.execute({ spec: { data: { url: '/work/nope.csv' }, mark: 'bar' } }, ctx);
    assert.equal(out.ok, false);
    assert.match(out.errors[0], /does not exist/);
  });

  await test('parquet → unsupported format error', async () => {
    const out = await renderChart.execute({ spec: { data: { url: '/data/x.parquet' }, mark: 'bar' } }, ctx);
    assert.match(out.errors[0], /only \.csv, \.tsv and \.json/);
  });

  await test('remote URL rejected', async () => {
    const out = await renderChart.execute({ spec: { data: { url: 'https://evil.example/x.csv' }, mark: 'bar' } }, ctx);
    assert.match(out.errors[0], /remote URLs are not allowed/);
  });

  await test('inline > 5000 rows rejected', async () => {
    const values = Array.from({ length: 5001 }, (_, i) => ({ i }));
    const out = await renderChart.execute({ spec: { data: { values }, mark: 'point', encoding: { x: { field: 'i', type: 'quantitative' } } } }, ctx);
    assert.match(out.errors[0], /limited to 5000/);
  });

  await test('bad mark / bad type / Vega spec / no mark / no data', async () => {
    let out = await renderChart.execute({ spec: { data: { values: [{ a: 1 }] }, mark: 'barz' } }, ctx);
    assert.match(out.errors[0], /unknown mark type "barz"/);
    out = await renderChart.execute({ spec: { data: { values: [{ a: 1 }] }, mark: 'bar', encoding: { x: { field: 'a', type: 'quantitativ' } } } }, ctx);
    assert.match(out.errors.join(), /"quantitativ" is invalid/);
    out = await renderChart.execute({ spec: { marks: [], signals: [] } }, ctx);
    assert.match(out.errors[0], /full Vega spec/);
    out = await renderChart.execute({ spec: { data: { values: [{ a: 1 }] }, encoding: {} } }, ctx);
    assert.match(out.errors[0], /needs "mark"/);
    out = await renderChart.execute({ spec: { mark: 'bar' } }, ctx);
    assert.match(out.errors[0], /no data/);
  });

  await test('compile error surfaces (missing type)', async () => {
    const out = await renderChart.execute({ spec: { data: { values: [{ a: 1 }] }, mark: 'bar', encoding: { x: { field: 'a' } } } }, ctx);
    // vega-lite 6 infers/errs on missing type; either ok or a compile error — must not throw
    assert.ok(typeof out.ok === 'boolean');
  });

  await test('vega-lite warnings + missing field warning returned', async () => {
    const out = await renderChart.execute({ spec: { data: { url: '/work/rev.csv' }, mark: 'bar', encoding: { x: { field: 'categry', type: 'nominal' }, y: { field: 'revenue', type: 'quantitative', aggregate: 'sumx' } } } }, ctx);
    assert.equal(out.ok, true);
    assert.ok(out.warnings.some((w) => /Fields not found in data: categry/.test(w)), JSON.stringify(out.warnings));
    assert.ok(out.warnings.some((w) => /Invalid aggregation operator/.test(w)), JSON.stringify(out.warnings));
  });

  await test('derived fields (calculate as / fold) not flagged', async () => {
    const out = await renderChart.execute({ spec: { data: { url: '/work/rev.csv' }, transform: [{ calculate: 'datum.revenue*2', as: 'rev2' }], mark: 'bar', encoding: { x: { field: 'rev2', type: 'quantitative' } } } }, ctx);
    assert.equal(out.warnings, undefined);
  });

  await test('layer + lookup data resolved', async () => {
    const spec = { data: { url: '/work/rev.csv' }, layer: [{ mark: 'line', encoding: { x: { field: 'month', type: 'ordinal' }, y: { field: 'revenue', type: 'quantitative' } } }, { data: { url: '/work/rows.json', format: { property: 'result' } }, mark: 'rule', encoding: { y: { field: 'a', type: 'quantitative' } } }] };
    const out = await renderChart.execute({ spec }, ctx);
    assert.equal(out.ok, true, JSON.stringify(out));
    const r = await chart.resolveSpecData(spec);
    assert.equal(r.spec.data.values.length, 4);
    assert.equal(r.spec.layer[1].data.values.length, 3);
    assert.equal(r.totalRows, 7);
    assert.equal(r.spec.data.url, undefined);
    assert.equal(spec.data.url, '/work/rev.csv', 'input not mutated');
  });

  await test('resolveSpecData types CSV columns (numbers, nulls, date strings kept)', async () => {
    const r = await chart.resolveSpecData({ data: { url: '/work/rev.csv' }, mark: 'bar' });
    assert.deepEqual(r.spec.data.values[0], { month: '2023-01', category: 'Jeans', revenue: 100.5 });
    assert.equal(r.spec.data.values[3].revenue, null);
    assert.deepEqual(r.columns['/work/rev.csv'], ['month', 'category', 'revenue']);
  });

  // ---- MCP pure helpers
  await test('jsonSchemaToZod round-trips and validates', async () => {
    const { z } = await vite.ssrLoadModule('zod');
    const js = { type: 'object', properties: { connection_name: { type: 'string', description: 'conn' }, sql: { type: 'string' } }, required: ['connection_name', 'sql'] };
    const zs = mcp.jsonSchemaToZod(js);
    assert.equal(zs.safeParse({ connection_name: 'a', sql: 'b' }).success, true);
    assert.equal(zs.safeParse({ sql: 'b' }).success, false);
    const back = z.toJSONSchema(zs, { target: 'draft-7', io: 'input' });
    assert.deepEqual(back.required, ['connection_name', 'sql']);
    assert.equal(back.properties.connection_name.description, 'conn');
    // $ref schema → passthrough fallback that still exposes the schema
    const zr = mcp.jsonSchemaToZod({ type: 'object', properties: { a: { $ref: '#/definitions/X' } }, definitions: { X: { type: 'string' } } });
    const br = z.toJSONSchema(zr, { target: 'draft-7', io: 'input' });
    assert.equal(br.properties.a.$ref, '#/definitions/X');
    assert.equal(zr.safeParse({ a: 'x', extra: 1 }).success, true);
    // empty schema
    assert.equal(mcp.jsonSchemaToZod(undefined).safeParse({}).success, true);
  });

  await test('filterMcpTools hides write tools by default', async () => {
    const tools = ['list_connections', 'execute_query', 'delete_connection', 'create_map', 'explore_data', 'manage_connections', 'nyc_x'].map((name) => ({ name, inputSchema: {} }));
    assert.deepEqual(mcp.filterMcpTools(tools).map((t) => t.name), ['list_connections', 'execute_query', 'explore_data', 'nyc_x']);
    assert.equal(mcp.filterMcpTools(tools, '*').length, 7);
    assert.deepEqual(mcp.filterMcpTools(tools, 'list_*,nyc_x').map((t) => t.name), ['list_connections', 'nyc_x']);
  });

  await test('formatMcpResult caps and throws on isError', async () => {
    const out = mcp.formatMcpResult({ content: [{ type: 'text', text: 'x'.repeat(10000) }] });
    assert.ok(out.length < 6200 && /truncated/.test(out));
    assert.throws(() => mcp.formatMcpResult({ content: [{ type: 'text', text: 'boom' }], isError: true }), /boom/);
  });

  await test('resolveMcpUrls: override, documented api host, CLI ai host', async () => {
    const cm = await vite.ssrLoadModule('/src/carto/mcp.ts');
    const info = { accessToken: 'x.y.z', apiBaseUrl: 'https://gcp-us-east1.api.carto.com', user: { id: 'u', accountId: 'ac_7xhfwyml', email: null } };
    assert.deepEqual(cm.resolveMcpUrls(info, undefined), ['https://ai-gcp-us-east1.api.carto.com/mcp/ac_7xhfwyml', 'https://gcp-us-east1.api.carto.com/mcp/ac_7xhfwyml']);
    assert.deepEqual(cm.resolveMcpUrls(info, 'https://ai-gcp-us-east1.api.carto.com/mcp/{accountId}')[0], 'https://ai-gcp-us-east1.api.carto.com/mcp/ac_7xhfwyml');
    // account id from JWT claim
    const payload = Buffer.from(JSON.stringify({ 'http://app.carto.com/account_id': 'ac_jwt' })).toString('base64url');
    assert.equal(cm.resolveAccountId({ accessToken: `h.${payload}.s`, user: null }), 'ac_jwt');
    assert.equal(cm.deriveAiApiUrl('https://my.selfhosted.com/api'), undefined);
  });
} finally {
  await vite.close();
}
console.log(results.join('\n'));
console.log(failed ? `\n${failed} FAILED` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
