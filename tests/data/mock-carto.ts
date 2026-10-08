import type { Page, Route } from '@playwright/test';

/** Mocked CARTO SQL / Exports API with the exact response shapes observed on the real API. */
export const MOCK_BASE = 'https://mock-carto.test';

const STATUSES = ['Complete', 'Shipped', 'Processing', 'Cancelled', 'Returned'];
export function orderItems(n: number) {
  let s = 7;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const base = Date.UTC(2023, 0, 1);
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < n; i++) {
    const ts = base + Math.floor(rnd() * 365 * 86400_000) + (i % 1000); // ms precision
    rows.push({
      id: i + 1,
      order_id: Math.floor(i / 2) + 1,
      user_id: Math.floor(rnd() * 100_000),
      status: STATUSES[i % STATUSES.length],
      created_at: new Date(ts).toISOString(), // TIMESTAMP → "…Z"
      returned_at: i % 10 === 0 ? new Date(ts + 5 * 86400_000).toISOString() : null,
      order_date: new Date(ts).toISOString().slice(0, 10), // DATE → "timestamp" + "YYYY-MM-DD"
      local_dt: new Date(ts).toISOString().slice(0, 19), // DATETIME → no zone
      sale_price: Math.round(rnd() * 20000) / 100,
      is_web: i % 3 === 0,
      tags: i % 2 ? ['a', 'b'] : [], // ARRAY → "unknown"
      geom: 'POINT(1 2)',
    });
  }
  const schema = [
    { name: 'id', type: 'number' },
    { name: 'order_id', type: 'number' },
    { name: 'user_id', type: 'number' },
    { name: 'status', type: 'string' },
    { name: 'created_at', type: 'timestamp' },
    { name: 'returned_at', type: 'timestamp' },
    { name: 'order_date', type: 'timestamp' },
    { name: 'local_dt', type: 'timestamp' },
    { name: 'sale_price', type: 'number' },
    { name: 'is_web', type: 'boolean' },
    { name: 'tags', type: 'unknown' },
    { name: 'geom', type: 'geometry' },
  ];
  return { rows, schema };
}

export interface MockState {
  queries: string[];
  bodies: any[];
  exportParquet?: Buffer;
}

export async function installMockCarto(page: Page, dataset = orderItems(50_000)): Promise<MockState> {
  const state: MockState = { queries: [], bodies: [] };
  await page.route('**/carto-info.json', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ accessToken: 'mock-token', apiBaseUrl: MOCK_BASE, user: null }) }),
  );
  const json = (r: Route, status: number, body: unknown) =>
    r.fulfill({ status, contentType: 'application/json; charset=utf-8', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });

  await page.route(`${MOCK_BASE}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'OPTIONS')
      return route.fulfill({
        status: 204,
        headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,DELETE', 'access-control-allow-headers': 'authorization,content-type' },
      });
    if (url.pathname === '/download/export.parquet')
      return route.fulfill({ status: 200, body: state.exportParquet!, headers: { 'access-control-allow-origin': '*' } });
    if (req.headers()['authorization'] !== 'Bearer mock-token') return json(route, 401, { error: 'Token not defined', status: 401 });
    const body = req.postDataJSON?.() ?? null;
    state.bodies.push(body);
    if (url.pathname.endsWith('/query')) {
      const q: string = body.q;
      state.queries.push(q);
      if (q.includes('__TABLES__'))
        return json(route, 200, {
          rows: [
            { table_id: 'order_items', type: 1, row_count: 181162, size_bytes: 13596416 },
            { table_id: 'huge_table', type: 1, row_count: 9e9, size_bytes: 5 * 1024 ** 4 },
          ],
          schema: [{ name: 'table_id', type: 'string' }, { name: 'type', type: 'number' }, { name: 'row_count', type: 'number' }, { name: 'size_bytes', type: 'number' }],
          meta: { cacheHit: false, totalBytesProcessed: '0', location: 'US' },
        });
      if (q.includes('INFORMATION_SCHEMA.COLUMNS'))
        return json(route, 200, {
          rows: [
            { column_name: 'id', data_type: 'INT64', is_partitioning_column: 'NO', clustering_ordinal_position: null },
            { column_name: 'created_at', data_type: 'TIMESTAMP', is_partitioning_column: 'YES', clustering_ordinal_position: null },
            { column_name: 'status', data_type: 'STRING', is_partitioning_column: 'NO', clustering_ordinal_position: 1 },
          ],
          schema: [],
          meta: { cacheHit: false, totalBytesProcessed: '10485760', location: 'US' },
        });
      if (q.includes('missing'))
        return json(route, 404, { status: 404, error: 'Not found: Table p:d.missing was not found in location US', rows: [] });
      const m = q.match(/LIMIT\s+(\d+)\s*$/i);
      const limit = Math.min(m ? Number(m[1]) : Infinity, 200_000);
      return json(route, 200, {
        rows: dataset.rows.slice(0, limit),
        schema: dataset.schema,
        meta: { cacheHit: false, totalBytesProcessed: '10552520', location: 'US' },
      });
    }
    if (url.pathname === '/v3/exports' && req.method() === 'POST') return json(route, 201, { jobId: 'job-1', status: 'pending' });
    if (url.pathname === '/v3/exports/job-1')
      return json(route, 200, {
        jobId: 'job-1',
        status: 'success',
        result: { rowCount: 50000, format: 'geoparquet', downloadUrl: `${MOCK_BASE}/download/export.parquet`, fileSize: state.exportParquet?.length },
      });
    return json(route, 404, { error: 'Not Found', status: 404 });
  });
  return state;
}
