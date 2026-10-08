import { expect, test, type Page } from '@playwright/test';
import { installMockCarto, orderItems, type MockState } from './mock-carto';

// Mocked CARTO SQL API + real DuckDB-WASM (jsDelivr) in headless Chromium.
test.describe.configure({ mode: 'serial' });

let page: Page;
let mock: MockState;
const data = orderItems(50_000);

const T = (name: string, input: unknown) => page.evaluate(([n, i]) => (window as any).__dataTest.tool(n, i), [name, input] as const);
const D = (sql: string, maxRows = 50) => page.evaluate(([s, m]) => (window as any).__dataTest.duck(s, m), [sql, maxRows] as const);

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  mock = await installMockCarto(page, data);
  await page.goto('/tests/pages/data.html');
  await page.waitForFunction(() => (window as any).__dataTest?.ready);
  const cold = await page.evaluate(() => (window as any).__dataTest.coldStart());
  console.log('DuckDB cold start', JSON.stringify(cold));
});
test.afterAll(() => page.close());

test('read-only guard', async () => {
  const g = (sql: string) => page.evaluate((s) => (window as any).__dataTest.guard(s), sql);
  const rejected = [
    'INSERT INTO `p.d.t` VALUES (1)',
    'DELETE FROM `p.d.t` WHERE true',
    'UPDATE p.d.t SET a = 1 WHERE true',
    'MERGE INTO p.d.t USING s ON false WHEN NOT MATCHED THEN INSERT ROW',
    'CREATE TABLE p.d.x AS SELECT 1',
    'CREATE OR REPLACE TEMP TABLE x AS SELECT 1',
    'DROP TABLE p.d.t',
    'ALTER TABLE p.d.t ADD COLUMN x INT64',
    'TRUNCATE TABLE p.d.t',
    'SELECT 1; DROP TABLE p.d.t',
    'SELECT 1; SELECT 2',
    "DECLARE x INT64 DEFAULT 1; SELECT x",
    "EXPORT DATA OPTIONS(uri='gs://b/*.csv', format='CSV') AS SELECT 1",
    'CALL p.d.proc()',
    "EXECUTE IMMEDIATE 'DELETE FROM t WHERE true'",
    'BEGIN TRANSACTION',
    "SELECT * FROM EXTERNAL_QUERY('conn', 'DELETE FROM x')",
    'WITH a AS (SELECT 1) DELETE FROM `p.d.t` WHERE true',
    '/* hi */ ; SELECT 1',
    '',
  ];
  for (const sql of rejected) {
    const r = await g(sql);
    expect(r.ok, `should reject: ${sql}`).toBe(false);
  }
  const accepted = [
    'SELECT 1',
    'select 1;  ',
    "SELECT 'DELETE FROM x; DROP TABLE y' AS s, \"a;b\" AS t",
    'SELECT `delete`, `update` FROM `p.d.t` -- ; DROP TABLE x',
    'WITH a AS (SELECT 1 AS x) SELECT * FROM a',
    '(SELECT 1) UNION ALL (SELECT 2)',
    "SELECT * REPLACE (UPPER(status) AS status) FROM `p.d.t` WHERE created_at > '2023-01-01'",
    "SELECT r'\\d+;' AS re, '''multi\nline; DROP''' AS m",
    "SELECT update_time, created_at FROM t # hash comment ; DELETE FROM x",
  ];
  for (const sql of accepted) {
    const r = await g(sql);
    expect(r.ok, `should accept: ${sql} → ${r.error}`).toBe(true);
  }
});

test('row cap rewriting', async () => {
  const c = (sql: string, cap: number) => page.evaluate(([s, n]) => (window as any).__dataTest.rowCap(s, n), [sql, cap] as const);
  expect((await c('SELECT * FROM t ORDER BY x', 100)).sql).toBe('SELECT * FROM t ORDER BY x\nLIMIT 101');
  expect((await c('SELECT * FROM t LIMIT 10;', 100)).sql).toBe('SELECT * FROM t LIMIT 10');
  expect((await c('SELECT * FROM t LIMIT 5000', 100)).sql).toBe('SELECT * FROM t LIMIT 101');
  expect((await c('SELECT * FROM (SELECT * FROM t LIMIT 5)', 100)).sql).toBe('SELECT * FROM (SELECT * FROM t LIMIT 5)\nLIMIT 101');
  expect((await c('SELECT 1 -- trailing comment', 100)).sql).toBe('SELECT 1\nLIMIT 101');
  const refs = await page.evaluate(() =>
    (window as any).__dataTest.tableRefs('SELECT * FROM `bigquery-public-data.thelook_ecommerce.orders` o JOIN `p`.`d`.`t` USING(id) JOIN bigquery-public-data.thelook_ecommerce.users u ON true, UNNEST(x)'),
  );
  expect(refs.sort()).toEqual(['bigquery-public-data.thelook_ecommerce.orders', 'bigquery-public-data.thelook_ecommerce.users', 'p.d.t'].sort());
});

test('bq_query writes parquet to the VFS and returns only a compact summary', async () => {
  const before = await page.evaluate(() => (window as any).__dataTest.sessionBytes());
  const r = await T('bq_query', {
    sql: 'SELECT * FROM `bigquery-public-data.thelook_ecommerce.order_items` WHERE created_at >= "2023-01-01"',
    save_as: 'order_items_2023',
    description: '2023 order items',
  });
  expect(r.ok, r.error).toBe(true);
  const o = r.out;
  console.log('bq_query summary chars', r.chars, 'elapsed', o.elapsedMs, 'parquet', o.bytesInFile);
  expect(o.path).toBe('/data/order_items_2023.parquet');
  expect(o.rowCount).toBe(50_000);
  expect(o.sample).toHaveLength(5);
  expect(o.truncated).toBe(false);
  expect(o.bytesProcessed).toBe(10552520);
  expect(r.chars).toBeLessThan(4000); // never the full dataset
  // the executed query carried our row cap; the pre-flight hit the free __TABLES__ meta table
  expect(mock.queries.some((q) => q.includes('__TABLES__'))).toBe(true);
  expect(mock.queries.at(-1)).toMatch(/LIMIT 100001$/);
  const types = Object.fromEntries(o.columns.map((c: any) => [c.name, c.type]));
  expect(types).toEqual({
    id: 'BIGINT',
    order_id: 'BIGINT',
    user_id: 'BIGINT',
    status: 'VARCHAR',
    created_at: 'TIMESTAMP',
    returned_at: 'TIMESTAMP',
    order_date: 'DATE',
    local_dt: 'TIMESTAMP',
    sale_price: 'DOUBLE',
    is_web: 'BOOLEAN',
    tags: 'VARCHAR',
    geom: 'VARCHAR',
  });
  const files = await page.evaluate(() => (window as any).__dataTest.files());
  expect(files.map((f: any) => f.path)).toEqual(expect.arrayContaining(['/data/order_items_2023.parquet', '/data/order_items_2023.sql']));
  const after = await page.evaluate(() => (window as any).__dataTest.sessionBytes());
  expect(after - before).toBe(10552520);
});

test('JSON → Parquet type fidelity (values round-trip exactly)', async () => {
  const r = await D(`SELECT id, strftime(created_at, '%Y-%m-%dT%H:%M:%S.%g') || 'Z' AS created_at, order_date::VARCHAR AS order_date,
      strftime(local_dt, '%Y-%m-%dT%H:%M:%S') AS local_dt, sale_price, is_web, returned_at IS NULL AS ret_null, tags
    FROM '/data/order_items_2023.parquet' WHERE id IN (1, 2, 12345, 50000) ORDER BY id`);
  for (const row of r.rows) {
    const src = data.rows[row.id - 1] as any;
    expect(row.created_at).toBe(src.created_at);
    expect(row.order_date).toBe(src.order_date);
    expect(row.local_dt).toBe(src.local_dt);
    expect(row.sale_price).toBe(src.sale_price);
    expect(row.is_web).toBe(src.is_web);
    expect(row.ret_null).toBe(src.returned_at === null);
    expect(row.tags).toBe(JSON.stringify(src.tags));
  }
  const nulls = await D(`SELECT count(*) - count(returned_at) AS n FROM '/data/order_items_2023.parquet'`);
  expect(nulls.rows[0].n).toBe(data.rows.filter((x: any) => x.returned_at === null).length);
});

test('duckdb_query aggregates the file; output is a compact CSV', async () => {
  const r = await T('duckdb_query', {
    sql: `SELECT status, count(*) AS n, round(sum(sale_price), 2) AS revenue FROM '/data/order_items_2023.parquet' GROUP BY 1 ORDER BY 1`,
  });
  expect(r.ok, r.error).toBe(true);
  const exp: Record<string, { n: number; rev: number }> = {};
  for (const x of data.rows as any[]) {
    exp[x.status] ??= { n: 0, rev: 0 };
    exp[x.status].n++;
    exp[x.status].rev += x.sale_price;
  }
  const lines = r.out.rows.split('\n');
  expect(lines[0]).toBe('status,n,revenue');
  for (const line of lines.slice(1)) {
    const [s, n, rev] = line.split(',');
    expect(Number(n)).toBe(exp[s].n);
    expect(Number(rev)).toBeCloseTo(exp[s].rev, 1);
  }
  // big result → capped at 50 rows + total count
  const big = await T('duckdb_query', { sql: `SELECT * FROM '/data/order_items_2023.parquet'` });
  expect(big.out.rowCount).toBe(50_000);
  expect(big.out.rows.split('\n')).toHaveLength(51);
  expect(big.chars).toBeLessThan(12_000);
});

test('duckdb_query save_as → /work csv/parquet; files written by others are visible', async () => {
  const r = await T('duckdb_query', {
    sql: `SELECT date_trunc('month', created_at) AS month, sum(sale_price) AS revenue FROM '/data/order_items_2023.parquet' GROUP BY 1 ORDER BY 1`,
    save_as: '/work/monthly.csv',
  });
  expect(r.ok, r.error).toBe(true);
  expect(r.out.saved.path).toBe('/work/monthly.csv');
  expect(r.out.rowCount).toBe(12);
  const csv = await page.evaluate(() => (window as any).__dataTest.readText('/work/monthly.csv'));
  expect(csv.split('\n')[0]).toBe('month,revenue');
  const p = await T('duckdb_query', { sql: `SELECT * FROM '/data/order_items_2023.parquet' WHERE is_web`, save_as: '/work/web.parquet' });
  expect(p.ok, p.error).toBe(true);
  expect(p.out.rowCount).toBe(Math.ceil(50_000 / 3));
  // a file written to the VFS by another tool (e.g. python/bash) is picked up automatically
  await page.evaluate(() => (window as any).__dataTest.writeFile('/work/extra.csv', 'a,b\n1,2\n3,4\n'));
  const e = await T('duckdb_query', { sql: `SELECT sum(a+b) AS s FROM read_csv_auto('/work/extra.csv')` });
  expect(e.out.rows).toBe('s\n10');
  // …and re-registered when it changes
  await page.evaluate(() => (window as any).__dataTest.writeFile('/work/extra.csv', 'a,b\n100,1\n'));
  const e2 = await T('duckdb_query', { sql: `SELECT sum(a+b) AS s FROM read_csv_auto('/work/extra.csv')` });
  expect(e2.out.rows).toBe('s\n101');
});

test('duckdb_query blocks network/extension access', async () => {
  for (const sql of [
    "SELECT * FROM read_parquet('https://evil.example/x.parquet')",
    'INSTALL httpfs',
    "ATTACH 'x.db'",
    "COPY (SELECT 1) TO '/work/x.csv'",
  ]) {
    const r = await T('duckdb_query', { sql });
    expect(r.ok, sql).toBe(false);
  }
});

test('guard rejects DML before any network call; API errors are surfaced', async () => {
  const n = mock.queries.length;
  for (const sql of ['DELETE FROM `p.d.t` WHERE true', 'SELECT 1; DROP TABLE p.d.t', 'CREATE TABLE p.d.x AS SELECT 1']) {
    const r = await T('bq_query', { sql, save_as: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('read-only guard');
  }
  expect(mock.queries.length).toBe(n);
  const e = await T('bq_query', { sql: 'SELECT * FROM `p.d.missing`', save_as: 'x' });
  expect(e.ok).toBe(false);
  expect(e.error).toContain('Not found: Table p:d.missing');
});

test('pre-flight refuses unfiltered scans of huge tables', async () => {
  const r = await T('bq_query', { sql: 'SELECT a FROM `p.d.huge_table`', save_as: 'x' });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/Refused: referenced tables total 5\.0 TB/);
  const w = await T('bq_query', { sql: "SELECT id FROM `p.d.huge_table` WHERE created_at >= '2023-12-01'", save_as: 'huge_filtered' });
  expect(w.ok, w.error).toBe(true);
  expect(w.out.warning).toMatch(/relying on WHERE/);
});

test('truncation is detected and reported', async () => {
  await page.evaluate(() => (window as any).__dataTest.setSqlConfig({ maxRows: 1000 }));
  const r = await T('bq_query', { sql: 'SELECT * FROM `bigquery-public-data.thelook_ecommerce.order_items`', save_as: 'capped' });
  await page.evaluate(() => (window as any).__dataTest.setSqlConfig({ maxRows: 100_000 }));
  expect(r.ok, r.error).toBe(true);
  expect(r.out.truncated).toBe(true);
  expect(r.out.rowCount).toBe(1000);
  expect(mock.queries.at(-1)).toMatch(/LIMIT 1001$/);
});

test('bq_list_tables / bq_describe_table are compact', async () => {
  const l = await T('bq_list_tables', { dataset: 'bigquery-public-data.thelook_ecommerce' });
  expect(l.ok, l.error).toBe(true);
  expect(l.out.tables[0]).toEqual({ table: 'order_items', kind: 'TABLE', rows: 181162, size: '13.0 MB' });
  const d = await T('bq_describe_table', { table: '`bigquery-public-data.thelook_ecommerce.order_items`' });
  expect(d.ok, d.error).toBe(true);
  expect(d.out.partitionedBy).toEqual(['created_at']);
  expect(d.out.clusteredBy).toEqual(['status']);
  expect(d.out.columns).toContain('id INT64');
  expect((await T('bq_list_tables', { dataset: 'x; DROP' })).ok).toBe(false);
});

test('bulk mode (Exports API) stores the parquet as-is', async () => {
  const b64 = await page.evaluate(() => (window as any).__dataTest.fileBase64('/data/order_items_2023.parquet'));
  mock.exportParquet = Buffer.from(b64, 'base64');
  const r = await T('bq_query', { sql: 'SELECT * FROM `bigquery-public-data.thelook_ecommerce.order_items`', save_as: 'bulk', mode: 'bulk' });
  expect(r.ok, r.error).toBe(true);
  expect(r.out.transport).toBe('exports-api');
  expect(r.out.rowCount).toBe(50_000);
  expect(mock.bodies.some((b) => b?.type === 'query' && b?.format === 'geoparquet')).toBe(true);
});
