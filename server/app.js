import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Shared error/success envelope, per Master Prompt §5.5:
//   { ok: true, data: {...} }
//   { ok: false, error: { code, message } }
function ok(res, data, status = 200) {
  return res.status(status).json({ ok: true, data });
}
function fail(res, status, code, message) {
  return res.status(status).json({ ok: false, error: { code, message } });
}

export function createApp(db, { jwtSecret }) {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));

  function issueToken(user) {
    return jwt.sign({ sub: user.id }, jwtSecret, { expiresIn: '7d' });
  }

  // Resolves the JWT into req.user. Every route that touches workspace-scoped
  // data requires this — there is no path to workspace data that skips it.
  function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return fail(res, 401, 'UNAUTHENTICATED', 'Missing bearer token.');
    try {
      const payload = jwt.verify(token, jwtSecret);
      const user = db.getUserById(payload.sub);
      if (!user) return fail(res, 401, 'UNAUTHENTICATED', 'User no longer exists.');
      req.user = user;
      next();
    } catch {
      return fail(res, 401, 'UNAUTHENTICATED', 'Invalid or expired token.');
    }
  }

  function publicUser(user) {
    return { id: user.id, email: user.email, display_name: user.display_name };
  }

  app.post('/api/auth/signup', async (req, res) => {
    const { email, password, display_name } = req.body || {};
    if (!email || !password) {
      return fail(res, 400, 'INVALID_INPUT', 'Email and password are required.');
    }
    if (password.length < 8) {
      return fail(res, 400, 'WEAK_PASSWORD', 'Password must be at least 8 characters.');
    }
    if (db.findUserByEmail(email)) {
      return fail(res, 409, 'EMAIL_TAKEN', 'An account with this email already exists.');
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = db.createUser({ email, passwordHash, displayName: display_name });

    // Auto-provision a personal workspace on first signup (§12).
    const workspace = db.createWorkspace({
      name: `${user.display_name}'s Workspace`,
      type: 'personal',
      ownerId: user.id,
    });
    db.addMember({ workspaceId: workspace.id, userId: user.id, role: 'owner' });

    const token = issueToken(user);
    return ok(res, { token, user: publicUser(user), workspace }, 201);
  });

  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return fail(res, 400, 'INVALID_INPUT', 'Email and password are required.');
    }
    const user = db.findUserByEmail(email);
    if (!user) return fail(res, 401, 'INVALID_CREDENTIALS', 'Incorrect email or password.');

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return fail(res, 401, 'INVALID_CREDENTIALS', 'Incorrect email or password.');

    const token = issueToken(user);
    return ok(res, { token, user: publicUser(user) });
  });

  app.get('/api/auth/me', requireAuth, (req, res) => {
    const workspaces = db.getWorkspacesForUser(req.user.id);
    return ok(res, { user: publicUser(req.user), workspaces });
  });

  app.get('/api/workspaces', requireAuth, (req, res) => {
    // Membership-filtered by construction — a user can never see a workspace
    // they don't belong to, mirroring the RLS policy in db/schema.sql.
    return ok(res, { workspaces: db.getWorkspacesForUser(req.user.id) });
  });

  app.post('/api/workspaces/:id/switch', requireAuth, (req, res) => {
    const workspace = db.getWorkspaceById(req.params.id);
    if (!workspace) return fail(res, 404, 'NOT_FOUND', 'Workspace not found.');
    if (!db.isMember(workspace.id, req.user.id)) {
      return fail(res, 403, 'FORBIDDEN', 'You are not a member of this workspace.');
    }
    return ok(res, { workspace });
  });

  return app;
}
