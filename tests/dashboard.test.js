import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, signupAndGetSession } from './helpers.js';

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
  const { server, base } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'dash-owner@example.com');
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
  const { server, base } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'dash-filter@example.com');
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
  const { server, base } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'dash-region@example.com');
    const dataset = await uploadFixture(base, token, workspace.id, 'dashboard-sales.csv');

    const { body } = await getKpis(base, token, dataset.id, '?region=North');
    assert.equal(body.data.kpis.total_revenue, 1900);
    assert.equal(body.data.kpis.active_customers, 3);
  } finally {
    server.close();
  }
});

test('a user outside the workspace cannot read its KPIs', async () => {
  const { server, base } = await startServer();
  try {
    const owner = await signupAndGetSession(base, 'dash-owner2@example.com');
    const outsider = await signupAndGetSession(base, 'dash-outsider@example.com');
    const dataset = await uploadFixture(base, owner.token, owner.workspace.id, 'dashboard-sales.csv');

    const { status } = await getKpis(base, outsider.token, dataset.id);
    assert.equal(status, 404);
  } finally {
    server.close();
  }
});

test('KPIs for a dataset lacking a date/revenue column report what is missing', async () => {
  const { server, base } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'dash-missing@example.com');
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
