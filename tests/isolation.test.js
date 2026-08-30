import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, signupAndGetSession } from './helpers.js';

// Mirrors the Master Prompt §17 Milestone 1 criterion: "SELECT from any
// workspace-scoped table as a non-member returns zero rows" — adapted to the
// mock's HTTP surface since there is no direct SQL access here.
test('a user cannot see or switch into a workspace they are not a member of', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const alice = await signupAndGetSession(base, 'alice-iso@example.com', { insforge });
    const bob = await signupAndGetSession(base, 'bob-iso@example.com', { insforge });

    // Bob's own workspace list must not contain Alice's workspace.
    const bobWorkspaces = await fetch(`${base}/api/workspaces`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    }).then((r) => r.json());
    const leaked = bobWorkspaces.data.workspaces.some((w) => w.id === alice.workspace.id);
    assert.equal(leaked, false);
    assert.equal(bobWorkspaces.data.workspaces.length, 1);

    // Bob attempting to switch into Alice's workspace id directly is forbidden.
    const switchAttempt = await fetch(`${base}/api/workspaces/${alice.workspace.id}/switch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.token}` },
    });
    const switchBody = await switchAttempt.json();
    assert.equal(switchAttempt.status, 403);
    assert.equal(switchBody.error.code, 'FORBIDDEN');
  } finally {
    server.close();
  }
});

test('requests without a valid token are rejected before touching workspace data', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const res = await fetch(`${base}/api/workspaces`);
    const body = await res.json();
    assert.equal(res.status, 401);
    assert.equal(body.error.code, 'UNAUTHENTICATED');
  } finally {
    server.close();
  }
});
