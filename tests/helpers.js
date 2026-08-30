import { createDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { createFakeInsforge } from './fake-insforge.js';
import { createFakeStorage } from './fake-storage.js';

// Shared by tests that need a live HTTP server (not just direct db/app
// imports) — each call gets an isolated in-memory db, a fresh fake InsForge
// backend (see fake-insforge.js — auth/workspaces/datasets/analytics all
// live on real InsForge in production, but tests can't depend on a
// network-reachable external project) and fake storage (fake-storage.js),
// so tests never see each other's data and never touch the network.
export async function startServer(configOverrides = {}) {
  const insforge = createFakeInsforge();
  const db = createDb(insforge);
  const storage = createFakeStorage();
  const reportStorage = createFakeStorage();
  const app = createApp(db, {
    insforge,
    storage,
    reportStorage,
    config: { maxUploadFileSizeMb: 25, maxUploadRowCount: 200000, defaultShareLinkExpiryDays: 7, ...configOverrides },
  });
  const server = app.listen(0);
  const { port } = server.address();
  return { server, db, insforge, base: `http://localhost:${port}` };
}

// Simulates the browser flow (real InsForge signUp, then this app's own
// self-provisioning /api/auth/me) without a network round-trip: the fake
// client's _testSignUp stands in for InsForge issuing a real session.
export async function signupAndGetSession(base, email, { insforge } = {}) {
  if (!insforge) throw new Error('signupAndGetSession now requires the { insforge } fake from startServer()');
  const { accessToken } = insforge._testSignUp(email, email.split('@')[0]);

  const res = await fetch(`${base}/api/auth/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`session bootstrap failed: ${body.error?.message}`);
  return { token: accessToken, user: body.data.user, workspace: body.data.workspaces[0] };
}
