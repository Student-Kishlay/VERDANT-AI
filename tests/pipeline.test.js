import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpreadsheet } from '../server/pipeline/parse-spreadsheet.js';
import { cleanDataset } from '../server/pipeline/clean-dataset.js';
import { detectColumns } from '../server/pipeline/detect-columns.js';
import { computeKpis } from '../server/pipeline/compute-kpis.js';
import { forecastRevenue } from '../server/pipeline/forecast-revenue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

async function loadFixture(name) {
  const buffer = fs.readFileSync(path.join(FIXTURES_DIR, name));
  return parseSpreadsheet(buffer, name);
}

// Hand-computed against tests/fixtures/sample-sales.csv (see its 12 data
// rows): 1 fully-empty row and 1 exact duplicate removed -> 10 rows; the
// missing date forward-fills from the prior row; revenue's 2 missing/junk
// values fill with the median (550) of the 8 valid numbers; region's 1
// missing value fills with "Unknown".
test('cleanDataset produces exactly the hand-computed summary on the fixture', async () => {
  const { headers, rows } = await loadFixture('sample-sales.csv');
  const result = cleanDataset(headers, rows);

  assert.deepEqual(result.summary, {
    normalized_columns: ['order_date', 'customer_name', 'region', 'revenue', 'quantity'],
    rows_removed_empty: 1,
    duplicates_removed: 1,
    date_columns: ['order_date'],
    numeric_columns: ['revenue', 'quantity'],
    missing_filled: { order_date: 1, revenue: 2, region: 1 },
    final_row_count: 10,
    final_column_count: 5,
  });
});

test('cleanDataset fills the correct values, not just the correct counts', async () => {
  const { headers, rows } = await loadFixture('sample-sales.csv');
  const { rows: cleaned } = cleanDataset(headers, rows);

  const carol = cleaned.find((r) => r.customer_name === 'Carol');
  const grace = cleaned.find((r) => r.customer_name === 'Grace');
  const eve = cleaned.find((r) => r.customer_name === 'Eve');
  const frank = cleaned.find((r) => r.customer_name === 'Frank');

  assert.equal(carol.revenue, 550); // missing revenue -> median of [100,200,400,500,600,900,1000,1100]
  assert.equal(grace.revenue, 550); // "N/A" -> also missing -> same median
  assert.equal(eve.order_date, '2024-01-04'); // missing date -> forward-filled from Dave's row
  assert.equal(frank.region, 'Unknown'); // missing region -> literal "Unknown"

  // No duplicate Alice/North/100/2 row survives
  const aliceRows = cleaned.filter((r) => r.customer_name === 'Alice');
  assert.equal(aliceRows.length, 1);
});

test('cleanDataset is deterministic: same input twice -> identical output', async () => {
  const { headers, rows } = await loadFixture('sample-sales.csv');
  const first = cleanDataset(headers, rows);
  const second = cleanDataset(headers, rows);
  assert.deepEqual(first, second);
});

test('cleanDataset throws on a file that cleans down to zero rows', () => {
  assert.throws(() => cleanDataset(['name'], [[''], ['']]), /EMPTY_AFTER_CLEANING/);
});

test('detectColumns assigns the expected role to each column, deterministically', async () => {
  const { headers, rows } = await loadFixture('sample-sales.csv');
  const cleaned = cleanDataset(headers, rows);
  const columns = detectColumns(cleaned.headers, cleaned.rows);

  assert.deepEqual(columns, [
    { column_name: 'order_date', detected_role: 'date', confidence: 0.7 },
    { column_name: 'customer_name', detected_role: 'customer', confidence: 0.7 },
    { column_name: 'region', detected_role: 'region', confidence: 1 },
    { column_name: 'revenue', detected_role: 'revenue', confidence: 1 },
    { column_name: 'quantity', detected_role: 'quantity', confidence: 1 },
  ]);
});

test('detectColumns leaves an unrecognizable column with no role rather than guessing', () => {
  const headers = ['notes'];
  const rows = [{ notes: 'looks fine' }, { notes: 'a bit late' }];
  const columns = detectColumns(headers, rows);
  assert.deepEqual(columns, [{ column_name: 'notes', detected_role: null, confidence: 0 }]);
});

test('parseSpreadsheet stores an injected script payload as-is (sanitization is a render-time concern)', async () => {
  const { headers, rows } = await loadFixture('xss-sample.csv');
  const { rows: cleaned } = cleanDataset(headers, rows);
  const injected = cleaned.find((r) => r.category.includes('img'));
  assert.equal(injected.category, '<img src=x onerror=alert(1)>');
});

// tests/fixtures/dashboard-sales.csv: 10 already-clean rows, Feb 1-10 2024,
// one repeat customer (Alice, rows 1 and 5) so distinct-count regressions
// (the metric the master prompt calls out as broken in the original) show up.
async function loadDashboardFixture() {
  const { headers, rows } = await loadFixture('dashboard-sales.csv');
  const cleaned = cleanDataset(headers, rows);
  const columns = detectColumns(cleaned.headers, cleaned.rows).map((c) => ({ ...c, effective_role: c.detected_role }));
  return { columns, rows: cleaned.rows };
}

test('computeKpis: unfiltered totals match hand computation', async () => {
  const { columns, rows } = await loadDashboardFixture();
  const kpis = computeKpis(columns, rows);

  assert.equal(kpis.available, true);
  assert.equal(kpis.total_revenue, 5500);
  assert.equal(kpis.total_orders, 10);
  assert.equal(kpis.avg_order_value, 550);
  assert.equal(kpis.active_customers, 9); // Alice's 2 rows count once — the regression this guards against
  assert.deepEqual(kpis.available_regions, ['East', 'North', 'South', 'West']);
  assert.equal(kpis.revenue_trend.length, 10);
  assert.deepEqual(
    kpis.category_mix,
    [
      { category: 'Grocery', revenue: 2500 },
      { category: 'Electronics', revenue: 1700 },
      { category: 'Apparel', revenue: 1300 },
    ]
  );
});

test('computeKpis: a date-range filter changes the totals (server-side recompute)', async () => {
  const { columns, rows } = await loadDashboardFixture();
  const kpis = computeKpis(columns, rows, { startDate: '2024-02-03', endDate: '2024-02-06' });

  assert.equal(kpis.total_revenue, 1800); // rows 3,4,5,6: 300+400+500+600
  assert.equal(kpis.total_orders, 4);
  assert.equal(kpis.avg_order_value, 450);
  assert.equal(kpis.active_customers, 4); // Carol, Dave, Alice, Eve
});

test('computeKpis: a region filter changes the totals independently of the date filter', async () => {
  const { columns, rows } = await loadDashboardFixture();
  const kpis = computeKpis(columns, rows, { region: 'North' });

  assert.equal(kpis.total_revenue, 1900); // rows 1,3,5,10: 100+300+500+1000
  assert.equal(kpis.total_orders, 4);
  assert.equal(kpis.active_customers, 3); // Alice (x2), Carol, Ivan -> 3 distinct
});

test('computeKpis reports which required role is missing instead of silently returning zeros', () => {
  const columns = [{ column_name: 'notes', detected_role: null, confidence: 0, effective_role: null }];
  const kpis = computeKpis(columns, [{ notes: 'hi' }]);
  assert.equal(kpis.available, false);
  assert.deepEqual(kpis.missing.sort(), ['date', 'revenue']);
});

const FORECAST_COLUMNS = [
  { column_name: 'order_date', effective_role: 'date' },
  { column_name: 'revenue', effective_role: 'revenue' },
];

// A perfectly linear 7-day series (100, 200, ..., 700) has a least-squares
// fit with zero residual: slope=100, intercept=100 (hand-verified). The
// moving average over all 7 days (window = min(7,7)) is the mean, 400.
// Forecast(x) = 0.6*(100+100x) + 0.4*400 for x=7,8,9 -> 640, 700, 760.
test('forecastRevenue matches a hand-computed linear-trend fit exactly', () => {
  const rows = [100, 200, 300, 400, 500, 600, 700].map((revenue, i) => ({
    order_date: `2024-03-0${i + 1}`,
    revenue,
  }));
  const result = forecastRevenue(FORECAST_COLUMNS, rows, { horizonDays: 3 });

  assert.equal(result.available, true);
  assert.equal(result.historical.length, 7);
  assert.deepEqual(
    result.series.map((p) => p.predicted_revenue),
    [640, 700, 760]
  );
  assert.deepEqual(
    result.series.map((p) => p.date),
    ['2024-03-08', '2024-03-09', '2024-03-10']
  );
});

// A declining 5-day series (500,400,300,200,100): slope=-100, intercept=500,
// moving average (window=5) = 300. Forecast(x)=0.6*(500-100x)+0.4*300 for
// x=5..9 -> 120, 60, 0, -60->0, -120->0. This is what actually exercises the
// "non-negative at every point" acceptance criterion.
test('forecastRevenue floors negative projections at zero', () => {
  const rows = [500, 400, 300, 200, 100].map((revenue, i) => ({
    order_date: `2024-04-0${i + 1}`,
    revenue,
  }));
  const result = forecastRevenue(FORECAST_COLUMNS, rows, { horizonDays: 5 });

  assert.deepEqual(
    result.series.map((p) => p.predicted_revenue),
    [120, 60, 0, 0, 0]
  );
  assert.ok(result.series.every((p) => p.predicted_revenue >= 0));
});

test('forecastRevenue zero-fills gap days rather than skipping them', () => {
  // Only day 1 and day 4 have sales; days 2-3 must appear as zero revenue,
  // making the historical series length 4, not 2.
  const rows = [
    { order_date: '2024-05-01', revenue: 100 },
    { order_date: '2024-05-04', revenue: 100 },
  ];
  const result = forecastRevenue(FORECAST_COLUMNS, rows, { horizonDays: 1 });
  assert.equal(result.historical.length, 4);
  assert.deepEqual(
    result.historical.map((p) => p.revenue),
    [100, 0, 0, 100]
  );
});

test('forecastRevenue reports missing columns instead of guessing', () => {
  const result = forecastRevenue([{ column_name: 'notes', effective_role: null }], [{ notes: 'hi' }], {
    horizonDays: 7,
  });
  assert.equal(result.available, false);
  assert.deepEqual(result.missing.sort(), ['date', 'revenue']);
});
