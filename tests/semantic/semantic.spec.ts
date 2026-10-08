import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { installMockLlm } from '../e2e/mock-llm';

/**
 * d11-semantic with a mock LLM and a mocked CARTO API:
 *   npx playwright test -c tests/semantic/playwright.semantic.config.ts
 * Checks that the semantic section (with catalog sizes) reaches the system prompt, that the semantic tools answer
 * from the cache without SQL calls, and that the catalog is cached in localStorage.
 */
const fixture = JSON.parse(readFileSync(new URL('./catalog.fixture.json', import.meta.url), 'utf8'));
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' };

async function mockCarto(page: Page) {
  const calls = { resources: 0, sql: 0 };
  await page.route('**/v3/connections/*/resources/**', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    calls.resources++;
    const fq = decodeURIComponent(new URL(route.request().url()).pathname.split('/resources/')[1]).replace(/`/g, '');
    const e = fixture.entries[fq];
    if (!e) return route.fulfill({ status: 404, headers: CORS, body: '{"error":"not found"}' });
    await route.fulfill({
      status: 200,
      headers: { ...CORS, 'content-type': 'application/json' },
      body: JSON.stringify({ id: fq, type: 'table', nrows: e.rows, size: e.bytes, originalSchema: e.columns, schema: e.columns, geomField: e.geomField }),
    });
  });
  await page.route('**/v3/sql/*/query', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    calls.sql++;
    await route.fulfill({
      status: 200,
      headers: { ...CORS, 'content-type': 'application/json' },
      body: JSON.stringify({ rows: [{ net_revenue: 123.45 }], schema: [{ name: 'net_revenue', type: 'number' }], meta: { totalBytesProcessed: '1048576' } }),
    });
  });
  return calls;
}

const evalRun = (page: Page, demoId: string) =>
  page.evaluate((d) => window.__runEval!({ demoId: d, harnessId: 'aisdk', model: 'mock-model', prompt: 'Revenue 2023?' }), demoId);

test('d11 injects the semantic section and answers describe/metric from cache', async ({ page }) => {
  const carto = await mockCarto(page);
  const llm = await installMockLlm(page, [
    { toolCalls: [{ name: 'describe_source', args: { name: 'order_items' } }, { name: 'get_metric', args: { name: 'net_revenue' } }] },
    { toolCalls: [{ name: 'run_sql', args: { sql: 'SELECT 1 AS net_revenue' } }] },
    { text: 'Net revenue was $123.45 (net = excludes Cancelled/Returned).' },
  ]);
  await page.goto('./?demo=d11-semantic');
  await expect(page.getByTestId('tools-bar')).toContainText('describe_source');
  const run: any = await evalRun(page, 'd11-semantic');
  expect(run.status).toBe('done');
  const system = JSON.stringify(llm.requests[0].messages[0]);
  expect(system).toContain('## Semantic model: theLook eCommerce');
  expect(system).toContain('181k rows');
  expect(system).toContain('Deutschland');
  const [describe, metric, sql] = run.tools;
  expect(describe.name).toBe('describe_source');
  expect(JSON.stringify(describe.output)).toContain('Complete');
  expect(JSON.stringify(metric.output)).toContain("NOT IN ('Cancelled', 'Returned')");
  expect(sql.name).toBe('run_sql');
  expect(carto.sql).toBe(1); // only the agent's own query: the catalog came from the connections API
  expect(carto.resources).toBe(9);
  const stored = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('semantic-catalog:v1:carto_dw') ?? '{}')).length);
  expect(stored).toBe(9);

  // Second run on a fresh page: catalog served from localStorage, no API calls.
  llm.setScript([{ text: 'ok' }]);
  await page.reload();
  await expect(page.getByTestId('tools-bar')).toContainText('describe_source');
  const before = carto.resources;
  expect((await evalRun(page, 'd11-semantic')).status).toBe('done');
  expect(carto.resources).toBe(before);
});

test('d7 (no semantic) system prompt has no semantic section', async ({ page }) => {
  await mockCarto(page);
  const llm = await installMockLlm(page, [{ text: 'ok' }]);
  await page.goto('./?demo=d7-sqlonly');
  await expect(page.getByTestId('tools-bar')).toContainText('run_sql');
  expect((await evalRun(page, 'd7-sqlonly')).status).toBe('done');
  expect(JSON.stringify(llm.requests[0].messages[0])).not.toContain('Semantic model');
});

test('catalog failure degrades to the model without catalog sizes', async ({ page }) => {
  await page.route('**/v3/connections/*/resources/**', (r) => r.fulfill({ status: 500, headers: CORS, body: '{"error":"boom"}' }));
  await page.route('**/v3/sql/*/query', (r) => r.fulfill({ status: 500, headers: CORS, body: '{"error":"boom"}' }));
  const llm = await installMockLlm(page, [{ toolCalls: [{ name: 'describe_source', args: { name: 'users' } }] }, { text: 'ok' }]);
  await page.goto('./?demo=d11-semantic');
  await expect(page.getByTestId('tools-bar')).toContainText('describe_source');
  const run: any = await evalRun(page, 'd11-semantic');
  expect(run.status).toBe('done');
  const system = JSON.stringify(llm.requests[0].messages[0]);
  expect(system).toContain('## Semantic model');
  expect(system).not.toContain('181k rows');
  expect(JSON.stringify(run.tools[0].output)).toContain('country_clean');
});
