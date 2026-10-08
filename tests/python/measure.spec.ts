/**
 * Measurements for FINDINGS.md (not part of the regular suite). Run:
 *   PY_MEASURE=1 npx playwright test -c tests/python/playwright.python.config.ts measure
 * Writes tests/python/measurements.json.
 */
import { test, type BrowserContext, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';

test.skip(!process.env.PY_MEASURE, 'set PY_MEASURE=1');
test.setTimeout(1_200_000);

declare global {
  interface Window {
    __pyTest: any;
  }
}

function trackNetwork(ctx: BrowserContext) {
  const rows: { url: string; status: number; bytes: number; fromCache: boolean }[] = [];
  ctx.on('requestfinished', async (req) => {
    try {
      const res = await req.response();
      const sizes = await req.sizes();
      rows.push({
        url: req.url(),
        status: res?.status() ?? 0,
        bytes: sizes.responseBodySize + sizes.responseHeadersSize,
        fromCache: (res as any)?.fromServiceWorker?.() || sizes.responseHeadersSize <= 0,
      });
    } catch {
      /* ignore */
    }
  });
  return rows;
}

const summarize = (rows: { url: string; bytes: number; fromCache: boolean }[]) => {
  const py = rows.filter((r) => r.url.includes('pyodide'));
  return {
    pyodideRequests: py.length,
    pyodideBytes: py.reduce((a, r) => a + Math.max(0, r.bytes), 0),
    cachedLooking: py.filter((r) => r.fromCache).length,
    files: py.map((r) => ({ file: r.url.split('/').pop(), bytes: r.bytes })).sort((a, b) => b.bytes - a.bytes),
  };
};

async function openPage(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto('/tests/pages/python.html');
  await page.waitForFunction(() => !!window.__pyTest);
  return page;
}

test('measure', async ({ browser }) => {
  const out: Record<string, any> = {};
  const ctx = await browser.newContext();
  const rows = trackNetwork(ctx);
  let page = await openPage(ctx);

  // 1. Cold load
  out.cold = await page.evaluate(() => window.__pyTest.prewarm());
  await page.waitForTimeout(500);
  out.coldNetwork = summarize(rows);
  out.statsAfterLoad = await page.evaluate(() => window.__pyTest.stats());
  out.jsHeapAfterLoad = await page.evaluate(() => window.__pyTest.jsHeap());

  // 2. Warm run latency
  const lat: number[] = [];
  const dur: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t0 = Date.now();
    const r = await page.evaluate(() => window.__pyTest.run('1 + 1'));
    lat.push(Date.now() - t0);
    dur.push(r.durationMs);
  }
  lat.sort((a, b) => a - b);
  dur.sort((a, b) => a - b);
  out.warmTrivial = { roundTripMedianMs: lat[10], roundTripP95Ms: lat[18], execMedianMs: dur[10] };
  await page.evaluate(() => window.__pyTest.writeFixture('/data/orders.parquet', '/tests/python/fixtures/orders.parquet'));
  const t1 = Date.now();
  const r1 = await page.evaluate(() =>
    window.__pyTest.run('import pandas as pd\ndf = pd.read_parquet("/data/orders.parquet")\ndf.groupby("category")["sale_price"].sum().to_dict()'),
  );
  out.warmSmallParquetGroupby = { roundTripMs: Date.now() - t1, execMs: r1.durationMs, syncMs: r1.syncMs, error: r1.error };

  // 3. DataFrame scaling
  out.scaling = [];
  for (const n of [100_000, 1_000_000, 5_000_000, 10_000_000, 20_000_000]) {
    const code = `
import gc, time, numpy as np, pandas as pd
for _v in ("big", "g"):
    globals().pop(_v, None)
gc.collect()
n = ${n}
t = time.time()
rng = np.random.default_rng(0)
labels = np.array([f"store_{i:04d}" for i in range(1000)], dtype=object)
big = pd.DataFrame({
    "id": np.arange(n, dtype="int64"),
    "x": rng.random(n),
    "y": rng.random(n),
    "qty": rng.integers(0, 1000, n),
    "cls": rng.integers(0, 100, n).astype("int32"),
    "cat": pd.Categorical.from_codes(rng.integers(0, 20, n), [f"c{i}" for i in range(20)]),
    "store": pd.array(labels[rng.integers(0, 1000, n)], dtype="str"),
    "ts": pd.Timestamp("2024-01-01") + pd.to_timedelta(rng.integers(0, 86400 * 365, n), unit="s"),
})
t_create = time.time() - t
t = time.time()
g = big.groupby(["cat", "store"], observed=True).agg(x=("x", "mean"), qty=("qty", "sum"))
t_groupby = time.time() - t
t = time.time()
s = big.sort_values("x").head(3)
t_sort = time.time() - t
mem = big.memory_usage(deep=True).sum()
{"n": n, "create_s": round(t_create, 2), "groupby_s": round(t_groupby, 2), "sort_s": round(t_sort, 2), "df_mb": round(mem / 1e6, 1), "groups": len(g)}
`;
    const t0 = Date.now();
    const r = await page.evaluate((c) => window.__pyTest.run(c, { timeoutMs: 300_000 }), code);
    const st = r.restarted ? null : await page.evaluate(() => window.__pyTest.stats());
    const row = { n, wallMs: Date.now() - t0, result: r.result, error: r.error?.split('\n').slice(-3).join(' | '), restarted: r.restarted, wasmHeapMB: st ? Math.round(st.wasmHeapBytes / 1e6) : null };
    console.log(JSON.stringify(row));
    out.scaling.push(row);
    if (r.error || r.restarted) break;
  }

  // 4. Large parquet round trip through the VFS (main thread <-> worker transfer), 1M rows
  await page.evaluate(() => window.__pyTest.restart());
  const rt = await page.evaluate(() =>
    window.__pyTest.run(`
import numpy as np, pandas as pd, time
n = 1_000_000
rng = np.random.default_rng(1)
df = pd.DataFrame({"a": np.arange(n), "b": rng.random(n), "c": rng.integers(0, 50, n), "s": pd.array(np.array(["aa","bb","cc"], dtype=object)[rng.integers(0,3,n)], dtype="str")})
t = time.time(); df.to_parquet("/work/big.parquet"); print("write_s", round(time.time()-t, 2))`),
  );
  const rt2 = await page.evaluate(() => window.__pyTest.run('import os; os.remove("/work/big.parquet")'));
  // Now the file only exists... nowhere; regenerate in the VFS by re-running and then test inbound sync in a fresh worker.
  await page.evaluate(() => window.__pyTest.run('df.to_parquet("/data/big.parquet")'));
  await page.evaluate(() => window.__pyTest.restart());
  const rt3 = await page.evaluate(() => window.__pyTest.run('t = time.time() if "time" in globals() else 0\nimport pandas as pd\nlen(pd.read_parquet("/data/big.parquet"))'));
  out.parquetRoundTrip1M = {
    outbound: { files: rt.changedFiles, syncMs: rt.syncMs, execMs: rt.durationMs, stdout: rt.stdout.trim() },
    delete: { deleted: rt2.deletedFiles },
    inboundFreshWorker: { syncMs: rt3.syncMs, execMs: rt3.durationMs, result: rt3.result, initWaitMs: rt3.initWaitMs },
  };

  // 5. Second load in the same context (HTTP cache)
  await page.close();
  rows.length = 0;
  page = await openPage(ctx);
  out.reloadSameContext = await page.evaluate(() => window.__pyTest.prewarm());
  await page.waitForTimeout(500);
  out.reloadNetwork = summarize(rows);
  await ctx.close();

  writeFileSync(new URL('./measurements.json', import.meta.url), JSON.stringify(out, null, 2));
});
