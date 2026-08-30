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

async function generateReport(base, token, datasetId, reportType) {
  const res = await fetch(`${base}/api/datasets/${datasetId}/reports`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ report_type: reportType }),
  });
  return { status: res.status, body: await res.json() };
}

const MAGIC_BYTES = {
  analytics_summary: '%PDF',
  sales_forecast: '%PDF',
  customer_segmentation: '%PDF',
  cleaned_dataset: 'PK\x03\x04',
};

for (const reportType of Object.keys(MAGIC_BYTES)) {
  test(`generating a "${reportType}" report produces a valid, uncorrupted file`, async () => {
    const { server, base, insforge } = await startServer();
    try {
      const { token, workspace } = await signupAndGetSession(base, `report-${reportType}@example.com`, { insforge });
      const dataset = await uploadFixture(base, token, workspace.id, 'dashboard-sales.csv');

      const { status, body } = await generateReport(base, token, dataset.id, reportType);
      assert.equal(status, 201);
      const share = body.data.share;
      assert.equal(share.report_type, reportType);
      assert.equal(share.status, 'active');

      const fileRes = await fetch(`${base}${share.url}`);
      assert.equal(fileRes.status, 200);
      const bytes = Buffer.from(await fileRes.arrayBuffer());
      assert.equal(bytes.subarray(0, MAGIC_BYTES[reportType].length).toString('latin1'), MAGIC_BYTES[reportType]);
      assert.ok(bytes.length > 100); // not a truncated/empty file
    } finally {
      server.close();
    }
  });
}

test('an unsupported report_type is rejected', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'report-badtype@example.com', { insforge });
    const dataset = await uploadFixture(base, token, workspace.id, 'dashboard-sales.csv');
    const { status, body } = await generateReport(base, token, dataset.id, 'not_a_real_type');
    assert.equal(status, 400);
    assert.equal(body.error.code, 'INVALID_INPUT');
  } finally {
    server.close();
  }
});

test('revoking a share makes the next fetch of that link 403 REVOKED', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'report-revoke@example.com', { insforge });
    const dataset = await uploadFixture(base, token, workspace.id, 'dashboard-sales.csv');
    const { body } = await generateReport(base, token, dataset.id, 'analytics_summary');
    const share = body.data.share;

    const beforeRevoke = await fetch(`${base}${share.url}`);
    assert.equal(beforeRevoke.status, 200);

    const revokeRes = await fetch(`${base}/api/shares/${share.id}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(revokeRes.status, 200);

    const afterRevoke = await fetch(`${base}${share.url}`);
    const afterBody = await afterRevoke.json();
    assert.equal(afterRevoke.status, 403);
    assert.equal(afterBody.error.code, 'REVOKED');
  } finally {
    server.close();
  }
});

test('an expired share is 403 EXPIRED on next access', async () => {
  const { server, base, db, insforge } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'report-expire@example.com', { insforge });
    const dataset = await uploadFixture(base, token, workspace.id, 'dashboard-sales.csv');
    const { body } = await generateReport(base, token, dataset.id, 'analytics_summary');
    const share = body.data.share;

    // Force expiry into the past directly via the exposed db handle, keeping
    // the same token so we can still fetch it by URL below.
    const currentToken = share.url.split('/').pop();
    await db.refreshShare(share.id, { token: currentToken, expiresAt: new Date(Date.now() - 1000).toISOString() });
    const updated = await db.getShareById(share.id);

    const res = await fetch(`${base}/public/shares/${updated.token}`);
    const resBody = await res.json();
    assert.equal(res.status, 403);
    assert.equal(resBody.error.code, 'EXPIRED');
  } finally {
    server.close();
  }
});

test('refreshing a share issues a new token; the old one 404s and the new one works', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'report-refresh@example.com', { insforge });
    const dataset = await uploadFixture(base, token, workspace.id, 'dashboard-sales.csv');
    const { body } = await generateReport(base, token, dataset.id, 'analytics_summary');
    const oldShare = body.data.share;

    const refreshRes = await fetch(`${base}/api/shares/${oldShare.id}/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const refreshBody = await refreshRes.json();
    const newShare = refreshBody.data.share;
    assert.notEqual(newShare.url, oldShare.url);

    const oldRes = await fetch(`${base}${oldShare.url}`);
    assert.equal(oldRes.status, 404);

    const newRes = await fetch(`${base}${newShare.url}`);
    assert.equal(newRes.status, 200);
  } finally {
    server.close();
  }
});

test('a user outside the workspace cannot list, refresh, or revoke its shares', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const owner = await signupAndGetSession(base, 'report-owner@example.com', { insforge });
    const outsider = await signupAndGetSession(base, 'report-outsider@example.com', { insforge });
    const dataset = await uploadFixture(base, owner.token, owner.workspace.id, 'dashboard-sales.csv');
    const { body } = await generateReport(base, owner.token, dataset.id, 'analytics_summary');
    const share = body.data.share;

    const listRes = await fetch(`${base}/api/workspaces/${owner.workspace.id}/shares`, {
      headers: { Authorization: `Bearer ${outsider.token}` },
    });
    assert.equal(listRes.status, 404);

    const refreshRes = await fetch(`${base}/api/shares/${share.id}/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${outsider.token}` },
    });
    assert.equal(refreshRes.status, 404);

    const revokeRes = await fetch(`${base}/api/shares/${share.id}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${outsider.token}` },
    });
    assert.equal(revokeRes.status, 404);
  } finally {
    server.close();
  }
});

test('the public share link needs no authentication at all', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'report-public@example.com', { insforge });
    const dataset = await uploadFixture(base, token, workspace.id, 'dashboard-sales.csv');
    const { body } = await generateReport(base, token, dataset.id, 'cleaned_dataset');
    const share = body.data.share;

    const res = await fetch(`${base}${share.url}`); // no Authorization header at all
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});
