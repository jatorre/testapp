import { test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

// Scaling measurements (opt-in: BENCH=1). Each size runs in a fresh browser context.
test.skip(!process.env.BENCH, 'set BENCH=1');
const SIZES = (process.env.BENCH_SIZES ?? '10000,100000,200000,1000000,2000000,3000000').split(',').map(Number);

test('ingest scaling: JSON → Arrow → DuckDB → Parquet → aggregate', async ({ browser }) => {
  const results: unknown[] = [];
  for (const n of SIZES) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    let crashed = '';
    page.on('crash', () => (crashed = 'renderer crashed (OOM?)'));
    await page.goto('/tests/pages/data.html');
    await page.waitForFunction(() => (window as any).__dataTest?.ready);
    const cold = await page.evaluate(() => (window as any).__dataTest.coldStart());
    const t0 = Date.now();
    try {
      const r = await page.evaluate((k) => (window as any).__dataTest.bench(k), n);
      results.push({ ...r, coldStartMs: cold.totalColdStartMs, wallMs: Date.now() - t0 });
    } catch (e: any) {
      results.push({ n, error: crashed || String(e.message).slice(0, 200), wallMs: Date.now() - t0 });
    }
    console.log(JSON.stringify(results.at(-1)));
    await ctx.close();
    if ((results.at(-1) as any).error) break;
  }
  writeFileSync(new URL('./measurements.json', import.meta.url), JSON.stringify(results, null, 1));
});
