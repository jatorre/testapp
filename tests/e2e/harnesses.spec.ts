import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { installMockLlm, type MockTurn } from './mock-llm';

const HARNESS_IDS = ['aisdk', 'handrolled', 'openai-agents'];

/** Turn 1: two parallel write_file calls. Turn 2: bash over both. Turn 3: final text. */
const SCRIPT: MockTurn[] = [
  {
    toolCalls: [
      { name: 'write_file', args: { path: '/work/a.txt', content: 'alpha\nbeta\n' } },
      { name: 'write_file', args: { path: '/work/b.csv', content: 'name,price\nfoo,1.5\nbar,2.5\n' } },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20, cached_tokens: 0 },
  },
  {
    toolCalls: [{ name: 'bash', args: { command: 'cat /work/a.txt /work/b.csv | wc -l' } }],
    usage: { prompt_tokens: 200, completion_tokens: 15, cached_tokens: 64 },
  },
  {
    text: 'All done: the two files have **5 lines** in total.',
    usage: { prompt_tokens: 300, completion_tokens: 12, cached_tokens: 128 },
  },
];

async function openApp(page: Page, harness: string) {
  await page.goto(`./?demo=d1-fs&harness=${harness}`);
  await expect(page.getByTestId('model-select')).toHaveValue('mock-model');
  await expect(page.getByTestId('tools-bar')).toContainText('bash');
  await expect(page.getByTestId('harness-select')).toHaveValue(harness);
}

async function sendPrompt(page: Page, text: string) {
  await page.getByTestId('prompt').fill(text);
  await page.getByTestId('send').click();
}

for (const harness of HARNESS_IDS) {
  test(`${harness}: tool loop, files, streaming text, usage totals`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const llm = await installMockLlm(page, SCRIPT);
    await openApp(page, harness);
    await sendPrompt(page, 'Write two files and count lines');

    // Final text streamed into the assistant message.
    await expect(page.getByTestId('msg-assistant')).toContainText('All done: the two files have 5 lines in total.');
    await expect(page.getByTestId('run-status')).toHaveText('done');

    // Tool cards: 2 write_file + 1 bash, all OK.
    const cards = page.getByTestId('tool-card');
    await expect(cards).toHaveCount(3);
    await expect(page.locator('[data-testid=tool-card][data-status=ok]')).toHaveCount(3);
    await expect(page.locator('[data-testid=tool-card][data-tool=bash]')).toHaveCount(1);

    // Expand the bash card and check the real just-bash output.
    await page.locator('[data-testid=tool-card][data-tool=bash] .tool-head').click();
    await expect(page.locator('[data-testid=tool-card][data-tool=bash] .tool-body')).toContainText('"stdout": "5');

    // Files appear in the file panel; CSV preview renders as a table.
    await expect(page.locator('[data-testid=file-entry][data-path="/work/a.txt"]')).toBeVisible();
    await page.locator('[data-testid=file-entry][data-path="/work/b.csv"] .file-name').click();
    await expect(page.getByTestId('file-preview').locator('table')).toContainText('foo');

    // Usage totals = sum of the 3 turns; 3 steps; tool rows logged.
    await expect(page.getByTestId('total-tokens')).toHaveText('600 / 47');
    await expect(page.getByTestId('total-steps')).toHaveText('3');
    await expect(page.getByTestId('log-tool-row')).toHaveCount(3);
    await expect(page.getByTestId('totals')).toContainText('192'); // cached tokens 64 + 128

    // The model received the tool results (via toModelString) and the tool schemas.
    expect(llm.requests).toHaveLength(3);
    const r0 = llm.requests[0];
    expect(r0.stream).toBe(true);
    expect(r0.tools.map((t: any) => t.function.name).sort()).toEqual(['bash', 'edit_file', 'list_files', 'read_file', 'write_file']);
    const toolMsgs = llm.requests[2].messages.filter((m: any) => m.role === 'tool');
    expect(toolMsgs.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(toolMsgs[toolMsgs.length - 1].content)).toContain('exitCode');
    const toolMsgs1 = llm.requests[1].messages.filter((m: any) => m.role === 'tool');
    expect(toolMsgs1).toHaveLength(2);

    expect(errors).toEqual([]);
  });
}

test('LLM HTTP error is shown and UI stays usable', async ({ page }) => {
  const llm = await installMockLlm(page, [{ error: { status: 401, message: 'Invalid token' } }]);
  await openApp(page, 'handrolled');
  await sendPrompt(page, 'hello');
  await expect(page.getByTestId('run-status')).toHaveText('error');
  await expect(page.getByTestId('chat-error').first()).toContainText('401');
  // Next attempt works.
  llm.setScript([{ text: 'Recovered.' }]);
  await sendPrompt(page, 'again');
  await expect(page.getByTestId('msg-assistant').last()).toContainText('Recovered.');
  await expect(page.getByTestId('run-status')).toHaveText('done');
});

test('invalid tool arguments are reported to the model, loop continues', async ({ page }) => {
  const llm = await installMockLlm(page, [
    { toolCalls: [{ name: 'read_file', args: { nope: 1 } }] },
    { toolCalls: [{ name: 'read_file', args: { path: '/work/missing.txt' } }] },
    { text: 'ok' },
  ]);
  await openApp(page, 'aisdk');
  await sendPrompt(page, 'read something');
  await expect(page.getByTestId('run-status')).toHaveText('done');
  await expect(page.locator('[data-testid=tool-card][data-status=error]')).toHaveCount(2);
  const toolMsg = llm.requests[1].messages.find((m: any) => m.role === 'tool');
  expect(JSON.stringify(toolMsg.content)).toContain('Invalid arguments');
});

test('maxSteps is honored', async ({ page }) => {
  // d1-fs has maxSteps 12; script loops tool calls forever.
  const loop: MockTurn = { toolCalls: [{ name: 'list_files', args: { path: '/work' } }] };
  const llm = await installMockLlm(page, [], { fallback: loop });
  await openApp(page, 'handrolled');
  await sendPrompt(page, 'loop');
  await expect(page.getByTestId('run-status')).toHaveText('done', { timeout: 30_000 });
  expect(llm.requests.length).toBe(12);
});

test('Stop aborts a running request', async ({ page }) => {
  await installMockLlm(page, [{ text: 'too late', delayMs: 5000 }]);
  await openApp(page, 'aisdk');
  await sendPrompt(page, 'slow');
  await expect(page.getByTestId('stop')).toBeVisible();
  await page.getByTestId('stop').click();
  await expect(page.getByTestId('run-status')).toHaveText('aborted');
  await expect(page.getByTestId('send')).toBeVisible();
});

test('window.__runEval runs headlessly and returns the run log', async ({ page }) => {
  await installMockLlm(page, SCRIPT);
  await openApp(page, 'aisdk');
  const run = await page.evaluate(() =>
    window.__runEval!({ demoId: 'd1-fs', harnessId: 'openai-agents', model: 'carto::claude-sonnet-5', prompt: 'go' }),
  );
  expect(run.status).toBe('done');
  expect(run.model).toBe('carto::claude-sonnet-5');
  expect(run.totals.usage.inputTokens).toBe(600);
  expect(run.totals.steps).toBe(3);
  expect(run.tools.map((t) => t.name)).toEqual(['write_file', 'write_file', 'bash']);
  expect(run.finalText).toContain('All done');
  await expect(page.getByTestId('total-tokens')).toHaveText('600 / 47');
});

test('export run log downloads JSON', async ({ page }) => {
  await installMockLlm(page, [{ text: 'hi' }]);
  await openApp(page, 'handrolled');
  await sendPrompt(page, 'hello');
  await expect(page.getByTestId('run-status')).toHaveText('done');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-log').click()]);
  const path = await dl.path();
  const json = JSON.parse(readFileSync(path, 'utf8'));
  expect(json[0].harnessId).toBe('handrolled');
  expect(json[0].totals.usage.inputTokens).toBe(100);
});
