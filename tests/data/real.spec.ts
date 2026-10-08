import { expect, test } from '@playwright/test';

// Real CARTO SQL API from the browser (opt-in: REAL_CARTO=1, token from .env.development.local — never logged).
test.skip(!process.env.REAL_CARTO, 'set REAL_CARTO=1');
const OI = '`bigquery-public-data.thelook_ecommerce.order_items`';

test('real CARTO SQL API probes', async ({ page }) => {
  await page.goto('/tests/pages/data.html');
  await page.waitForFunction(() => (window as any).__dataTest?.ready);
  const E = <T,>(fn: string, ...args: unknown[]): Promise<T> =>
    page.evaluate(([f, a]) => (window as any).__dataTest[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
  const log = (k: string, v: unknown) => console.log(k, JSON.stringify(v));
  expect(await E('infoSource')).toBe('env');
  log('coldStart', await E('coldStart'));

  // 1) tool path, realistic agent query
  const q = await E<any>('tool', 'bq_query', {
    sql: `SELECT oi.created_at, oi.status, oi.sale_price, p.category, p.brand FROM ${OI} oi JOIN \`bigquery-public-data.thelook_ecommerce.products\` p ON p.id = oi.product_id WHERE oi.created_at >= '2023-01-01' AND oi.created_at < '2024-01-01'`,
    save_as: 'oi_2023',
  });
  log('bq_query', { ok: q.ok, error: q.error, ...(q.out ?? {}), sample: undefined, chars: q.chars });
  expect(q.ok).toBe(true);
  log('duckdb_query', await E('tool', 'duckdb_query', { sql: `SELECT category, round(sum(sale_price)) rev FROM '/data/oi_2023.parquet' GROUP BY 1 ORDER BY 2 DESC LIMIT 5` }));
  log('list', await E('tool', 'bq_list_tables', { dataset: 'bigquery-public-data.thelook_ecommerce' }));
  log('describe', await E('tool', 'bq_describe_table', { table: 'bigquery-public-data.thelook_ecommerce.order_items' }));

  // 2) raw fetch + ingest of the full order_items (181k rows, 7 cols)
  log('full order_items', await E('realFetch', `SELECT id, order_id, user_id, product_id, status, created_at, sale_price FROM ${OI}`));

  // 3) are BigQuery job options accepted on /query? (10.5 MB query; cap of 1 byte would fail if honored)
  const base = { q: `SELECT count(*) n, sum(sale_price) s FROM ${OI}`, queryParameters: {} };
  for (const extra of [{ maximumBytesBilled: '1' }, { dryRun: true }, { options: { maximumBytesBilled: '1', dryRun: true } }, { queryOptions: { maximumBytesBilled: '1' } }])
    log(`/query + ${JSON.stringify(extra)}`, await E('rawSql', { ...base, ...extra }));
  // 4) job API with provider options (documented: forwarded verbatim)
  for (const options of [{ dryRun: true }, { maximumBytesBilled: '1' }]) {
    const r = await E<any>('rawSql', { query: base.q, queryParameters: {}, options }, 'job');
    log(`/job options ${JSON.stringify(options)}`, r);
    const id = (() => { try { const j = JSON.parse(r.body); return j.externalId || j.jobId; } catch { return null; } })();
    if (id) {
      for (let i = 0; i < 20; i++) {
        const s = await E<any>('rawGet', `/v3/sql/${await E('connection')}/job/${id}`);
        const st = (() => { try { return JSON.parse(s.body).status; } catch { return '?'; } })();
        if (!['pending', 'running'].includes(st)) { log(`  job status`, s); break; }
        await page.waitForTimeout(1500);
      }
    }
  }
  // 5) Exports API with type=query (bulk mode)
  const b = await E<any>('tool', 'bq_query', { sql: `SELECT id, status, created_at, sale_price FROM ${OI} WHERE created_at >= '2022-01-01'`, save_as: 'bulk_oi', mode: 'bulk' });
  log('bulk', { ok: b.ok, error: b.error, ...(b.out ?? {}), sample: b.out?.sample?.slice(0, 1) });
  log('session', { bytes: await E('sessionBytes'), log: await E('queryLog') });
});
