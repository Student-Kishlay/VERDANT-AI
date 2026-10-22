import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, signupAndGetSession } from './helpers.js';
import { computeKpis } from '../server/pipeline/compute-kpis.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

async function uploadFixture(base, token, workspaceId, fileName) {
  const buffer = fs.readFileSync(path.join(FIXTURES_DIR, fileName));
  const form = new FormData();
  form.append('workspace_id', workspaceId);
  form.append('file', new Blob([buffer], { type: 'text/csv' }), fileName);
  const res = await fetch(`${base}/api/datasets/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return (await res.json()).data.dataset;
}

async function getKpis(base, token, datasetId, query = '') {
  const res = await fetch(`${base}/api/datasets/${datasetId}/kpis${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json() };
}

test('GET .../kpis returns the exact hand-computed unfiltered totals', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'dash-owner@example.com', { insforge });
    const dataset = await uploadFixture(base, token, workspace.id, 'dashboard-sales.csv');

    const { status, body } = await getKpis(base, token, dataset.id);
    assert.equal(status, 200);
    assert.equal(body.data.kpis.total_revenue, 5500);
    assert.equal(body.data.kpis.total_orders, 10);
    assert.equal(body.data.kpis.avg_order_value, 550);
    assert.equal(body.data.kpis.active_customers, 9);
  } finally {
    server.close();
  }
});

test('a date-range query param changes the response', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'dash-filter@example.com', { insforge });
    const dataset = await uploadFixture(base, token, workspace.id, 'dashboard-sales.csv');

    const filtered = await getKpis(base, token, dataset.id, '?start_date=2024-02-03&end_date=2024-02-06');
    assert.equal(filtered.body.data.kpis.total_revenue, 1800);
    assert.equal(filtered.body.data.kpis.total_orders, 4);

    const unfiltered = await getKpis(base, token, dataset.id);
    assert.equal(unfiltered.body.data.kpis.total_revenue, 5500);
    assert.notEqual(filtered.body.data.kpis.total_revenue, unfiltered.body.data.kpis.total_revenue);
  } finally {
    server.close();
  }
});

test('a region query param changes the response', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'dash-region@example.com', { insforge });
    const dataset = await uploadFixture(base, token, workspace.id, 'dashboard-sales.csv');

    const { body } = await getKpis(base, token, dataset.id, '?region=North');
    assert.equal(body.data.kpis.total_revenue, 1900);
    assert.equal(body.data.kpis.active_customers, 3);
  } finally {
    server.close();
  }
});

test('a user outside the workspace cannot read its KPIs', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const owner = await signupAndGetSession(base, 'dash-owner2@example.com', { insforge });
    const outsider = await signupAndGetSession(base, 'dash-outsider@example.com', { insforge });
    const dataset = await uploadFixture(base, owner.token, owner.workspace.id, 'dashboard-sales.csv');

    const { status } = await getKpis(base, outsider.token, dataset.id);
    assert.equal(status, 404);
  } finally {
    server.close();
  }
});

test('KPIs for a dataset lacking a date/revenue column report what is missing', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'dash-missing@example.com', { insforge });
    const blob = new Blob(['notes,color\nfine,blue\nlate,red\n'], { type: 'text/csv' });
    const form = new FormData();
    form.append('workspace_id', workspace.id);
    form.append('file', blob, 'no-kpi-columns.csv');
    const uploadRes = await fetch(`${base}/api/datasets/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    }).then((r) => r.json());

    const { body } = await getKpis(base, token, uploadRes.data.dataset.id);
    assert.equal(body.data.kpis.available, false);
    assert.ok(body.data.kpis.missing.includes('revenue'));
  } finally {
    server.close();
  }
});

// ── Pure computeKpis: MoM, drill-down, top products, customer value ──────


const KPI_COLUMNS = [
  { column_name: 'd', effective_role: 'date' },
  { column_name: 'rev', effective_role: 'revenue' },
  { column_name: 'cust', effective_role: 'customer' },
  { column_name: 'cat', effective_role: 'category' },
  { column_name: 'prod', effective_role: 'product' },
  { column_name: 'qty', effective_role: 'quantity' },
];
const KPI_ROWS = [
  { d: '2024-01-10', rev: 100, cust: 'A', cat: 'Electronics', prod: 'Phone', qty: 1 },
  { d: '2024-01-20', rev: 100, cust: 'B', cat: 'Apparel', prod: 'Shirt', qty: 4 },
  { d: '2024-02-05', rev: 300, cust: 'A', cat: 'Electronics', prod: 'Phone', qty: 2 },
  { d: '2024-02-15', rev: 50, cust: 'C', cat: 'Apparel', prod: 'Shirt', qty: 1 },
  { d: '2024-02-20', rev: 150, cust: 'D', cat: 'Electronics', prod: 'Laptop', qty: 1 },
];

test('MoM compares the latest month with the one before it', () => {
  const k = computeKpis(KPI_COLUMNS, KPI_ROWS);
  assert.equal(k.mom.current_month, '2024-02');
  assert.equal(k.mom.previous_month, '2024-01');
  assert.deepEqual(k.mom.changes.total_revenue, { current: 500, previous: 200, change_pct: 150 });
  assert.equal(k.mom.changes.active_customers.change_pct, 50); // 3 vs 2
  assert.deepEqual(k.date_range, { min: '2024-01-10', max: '2024-02-20' });
});

test('MoM anchors on the end date and reports null with no prior month', () => {
  const k = computeKpis(KPI_COLUMNS, KPI_ROWS, { endDate: '2024-01-31' });
  assert.equal(k.mom.current_month, '2024-01');
  assert.equal(k.mom.changes.total_revenue.change_pct, null);
});

test('category drill-down filters totals and trend but keeps every category bar', () => {
  const k = computeKpis(KPI_COLUMNS, KPI_ROWS, { category: 'Electronics' });
  assert.equal(k.total_revenue, 550);
  assert.deepEqual(k.revenue_trend.map((p) => p.date), ['2024-01-10', '2024-02-05', '2024-02-20']);
  assert.deepEqual(k.category_mix.map((c) => c.category), ['Electronics', 'Apparel']);
  assert.deepEqual(k.available_categories, ['Apparel', 'Electronics']);
});

test('top products rank by revenue with units and share', () => {
  const k = computeKpis(KPI_COLUMNS, KPI_ROWS);
  assert.equal(k.product_available, true);
  assert.deepEqual(k.top_products[0], { product: 'Phone', revenue: 400, units: 3, orders: 2, share_pct: 57.1 });
  assert.deepEqual(k.top_products.map((p) => p.product), ['Phone', 'Shirt', 'Laptop']);
});

test('customer value counts first-time customers inside the range only', () => {
  const k = computeKpis(KPI_COLUMNS, KPI_ROWS, { startDate: '2024-02-01', endDate: '2024-02-29' });
  assert.equal(k.customer_value.new_customers, 2); // C and D; A first bought in January
  assert.equal(k.customer_value.customers_all_time, 4);
  assert.equal(k.customer_value.avg_lifetime_value, 175); // 700 / 4
});

test('a dataset without product/customer columns degrades cleanly', () => {
  const k = computeKpis(KPI_COLUMNS.slice(0, 2), KPI_ROWS);
  assert.equal(k.product_available, false);
  assert.deepEqual(k.top_products, []);
  assert.equal(k.customer_value.available, false);
});

test('the category query param reaches the KPI route', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'dash-drill@example.com', { insforge });
    const dataset = await uploadFixture(base, token, workspace.id, 'dashboard-sales.csv');
    const all = (await getKpis(base, token, dataset.id)).body.data.kpis;
    const drilled = (await getKpis(base, token, dataset.id, '?category=Electronics')).body.data.kpis;
    assert.ok(drilled.total_revenue < all.total_revenue);
    assert.equal(drilled.category_mix.length, all.category_mix.length);
  } finally {
    server.close();
  }
});
