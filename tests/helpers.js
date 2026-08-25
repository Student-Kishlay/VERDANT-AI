import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { createStorage } from '../server/storage.js';

// Shared by tests that need a live HTTP server (not just direct db/app
// imports) — each call gets an isolated in-memory db and a scratch upload
// directory so tests never see each other's data.
export async function startServer(configOverrides = {}) {
  const db = createDb(null);
  const storage = createStorage(path.join(os.tmpdir(), 'verdant-bi-test-uploads', crypto.randomUUID()));
  const reportStorage = createStorage(path.join(os.tmpdir(), 'verdant-bi-test-reports', crypto.randomUUID()));
  const app = createApp(db, {
    jwtSecret: 'test-secret',
    storage,
    reportStorage,
    config: { maxUploadFileSizeMb: 25, maxUploadRowCount: 200000, defaultShareLinkExpiryDays: 7, ...configOverrides },
  });
  const server = app.listen(0);
  const { port } = server.address();
  return { server, db, base: `http://localhost:${port}` };
}

export async function signupAndGetSession(base, email) {
  const res = await fetch(`${base}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123', display_name: email.split('@')[0] }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`signup failed: ${body.error?.message}`);
  return body.data; // { token, user, workspace }
}
