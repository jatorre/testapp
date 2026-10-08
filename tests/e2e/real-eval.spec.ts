import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { DEMOS } from '../../src/demos';

/**
 * Evaluation matrix against the real CARTO stack (LiteLLM + SQL API on carto_dw), fully in the browser.
 *   REAL_LLM=1 EVAL=d3-duckdb:aisdk:carto::claude-sonnet-5 npx playwright test real-eval
 * EVAL is a comma-separated list of demoId:harnessId:model. The prompt is the demo's first suggestion,
 * or EVAL_PROMPT. Full run logs go to eval-results/<demo>__<harness>__<model>.json.
 */
const MATRIX = (process.env.EVAL ?? '').split(',').filter(Boolean).map((s) => {
  const [demoId, harnessId, ...m] = s.split(':');
  return { demoId, harnessId, model: m.join(':') };
});

for (const { demoId, harnessId, model } of MATRIX) {
  test(`eval · ${demoId} · ${harnessId} · ${model}`, async ({ page }) => {
    test.setTimeout(900_000);
    await page.goto(`./?demo=${demoId}`);
    await expect(page.getByTestId('connection')).toHaveClass(/ok/);
    await expect.poll(() => page.evaluate(() => window.__evalInfo?.models.length ?? 0)).toBeGreaterThan(0);
    const prompt = process.env.EVAL_PROMPT ?? DEMOS.find((d) => d.id === demoId)!.suggestions[0];
    const run: any = await page.evaluate((req) => window.__runEval!(req), {
      demoId, harnessId, model, prompt, timeoutMs: 840_000,
    });
    const files = await page
      .locator('[data-testid=file-entry]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-path') ?? ''));
    const charts = run.events.filter((e: any) => e.type === 'artifact').length;
    const toolCounts: Record<string, number> = {};
    for (const t of run.tools) toolCounts[t.name] = (toolCounts[t.name] ?? 0) + 1;
    const summary = {
      demoId, harnessId, model, status: run.status, error: run.error?.slice(0, 300),
      steps: run.totals.steps, toolCalls: run.totals.toolCalls, toolErrors: run.totals.toolErrors, toolCounts,
      usage: run.totals.usage, wallMs: run.totals.wallMs, toolMs: run.totals.toolMs, llmMs: run.totals.llmMs,
      maxToolOutputChars: Math.max(0, ...run.tools.map((t: any) => t.outputChars ?? 0)),
      files: files.filter((f: string) => /^\/(data|work)\//.test(f)), charts, answer: run.finalText,
    };
    mkdirSync('eval-results', { recursive: true });
    const name = `${demoId}__${harnessId}__${model.replace(/[^a-z0-9.-]/gi, '_')}`;
    writeFileSync(`eval-results/${name}.json`, JSON.stringify({ summary, run }, null, 2));
    console.log(`[eval] ${JSON.stringify({ ...summary, answer: (run.finalText ?? '').slice(0, 300) })}`);
    expect(run.status, run.error).toBe('done');
  });
}

// UI check: drive a demo through the real chat UI and screenshot it (charts must actually render).
test.describe('ui', () => {
  test.skip(!process.env.EVAL_UI, 'set EVAL_UI=<demoId> to run');
  test(`ui · ${process.env.EVAL_UI}`, async ({ page }) => {
    test.setTimeout(900_000);
    const demoId = process.env.EVAL_UI!;
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.goto(`./?demo=${demoId}`);
    await expect(page.getByTestId('connection')).toHaveClass(/ok/);
    await page.getByTestId('suggestion').first().click();
    await expect(page.getByTestId('run-status')).toHaveText(/done|error|aborted/i, { timeout: 840_000 });
    await page.waitForTimeout(1500);
    mkdirSync('eval-results', { recursive: true });
    await page.screenshot({ path: `eval-results/ui-${demoId}.png`, fullPage: true });
    const charts = page.locator('[data-testid=chart] .vega-embed, [data-testid=chart] canvas, [data-testid=chart] svg');
    console.log(`[ui] charts rendered: ${await page.getByTestId('chart').count()}, chart errors: ${await page.locator('[data-testid=chart] .error').count()}, svg/canvas: ${await charts.count()}`);
  });
});
