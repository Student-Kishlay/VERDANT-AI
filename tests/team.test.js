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

async function listMyInvitations(base, token) {
  const res = await fetch(`${base}/api/invitations`, { headers: { Authorization: `Bearer ${token}` } });
  return (await res.json()).data.invitations;
}

async function respond(base, token, invitationId, action) {
  const res = await fetch(`${base}/api/invitations/${invitationId}/${action}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json() };
}

// Invite + the invitee accepting — what used to happen implicitly.
async function inviteAndAccept(base, ownerToken, workspaceId, invitee) {
  const { body } = await invite(base, ownerToken, workspaceId, invitee.user.email);
  return respond(base, invitee.token, body.data.invitation.id, 'accept');
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

test('inviting an already-registered email does not add them until they accept', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const owner = await signupAndGetSession(base, 'team-owner1@example.com', { insforge });
    const existingUser = await signupAndGetSession(base, 'team-existing@example.com', { insforge });
    const workspace = await createTeamWorkspace(base, owner.token, 'Acme Corp');

    const { status, body } = await invite(base, owner.token, workspace.id, 'team-existing@example.com');
    assert.equal(status, 201);
    assert.equal(body.data.status, 'pending');
    assert.equal(body.data.email_sent, true);

    const sent = insforge.sentEmails.find((e) => e.to === 'team-existing@example.com');
    assert.ok(sent);
    assert.ok(sent.html.includes(`/team.html?invite=${body.data.invitation.id}`));

    const { body: before } = await getMembers(base, owner.token, workspace.id);
    assert.equal(before.data.members.length, 1);
    assert.equal(before.data.pending_invitations.length, 1);

    const mine = await listMyInvitations(base, existingUser.token);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].workspace_name, 'Acme Corp');

    const accepted = await respond(base, existingUser.token, mine[0].id, 'accept');
    assert.equal(accepted.status, 200);

    const { body: after } = await getMembers(base, owner.token, workspace.id);
    const member = after.data.members.find((m) => m.email === 'team-existing@example.com');
    assert.ok(member);
    assert.equal(member.role, 'member');
    assert.equal(after.data.pending_invitations.length, 0);

    const meRes = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${existingUser.token}` } });
    assert.ok((await meRes.json()).data.workspaces.some((w) => w.id === workspace.id));
  } finally {
    server.close();
  }
});

test('a non-registered invitee is not auto-joined on signup and must accept', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const owner = await signupAndGetSession(base, 'team-owner2@example.com', { insforge });
    const workspace = await createTeamWorkspace(base, owner.token, 'Acme Corp');
    await invite(base, owner.token, workspace.id, 'future-member@example.com');

    const newUser = await signupAndGetSession(base, 'future-member@example.com', { insforge });
    const meRes = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${newUser.token}` } });
    assert.ok(!(await meRes.json()).data.workspaces.some((w) => w.id === workspace.id));

    const [inv] = await listMyInvitations(base, newUser.token);
    const { status, body } = await respond(base, newUser.token, inv.id, 'accept');
    assert.equal(status, 200);
    assert.equal(body.data.workspace.id, workspace.id);

    const { body: membersAfter } = await getMembers(base, owner.token, workspace.id);
    assert.equal(membersAfter.data.members.length, 2);
    assert.equal(membersAfter.data.pending_invitations.length, 0);
  } finally {
    server.close();
  }
});

test('only the invited email can accept an invitation', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const owner = await signupAndGetSession(base, 'team-owner7@example.com', { insforge });
    const intruder = await signupAndGetSession(base, 'intruder@example.com', { insforge });
    const workspace = await createTeamWorkspace(base, owner.token, 'Acme Corp');
    const { body } = await invite(base, owner.token, workspace.id, 'invitee7@example.com');
    const invitationId = body.data.invitation.id;

    assert.equal((await respond(base, intruder.token, invitationId, 'accept')).status, 404);
    assert.equal((await respond(base, owner.token, invitationId, 'accept')).status, 404);
    const { body: members } = await getMembers(base, owner.token, workspace.id);
    assert.equal(members.data.members.length, 1);
  } finally {
    server.close();
  }
});

test('declining an invitation removes it and it cannot be accepted afterwards', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const owner = await signupAndGetSession(base, 'team-owner8@example.com', { insforge });
    const invitee = await signupAndGetSession(base, 'invitee8@example.com', { insforge });
    const workspace = await createTeamWorkspace(base, owner.token, 'Acme Corp');
    const { body } = await invite(base, owner.token, workspace.id, 'invitee8@example.com');
    const invitationId = body.data.invitation.id;

    assert.equal((await respond(base, invitee.token, invitationId, 'decline')).status, 200);
    assert.equal((await listMyInvitations(base, invitee.token)).length, 0);
    assert.equal((await respond(base, invitee.token, invitationId, 'accept')).status, 409);
  } finally {
    server.close();
  }
});

test('inviting someone who is already a member is rejected', async () => {
  const { server, base, insforge } = await startServer();
  try {
    const owner = await signupAndGetSession(base, 'team-owner9@example.com', { insforge });
    const member = await signupAndGetSession(base, 'member9@example.com', { insforge });
    const workspace = await createTeamWorkspace(base, owner.token, 'Acme Corp');
    await inviteAndAccept(base, owner.token, workspace.id, member);

    const { status, body } = await invite(base, owner.token, workspace.id, 'member9@example.com');
    assert.equal(status, 409);
    assert.equal(body.error.code, 'ALREADY_MEMBER');
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
    await inviteAndAccept(base, owner.token, workspace.id, member);

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
    await inviteAndAccept(base, owner.token, workspace.id, member);
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
    await inviteAndAccept(base, owner.token, workspace.id, member);
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
    await inviteAndAccept(base, ownerA.token, workspaceA.id, memberA);

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
