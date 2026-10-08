import { expect, test, type Page } from '@playwright/test';

type Api = any;
declare global {
  interface Window {
    __pyTest: Api;
  }
}

let page: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('[page error]', m.text());
  });
  await page.goto('/tests/pages/python.html');
  await expect(page.locator('#status')).toHaveText('ready');
  const r = await page.evaluate(() => window.__pyTest.prewarm());
  console.log('prewarm', JSON.stringify(r));
});

test.afterAll(async () => page?.close());

const run = (code: string, opts: { timeoutMs?: number } = {}) =>
  page.evaluate(([c, o]) => window.__pyTest.run(c, o), [code, opts] as const);

test('hello world + last-expression repr', async () => {
  const r = await run('print("hello world")\n1 + 1');
  expect(r.error).toBeNull();
  expect(r.stdout).toContain('hello world');
  expect(r.result).toBe('2');
});

test('state persists across calls', async () => {
  await run('x = 41\nimport numpy as np');
  const r = await run('x + 1, np.__name__');
  expect(r.error).toBeNull();
  expect(r.result).toBe("(42, 'numpy')");
});

test('pandas reads parquet from VFS /data (pyarrow) + groupby', async () => {
  await page.evaluate(() => window.__pyTest.writeFixture('/data/orders.parquet', '/tests/python/fixtures/orders.parquet'));
  const r = await run(`
import pandas as pd
df = pd.read_parquet("/data/orders.parquet")
print(df.shape, str(df["created_at"].dtype))
g = df.groupby("category")["sale_price"].sum()
g.to_dict()`);
  expect(r.error).toBeNull();
  expect(r.stdout).toContain('(1000, 4)');
  expect(r.result).toBe("{'Jeans': 6125.0, 'Shoes': 6125.0, 'Socks': 6375.0, 'Tops': 6375.0}");
});

test('pandas reads CSV from VFS', async () => {
  await page.evaluate(() => window.__pyTest.writeFixture('/work/orders.csv', '/tests/python/fixtures/orders.csv'));
  const r = await run(`pd.read_csv("orders.csv").groupby("category").size().to_dict()`);
  expect(r.error).toBeNull();
  expect(r.result).toBe("{'Jeans': 250, 'Shoes': 250, 'Socks': 250, 'Tops': 250}");
  // Unchanged input files must not come back as changed.
  expect(r.changedFiles).toEqual([]);
});

test('VFS edits after first sync are picked up (incl. same-size rewrite)', async () => {
  await page.evaluate(() => window.__pyTest.writeFile('/work/v.txt', 'aaa'));
  expect((await run('open("v.txt").read()')).result).toBe("'aaa'");
  await page.evaluate(() => window.__pyTest.writeFile('/work/v.txt', 'bbb'));
  expect((await run('open("v.txt").read()')).result).toBe("'bbb'");
  await page.evaluate(() => window.__pyTest.rm('/work/v.txt'));
  expect((await run('import os; os.path.exists("/work/v.txt")')).result).toBe('False');
});

test('writing /work/out.csv (and parquet) comes back to the VFS', async () => {
  const r = await run(`
summary = df.groupby("category", as_index=False)["sale_price"].mean()
summary.to_csv("/work/out.csv", index=False)
summary.to_parquet("/work/out.parquet")
import os; os.makedirs("/work/sub", exist_ok=True); open("/work/sub/n.txt","w").write("hi")`);
  expect(r.error).toBeNull();
  expect(r.changedFiles.map((f: any) => f.path).sort()).toEqual(['/work/out.csv', '/work/out.parquet', '/work/sub/n.txt']);
  const csv = await page.evaluate(() => window.__pyTest.readText('/work/out.csv'));
  expect(csv.split('\n')[0]).toBe('category,sale_price');
  expect(await page.evaluate(() => window.__pyTest.readText('/work/sub/n.txt'))).toBe('hi');
  // deletion inside Python propagates
  const d = await run('os.remove("/work/sub/n.txt")');
  expect(d.deletedFiles).toEqual(['/work/sub/n.txt']);
  expect(await page.evaluate(() => window.__pyTest.exists('/work/sub/n.txt'))).toBe(false);
});

test('exception returns a trimmed traceback', async () => {
  const r = await run(`
def f(d):
    return d["nope"]
f({})`);
  expect(r.error).toContain('Traceback');
  expect(r.error).toContain("KeyError: 'nope'");
  expect(r.error).toContain('line 3, in f');
  expect(r.error).not.toContain('_pyodide'); // internal frames stripped
  const s = await run('def broken(:\n  pass');
  expect(s.error).toContain('SyntaxError');
});

test('AgentTool output is compact', async () => {
  const out = await page.evaluate(() => window.__pyTest.tool('print("x"*100000)\n[1,2]'));
  expect(out.stdout.length).toBeLessThan(4200);
  expect(out.result).toBe('[1, 2]');
  expect(typeof out.durationMs).toBe('number');
});

test('infinite loop is killed by timeout and worker recovers', async () => {
  const t0 = Date.now();
  const r = await run('while True: pass', { timeoutMs: 3000 });
  const elapsed = Date.now() - t0;
  expect(r.restarted).toBe(true);
  expect(r.error).toContain('timed out');
  expect(elapsed).toBeLessThan(15_000);
  const r2 = await run('print("alive"); "x" in globals()');
  expect(r2.error).toBeNull();
  expect(r2.stdout).toContain('alive');
  expect(r2.result).toBe('False'); // state was reset
  expect(r2.freshAfterRestart).toBe(true);
  // files were re-synced into the new interpreter
  const r3 = await run('import pandas as pd; len(pd.read_parquet("/data/orders.parquet"))');
  expect(r3.result).toBe('1000');
  const tool = await page.evaluate(() => window.__pyTest.tool('1'));
  expect(tool.note).toBeUndefined();
});
