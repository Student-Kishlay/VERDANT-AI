import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, signupAndGetSession } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

async function createTeamWorkspace(base, token, name) {
  const res = await fetch(`${base}/api/workspaces`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return (await res.json()).data.workspace;
}

async function invite(base, token, workspaceId, email) {
  const res = await fetch(`${base}/api/workspaces/${workspaceId}/invitations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  return { status: res.status, body: await res.json() };
}

async function getMembers(base, token, workspaceId) {
  const res = await fetch(`${base}/api/workspaces/${workspaceId}/members`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json() };
}

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

test('creating a team workspace makes the creator its owner', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const { token } = await signupAndGetSession(base, 'team-creator@example.com', { insforge });
    const workspace = await createTeamWorkspace(base, token, 'Acme Corp');
    assert.equal(workspace.type, 'team');
    assert.equal(workspace.role, 'owner');
  } finally {
    server.close();
  }
});

test('inviting an already-registered email grants immediate membership', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const owner = await signupAndGetSession(base, 'team-owner1@example.com', { insforge });
    const existingUser = await signupAndGetSession(base, 'team-existing@example.com', { insforge });
    const workspace = await createTeamWorkspace(base, owner.token, 'Acme Corp');

    const { status, body } = await invite(base, owner.token, workspace.id, 'team-existing@example.com');
    assert.equal(status, 201);
    assert.equal(body.data.status, 'joined');

    const { body: membersBody } = await getMembers(base, owner.token, workspace.id);
    const member = membersBody.data.members.find((m) => m.email === 'team-existing@example.com');
    assert.ok(member);
    assert.equal(member.role, 'member');

    // The invited user should now actually see the workspace themselves.
    const meRes = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${existingUser.token}` } });
    const meBody = await meRes.json();
    assert.ok(meBody.data.workspaces.some((w) => w.id === workspace.id));
  } finally {
    server.close();
  }
});

test('inviting a non-registered email creates a pending invitation that converts to membership on signup', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const owner = await signupAndGetSession(base, 'team-owner2@example.com', { insforge });
    const workspace = await createTeamWorkspace(base, owner.token, 'Acme Corp');

    const { status, body } = await invite(base, owner.token, workspace.id, 'future-member@example.com');
    assert.equal(status, 201);
    assert.equal(body.data.status, 'pending');

    const { body: membersBefore } = await getMembers(base, owner.token, workspace.id);
    assert.equal(membersBefore.data.pending_invitations.length, 1);
    assert.equal(membersBefore.data.members.length, 1); // just the owner so far

    // Now the invited email signs up.
    const newUser = await signupAndGetSession(base, 'future-member@example.com', { insforge });
    const meRes = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${newUser.token}` } });
    const meBody = await meRes.json();
    const membership = meBody.data.workspaces.find((w) => w.id === workspace.id);
    assert.ok(membership);
    assert.equal(membership.role, 'member');

    const { body: membersAfter } = await getMembers(base, owner.token, workspace.id);
    assert.equal(membersAfter.data.pending_invitations.length, 0);
    assert.equal(membersAfter.data.members.length, 2);
  } finally {
    server.close();
  }
});

test('a non-owner member cannot invite others', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const owner = await signupAndGetSession(base, 'team-owner3@example.com', { insforge });
    const member = await signupAndGetSession(base, 'team-member3@example.com', { insforge });
    const workspace = await createTeamWorkspace(base, owner.token, 'Acme Corp');
    await invite(base, owner.token, workspace.id, 'team-member3@example.com');

    const { status, body } = await invite(base, member.token, workspace.id, 'someone-else@example.com');
    assert.equal(status, 403);
    assert.equal(body.error.code, 'FORBIDDEN');
  } finally {
    server.close();
  }
});

test('a non-owner member cannot delete a dataset in that workspace', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const owner = await signupAndGetSession(base, 'team-owner4@example.com', { insforge });
    const member = await signupAndGetSession(base, 'team-member4@example.com', { insforge });
    const workspace = await createTeamWorkspace(base, owner.token, 'Acme Corp');
    await invite(base, owner.token, workspace.id, 'team-member4@example.com');
    const dataset = await uploadFixture(base, owner.token, workspace.id, 'dashboard-sales.csv');

    const res = await fetch(`${base}/api/datasets/${dataset.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${member.token}` },
    });
    const body = await res.json();
    assert.equal(res.status, 403);
    assert.equal(body.error.code, 'FORBIDDEN');
  } finally {
    server.close();
  }
});

test('a non-owner member cannot revoke or refresh a share in that workspace', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const owner = await signupAndGetSession(base, 'team-owner5@example.com', { insforge });
    const member = await signupAndGetSession(base, 'team-member5@example.com', { insforge });
    const workspace = await createTeamWorkspace(base, owner.token, 'Acme Corp');
    await invite(base, owner.token, workspace.id, 'team-member5@example.com');
    const dataset = await uploadFixture(base, owner.token, workspace.id, 'dashboard-sales.csv');

    const genRes = await fetch(`${base}/api/datasets/${dataset.id}/reports`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ report_type: 'analytics_summary' }),
    });
    const share = (await genRes.json()).data.share;

    const revokeRes = await fetch(`${base}/api/shares/${share.id}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${member.token}` },
    });
    assert.equal(revokeRes.status, 403);

    const refreshRes = await fetch(`${base}/api/shares/${share.id}/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${member.token}` },
    });
    assert.equal(refreshRes.status, 403);
  } finally {
    server.close();
  }
});

test('a member of workspace A querying workspace B dataset directly gets zero rows', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const ownerA = await signupAndGetSession(base, 'team-ownerA@example.com', { insforge });
    const memberA = await signupAndGetSession(base, 'team-memberA@example.com', { insforge });
    const workspaceA = await createTeamWorkspace(base, ownerA.token, 'Team A');
    await invite(base, ownerA.token, workspaceA.id, 'team-memberA@example.com');

    const ownerB = await signupAndGetSession(base, 'team-ownerB@example.com', { insforge });
    const workspaceB = await createTeamWorkspace(base, ownerB.token, 'Team B');
    const datasetB = await uploadFixture(base, ownerB.token, workspaceB.id, 'dashboard-sales.csv');

    const res = await fetch(`${base}/api/datasets/${datasetB.id}`, {
      headers: { Authorization: `Bearer ${memberA.token}` },
    });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('inviting the same unregistered email twice does not create duplicate invitations', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const owner = await signupAndGetSession(base, 'team-owner6@example.com', { insforge });
    const workspace = await createTeamWorkspace(base, owner.token, 'Acme Corp');

    await invite(base, owner.token, workspace.id, 'dupe@example.com');
    await invite(base, owner.token, workspace.id, 'dupe@example.com');

    const { body } = await getMembers(base, owner.token, workspace.id);
    assert.equal(body.data.pending_invitations.length, 1);
  } finally {
    server.close();
  }
});
