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

async function getForecast(base, token, datasetId, horizonDays) {
  const res = await fetch(`${base}/api/datasets/${datasetId}/forecast?horizon_days=${horizonDays}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json() };
}

async function getSegments(base, token, datasetId) {
  const res = await fetch(`${base}/api/datasets/${datasetId}/segments`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json() };
}

async function getAnomalies(base, token, datasetId) {
  const res = await fetch(`${base}/api/datasets/${datasetId}/anomalies`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json() };
}

test('GET .../forecast returns a non-negative series of the requested length', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'forecast-owner@example.com', { insforge });
    const dataset = await uploadFixture(base, token, workspace.id, 'dashboard-sales.csv');

    const { status, body } = await getForecast(base, token, dataset.id, 7);
    assert.equal(status, 200);
    assert.equal(body.data.forecast.available, true);
    assert.equal(body.data.forecast.series.length, 7);
    assert.ok(body.data.forecast.series.every((p) => p.predicted_revenue >= 0));
  } finally {
    server.close();
  }
});

test('each horizon option returns a series of matching length', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'forecast-horizons@example.com', { insforge });
    const dataset = await uploadFixture(base, token, workspace.id, 'dashboard-sales.csv');

    for (const horizon of [7, 30, 90]) {
      const { body } = await getForecast(base, token, dataset.id, horizon);
      assert.equal(body.data.forecast.series.length, horizon);
    }
  } finally {
    server.close();
  }
});

test('an unsupported horizon is rejected', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'forecast-badhorizon@example.com', { insforge });
    const dataset = await uploadFixture(base, token, workspace.id, 'dashboard-sales.csv');

    const { status, body } = await getForecast(base, token, dataset.id, 14);
    assert.equal(status, 400);
    assert.equal(body.error.code, 'INVALID_INPUT');
  } finally {
    server.close();
  }
});

test('each forecast request appends to the forecasts log rather than overwriting', async () => {
  const { server, base, db, insforge } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'forecast-log@example.com', { insforge });
    const dataset = await uploadFixture(base, token, workspace.id, 'dashboard-sales.csv');

    await getForecast(base, token, dataset.id, 7);
    await getForecast(base, token, dataset.id, 30);
    assert.equal((await db.listForecasts(dataset.id)).length, 2);
  } finally {
    server.close();
  }
});

test('a user outside the workspace cannot read its forecast', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const owner = await signupAndGetSession(base, 'forecast-owner2@example.com', { insforge });
    const outsider = await signupAndGetSession(base, 'forecast-outsider@example.com', { insforge });
    const dataset = await uploadFixture(base, owner.token, owner.workspace.id, 'dashboard-sales.csv');

    const { status } = await getForecast(base, outsider.token, dataset.id, 7);
    assert.equal(status, 404);
  } finally {
    server.close();
  }
});

test('GET .../segments returns all 6 labels end to end after upload', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'segments-owner@example.com', { insforge });
    const dataset = await uploadFixture(base, token, workspace.id, 'segmentation-sales.csv');

    const { status, body } = await getSegments(base, token, dataset.id);
    assert.equal(status, 200);
    assert.equal(body.data.segmentation.available, true);
    assert.equal(body.data.segmentation.segments.length, 10);
    assert.equal(body.data.segmentation.summary_by_label.length, 6);
  } finally {
    server.close();
  }
});

test('recomputing segments replaces the set rather than duplicating it', async () => {
  const { server, base, db, insforge } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'segments-recompute@example.com', { insforge });
    const dataset = await uploadFixture(base, token, workspace.id, 'segmentation-sales.csv');

    await getSegments(base, token, dataset.id);
    await getSegments(base, token, dataset.id);
    assert.equal((await db.getSegments(dataset.id)).length, 10);
  } finally {
    server.close();
  }
});

test('a user outside the workspace cannot read its segments', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const owner = await signupAndGetSession(base, 'segments-owner2@example.com', { insforge });
    const outsider = await signupAndGetSession(base, 'segments-outsider@example.com', { insforge });
    const dataset = await uploadFixture(base, owner.token, owner.workspace.id, 'segmentation-sales.csv');

    const { status } = await getSegments(base, outsider.token, dataset.id);
    assert.equal(status, 404);
  } finally {
    server.close();
  }
});

test('GET .../anomalies flags exactly the 5 designed outliers end to end', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'anomalies-owner@example.com', { insforge });
    const dataset = await uploadFixture(base, token, workspace.id, 'anomaly-sales.csv');

    const { status, body } = await getAnomalies(base, token, dataset.id);
    assert.equal(status, 200);
    assert.equal(body.data.anomalies.available, true);
    assert.equal(body.data.anomalies.flagged_rows.length, 5);
    assert.deepEqual(body.data.anomalies.flagged_rows.map((f) => f.row_index), [95, 96, 97, 98, 99]);
  } finally {
    server.close();
  }
});

test('recomputing anomalies replaces the set rather than duplicating it', async () => {
  const { server, base, db, insforge } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'anomalies-recompute@example.com', { insforge });
    const dataset = await uploadFixture(base, token, workspace.id, 'anomaly-sales.csv');

    await getAnomalies(base, token, dataset.id);
    await getAnomalies(base, token, dataset.id);
    assert.equal((await db.getAnomalies(dataset.id)).length, 5);
  } finally {
    server.close();
  }
});

test('a user outside the workspace cannot read its anomalies', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const owner = await signupAndGetSession(base, 'anomalies-owner2@example.com', { insforge });
    const outsider = await signupAndGetSession(base, 'anomalies-outsider@example.com', { insforge });
    const dataset = await uploadFixture(base, owner.token, owner.workspace.id, 'anomaly-sales.csv');

    const { status } = await getAnomalies(base, outsider.token, dataset.id);
    assert.equal(status, 404);
  } finally {
    server.close();
  }
});
