import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createStorage } from './storage.js';
import { cleanDataset, METHODOLOGY_VERSION as CLEAN_METHODOLOGY_VERSION } from './pipeline/clean-dataset.js';
import { detectColumns } from './pipeline/detect-columns.js';
import { parseSpreadsheet } from './pipeline/parse-spreadsheet.js';
import { computeKpis } from './pipeline/compute-kpis.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const DEFAULT_CONFIG = {
  maxUploadFileSizeMb: 25,
  maxUploadRowCount: 200000,
  allowedFileTypes: ['.csv', '.xlsx'],
};

// Shared error/success envelope, per Master Prompt §5.5:
//   { ok: true, data: {...} }
//   { ok: false, error: { code, message } }
function ok(res, data, status = 200) {
  return res.status(status).json({ ok: true, data });
}
function fail(res, status, code, message) {
  return res.status(status).json({ ok: false, error: { code, message } });
}

export function createApp(db, { jwtSecret, storage, config } = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const store = storage || createStorage(path.join(os.tmpdir(), 'verdant-bi-uploads', crypto.randomUUID()));

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

  // ── Datasets (Milestone 3: Upload & Clean) ──────────────────────────────

  const ALLOWED_ROLES = ['date', 'revenue', 'product', 'region', 'category', 'customer', 'quantity', 'order'];

  function withEffectiveRole(columnMap) {
    return {
      column_name: columnMap.column_name,
      detected_role: columnMap.detected_role,
      confidence: columnMap.confidence,
      user_override: columnMap.user_override,
      effective_role: columnMap.user_override ?? columnMap.detected_role,
    };
  }

  // Deliberately omits storage_path/file_hash — internal to the mock backend,
  // not something the client needs or should see.
  function datasetView(dataset) {
    return {
      id: dataset.id,
      workspace_id: dataset.workspace_id,
      file_name: dataset.file_name,
      row_count: dataset.row_count,
      column_count: dataset.column_count,
      status: dataset.status,
      failure_reason: dataset.failure_reason,
      cleaning_summary: dataset.cleaning_summary,
      methodology_version: dataset.methodology_version,
      uploaded_at: dataset.uploaded_at,
      columns: db.getColumnMaps(dataset.id).map(withEffectiveRole),
      preview_rows: db.getDatasetRowsPreview(dataset.id, 20),
    };
  }

  // A dataset lookup that isn't a member's own workspace responds 404, same
  // as "doesn't exist" — this avoids confirming another workspace's dataset
  // IDs even exist, consistent with the isolation boundary in §12/§14.
  function getAccessibleDataset(req) {
    const dataset = db.getDatasetById(req.params.id);
    if (!dataset || !db.isMember(dataset.workspace_id, req.user.id)) return null;
    return dataset;
  }

  const upload = multer({
    storage: multer.memoryStorage(),
    // busboy silently truncates (instead of raising LIMIT_FILE_SIZE) when
    // given a non-integer byte limit — always floor to a whole byte count.
    limits: { fileSize: Math.floor(cfg.maxUploadFileSizeMb * 1024 * 1024) },
  });

  function uploadMiddleware(req, res, next) {
    upload.single('file')(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return fail(res, 400, 'FILE_TOO_LARGE', `File exceeds the ${cfg.maxUploadFileSizeMb}MB limit.`);
      }
      return fail(res, 400, 'UPLOAD_ERROR', err.message);
    });
  }

  app.get('/api/config', (req, res) => {
    return ok(res, cfg);
  });

  app.post('/api/datasets/upload', requireAuth, uploadMiddleware, async (req, res) => {
    const { workspace_id } = req.body || {};
    if (!workspace_id) return fail(res, 400, 'INVALID_INPUT', 'workspace_id is required.');
    if (!db.isMember(workspace_id, req.user.id)) {
      return fail(res, 403, 'FORBIDDEN', 'You are not a member of this workspace.');
    }
    if (!req.file) return fail(res, 400, 'INVALID_INPUT', 'A file is required.');

    const fileName = req.file.originalname;
    const ext = path.extname(fileName).toLowerCase();
    if (!cfg.allowedFileTypes.includes(ext)) {
      return fail(res, 400, 'INVALID_FILE_TYPE', 'Only .csv and .xlsx files are supported.');
    }

    const buffer = req.file.buffer;
    // Never trust the extension alone — sniff the zip magic bytes (§5.1).
    const looksLikeZip = buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;
    if (ext === '.xlsx' && !looksLikeZip) {
      return fail(res, 400, 'INVALID_FILE_TYPE', 'This file does not look like a valid .xlsx file.');
    }
    if (ext === '.csv' && looksLikeZip) {
      return fail(res, 400, 'INVALID_FILE_TYPE', 'This file does not look like a valid .csv file.');
    }

    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

    // Idempotent re-upload (§5.1): same workspace + same content -> the
    // existing dataset, never a duplicate.
    const existing = db.findDatasetByHash(workspace_id, fileHash);
    if (existing) {
      return ok(res, { dataset: datasetView(existing), alreadyExists: true });
    }

    let parsed;
    try {
      parsed = await parseSpreadsheet(buffer, fileName);
    } catch {
      return fail(res, 400, 'PARSE_ERROR', 'Could not read this file — it may be corrupted.');
    }

    if (parsed.rows.length > cfg.maxUploadRowCount) {
      return fail(
        res,
        400,
        'ROW_LIMIT_EXCEEDED',
        `This file has more than ${cfg.maxUploadRowCount} rows. Please pre-aggregate it and try again.`
      );
    }

    const storagePath = store.saveUpload(buffer, { workspaceId: workspace_id, fileHash, fileName });
    const dataset = db.createDataset({
      workspaceId: workspace_id,
      fileName,
      fileHash,
      storagePath,
      uploadedBy: req.user.id,
    });

    try {
      const { headers, rows, summary } = cleanDataset(parsed.headers, parsed.rows);
      const columns = detectColumns(headers, rows);

      db.saveDatasetRows(dataset.id, rows);
      db.setColumnMaps(dataset.id, columns);
      db.updateDataset(dataset.id, {
        status: 'ready',
        row_count: summary.final_row_count,
        column_count: summary.final_column_count,
        cleaning_summary: summary,
        methodology_version: CLEAN_METHODOLOGY_VERSION,
      });
    } catch (err) {
      // Structured error logging (§14.1) — the only debugging signal once
      // this runs as a real deployed edge function with no local terminal.
      console.error(
        JSON.stringify({
          function: 'clean-dataset',
          workspace_id,
          dataset_id: dataset.id,
          error_message: err.message,
          timestamp: new Date().toISOString(),
        })
      );
      db.updateDataset(dataset.id, { status: 'failed', failure_reason: err.message });
    }

    return ok(res, { dataset: datasetView(db.getDatasetById(dataset.id)) }, 201);
  });

  app.get('/api/datasets', requireAuth, (req, res) => {
    const workspaceId = req.query.workspace_id;
    if (!workspaceId) return fail(res, 400, 'INVALID_INPUT', 'workspace_id is required.');
    if (!db.isMember(workspaceId, req.user.id)) {
      return fail(res, 403, 'FORBIDDEN', 'You are not a member of this workspace.');
    }
    return ok(res, { datasets: db.listDatasetsForWorkspace(workspaceId).map(datasetView) });
  });

  app.get('/api/datasets/:id', requireAuth, (req, res) => {
    const dataset = getAccessibleDataset(req);
    if (!dataset) return fail(res, 404, 'NOT_FOUND', 'Dataset not found.');
    return ok(res, { dataset: datasetView(dataset) });
  });

  app.get('/api/datasets/:id/columns', requireAuth, (req, res) => {
    const dataset = getAccessibleDataset(req);
    if (!dataset) return fail(res, 404, 'NOT_FOUND', 'Dataset not found.');
    return ok(res, { columns: db.getColumnMaps(dataset.id).map(withEffectiveRole) });
  });

  app.post('/api/datasets/:id/columns/:column_name/override', requireAuth, (req, res) => {
    const dataset = getAccessibleDataset(req);
    if (!dataset) return fail(res, 404, 'NOT_FOUND', 'Dataset not found.');

    const { role } = req.body || {};
    if (role !== null && role !== undefined && !ALLOWED_ROLES.includes(role)) {
      return fail(res, 400, 'INVALID_INPUT', `role must be one of: ${ALLOWED_ROLES.join(', ')}, or null to clear.`);
    }
    const updated = db.setColumnOverride(dataset.id, req.params.column_name, role ?? null);
    if (!updated) return fail(res, 404, 'NOT_FOUND', 'Column not found on this dataset.');
    return ok(res, { column: withEffectiveRole(updated) });
  });

  app.delete('/api/datasets/:id', requireAuth, (req, res) => {
    const dataset = getAccessibleDataset(req);
    if (!dataset) return fail(res, 404, 'NOT_FOUND', 'Dataset not found.');
    store.deleteUpload(dataset.storage_path);
    db.deleteDataset(dataset.id);
    return ok(res, { deleted: true });
  });

  // ── KPI Dashboard (Milestone 4) ──────────────────────────────────────────

  app.get('/api/datasets/:id/kpis', requireAuth, (req, res) => {
    const dataset = getAccessibleDataset(req);
    if (!dataset) return fail(res, 404, 'NOT_FOUND', 'Dataset not found.');
    if (dataset.status !== 'ready') {
      return fail(res, 409, 'NOT_READY', `Dataset is ${dataset.status}, not ready.`);
    }

    const columns = db.getColumnMaps(dataset.id).map(withEffectiveRole);
    const rows = db.getAllDatasetRows(dataset.id);
    const { start_date, end_date, region } = req.query;

    const kpis = computeKpis(columns, rows, { startDate: start_date, endDate: end_date, region });
    return ok(res, { kpis });
  });

  return app;
}
