import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { installMockLlm } from './mock-llm';

/** Demo 10 (map workspace) against the mock LLM: map tools, screenshots as image parts, annotations as context. */
const HARNESS_IDS = ['aisdk', 'handrolled', 'openai-agents'];

const POINTS = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-74, 40.7] }, properties: { name: 'NYC', n: 30 } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-118.2, 34] }, properties: { name: 'LA', n: 20 } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-87.6, 41.9] }, properties: { name: 'Chicago', n: 10 } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-95.4, 29.8] }, properties: { name: 'Houston', n: 5 } },
  ],
};
// Texas triangle (Dallas – Houston – San Antonio), [lon, lat].
const TRIANGLE = { type: 'Polygon', coordinates: [[[-97.3, 33.3], [-96.2, 33.2], [-94.6, 29.6], [-95.1, 29.0], [-98.9, 29.1], [-99.0, 29.7], [-97.3, 33.3]]] };

async function openMap(page: Page, harness: string) {
  await page.goto(`./?demo=d10-map&harness=${harness}`);
  await expect(page.getByTestId('model-select')).toHaveValue('mock-model');
  await expect(page.getByTestId('tools-bar')).toContainText('map_screenshot');
  await expect(page.getByTestId('map').locator('canvas')).toBeVisible();
  await expect(page.getByTestId('map-pane')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
}
async function send(page: Page, text: string) {
  await page.getByTestId('prompt').fill(text);
  await page.getByTestId('send').click();
  await expect(page.getByTestId('run-status')).toHaveText('done', { timeout: 60_000 });
}
const imageParts = (content: unknown) =>
  Array.isArray(content) ? content.filter((p: any) => p.type === 'image_url' && /^data:image\/png;base64,iVBOR/.test(p.image_url?.url)) : [];
const toolOutputs = (req: any) => req.messages.filter((m: any) => m.role === 'tool').map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));

for (const harness of HARNESS_IDS) {
  test(`${harness}: add a GeoJSON layer, style it, screenshot reaches the model as an image`, async ({ page }) => {
    test.setTimeout(90_000);
    const llm = await installMockLlm(page, [
      { toolCalls: [{ name: 'map_add_geojson', args: { id: 'cities', name: 'Cities', geojson: POINTS, style: { radius: 9 } } }] },
      { toolCalls: [{ name: 'map_style_layer', args: { id: 'cities', color_by_column: 'n', color_scheme: 'bins', bins: 3, palette: 'Sunset' } }] },
      { toolCalls: [{ name: 'map_set_view', args: { fit_layer: 'cities' } }, { name: 'map_annotate', args: { point: [-74, 40.7], label: 'Biggest' } }] },
      { toolCalls: [{ name: 'map_screenshot', args: {} }] },
      { text: 'Four cities.' },
    ]);
    await openMap(page, harness);
    await send(page, 'map the cities');
    await expect(page.locator('[data-testid=map-layer][data-layer=cities]')).toHaveAttribute('data-status', 'ready');
    await expect(page.getByTestId('map-legend')).toContainText('≥');
    await expect(page.locator('[data-testid=map-annotation][data-id=M1]')).toBeVisible();

    const add = JSON.parse(toolOutputs(llm.requests[1])[0]);
    expect(add).toMatchObject({ id: 'cities', kind: 'geojson', status: 'ready', features: 4, columns: ['name', 'n'] });
    expect(add.bbox).toEqual([-118.2, 29.8, -74, 41.9]);
    const styled = JSON.parse(toolOutputs(llm.requests[2]).at(-1));
    expect(styled.legend).toMatch(/^Cities — n: < .* \| .* \| ≥ /);

    const msgs = llm.requests[4].messages;
    const toolIdx = msgs.findLastIndex((m: any) => m.role === 'tool');
    const toolMsg = msgs[toolIdx];
    let png: string;
    if (harness === 'aisdk') {
      expect(imageParts(toolMsg.content)).toHaveLength(1);
      png = imageParts(toolMsg.content)[0].image_url.url;
      expect(JSON.stringify(toolMsg.content)).toContain('Map screenshot');
    } else {
      expect(toolMsg.content).toContain('Map screenshot');
      expect(toolMsg.content).toContain('attached below');
      const next = msgs[toolIdx + 1];
      expect(next.role).toBe('user');
      expect(imageParts(next.content)).toHaveLength(1);
      png = imageParts(next.content)[0].image_url.url;
    }
    // The screenshot is a real render: not blank (decoded size and pixel variety checked in the page).
    const stats = await page.evaluate(async (url) => {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement('canvas');
      [c.width, c.height] = [img.width, img.height];
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const colors = new Set<number>();
      let orange = 0;
      for (let i = 0; i < d.length; i += 4 * 7) {
        colors.add((d[i] >> 3) * 1024 + (d[i + 1] >> 3) * 32 + (d[i + 2] >> 3));
        if (d[i] > 200 && d[i + 1] < 140 && d[i + 2] < 90) orange++;
      }
      return { w: img.width, h: img.height, colors: colors.size, orange };
    }, png);
    expect(stats.w).toBeGreaterThan(300);
    expect(stats.colors).toBeGreaterThan(50); // basemap + layers, not a blank canvas
    mkdirSync('eval-results', { recursive: true });
    writeFileSync(`eval-results/d10-mock-screenshot__${harness}.png`, Buffer.from(png.split(',')[1], 'base64'));
    // The base64 never ends up in the run log.
    const run = await page.evaluate(() => window.__runLogs!.at(-1));
    expect(JSON.stringify(run)).not.toContain('iVBOR');
  });
}

test('annotation: seeded A1 shows as a chip and goes with the next message as WKT context plus a screenshot of the user view', async ({ page }) => {
  const llm = await installMockLlm(page, [
    { toolCalls: [{ name: 'get_annotations', args: {} }] },
    { text: 'A1 is the Texas triangle.' },
    { text: 'second answer' },
  ]);
  await openMap(page, 'handrolled');
  const id = await page.evaluate((g) => window.__addAnnotation!(g as any, 'why so many here?'), TRIANGLE);
  expect(id).toBe('A1');
  await expect(page.locator('[data-testid=annotation-chip][data-id=A1]')).toHaveAttribute('data-selected', 'true');
  await expect(page.locator('[data-testid=map-annotation][data-id=A1]')).toContainText('why so many here?');
  await send(page, 'How many customers are inside A1?');
  await expect(page.getByTestId('msg-annotation')).toHaveCount(1);
  // Sent once: the chip is deselected after sending.
  await expect(page.locator('[data-testid=annotation-chip][data-id=A1]')).toHaveAttribute('data-selected', 'false');

  const content = llm.requests[0].messages.find((m: any) => m.role === 'user').content;
  const parts: any[] = Array.isArray(content) ? content : [{ type: 'text', text: content }];
  const user = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  expect(user).toContain('How many customers are inside A1?');
  expect(user).toContain('- A1 "why so many here?": Polygon, bbox [-99, 29, -94.6, 33.3]');
  expect(user).toContain('wkt: POLYGON((-97.3 33.3, -96.2 33.2');
  expect(user).toContain('ST_GEOGFROMTEXT');
  expect(user).toContain('screenshot of the map as the user sees it');
  // The user's view with the mark on it goes along as an image part.
  expect(parts.some((p) => p.type === 'image_url' && String(p.image_url?.url).startsWith('data:image/png'))).toBe(true);
  const ann = JSON.parse(toolOutputs(llm.requests[1])[0]);
  expect(ann[0]).toMatchObject({ id: 'A1', by: 'user', note: 'why so many here?', type: 'Polygon' });
  expect(ann[0].area_km2).toBeGreaterThan(50_000);

  // The context stays in the history of the next turn, without re-attaching.
  await send(page, 'and now?');
  const text = (c: any) => (Array.isArray(c) ? c.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n') : c);
  const hist = llm.requests[2].messages.filter((m: any) => m.role === 'user').map((m: any) => text(m.content));
  expect(hist[0]).toContain('- A1 "why so many here?"');
  expect(hist[1]).toBe('and now?');
});

test('carto layer: SQL guard rejects writes before any network call; Maps API errors come back compactly', async ({ page }) => {
  const maps: string[] = [];
  await page.route('**/v3/maps/**', (route) => {
    maps.push(route.request().url());
    route.fulfill({ status: 401, json: { error: 'Unauthorized: invalid token' }, headers: { 'access-control-allow-origin': '*' } });
  });
  const llm = await installMockLlm(page, [
    { toolCalls: [{ name: 'map_add_carto_layer', args: { kind: 'points', sql: 'DELETE FROM `p.d.users` WHERE true' } }] },
    { toolCalls: [{ name: 'map_add_carto_layer', args: { id: 'users', kind: 'points', sql: 'SELECT ST_GEOGPOINT(longitude, latitude) AS geom FROM `bigquery-public-data.thelook_ecommerce.users`' } }] },
    { toolCalls: [{ name: 'map_add_carto_layer', args: { kind: 'h3', sql: 'SELECT h3 FROM t' } }] },
    { toolCalls: [{ name: 'map_list_layers', args: {} }] },
    { text: 'done' },
  ]);
  await openMap(page, 'handrolled');
  await send(page, 'add layers');
  const outs = llm.requests.slice(1, 5).map((r) => toolOutputs(r).at(-1));
  expect(outs[0]).toContain('statement starts with DELETE');
  expect(outs[1]).toMatch(/Layer users failed: .*401|Unauthorized/i);
  expect(outs[2]).toContain('h3 layers need aggregation_exp');
  expect(JSON.parse(outs[3]).layers[0]).toMatchObject({ id: 'users', status: 'error' });
  expect(maps.length).toBeGreaterThan(0);
  expect(maps.every((u) => !u.includes('DELETE'))).toBe(true);
  await expect(page.locator('[data-testid=map-layer][data-layer=users]')).toHaveAttribute('data-status', 'error');
});

test('drawing a rectangle with the toolbar creates A1 with a note', async ({ page }) => {
  await installMockLlm(page, []);
  await openMap(page, 'handrolled');
  const box = (await page.getByTestId('map').boundingBox())!;
  expect(box.height).toBeGreaterThan(400);
  await page.getByTestId('draw-rectangle').click();
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.click(x - 60, y - 40);
  await page.mouse.move(x + 60, y + 40, { steps: 5 });
  await page.mouse.click(x + 60, y + 40);
  await expect(page.getByTestId('annotation-note-form')).toBeVisible();
  await page.getByTestId('annotation-note').fill('my area');
  await page.getByTestId('annotation-note').press('Enter');
  await expect(page.locator('[data-testid=map-annotation][data-id=A1]')).toContainText('my area');
  await expect(page.locator('[data-testid=annotation-chip][data-id=A1]')).toHaveAttribute('data-selected', 'true');
});
