import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { installMockLlm } from './mock-llm';

/** Demo 8: attachments (images + Excel) through every harness, against the mock LLM (and a mocked CARTO API). */
const HARNESS_IDS = ['aisdk', 'handrolled', 'openai-agents'];
const PNG = 'tests/fixtures/chart.png';
const XLSX = 'tests/fixtures/stores.xlsx';

async function openDemo(page: Page, harness: string, demo = 'd8-attach') {
  await page.goto(`./?demo=${demo}&harness=${harness}`);
  await expect(page.getByTestId('model-select')).toHaveValue('mock-model');
  await expect(page.getByTestId('tools-bar')).toContainText('read_attachment');
}
async function send(page: Page, text: string) {
  await page.getByTestId('prompt').fill(text);
  await page.getByTestId('send').click();
  await expect(page.getByTestId('run-status')).toHaveText('done');
}
const addAttachment = (page: Page, path: string, mime: string) =>
  page.evaluate(([n, m, b]) => window.__addAttachment!(n, m, b), [path.split('/').pop()!, mime, readFileSync(path).toString('base64')]);

const imageParts = (content: unknown) =>
  Array.isArray(content) ? content.filter((p: any) => p.type === 'image_url' && /^data:image\/png;base64,iVBOR/.test(p.image_url?.url)) : [];

for (const harness of HARNESS_IDS) {
  test(`${harness}: an attached image reaches the LLM as an image_url content part`, async ({ page }) => {
    const llm = await installMockLlm(page, [{ text: 'A bar chart.' }]);
    await openDemo(page, harness);
    await page.getByTestId('attach-input').setInputFiles(PNG);
    await expect(page.getByTestId('pending-attachment')).toHaveAttribute('data-kind', 'image');
    await send(page, 'What does this chart show?');
    await expect(page.getByTestId('msg-attachment')).toHaveCount(1);
    await expect(page.getByTestId('pending-attachment')).toHaveCount(0);
    const userMsg = llm.requests[0].messages.find((m: any) => m.role === 'user');
    expect(Array.isArray(userMsg.content)).toBe(true);
    expect(userMsg.content[0]).toMatchObject({ type: 'text' });
    expect(userMsg.content[0].text).toContain('What does this chart show?');
    expect(userMsg.content[0].text).toContain('a1: chart.png (image');
    expect(imageParts(userMsg.content)).toHaveLength(1);
  });

  test(`${harness}: view_image returns the image to the model`, async ({ page }) => {
    const llm = await installMockLlm(page, [
      { toolCalls: [{ name: 'view_image', args: { id: 'a1' } }] },
      { text: 'Seen it.' },
    ]);
    await openDemo(page, harness);
    await addAttachment(page, PNG, 'image/png');
    await send(page, 'look at a1');
    await expect(page.locator('[data-testid=tool-card][data-tool=view_image][data-status=ok]')).toHaveCount(1);
    const msgs = llm.requests[1].messages;
    const toolIdx = msgs.findIndex((m: any) => m.role === 'tool');
    const toolMsg = msgs[toolIdx];
    if (harness === 'aisdk') {
      // AI SDK (supportsMultiPartToolContent): the image is a content part of the tool message itself.
      expect(imageParts(toolMsg.content)).toHaveLength(1);
    } else {
      // Hand-rolled / OpenAI Agents: text-only tool message + ONE follow-up user message carrying the image.
      expect(typeof toolMsg.content).toBe('string');
      expect(toolMsg.content).toContain('attached below');
      const next = msgs[toolIdx + 1];
      expect(next.role).toBe('user');
      expect(imageParts(next.content)).toHaveLength(1);
    }
    // The base64 never ends up in the run log.
    const run = await page.evaluate(() => window.__runLogs!.at(-1));
    expect(JSON.stringify(run)).not.toContain('iVBOR');
  });
}

test('xlsx upload is parsed into sheets; read_attachment returns CSV', async ({ page }) => {
  const llm = await installMockLlm(page, [
    { toolCalls: [{ name: 'list_attachments', args: {} }] },
    { toolCalls: [{ name: 'read_attachment', args: { id: 'a1', limit: 5, offset: 1 } }, { name: 'read_attachment', args: { id: 'a1', sheet: 'notes' } }] },
    { text: 'Read it.' },
  ]);
  await openDemo(page, 'handrolled');
  await page.getByTestId('attach-input').setInputFiles(XLSX);
  await expect(page.getByTestId('pending-attachment')).toHaveAttribute('data-kind', 'table');
  await send(page, 'read my targets');
  const user = llm.requests[0].messages.find((m: any) => m.role === 'user');
  expect(user.content).toContain('a1: stores.xlsx (spreadsheet; sheets: Targets 14 rows [country, region, region_manager, target_revenue_2023]; Notes 2 rows');
  const tools = llm.requests[2].messages.filter((m: any) => m.role === 'tool').slice(-2).map((m: any) => m.content);
  expect(tools[0]).toContain('sheet=Targets rows 1-6 of 14 (more: use offset)');
  expect(tools[0]).toContain('country,region,region_manager,target_revenue_2023\nUnited States,Americas,Sarah Johnson,210000');
  expect(tools[1]).toContain('Targets are in USD for calendar year 2023.');
});

test('upload_to_warehouse: one CTAS into the private dataset, agent_tmp_ prefix, 24 h expiry', async ({ page }) => {
  const sql: string[] = [];
  await page.route('**/v3/connections/carto_dw/resources**', (route) => {
    const deep = route.request().url().includes('/resources/');
    route.fulfill({
      json: deep
        ? { children: [{ id: 'carto-dw-ac-test.shared', name: 'shared', type: 'dataset' }, { id: 'carto-dw-ac-test.private_me_123', name: 'private', type: 'dataset' }] }
        : { children: [{ id: 'carto-demo-data', type: 'project' }, { id: 'carto-dw-ac-test', type: 'project' }] },
      headers: { 'access-control-allow-origin': '*' },
    });
  });
  await page.route('**/v3/sql/carto_dw/query', (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    sql.push(route.request().postDataJSON().q);
    route.fulfill({ json: { rows: [], schema: [], meta: { totalBytesProcessed: '0' } }, headers: { 'access-control-allow-origin': '*' } });
  });
  const llm = await installMockLlm(page, [
    { toolCalls: [{ name: 'upload_to_warehouse', args: { id: 'a1', table_name: 'targets' } }] },
    { toolCalls: [{ name: 'run_sql', args: { sql: 'DROP TABLE `carto-dw-ac-test.private_me_123.agent_tmp_targets`' } }] },
    { text: 'Uploaded.' },
  ]);
  await openDemo(page, 'aisdk', 'd8-attach-wh');
  await addAttachment(page, XLSX, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  await send(page, 'upload my targets');
  expect(sql).toHaveLength(1); // run_sql's DROP was rejected client-side by the read-only guard
  expect(sql[0]).toMatch(/^CREATE OR REPLACE TABLE `carto-dw-ac-test\.private_me_123\.agent_tmp_targets`/);
  expect(sql[0]).toContain('INTERVAL 24 HOUR');
  expect(sql[0]).toContain('ARRAY<STRUCT<`country` STRING, `region` STRING, `region_manager` STRING, `target_revenue_2023` INT64>>');
  expect(sql[0]).toContain("STRUCT('China', 'APAC', 'Li Wei', 280000)");
  const tool = JSON.parse(llm.requests[1].messages.find((m: any) => m.role === 'tool').content);
  expect(tool).toMatchObject({ table: 'carto-dw-ac-test.private_me_123.agent_tmp_targets', rows: 14 });
  expect(llm.requests[2].messages.filter((m: any) => m.role === 'tool').pop().content).toContain('read-only guard');
});

test('DuckDB path: a spreadsheet attachment is queryable as table att_<id>', async ({ page }) => {
  test.setTimeout(120_000);
  const llm = await installMockLlm(page, [
    { toolCalls: [{ name: 'duckdb_query', args: { sql: "SELECT region, sum(target_revenue_2023) AS t FROM att_a1 GROUP BY 1 ORDER BY 1" } }] },
    { toolCalls: [{ name: 'duckdb_query', args: { sql: 'SELECT count(*) AS n FROM att_a1_notes' } }] },
    { text: 'ok' },
  ]);
  await openDemo(page, 'handrolled', 'd8-attach-local');
  await addAttachment(page, XLSX, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  await page.getByTestId('prompt').fill('sum targets by region');
  await page.getByTestId('send').click();
  await expect(page.getByTestId('run-status')).toHaveText('done', { timeout: 90_000 });
  const out = JSON.parse(llm.requests[1].messages.find((m: any) => m.role === 'tool').content);
  expect(out.rows).toBe('region,t\nAPAC,387000\nAmericas,346000\nEMEA,172000');
  expect(JSON.parse(llm.requests[2].messages.filter((m: any) => m.role === 'tool').pop().content).rows).toBe('n\n2');
});

test('capture: a rendered point map is captured by the tool and by the 📷 button', async ({ page }) => {
  const spec = {
    width: 300, height: 200, projection: { type: 'equirectangular' }, mark: 'circle',
    data: { values: [{ lon: -74, lat: 40.7, name: 'NYC' }, { lon: -118.2, lat: 34, name: 'LA' }, { lon: -87.6, lat: 41.9, name: 'Chicago' }] },
    encoding: { longitude: { field: 'lon', type: 'quantitative' }, latitude: { field: 'lat', type: 'quantitative' } },
  };
  const llm = await installMockLlm(page, [
    { toolCalls: [{ name: 'render_chart', args: { spec, title: 'Distribution centers' } }] },
    { toolCalls: [{ name: 'capture_chart', args: {} }] },
    { text: 'Three points.' },
  ]);
  await openDemo(page, 'handrolled');
  await send(page, 'map and check it');
  await expect(page.getByTestId('chart').locator('canvas, svg').first()).toBeVisible();
  const msgs = llm.requests[2].messages;
  expect(imageParts(msgs[msgs.length - 1].content)).toHaveLength(1);
  // The composer button attaches the same chart as a pending image.
  await page.getByTestId('capture').click();
  await expect(page.getByTestId('pending-attachment')).toHaveAttribute('data-kind', 'image');
  await expect(page.getByTestId('pending-attachment')).toContainText('Distribution centers.png');
});

test('fetch_url: CORS data file → attachment summary; blocked URL → fallback reader refuses an unverified answer', async ({ page }) => {
  await page.route('https://data.example.test/**', (route) =>
    route.request().url().endsWith('/pop.csv')
      ? route.fulfill({ body: 'country;pop\nSpain;48\nFrance;68\n', headers: { 'content-type': 'text/plain', 'access-control-allow-origin': '*' } })
      : route.abort('failed'),
  );
  const llm = await installMockLlm(page, [
    { toolCalls: [{ name: 'fetch_url', args: { url: 'https://data.example.test/pop.csv' } }] },
    { toolCalls: [{ name: 'fetch_url', args: { url: 'https://data.example.test/page.html' } }] },
    { text: 'a page summary with no url_context metadata' }, // consumed by the read_url fallback (grounded Gemini call)
    { text: 'done' },
  ]);
  await openDemo(page, 'handrolled');
  await send(page, 'fetch these');
  const tools = llm.requests[3].messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content);
  const direct = JSON.parse(tools[0]);
  expect(direct).toMatchObject({ via: 'direct', id: 'a1', name: 'pop.csv', kind: 'table', sample: 'country,pop\nSpain,48\nFrance,68' });
  expect(direct.sheets[0]).toMatchObject({ rows: 2, columns: 'country, pop' });
  expect(tools[1]).toContain('Direct fetch failed (blocked by CORS or network)');
  expect(tools[1]).toContain('its answer would be made up');
  expect(llm.requests[2].tools).toEqual([{ urlContext: {} }]); // the fallback is a separate grounded call, no function tools
});
