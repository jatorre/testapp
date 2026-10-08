import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { TARGETS_PROMPT } from '../../src/demos';

/**
 * Demo 8 evals against the real stack (opt-in):
 *   REAL_LLM=1 ATTACH_MODELS=carto::claude-opus-5.5,carto::gemini-3.1-pro npx playwright test real-attach
 * Tasks (ATTACH_TASKS, default all): t1 = "what's wrong with this chart" (image in the user message);
 * t2-wh / t2-local = targets.xlsx vs BigQuery revenue, joined via upload_to_warehouse+run_sql or bq_to_duckdb+duckdb_query.
 * Ground truth for t2 comes from the CARTO CLI (`carto sql query carto_dw … --json`). Logs → eval-results/d8-<task>__….json
 */
const MODELS = (process.env.ATTACH_MODELS ?? '').split(',').filter(Boolean);
const TASKS = (process.env.ATTACH_TASKS ?? 't1,t2-wh,t2-local').split(',');
const HARNESS = process.env.ATTACH_HARNESS ?? 'aisdk';

const T1_PROMPT = 'Here is a screenshot of a chart. What does it show, and is anything wrong with it?';
const TASK_DEF: Record<string, { demoId: string; prompt: string; file: string; mime: string }> = {
  t1: { demoId: 'd8-attach', prompt: T1_PROMPT, file: 'tests/fixtures/chart.png', mime: 'image/png' },
  't2-wh': { demoId: 'd8-attach-wh', prompt: TARGETS_PROMPT, file: 'tests/fixtures/stores.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  't2-local': { demoId: 'd8-attach-local', prompt: TARGETS_PROMPT, file: 'tests/fixtures/stores.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
};

const TARGETS: Record<string, number> = {
  China: 280000, 'United States': 210000, Brasil: 120000, 'South Korea': 60000, Germany: 38000, France: 45000,
  'United Kingdom': 35000, Spain: 40000, Japan: 22000, Australia: 25000, Belgium: 9000, Poland: 5000, Colombia: 1000, Mexico: 15000,
};
let truth: { actual: Record<string, number>; missed: string[]; beat: string[] } | undefined;
function groundTruth() {
  if (truth) return truth;
  const sql =
    'SELECT u.country, ROUND(SUM(oi.sale_price), 2) AS revenue FROM `bigquery-public-data.thelook_ecommerce.order_items` oi ' +
    'JOIN `bigquery-public-data.thelook_ecommerce.users` u ON u.id = oi.user_id ' +
    "WHERE EXTRACT(YEAR FROM oi.created_at) = 2023 AND oi.status NOT IN ('Cancelled', 'Returned') GROUP BY 1";
  const rows: { country: string; revenue: number }[] = JSON.parse(execFileSync('carto', ['sql', 'query', 'carto_dw', sql, '--json'], { encoding: 'utf8' })).rows;
  const actual = Object.fromEntries(rows.map((r) => [r.country, r.revenue]));
  const missed = Object.keys(TARGETS).filter((c) => (actual[c] ?? 0) < TARGETS[c]);
  truth = { actual, missed, beat: Object.keys(TARGETS).filter((c) => !missed.includes(c)) };
  return truth;
}

/** Automatic checks (the answers are also read by hand; see the saved logs). */
function grade(task: string, answer: string) {
  if (task === 't1') {
    return {
      truncatedAxis: /(not|doesn't|does not|n't) (start|begin) at (zero|0)|truncat|non-zero|baseline|75,?000|starts at \$?75/i.test(answer),
      missingJuly: /july|jul\b|2023-07/i.test(answer),
    };
  }
  const t = groundTruth();
  const mentioned = (c: string) => new RegExp(c.replace(/ /g, '\\s+'), 'i').test(answer);
  return { missedTruth: t.missed, missedNamed: t.missed.filter(mentioned), missedNotNamed: t.missed.filter((c) => !mentioned(c)) };
}

function safeGrade(task: string, answer?: string) {
  try {
    return answer ? grade(task, answer) : null;
  } catch (e) {
    return { gradeError: String(e).slice(0, 300) };
  }
}

for (const model of MODELS) {
  for (const task of TASKS) {
    test(`attach · ${task} · ${HARNESS} · ${model}`, async ({ page }) => {
      test.setTimeout(900_000);
      const def = TASK_DEF[task];
      await page.goto(`./?demo=${def.demoId}`);
      await expect(page.getByTestId('connection')).toHaveClass(/ok/);
      await expect.poll(() => page.evaluate(() => window.__evalInfo?.models.length ?? 0)).toBeGreaterThan(0);
      const att = await page.evaluate(([n, m, b]) => window.__addAttachment!(n, m, b), [def.file.split('/').pop()!, def.mime, readFileSync(def.file).toString('base64')]);
      const run: any = await page.evaluate((req) => window.__runEval!(req), {
        demoId: def.demoId, harnessId: HARNESS, model, prompt: def.prompt, attachments: [att.id], timeoutMs: 840_000,
      });
      const toolCounts: Record<string, number> = {};
      for (const t of run.tools) toolCounts[t.name] = (toolCounts[t.name] ?? 0) + 1;
      const uploads = run.tools.filter((t: any) => t.name === 'upload_to_warehouse').map((t: any) => ({ ms: t.durationMs, output: t.output }));
      const summary = {
        task, demoId: def.demoId, harnessId: HARNESS, model, status: run.status, error: run.error?.slice(0, 300),
        steps: run.totals.steps, toolCalls: run.totals.toolCalls, toolErrors: run.totals.toolErrors, toolCounts,
        usage: run.totals.usage, wallMs: run.totals.wallMs, toolMs: run.totals.toolMs, llmMs: run.totals.llmMs, uploads,
        grade: safeGrade(task, run.finalText), answer: run.finalText,
      };
      mkdirSync('eval-results', { recursive: true });
      writeFileSync(`eval-results/d8-${task}__${HARNESS}__${model.replace(/[^a-z0-9.-]/gi, '_')}.json`, JSON.stringify({ summary, run }, null, 2));
      console.log(`[attach] ${JSON.stringify({ ...summary, answer: (run.finalText ?? '').slice(0, 400) })}`);
      expect(run.status, run.error).toBe('done');
    });
  }
}
