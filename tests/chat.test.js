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

async function sendChat(base, token, workspaceId, datasetId, message) {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace_id: workspaceId, dataset_id: datasetId, message }),
  });
  return { status: res.status, body: await res.json() };
}

async function getHistory(base, token, workspaceId, datasetId) {
  const res = await fetch(`${base}/api/chat?workspace_id=${workspaceId}&dataset_id=${datasetId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json() };
}

test('a grounded revenue question returns the exact correct number', async () => {
  const { server, base } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'chat-revenue@example.com');
    const dataset = await uploadFixture(base, token, workspace.id, 'dashboard-sales.csv');

    const { status, body } = await sendChat(base, token, workspace.id, dataset.id, 'What is the total revenue?');
    assert.equal(status, 201);
    assert.match(body.data.message.content, /5,500\.00/);
    assert.equal(body.data.message.grounding_status, 'n/a'); // no chart proposed for this question
  } finally {
    server.close();
  }
});

test('a category-breakdown question returns a verified chart matching real categories', async () => {
  const { server, base } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'chat-category@example.com');
    const dataset = await uploadFixture(base, token, workspace.id, 'dashboard-sales.csv');

    const { body } = await sendChat(base, token, workspace.id, dataset.id, 'Show me revenue by category');
    assert.equal(body.data.message.grounding_status, 'verified');
    assert.ok(body.data.message.chart_payload);
    assert.deepEqual(
      [...body.data.message.chart_payload.labels].sort(),
      ['Apparel', 'Electronics', 'Grocery'].sort()
    );
  } finally {
    server.close();
  }
});

test('conversation history persists and is retrievable in order', async () => {
  const { server, base } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'chat-history@example.com');
    const dataset = await uploadFixture(base, token, workspace.id, 'dashboard-sales.csv');

    await sendChat(base, token, workspace.id, dataset.id, 'hello');
    await sendChat(base, token, workspace.id, dataset.id, 'What is the total revenue?');

    const { status, body } = await getHistory(base, token, workspace.id, dataset.id);
    assert.equal(status, 200);
    // 2 user messages + 2 assistant replies, in order
    assert.equal(body.data.messages.length, 4);
    assert.deepEqual(body.data.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  } finally {
    server.close();
  }
});

test('a message beyond the per-hour limit is rejected with a clear error', async () => {
  const { server, base } = await startServer({ aiChatMaxMessagesPerWorkspacePerHour: 2 });
  try {
    const { token, workspace } = await signupAndGetSession(base, 'chat-ratelimit@example.com');
    const dataset = await uploadFixture(base, token, workspace.id, 'dashboard-sales.csv');

    await sendChat(base, token, workspace.id, dataset.id, 'hello');
    await sendChat(base, token, workspace.id, dataset.id, 'hello again');
    const third = await sendChat(base, token, workspace.id, dataset.id, 'one too many');

    assert.equal(third.status, 429);
    assert.equal(third.body.error.code, 'RATE_LIMITED');
    assert.match(third.body.error.message, /try again/i);
  } finally {
    server.close();
  }
});

test('an unmatched question gives an honest fallback rather than a guess', async () => {
  const { server, base } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'chat-fallback@example.com');
    const dataset = await uploadFixture(base, token, workspace.id, 'dashboard-sales.csv');

    const { body } = await sendChat(base, token, workspace.id, dataset.id, 'what is the meaning of life');
    assert.match(body.data.message.content, /I can help with questions about/);
  } finally {
    server.close();
  }
});

test('a user outside the workspace cannot read or post to its chat', async () => {
  const { server, base } = await startServer();
  try {
    const owner = await signupAndGetSession(base, 'chat-owner@example.com');
    const outsider = await signupAndGetSession(base, 'chat-outsider@example.com');
    const dataset = await uploadFixture(base, owner.token, owner.workspace.id, 'dashboard-sales.csv');

    const historyRes = await getHistory(base, outsider.token, owner.workspace.id, dataset.id);
    assert.equal(historyRes.status, 404);

    const sendRes = await sendChat(base, outsider.token, owner.workspace.id, dataset.id, 'hello');
    assert.equal(sendRes.status, 404);
  } finally {
    server.close();
  }
});

test('a chat message containing an XSS payload is stored as-is (sanitization is a render-time concern)', async () => {
  const { server, base } = await startServer();
  try {
    const { token, workspace } = await signupAndGetSession(base, 'chat-xss@example.com');
    const dataset = await uploadFixture(base, token, workspace.id, 'dashboard-sales.csv');

    const payload = '<img src=x onerror=alert(1)>';
    await sendChat(base, token, workspace.id, dataset.id, payload);
    const { body } = await getHistory(base, token, workspace.id, dataset.id);
    const userMessage = body.data.messages.find((m) => m.role === 'user');
    assert.equal(userMessage.content, payload);
  } finally {
    server.close();
  }
});

test('GET /api/config never exposes the Groq API key', async () => {
  const { server, base } = await startServer({ groqApiKey: 'super-secret-value-should-not-leak' });
  try {
    const res = await fetch(`${base}/api/config`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.data.groqApiKey, undefined);
    assert.ok(!JSON.stringify(body).includes('super-secret-value-should-not-leak'));
  } finally {
    server.close();
  }
});
