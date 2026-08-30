import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, signupAndGetSession } from './helpers.js';

// Signup/login themselves now happen on InsForge directly (public/js/
// insforge-client.js calls insforge.auth.* — see db/insforge-schema.sql and
// server/insforge.js). What this server still owns is: verifying the
// InsForge access token, and self-provisioning a personal workspace the
// first time a signed-in user has none (server/app.js's /api/auth/me).

test('first /api/auth/me call self-provisions a personal workspace', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const { token, user, workspace } = await signupAndGetSession(base, 'alice@example.com', { insforge });
    assert.equal(user.email, 'alice@example.com');
    assert.equal(workspace.type, 'personal');
    assert.equal(workspace.role, 'owner');

    const me = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    const meBody = await me.json();
    assert.equal(me.status, 200);
    assert.equal(meBody.data.user.email, 'alice@example.com');
    assert.equal(meBody.data.workspaces.length, 1);
    assert.equal(meBody.data.workspaces[0].role, 'owner');
  } finally {
    server.close();
  }
});

test('calling /api/auth/me twice does not create a second workspace', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const { token } = await signupAndGetSession(base, 'idempotent@example.com', { insforge });
    const me = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    const meBody = await me.json();
    assert.equal(meBody.data.workspaces.length, 1);
  } finally {
    server.close();
  }
});

test('a pending invitation for the user\'s email is accepted on first /api/auth/me call', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const owner = await signupAndGetSession(base, 'invite-owner@example.com', { insforge });
    const inviteRes = await fetch(`${base}/api/workspaces/${owner.workspace.id}/invitations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'invited@example.com' }),
    });
    const inviteBody = await inviteRes.json();
    assert.equal(inviteBody.data.status, 'pending');

    const { token } = await signupAndGetSession(base, 'invited@example.com', { insforge });
    const me = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    const meBody = await me.json();
    // Their own personal workspace, plus the one they were invited to.
    assert.equal(meBody.data.workspaces.length, 2);
    const invitedWorkspace = meBody.data.workspaces.find((w) => w.id === owner.workspace.id);
    assert.equal(invitedWorkspace.role, 'member');
  } finally {
    server.close();
  }
});

test('requireAuth rejects a missing bearer token', async () => {
  const { server, base } = await startServer();
  try {
    const res = await fetch(`${base}/api/auth/me`);
    const body = await res.json();
    assert.equal(res.status, 401);
    assert.equal(body.error.code, 'UNAUTHENTICATED');
  } finally {
    server.close();
  }
});

test('requireAuth rejects an invalid/malformed token', async () => {
  const { server, base } = await startServer();
  try {
    const res = await fetch(`${base}/api/auth/me`, { headers: { Authorization: 'Bearer not-a-real-token' } });
    const body = await res.json();
    assert.equal(res.status, 401);
    assert.equal(body.error.code, 'UNAUTHENTICATED');
  } finally {
    server.close();
  }
});
