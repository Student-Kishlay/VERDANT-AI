import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../server/db.js';
import { createApp } from '../server/app.js';

async function startServer() {
  const db = createDb(null); // in-memory, no disk persistence for tests
  const app = createApp(db, { jwtSecret: 'test-secret' });
  const server = app.listen(0);
  const { port } = server.address();
  return { server, base: `http://localhost:${port}` };
}

test('signup -> login -> /auth/me returns the correct user and workspace', async () => {
  const { server, base } = await startServer();
  try {
    const signup = await fetch(`${base}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'password123', display_name: 'Alice' }),
    });
    const signupBody = await signup.json();
    assert.equal(signup.status, 201);
    assert.equal(signupBody.ok, true);
    assert.equal(signupBody.data.user.email, 'alice@example.com');
    assert.equal(signupBody.data.workspace.type, 'personal');

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'password123' }),
    });
    const loginBody = await login.json();
    assert.equal(login.status, 200);
    assert.ok(loginBody.data.token);

    const me = await fetch(`${base}/api/auth/me`, {
      headers: { Authorization: `Bearer ${loginBody.data.token}` },
    });
    const meBody = await me.json();
    assert.equal(me.status, 200);
    assert.equal(meBody.data.user.email, 'alice@example.com');
    assert.equal(meBody.data.workspaces.length, 1);
    assert.equal(meBody.data.workspaces[0].role, 'owner');
  } finally {
    server.close();
  }
});

test('login with wrong password is rejected', async () => {
  const { server, base } = await startServer();
  try {
    await fetch(`${base}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bob@example.com', password: 'correct-password' }),
    });

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bob@example.com', password: 'wrong-password' }),
    });
    const body = await login.json();
    assert.equal(login.status, 401);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'INVALID_CREDENTIALS');
  } finally {
    server.close();
  }
});

test('duplicate signup email is rejected', async () => {
  const { server, base } = await startServer();
  try {
    const payload = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'dup@example.com', password: 'password123' }),
    };
    await fetch(`${base}/api/auth/signup`, payload);
    const second = await fetch(`${base}/api/auth/signup`, payload);
    const body = await second.json();
    assert.equal(second.status, 409);
    assert.equal(body.error.code, 'EMAIL_TAKEN');
  } finally {
    server.close();
  }
});
