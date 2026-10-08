// Generates the demo-8 fixtures:  node tests/fixtures/make-fixtures.mjs
//  - stores.xlsx: 2023 revenue targets by country (joinable with thelook_ecommerce users.country) + a notes sheet.
//  - chart.png:   a flawed chart (truncated y axis, a missing month) for the "what's wrong with this chart" test.
import { writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import * as vega from 'vega';
import { compile } from 'vega-lite';
import { chromium } from '@playwright/test';

const dir = dirname(fileURLToPath(import.meta.url));

// Targets chosen ≥5% away from actual 2023 net revenue (items created in 2023, excluding Cancelled/Returned) so the
// answer is unambiguous: missed = United States, South Korea, France, Spain, Australia, Poland, Colombia, Mexico (no sales).
const targets = [
  ['China', 'APAC', 'Li Wei', 280000],
  ['United States', 'Americas', 'Sarah Johnson', 210000],
  ['Brasil', 'Americas', 'Sarah Johnson', 120000],
  ['South Korea', 'APAC', 'Li Wei', 60000],
  ['Germany', 'EMEA', 'Anna Schmidt', 38000],
  ['France', 'EMEA', 'Anna Schmidt', 45000],
  ['United Kingdom', 'EMEA', 'James Brown', 35000],
  ['Spain', 'EMEA', 'James Brown', 40000],
  ['Japan', 'APAC', 'Kenji Sato', 22000],
  ['Australia', 'APAC', 'Kenji Sato', 25000],
  ['Belgium', 'EMEA', 'Anna Schmidt', 9000],
  ['Poland', 'EMEA', 'James Brown', 5000],
  ['Colombia', 'Americas', 'Carlos Ruiz', 1000],
  ['Mexico', 'Americas', 'Carlos Ruiz', 15000],
];
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(
  wb,
  XLSX.utils.aoa_to_sheet([['country', 'region', 'region_manager', 'target_revenue_2023'], ...targets]),
  'Targets',
);
XLSX.utils.book_append_sheet(
  wb,
  XLSX.utils.aoa_to_sheet([['note'], ['Targets are in USD for calendar year 2023.'], ['Owner: sales-ops. Draft v3.']]),
  'Notes',
);
writeFileSync(join(dir, 'stores.xlsx'), XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));

// Real 2023 monthly gross revenue (thelook_ecommerce order_items.sale_price), July deliberately left out,
// y axis deliberately not starting at zero.
const monthly = [
  ['2023-01', 84010], ['2023-02', 79856], ['2023-03', 85336], ['2023-04', 83258], ['2023-05', 93033],
  ['2023-06', 106560], ['2023-08', 105235], ['2023-09', 103144], ['2023-10', 101480], ['2023-11', 110594], ['2023-12', 116248],
];
const spec = {
  $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
  title: 'Monthly revenue 2023',
  width: 520,
  height: 300,
  background: 'white',
  data: { values: monthly.map(([month, revenue]) => ({ month, revenue })) },
  mark: { type: 'bar', color: '#4c78a8', clip: true },
  encoding: {
    x: { field: 'month', type: 'ordinal', title: 'Month' },
    y: { field: 'revenue', type: 'quantitative', title: 'Revenue (USD)', scale: { domain: [75000, 120000] } },
  },
};
const view = new vega.View(vega.parse(compile(spec).spec), { renderer: 'none' });
const svg = await view.toSVG();
const fallback = '/opt/pw-browsers/chromium';
const browser = await chromium.launch(existsSync(fallback) && !process.env.PLAYWRIGHT_BROWSERS_PATH ? { executablePath: fallback } : {});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
await page.setContent(`<body style="margin:0;background:#fff"><div id="c" style="display:inline-block">${svg}</div></body>`);
writeFileSync(join(dir, 'chart.png'), await page.locator('#c').screenshot());
await browser.close();
console.log('wrote stores.xlsx and chart.png');
