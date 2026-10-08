import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { MAP_PROMPTS } from '../../src/map/demo';

/**
 * Demo 10 (map workspace) against the real stack (opt-in), driven through the chat UI like a user:
 *   REAL_LLM=1 MAP_MODELS=carto::claude-opus-5.5 npx playwright test -c playwright.map.config.ts
 * Sessions (MAP_TASKS, default all): t1t2 = T1 then T2 in the same conversation; t3 = seeded annotation A1 (Texas
 * triangle); t4 = nearest distribution center to the largest cluster. Ground truth (CARTO CLI, see the report):
 * A1 holds 1,902 of Texas' 2,396 US customers (rest of Texas 494); the largest cluster at H3 res 3–6 is New York City,
 * nearest DC "Port Authority of New York/New Jersey NY/NJ". Logs + map PNGs → eval-results/d10-<task>__<harness>__<model>.*
 */
const MODELS = (process.env.MAP_MODELS ?? '').split(',').filter(Boolean);
const TASKS = (process.env.MAP_TASKS ?? 't1t2,t3,t4').split(',');
const HARNESS = process.env.MAP_HARNESS ?? 'aisdk';
const A1 = { type: 'Polygon', coordinates: [[[-97.6, 33.4], [-96.0, 33.3], [-94.7, 30.2], [-94.9, 29.3], [-95.6, 29.0], [-98.9, 29.0], [-99.0, 29.8], [-97.6, 33.4]]] };

async function open(page: Page) {
  await page.goto(`./?demo=d10-map&harness=${HARNESS}`);
  await expect(page.getByTestId('connection')).toHaveClass(/ok/);
  await expect.poll(() => page.evaluate(() => window.__evalInfo?.models.length ?? 0)).toBeGreaterThan(0);
  await expect(page.getByTestId('map-pane')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
}

async function ask(page: Page, model: string, prompt: string): Promise<any> {
  await page.getByTestId('model-select').selectOption(model);
  const before = await page.evaluate(() => window.__runLogs?.length ?? 0);
  await page.getByTestId('prompt').fill(prompt);
  await page.getByTestId('send').click();
  await expect
    .poll(() => page.evaluate((n) => (window.__runLogs?.length ?? 0) > n && window.__runLogs!.at(-1)!.status !== 'running', before), { timeout: 840_000, intervals: [2000] })
    .toBe(true);
  return page.evaluate(() => window.__runLogs!.at(-1));
}

function grade(task: string, run: any) {
  const a: string = run.finalText ?? '';
  const calls = (n: string) => run.tools.filter((t: any) => t.name === n).length;
  const base = { screenshots: calls('map_screenshot'), cartoLayers: calls('map_add_carto_layer'), geojsonLayers: calls('map_add_geojson'), styles: calls('map_style_layer'), annotates: calls('map_annotate'), sql: calls('run_sql') };
  if (task === 't1') {
    const regions = { california: /california|west coast|los angeles/i, texas: /texas|houston|dallas/i, florida: /florida/i, northeast: /new york|northeast|east coast|boston|atlantic/i, midwest: /chicago|midwest|great lakes/i, sparse: /sparse|empty|great plains|mountain|rockies|interior|rural/i };
    const hit = Object.entries(regions).filter(([, re]) => re.test(a)).map(([k]) => k);
    return { ...base, regions: hit, correct: hit.length >= 3 && base.cartoLayers + base.geojsonLayers > 0 && base.screenshots > 0 };
  }
  if (task === 't2') return { ...base, correct: base.styles + base.cartoLayers + base.geojsonLayers > 0 && base.screenshots > 0 };
  if (task === 't3') {
    const inside = /1[,.\s]?9\d\d\b/.test(a);
    const exact = /1[,.\s]?902\b/.test(a);
    const rest = /\b49[0-9]\b|\b79(\.\d)?\s?%|\b2[,.\s]?396\b/.test(a);
    return { ...base, inside1902: exact, insideApprox: inside, comparesToTexas: rest, correct: exact && rest };
  }
  const dc = /port authority|new york\s*\/\s*new jersey|NY\/NJ/i.test(a);
  return { ...base, portAuthority: dc, shownOnMap: base.annotates + base.geojsonLayers + base.cartoLayers > 0, correct: dc && base.annotates + base.geojsonLayers + base.cartoLayers > 0 };
}

async function save(page: Page, task: string, model: string, run: any) {
  const slug = `d10-${task}__${HARNESS}__${model.replace(/[^a-z0-9.-]/gi, '_')}`;
  const toolCounts: Record<string, number> = {};
  for (const t of run.tools) toolCounts[t.name] = (toolCounts[t.name] ?? 0) + 1;
  const shots = run.tools.filter((t: any) => t.name === 'map_screenshot').map((t: any) => ({ ms: t.durationMs, output: t.output }));
  const summary = {
    task, harnessId: HARNESS, model, status: run.status, error: run.error?.slice(0, 300),
    steps: run.totals.steps, toolCalls: run.totals.toolCalls, toolErrors: run.totals.toolErrors, toolCounts,
    usage: run.totals.usage, stepInput: run.steps?.map((s: any) => s.usage?.inputTokens), wallMs: run.totals.wallMs, toolMs: run.totals.toolMs, llmMs: run.totals.llmMs,
    screenshots: shots, layers: await page.evaluate(() => window.__mapLayers?.().map((l) => ({ id: l.id, kind: l.kind, status: l.status, n: l.featureCount, legend: l.legend.title, error: l.error }))),
    grade: grade(task, run), answer: run.finalText,
  };
  mkdirSync('eval-results', { recursive: true });
  writeFileSync(`eval-results/${slug}.json`, JSON.stringify({ summary, run }, null, 2));
  await page.getByTestId('map-pane').screenshot({ path: `eval-results/${slug}.png` });
  console.log(`[map] ${JSON.stringify({ ...summary, run: undefined, answer: (run.finalText ?? '').slice(0, 300) })}`);
  return summary;
}

/** No LLM: real CARTO sources through the engine. H3 + points + marker all render (regression: depth hid points). */
test('map · layers render on the real stack (H3 + GeoJSON + marker), no LLM', async ({ page }) => {
  test.skip(!TASKS.includes('layers'), 'MAP_TASKS=layers');
  test.setTimeout(180_000);
  await open(page);
  const r = await page.evaluate(async () => {
    const e = (window as any).__mapEngine;
    const h3 = await e.addCartoLayer({
      id: 'h3', kind: 'h3', aggregation_exp: 'COUNT(*) AS n', style: { color_by_column: 'n', palette: 'PurpOr', opacity: 0.9 },
      sql: "SELECT `carto-un`.carto.H3_FROMGEOGPOINT(ST_GEOGPOINT(longitude, latitude), 4) AS h3 FROM `bigquery-public-data.thelook_ecommerce.users` WHERE country = 'United States'",
    });
    const dc = await e.addGeojson({ id: 'dc', from_sql: 'SELECT name, longitude, latitude FROM `bigquery-public-data.thelook_ecommerce.distribution_centers`', style: { color: '#00ff00', radius: 14 } });
    (window as any).__addAnnotation({ type: 'Point', coordinates: [-73.78, 40.63] }, 'x');
    await e.setView({ center: [-74, 40.7], zoom: 7 });
    const shot = await e.screenshot();
    // Count pure-green pixels (the DC points) in the screenshot.
    const img = new Image();
    img.src = shot.image.dataUrl;
    await img.decode();
    const c = document.createElement('canvas');
    [c.width, c.height] = [img.width, img.height];
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let green = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 60 && d[i + 1] > 200 && d[i + 2] < 60) green++;
    return { h3, dc, green, dataUrl: shot.image.dataUrl, waited: shot.waitedMs, warning: shot.warning };
  });
  mkdirSync('eval-results', { recursive: true });
  writeFileSync('eval-results/d10-layers-smoke.png', Buffer.from(r.dataUrl.split(',')[1], 'base64'));
  console.log('[layers]', JSON.stringify({ h3: r.h3, dc: r.dc, green: r.green, waited: r.waited, warning: r.warning }));
  expect(r.h3.status).toBe('ready');
  expect(r.h3.legend.items.length).toBeGreaterThan(2);
  expect(r.dc.featureCount).toBe(10);
  expect(r.green).toBeGreaterThan(100);
});

for (const model of MODELS) {
  for (const task of TASKS) {
    test(`map · ${task} · ${HARNESS} · ${model}`, async ({ page }) => {
      test.setTimeout(1_800_000);
      await open(page);
      if (task === 't1t2') {
        const r1 = await ask(page, model, MAP_PROMPTS.t1);
        await save(page, 't1', model, r1);
        const r2 = await ask(page, model, MAP_PROMPTS.t2);
        await save(page, 't2', model, r2);
        expect(r1.status, r1.error).toBe('done');
        expect(r2.status, r2.error).toBe('done');
        return;
      }
      if (task === 't3') {
        const id = await page.evaluate((g) => window.__addAnnotation!(g as any, 'why so many here?'), A1);
        expect(id).toBe('A1');
        await page.evaluate(() => new Promise((r) => setTimeout(r, 1500)));
      }
      const run = await ask(page, model, task === 't3' ? MAP_PROMPTS.t3 : MAP_PROMPTS.t4);
      await save(page, task, model, run);
      expect(run.status, run.error).toBe('done');
    });
  }
}
