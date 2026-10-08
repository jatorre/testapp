import { expect, test, type Page } from '@playwright/test';

async function open(page: Page) {
  const logs: string[] = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  await page.goto('/tests/pages/mcp.html');
  await expect(page.locator('#out')).toHaveText('ready', { timeout: 30_000 });
  return logs;
}
const run = (page: Page, o: object) => page.evaluate((o) => (window as any).__mcp.scenario(o), o);
const connectOnly = (page: Page, mode: string, transports: string[]) =>
  page.evaluate(([m, t]) => (window as any).__mcp.connectOnly(m, t), [mode, transports] as const);

for (const mode of ['stateful-exposed', 'stateless']) {
  test(`full flow via SDK transport (${mode})`, async ({ page }) => {
    await open(page);
    const r: any = await run(page, { mode, full: true });
    console.log(mode, JSON.stringify({ diag: { ...r.diagnostics, calls: r.diagnostics.calls.length }, tools: r.tools }));
    expect(r.tools).toContain('mcp__nyc_collision_hotspots_getis_ord_gi');
    expect(r.tools).toContain('mcp__async_workflow_job_get_status_v1_0_0');
    expect(r.tools).not.toContain('mcp__delete_connection'); // write tool filtered
    expect(r.diagnostics.transport).toBe('sdk');
    expect(r.diagnostics.sessionIdVisible).toBe(mode === 'stateful-exposed');
    expect(r.sync.ok).toBe(true);
    expect(r.sync.out).toContain('892a100d2c3ffff');
    expect(r.sync.out).toContain('Bicycle');
    // async job auto-polled to rows
    expect(r.async.ok).toBe(true);
    expect(r.async.out).toContain('Cafe A');
    expect(r.sqlRead.ok).toBe(true);
    expect(r.sqlWrite.ok).toBe(false);
    expect(r.sqlWrite.error).toMatch(/read-only/);
    expect(r.failing.ok).toBe(false);
    expect(r.failing.error).toMatch(/boom/);
    expect(r.big.out.length).toBeLessThan(6200);
    expect(r.badArgs.error).toMatch(/invalid input/);
  });
}

test('stateful server WITHOUT Access-Control-Expose-Headers: mcp-session-id → fails visibly', async ({ page }) => {
  await open(page);
  const sdk: any = await connectOnly(page, 'stateful-hidden', ['sdk']);
  console.log('hidden/sdk', JSON.stringify(sdk));
  expect(sdk.ok).toBe(false);
  expect(sdk.diag.attempts[0].status).toBe(400);
  expect(sdk.diag.attempts[0].error).toMatch(/Access-Control-Expose-Headers/);
  const raw: any = await connectOnly(page, 'stateful-hidden', ['raw']);
  console.log('hidden/raw', JSON.stringify(raw));
  expect(raw.ok).toBe(false);
  expect(raw.error).toMatch(/Access-Control-Expose-Headers/);
  // The agent tool layer degrades to mcp_status with the diagnostics
  const r: any = await run(page, { mode: 'stateful-hidden' });
  expect(r.tools).toEqual(['mcp_status']);
  expect(r.status.out.ok).toBe(false);
});

test('raw JSON-RPC fallback works (stateless, stateful-exposed)', async ({ page }) => {
  await open(page);
  for (const mode of ['stateless', 'stateful-exposed']) {
    const raw: any = await connectOnly(page, mode, ['raw']);
    console.log(`${mode}/raw`, JSON.stringify({ ok: raw.ok, tools: raw.tools, connectMs: raw.diag?.connectMs, listMs: raw.diag?.listMs, sid: raw.diag?.sessionIdVisible }));
    expect(raw.ok).toBe(true);
    expect(raw.tools).toBeGreaterThan(5);
    expect(raw.call).toContain('filter_pois_1');
  }
  const r: any = await run(page, { mode: 'stateless', transports: ['raw'], full: true });
  expect(r.async.out).toContain('Cafe B');
});

test('bad token → 401 → mcp_status; URL fallback chain', async ({ page }) => {
  await open(page);
  const bad: any = await run(page, { mode: 'stateless', token: 'wrong' });
  console.log('401', JSON.stringify(bad.diagnostics.attempts));
  expect(bad.tools).toEqual(['mcp_status']);
  expect(bad.diagnostics.attempts[0].status).toBe(401);
  expect(bad.diagnostics.attempts.length).toBe(1); // auth error skips the raw retry on same URL
  const chain: any = await run(page, { urls: ['http://localhost:5177/nope/mcp/x', 'http://localhost:5177/stateless/mcp/ac_test'] });
  console.log('chain', JSON.stringify(chain.diagnostics.attempts));
  expect(chain.diagnostics.ok).toBe(true);
  expect(chain.diagnostics.url).toContain('/stateless/');
  const unreachable: any = await run(page, { urls: ['http://localhost:5199/mcp/x'] });
  expect(unreachable.tools).toEqual(['mcp_status']);
  expect(unreachable.diagnostics.attempts[0].error).toMatch(/fetch|network|CORS/i);
});
