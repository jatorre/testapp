import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Opt-in smoke test against the real CARTO LiteLLM proxy:
 *   REAL_LLM=1 npx playwright test
 * Credentials come from .env.local (read by Vite). The token is never logged.
 * Results (per harness: status, tokens, timing) are written to test-results/real-llm-smoke.json.
 */
const MODEL = process.env.REAL_MODEL ?? 'carto::claude-sonnet-4.6';
const HARNESSES = ['aisdk', 'handrolled', 'openai-agents'];
const PROMPT =
  'Write a small CSV of 10 fake products with prices to /work/products.csv, then use awk to compute the average price.';

const OUT = 'test-results/real-llm-smoke.json';
// Persist after every test: a failing test restarts the worker and would lose in-memory results.
function record(row: Record<string, unknown>) {
  mkdirSync('test-results', { recursive: true });
  const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
  const results = prev?.model === MODEL ? prev.results.filter((r: any) => r.harness !== row.harness) : [];
  results.push(row);
  writeFileSync(OUT, JSON.stringify({ model: MODEL, prompt: PROMPT, results }, null, 2));
  console.log(`[real-llm] ${JSON.stringify(row)}`);
}

for (const harnessId of HARNESSES) {
  test(`real LLM · demo 1 · ${harnessId}`, async ({ page }) => {
    await page.goto('./?demo=d1-fs');
    await expect(page.getByTestId('connection')).toHaveClass(/ok/);
    await expect(page.getByTestId('tools-bar')).toContainText('bash');
    await expect.poll(() => page.evaluate(() => window.__evalInfo?.models.length ?? 0)).toBeGreaterThan(0);
    const models: string[] = await page.evaluate(() => window.__evalInfo!.models);
    expect(models, `model ${MODEL} not offered by /models; available: ${models.join(', ')}`).toContain(MODEL);
    const run: any = await page.evaluate(
      (req) => window.__runEval!(req),
      { demoId: 'd1-fs', harnessId, model: MODEL, prompt: PROMPT, timeoutMs: 240_000 },
    );
    const files: string[] = await page
      .locator('[data-testid=file-entry]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-path') ?? ''));
    record({
      harness: harnessId,
      status: run.status,
      error: run.error?.slice(0, 200),
      steps: run.totals.steps,
      toolCalls: run.totals.toolCalls,
      toolErrors: run.totals.toolErrors,
      inputTokens: run.totals.usage.inputTokens,
      outputTokens: run.totals.usage.outputTokens,
      cachedTokens: run.totals.usage.cachedInputTokens,
      wallMs: run.totals.wallMs,
      toolMs: run.totals.toolMs,
      llmMs: run.totals.llmMs,
      wroteCsv: files.includes('/work/products.csv'),
      answer: (run.finalText ?? '').slice(0, 120).replace(/\s+/g, ' '),
    });
    expect(run.status, run.error).toBe('done');
    expect(run.totals.toolCalls).toBeGreaterThan(0);
    expect(run.totals.usage.inputTokens).toBeGreaterThan(0);
    expect(files).toContain('/work/products.csv');
  });
}
