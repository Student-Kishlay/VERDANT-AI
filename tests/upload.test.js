import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, signupAndGetSession } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

function fixtureBlob(name, type = 'text/csv') {
  const buffer = fs.readFileSync(path.join(FIXTURES_DIR, name));
  return new Blob([buffer], { type });
}

async function uploadFixture(base, token, workspaceId, fileName, blob) {
  const form = new FormData();
  form.append('workspace_id', workspaceId);
  form.append('file', blob, fileName);
  const res = await fetch(`${base}/api/datasets/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return { status: res.status, body: await res.json() };
}

test('uploading the fixture CSV reaches status ready with the exact hand-computed summary', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'uploader@example.com', { insforge });
    const { status, body } = await uploadFixture(base, token, workspace.id, 'sample-sales.csv', fixtureBlob('sample-sales.csv'));

    assert.equal(status, 201);
    assert.equal(body.ok, true);
    assert.equal(body.data.dataset.status, 'ready');
    assert.deepEqual(body.data.dataset.cleaning_summary, {
      normalized_columns: ['order_date', 'customer_name', 'region', 'revenue', 'quantity'],
      rows_removed_empty: 1,
      duplicates_removed: 1,
      date_columns: ['order_date'],
      numeric_columns: ['revenue', 'quantity'],
      missing_filled: { order_date: 1, revenue: 2, region: 1 },
      final_row_count: 10,
      final_column_count: 5,
    });

    const columnsByName = Object.fromEntries(body.data.dataset.columns.map((c) => [c.column_name, c]));
    assert.equal(columnsByName.revenue.effective_role, 'revenue');
    assert.equal(columnsByName.region.effective_role, 'region');
  } finally {
    server.close();
  }
});

test('re-uploading identical bytes resolves to the existing dataset, no duplicate', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'reupload@example.com', { insforge });
    const first = await uploadFixture(base, token, workspace.id, 'sample-sales.csv', fixtureBlob('sample-sales.csv'));
    const second = await uploadFixture(base, token, workspace.id, 'sample-sales.csv', fixtureBlob('sample-sales.csv'));

    assert.equal(second.body.data.alreadyExists, true);
    assert.equal(second.body.data.dataset.id, first.body.data.dataset.id);

    const list = await fetch(`${base}/api/datasets?workspace_id=${workspace.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    assert.equal(list.data.datasets.length, 1);
  } finally {
    server.close();
  }
});

test('a column-role override persists and takes precedence over the detected role', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'override@example.com', { insforge });
    const uploaded = await uploadFixture(base, token, workspace.id, 'sample-sales.csv', fixtureBlob('sample-sales.csv'));
    const datasetId = uploaded.body.data.dataset.id;

    const overrideRes = await fetch(`${base}/api/datasets/${datasetId}/columns/region/override`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'category' }),
    }).then((r) => r.json());
    assert.equal(overrideRes.data.column.effective_role, 'category');

    const refetched = await fetch(`${base}/api/datasets/${datasetId}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    const region = refetched.data.dataset.columns.find((c) => c.column_name === 'region');
    assert.equal(region.user_override, 'category');
    assert.equal(region.effective_role, 'category');
    assert.equal(region.detected_role, 'region'); // heuristic result preserved, override just takes precedence
  } finally {
    server.close();
  }
});

test('an oversized file is rejected before any dataset is created', async () => {
  const { server, base, insforge } = await startServer({ maxUploadFileSizeMb: 0.0001 }); // ~100 bytes
  try {
    const { token, workspace } = await signupAndGetSession(base, 'toobig@example.com', { insforge });
    const { status, body } = await uploadFixture(base, token, workspace.id, 'sample-sales.csv', fixtureBlob('sample-sales.csv'));
    assert.equal(status, 400);
    assert.equal(body.error.code, 'FILE_TOO_LARGE');

    const list = await fetch(`${base}/api/datasets?workspace_id=${workspace.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    assert.equal(list.data.datasets.length, 0);
  } finally {
    server.close();
  }
});

test('a disallowed file type is rejected', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'wrongtype@example.com', { insforge });
    const blob = new Blob(['just some text'], { type: 'text/plain' });
    const { status, body } = await uploadFixture(base, token, workspace.id, 'notes.txt', blob);
    assert.equal(status, 400);
    assert.equal(body.error.code, 'INVALID_FILE_TYPE');
  } finally {
    server.close();
  }
});

test('a file over the row-count ceiling is rejected and no dataset is created', async () => {
  const { server, base, insforge } = await startServer({ maxUploadRowCount: 5 });
  try {
    const { token, workspace } = await signupAndGetSession(base, 'toomanyrows@example.com', { insforge });
    const { status, body } = await uploadFixture(base, token, workspace.id, 'sample-sales.csv', fixtureBlob('sample-sales.csv'));
    assert.equal(status, 400);
    assert.equal(body.error.code, 'ROW_LIMIT_EXCEEDED');

    const list = await fetch(`${base}/api/datasets?workspace_id=${workspace.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    assert.equal(list.data.datasets.length, 0);
  } finally {
    server.close();
  }
});

test('a header-only (effectively empty) CSV ends with status failed and a reason, not a hang', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'empty@example.com', { insforge });
    const blob = new Blob(['order_date,revenue\n'], { type: 'text/csv' });
    const { status, body } = await uploadFixture(base, token, workspace.id, 'empty.csv', blob);
    assert.equal(status, 201);
    assert.equal(body.data.dataset.status, 'failed');
    assert.ok(body.data.dataset.failure_reason);
  } finally {
    server.close();
  }
});

test('a user outside the workspace cannot read or delete its dataset', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const owner = await signupAndGetSession(base, 'owner-ds@example.com', { insforge });
    const outsider = await signupAndGetSession(base, 'outsider-ds@example.com', { insforge });
    const uploaded = await uploadFixture(base, owner.token, owner.workspace.id, 'sample-sales.csv', fixtureBlob('sample-sales.csv'));
    const datasetId = uploaded.body.data.dataset.id;

    const getRes = await fetch(`${base}/api/datasets/${datasetId}`, {
      headers: { Authorization: `Bearer ${outsider.token}` },
    });
    assert.equal(getRes.status, 404);

    const deleteRes = await fetch(`${base}/api/datasets/${datasetId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${outsider.token}` },
    });
    assert.equal(deleteRes.status, 404);

    // Owner can still see it — proves the 404 above was isolation, not breakage
    const ownerGet = await fetch(`${base}/api/datasets/${datasetId}`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    assert.equal(ownerGet.status, 200);
  } finally {
    server.close();
  }
});

test('deleting a dataset removes it for its owner too', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'deleter@example.com', { insforge });
    const uploaded = await uploadFixture(base, token, workspace.id, 'sample-sales.csv', fixtureBlob('sample-sales.csv'));
    const datasetId = uploaded.body.data.dataset.id;

    const del = await fetch(`${base}/api/datasets/${datasetId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(del.status, 200);

    const get = await fetch(`${base}/api/datasets/${datasetId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(get.status, 404);
  } finally {
    server.close();
  }
});
