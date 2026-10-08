/**
 * Offline checks of the semantic models + renderer against a real catalog snapshot (catalog.fixture.json, fetched from
 * GET /v3/connections/carto_dw/resources/<table> on 2026-10-08).
 *   node tests/semantic/semantic.unit.ts        (Node ≥ 22.18 strips the TS types)
 * Prints the rendered prompt section size (chars and ~tokens) and with PRINT=1 the section itself.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describeSourcePayload, estimateTokens, listSourcesPayload, metricPayload, renderSemanticPrompt, resolveModel } from '../../src/semantic/render.ts';
import type { Catalog, SemanticModel } from '../../src/semantic/types.ts';

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const models: Record<string, SemanticModel> = {};
for (const f of ['thelook_ecommerce', 'us_geo']) {
  const m = read(`../../src/semantic/models/${f}.json`) as SemanticModel;
  models[m.id] = m;
}
const catalog = read('./catalog.fixture.json') as Catalog;
const model = resolveModel('thelook_ecommerce', models);

let failures = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message : e}`);
  }
};

const cols = (source: string) => {
  const s = model.sources.find((x) => x.name === source);
  assert.ok(s, `unknown source ${source}`);
  return new Set(catalog.entries[s.table]?.columns.map((c) => c.name));
};
const assertRef = (ref: string) => {
  const [s, c] = ref.split('.');
  assert.ok(cols(s).has(c), `${ref} is not a column in the catalog`);
};

check('includes are merged (7 thelook + 2 geo sources)', () => {
  assert.equal(model.sources.length, 9);
  assert.equal(model.key, 'thelook_ecommerce@2026-10-08.1+us_geo@2026-10-08.1');
  assert.deepEqual(new Set(Object.values(model.sourceVersions)), new Set(['2026-10-08.1']));
});
check('every source has a catalog entry with columns', () => {
  for (const s of model.sources) assert.ok(catalog.entries[s.table]?.columns.length, s.table);
});
check('declared columns, PKs, time and geo columns exist', () => {
  for (const s of model.sources) {
    const c = cols(s.name);
    for (const k of Object.keys(s.columns ?? {})) assert.ok(c.has(k), `${s.name}.${k}`);
    for (const k of [s.primary_key, s.time_column, s.geo?.lat, s.geo?.lon, s.geo?.geography].filter(Boolean) as string[])
      assert.ok(c.has(k), `${s.name}.${k}`);
  }
});
check('relationships reference real columns', () => {
  for (const r of model.relationships ?? []) {
    assertRef(r.from);
    assertRef(r.to);
  }
});
check('metric/dimension SQL only references real columns', () => {
  const names = new Set(model.sources.map((s) => s.name));
  for (const m of [...(model.metrics ?? []), ...(model.dimensions ?? [])]) {
    const sql = `${m.sql} ${'filter' in m ? (m.filter ?? '') : ''}`;
    for (const [, s, c] of sql.matchAll(/\b([a-z_]+)\.([a-z_]+)\b/g)) if (names.has(s)) assertRef(`${s}.${c}`);
  }
});
check('describe_source / get_metric / list_sources payloads', () => {
  const d = describeSourcePayload(model, 'bigquery-public-data.thelook_ecommerce.order_items', catalog);
  assert.equal(d.name, 'order_items');
  assert.equal(d.rows, 181162);
  assert.ok(d.columns.find((c) => c.name === 'status')?.values?.includes('Returned'));
  assert.ok(d.joins.some((j) => j.startsWith('order_items.order_id → orders.order_id')));
  assert.equal(describeSourcePayload(model, 'USERS', catalog).geo?.geography, 'user_geom');
  const m = metricPayload(model, 'gross_margin');
  assert.match(m.example_sql!, /JOIN `bigquery-public-data\.thelook_ecommerce\.inventory_items` AS inventory_items ON inventory_items\.id = order_items\.inventory_item_id/);
  assert.match(metricPayload(model, 'net_revenue').example_sql!, /status NOT IN \('Cancelled', 'Returned'\)/);
  assert.throws(() => metricPayload(model, 'nope'), /Unknown metric/);
  assert.equal(listSourcesPayload(model, catalog).sources.length, 9);
});

const text = renderSemanticPrompt(model, catalog);
const bare = renderSemanticPrompt(model); // catalog unavailable → declared columns only
const lite = renderSemanticPrompt(model, catalog, { mode: 'lite' });
check('lite mode drops column lists but keeps notes and sizes', () => {
  assert.ok(!lite.includes('  cols: ') && lite.includes('Deutschland') && lite.includes('181k rows'));
  assert.ok(lite.length < text.length * 0.85, `${lite.length} vs ${text.length}`);
});
check('rendered section is compact (≤ 12k chars ≈ 3k tokens) and complete', () => {
  assert.ok(text.length <= 12_000, `${text.length} chars`);
  for (const s of model.sources) assert.ok(text.includes(s.table), s.table);
  assert.ok(text.includes('Deutschland'));
  assert.ok(text.includes('net_revenue = SUM(order_items.sale_price) FILTER'));
  assert.ok(text.includes('181k rows'));
});
console.log(`\nprompt section: ${text.length} chars ≈ ${estimateTokens(text)} tokens (without catalog: ${bare.length} chars ≈ ${estimateTokens(bare)} tokens; lite: ${lite.length} chars ≈ ${estimateTokens(lite)} tokens)`);
if (process.env.PRINT) console.log(`\n${text}\n`);
if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
