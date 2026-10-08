import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

// Real CARTO endpoint; needs .env.local (VITE_CARTO_TOKEN, VITE_CARTO_ACCOUNT_ID). Opt-in: REAL_CARTO=1.
// Logs only response headers + results; never the Authorization request header.
test.skip(!process.env.REAL_CARTO, 'set REAL_CARTO=1 to run against the real CARTO MCP endpoint');
test.setTimeout(120_000);

test('real CARTO MCP from Chromium', async ({ page }) => {
  const net: unknown[] = [];
  page.on('response', async (r) => {
    if (!/carto\.com/.test(r.url())) return;
    const h = r.headers();
    let body: unknown;
    try {
      const req = r.request().postDataJSON();
      body = req?.method;
    } catch {}
    net.push({
      method: r.request().method(), url: r.url(), rpc: body, status: r.status(), ct: h['content-type'],
      acao: h['access-control-allow-origin'], aceh: h['access-control-expose-headers'], acah: h['access-control-allow-headers'],
      sessionHeader: 'mcp-session-id' in h, protocolHeader: h['mcp-protocol-version'],
    });
  });
  await page.goto('/tests/pages/mcp.html');
  await expect(page.locator('#out')).toHaveText('ready', { timeout: 30_000 });
  const r: any = await page.evaluate(() => (window as any).__mcp.real());
  const report = { result: r, network: net };
  writeFileSync('/tmp/claude-0/-home-user-testapp/1afe42e3-5259-5b08-b898-d1c7889579c9/scratchpad/mcp-real.json', JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ ...r, toolNames: r.toolNames.length }, null, 1).slice(0, 9000));
});
