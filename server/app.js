import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cleanDataset, METHODOLOGY_VERSION as CLEAN_METHODOLOGY_VERSION } from './pipeline/clean-dataset.js';
import { detectColumns } from './pipeline/detect-columns.js';
import { parseSpreadsheet } from './pipeline/parse-spreadsheet.js';
import { computeKpis } from './pipeline/compute-kpis.js';
import { forecastRevenue } from './pipeline/forecast-revenue.js';
import { segmentCustomers } from './pipeline/segment-customers.js';
import { detectAnomalies } from './pipeline/detect-anomalies.js';
import { buildContextSummary } from './pipeline/build-context-summary.js';
import { verifyChartGrounding } from './pipeline/verify-chart-grounding.js';
import { verifyReplyNumbers } from './pipeline/verify-reply-numbers.js';
import { getProvider } from './llm/index.js';
import { createChatTools } from './llm/chat-tools.js';
import { createRateLimiter } from './rate-limiter.js';
import { generateReport, REPORT_TYPES } from './pipeline/generate-report.js';

// import.meta.url is undefined when bundled as CommonJS (Netlify Functions);
// there the CDN serves public/, so the fallback path is never hit.
const PUBLIC_DIR = import.meta.url
  ? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
  : path.join(process.cwd(), 'public');

const DEFAULT_CONFIG = {
  maxUploadFileSizeMb: 25,
  maxUploadRowCount: 200000,
  allowedFileTypes: ['.csv', '.xlsx'],
  anomalyContaminationRate: 0.05,
  aiProvider: 'mock',
  groqApiKey: '',
  // Public by design — an anon key is meant for client-side use (same as
  // Supabase's), never a secret. The service-role key stays server-only.
  insforgeBaseUrl: '',
  insforgeAnonKey: '',
  groqModel: 'llama-3.3-70b-versatile',
  chartGroundingThreshold: 0.6,
  aiChatMaxMessagesPerWorkspacePerHour: 60,
  aiChatMaxContextTokens: 4000,
  defaultShareLinkExpiryDays: 7,
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

export function createApp(db, { insforge, storage, reportStorage, config } = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const store = storage;
  const reportStore = reportStorage;
  const chatRateLimiter = createRateLimiter();

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));

  // Every route here that talks to InsForge can now fail on a real network
  // error, not just a bug — and Express 4 doesn't catch a rejected promise
  // from an async handler, so an uncaught one becomes an unhandled
  // rejection that crashes the whole process, taking down every other
  // request in flight. Wrap route registration once here so every async
  // handler's rejection is forwarded to the error middleware below instead.
  for (const method of ['get', 'post', 'put', 'delete', 'patch']) {
    const original = app[method].bind(app);
    app[method] = (routePath, ...handlers) =>
      original(
        routePath,
        ...handlers.map((fn) =>
          fn.constructor.name === 'AsyncFunction' ? (req, res, next) => fn(req, res, next).catch(next) : fn
        )
      );
  }

  // Auth now happens entirely on InsForge (public/js/insforge-client.js
  // calls insforge.auth.* directly) — this only verifies the InsForge
  // access token the browser sends and reads its claims. There is no local
  // signup/login route anymore, and no DB lookup here: sub/email come
  // straight out of the verified JWT.
  function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return fail(res, 401, 'UNAUTHENTICATED', 'Missing bearer token.');
    try {
      const payload = insforge.verifyToken(token);
      req.user = { id: payload.sub, email: payload.email };
      next();
    } catch {
      return fail(res, 401, 'UNAUTHENTICATED', 'Invalid or expired token.');
    }
  }

  function publicUser(user, displayName) {
    return { id: user.id, email: user.email, display_name: displayName || user.email.split('@')[0] };
  }

  // Self-provisioning: the first time a signed-in user has zero workspaces
  // (i.e. right after their first InsForge signup), give them a personal
  // workspace. Pending invitations are NOT auto-accepted here — the invitee
  // has to accept each one explicitly (POST /api/invitations/:id/accept).
  app.get('/api/auth/me', requireAuth, async (req, res) => {
    const profile = await db.getUserById(req.user.id);
    const displayName = profile?.profile?.name || req.user.email.split('@')[0];
    let workspaces = await db.getWorkspacesForUser(req.user.id);

    if (workspaces.length === 0) {
      const workspace = await db.createWorkspace({
        name: `${displayName}'s Workspace`,
        type: 'personal',
        ownerId: req.user.id,
      });
      await db.addMember({ workspaceId: workspace.id, userId: req.user.id, role: 'owner' });
      workspaces = await db.getWorkspacesForUser(req.user.id);
    }

    return ok(res, { user: publicUser(req.user, displayName), workspaces });
  });

  app.get('/api/workspaces', requireAuth, async (req, res) => {
    // Membership-filtered by construction — a user can never see a workspace
    // they don't belong to, mirroring the RLS policy in db/insforge-schema.sql.
    return ok(res, { workspaces: await db.getWorkspacesForUser(req.user.id) });
  });

  app.get('/api/workspaces/:id/stats', requireAuth, async (req, res) => {
    if (!(await db.isMember(req.params.id, req.user.id))) {
      return fail(res, 404, 'NOT_FOUND', 'Workspace not found.');
    }
    return ok(res, { stats: await db.getWorkspaceStats(req.params.id) });
  });

  app.post('/api/workspaces/:id/switch', requireAuth, async (req, res) => {
    const workspace = await db.getWorkspaceById(req.params.id);
    if (!workspace) return fail(res, 404, 'NOT_FOUND', 'Workspace not found.');
    if (!(await db.isMember(workspace.id, req.user.id))) {
      return fail(res, 403, 'FORBIDDEN', 'You are not a member of this workspace.');
    }
    return ok(res, { workspace });
  });

  // ── Team / Multi-User Workspaces (Milestone 8) ──────────────────────────

  // §12: "owners can manage membership, delete datasets, revoke share
  // links" — the actual authorization boundary, checked server-side, not
  // just hidden in the UI.
  async function requireOwner(workspaceId, userId) {
    return (await db.getMemberRole(workspaceId, userId)) === 'owner';
  }

  app.post('/api/workspaces', requireAuth, async (req, res) => {
    const { name } = req.body || {};
    if (!name || !name.trim()) return fail(res, 400, 'INVALID_INPUT', 'A workspace name is required.');

    const workspace = await db.createWorkspace({ name: name.trim(), type: 'team', ownerId: req.user.id });
    await db.addMember({ workspaceId: workspace.id, userId: req.user.id, role: 'owner' });
    return ok(res, { workspace: { ...workspace, role: 'owner' } }, 201);
  });

  app.get('/api/workspaces/:id/members', requireAuth, async (req, res) => {
    if (!(await db.isMember(req.params.id, req.user.id))) {
      return fail(res, 404, 'NOT_FOUND', 'Workspace not found.');
    }
    const members = await db.getMembers(req.params.id);
    const invitations = await db.listInvitations(req.params.id);
    const pending = invitations
      .filter((i) => i.status === 'pending')
      .map((i) => ({ invited_email: i.invited_email, status: 'pending', created_at: i.created_at }));
    return ok(res, { members, pending_invitations: pending });
  });

  app.post('/api/workspaces/:id/invitations', requireAuth, async (req, res) => {
    const workspaceId = req.params.id;
    if (!(await db.isMember(workspaceId, req.user.id))) {
      return fail(res, 404, 'NOT_FOUND', 'Workspace not found.');
    }
    if (!(await requireOwner(workspaceId, req.user.id))) {
      return fail(res, 403, 'FORBIDDEN', 'Only the workspace owner can invite members.');
    }

    const { email } = req.body || {};
    if (!email || !email.trim()) return fail(res, 400, 'INVALID_INPUT', 'An email address is required.');

    const invitedEmail = email.trim().toLowerCase();

    // Never add anyone directly — even an already-registered user only gets
    // a pending invitation they must accept while signed in as that email.
    const existingUser = await db.findUserByEmail(invitedEmail);
    if (existingUser && (await db.isMember(workspaceId, existingUser.id))) {
      return fail(res, 409, 'ALREADY_MEMBER', 'That person is already a member of this workspace.');
    }

    const existingInvitation = await db.findPendingInvitation(workspaceId, invitedEmail);
    const invitation =
      existingInvitation || (await db.createInvitation({ workspaceId, invitedEmail, invitedBy: req.user.id }));

    const email_sent = await sendInvitationEmail(req, invitation);
    return ok(res, { status: 'pending', invitation, email_sent }, 201);
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  // Best-effort: the invitation stays valid even if the email fails — the
  // invitee also sees it on the Team page once signed in with that email.
  async function sendInvitationEmail(req, invitation) {
    if (typeof insforge?.sendEmail !== 'function') return false;
    try {
      const workspace = await db.getWorkspaceById(invitation.workspace_id);
      const inviter = await db.getUserById(invitation.invited_by);
      const inviterName = inviter?.profile?.name || inviter?.email || 'A teammate';
      const origin = req.get('origin') || `${req.protocol}://${req.get('host')}`;
      const link = `${origin}/team.html?invite=${encodeURIComponent(invitation.id)}`;
      await insforge.sendEmail({
        to: invitation.invited_email,
        subject: `You've been invited to join ${workspace?.name || 'a workspace'} on Verdant BI`,
        html:
          `<p>${escapeHtml(inviterName)} invited you to join the workspace ` +
          `<strong>${escapeHtml(workspace?.name || '')}</strong> on Verdant BI.</p>` +
          `<p><a href="${escapeHtml(link)}">Review and accept the invitation</a></p>` +
          `<p>You'll need to sign in (or sign up) with this email address to accept. ` +
          `If you weren't expecting this, you can ignore this email.</p>`,
      });
      return true;
    } catch (err) {
      console.error('Failed to send invitation email:', err.message);
      return false;
    }
  }

  // Invitations addressed to the signed-in user's own (verified, from the
  // JWT) email — this is what makes joining require email ownership.
  async function findOwnInvitation(req, res) {
    const invitation = await db.getInvitationById(req.params.id);
    if (!invitation || invitation.invited_email.toLowerCase() !== req.user.email.toLowerCase()) {
      fail(res, 404, 'NOT_FOUND', 'Invitation not found.');
      return null;
    }
    if (invitation.status !== 'pending') {
      fail(res, 409, 'INVITATION_CLOSED', `This invitation has already been ${invitation.status === 'accepted' ? 'accepted' : 'withdrawn or declined'}.`);
      return null;
    }
    return invitation;
  }

  app.get('/api/invitations', requireAuth, async (req, res) => {
    const pending = await db.findPendingInvitationsForEmail(req.user.email);
    const invitations = await Promise.all(
      pending.map(async (i) => {
        const workspace = await db.getWorkspaceById(i.workspace_id);
        const inviter = await db.getUserById(i.invited_by);
        return {
          id: i.id,
          workspace_id: i.workspace_id,
          workspace_name: workspace?.name ?? null,
          invited_by: inviter?.profile?.name || inviter?.email || null,
          created_at: i.created_at,
        };
      })
    );
    return ok(res, { invitations });
  });

  app.post('/api/invitations/:id/accept', requireAuth, async (req, res) => {
    const invitation = await findOwnInvitation(req, res);
    if (!invitation) return;
    if (!(await db.isMember(invitation.workspace_id, req.user.id))) {
      await db.addMember({ workspaceId: invitation.workspace_id, userId: req.user.id, role: 'member' });
    }
    await db.acceptInvitation(invitation.id);
    const workspace = await db.getWorkspaceById(invitation.workspace_id);
    return ok(res, { workspace: { ...workspace, role: 'member' } });
  });

  app.post('/api/invitations/:id/decline', requireAuth, async (req, res) => {
    const invitation = await findOwnInvitation(req, res);
    if (!invitation) return;
    await db.revokeInvitation(invitation.id);
    return ok(res, { status: 'declined' });
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
  async function datasetView(dataset) {
    const [columns, previewRows] = await Promise.all([
      db.getColumnMaps(dataset.id),
      db.getDatasetRowsPreview(dataset.id, 20),
    ]);
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
      columns: columns.map(withEffectiveRole),
      preview_rows: previewRows,
    };
  }

  // A dataset lookup that isn't a member's own workspace responds 404, same
  // as "doesn't exist" — this avoids confirming another workspace's dataset
  // IDs even exist, consistent with the isolation boundary in §12/§14.
  async function getAccessibleDatasetById(datasetId, userId) {
    const dataset = await db.getDatasetById(datasetId);
    if (!dataset || !(await db.isMember(dataset.workspace_id, userId))) return null;
    return dataset;
  }

  function getAccessibleDataset(req) {
    return getAccessibleDatasetById(req.params.id, req.user.id);
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
    // Public, unauthenticated route — never include secrets (groqApiKey)
    // here, only what the browser legitimately needs to know.
    const { groqApiKey, ...publicConfig } = cfg;
    return ok(res, publicConfig);
  });

  app.post('/api/datasets/upload', requireAuth, uploadMiddleware, async (req, res) => {
    const { workspace_id } = req.body || {};
    if (!workspace_id) return fail(res, 400, 'INVALID_INPUT', 'workspace_id is required.');
    if (!(await db.isMember(workspace_id, req.user.id))) {
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
    const existing = await db.findDatasetByHash(workspace_id, fileHash);
    if (existing) {
      return ok(res, { dataset: await datasetView(existing), alreadyExists: true });
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

    const storagePath = await store.saveUpload(buffer, { workspaceId: workspace_id, fileHash, fileName });
    const dataset = await db.createDataset({
      workspaceId: workspace_id,
      fileName,
      fileHash,
      storagePath,
      uploadedBy: req.user.id,
    });

    try {
      const { headers, rows, summary } = cleanDataset(parsed.headers, parsed.rows);
      const columns = detectColumns(headers, rows);

      await db.saveDatasetRows(dataset.id, rows);
      await db.setColumnMaps(dataset.id, columns);
      await db.updateDataset(dataset.id, {
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
      await db.updateDataset(dataset.id, { status: 'failed', failure_reason: err.message });
    }

    return ok(res, { dataset: await datasetView(await db.getDatasetById(dataset.id)) }, 201);
  });

  app.get('/api/datasets', requireAuth, async (req, res) => {
    const workspaceId = req.query.workspace_id;
    if (!workspaceId) return fail(res, 400, 'INVALID_INPUT', 'workspace_id is required.');
    if (!(await db.isMember(workspaceId, req.user.id))) {
      return fail(res, 403, 'FORBIDDEN', 'You are not a member of this workspace.');
    }
    const datasets = await db.listDatasetsForWorkspace(workspaceId);
    return ok(res, { datasets: await Promise.all(datasets.map(datasetView)) });
  });

  app.get('/api/datasets/:id', requireAuth, async (req, res) => {
    const dataset = await getAccessibleDataset(req);
    if (!dataset) return fail(res, 404, 'NOT_FOUND', 'Dataset not found.');
    return ok(res, { dataset: await datasetView(dataset) });
  });

  app.get('/api/datasets/:id/columns', requireAuth, async (req, res) => {
    const dataset = await getAccessibleDataset(req);
    if (!dataset) return fail(res, 404, 'NOT_FOUND', 'Dataset not found.');
    return ok(res, { columns: (await db.getColumnMaps(dataset.id)).map(withEffectiveRole) });
  });

  app.post('/api/datasets/:id/columns/:column_name/override', requireAuth, async (req, res) => {
    const dataset = await getAccessibleDataset(req);
    if (!dataset) return fail(res, 404, 'NOT_FOUND', 'Dataset not found.');

    const { role } = req.body || {};
    if (role !== null && role !== undefined && !ALLOWED_ROLES.includes(role)) {
      return fail(res, 400, 'INVALID_INPUT', `role must be one of: ${ALLOWED_ROLES.join(', ')}, or null to clear.`);
    }
    const updated = await db.setColumnOverride(dataset.id, req.params.column_name, role ?? null);
    if (!updated) return fail(res, 404, 'NOT_FOUND', 'Column not found on this dataset.');
    return ok(res, { column: withEffectiveRole(updated) });
  });

  app.delete('/api/datasets/:id', requireAuth, async (req, res) => {
    const dataset = await getAccessibleDataset(req);
    if (!dataset) return fail(res, 404, 'NOT_FOUND', 'Dataset not found.');
    if (!(await requireOwner(dataset.workspace_id, req.user.id))) {
      return fail(res, 403, 'FORBIDDEN', 'Only the workspace owner can delete datasets.');
    }
    await store.deleteUpload(dataset.storage_path);
    await db.deleteDataset(dataset.id);
    return ok(res, { deleted: true });
  });

  // ── KPI Dashboard (Milestone 4) ──────────────────────────────────────────

  app.get('/api/datasets/:id/kpis', requireAuth, async (req, res) => {
    const dataset = await getAccessibleDataset(req);
    if (!dataset) return fail(res, 404, 'NOT_FOUND', 'Dataset not found.');
    if (dataset.status !== 'ready') {
      return fail(res, 409, 'NOT_READY', `Dataset is ${dataset.status}, not ready.`);
    }

    const columns = (await db.getColumnMaps(dataset.id)).map(withEffectiveRole);
    const rows = await db.getAllDatasetRows(dataset.id);
    const { start_date, end_date, region, category } = req.query;

    const kpis = computeKpis(columns, rows, { startDate: start_date, endDate: end_date, region, category });
    return ok(res, { kpis });
  });

  // ── Insights: Sales Forecasting (Milestone 5a) ──────────────────────────

  const ALLOWED_HORIZONS = [7, 30, 90];

  app.get('/api/datasets/:id/forecast', requireAuth, async (req, res) => {
    const dataset = await getAccessibleDataset(req);
    if (!dataset) return fail(res, 404, 'NOT_FOUND', 'Dataset not found.');
    if (dataset.status !== 'ready') {
      return fail(res, 409, 'NOT_READY', `Dataset is ${dataset.status}, not ready.`);
    }

    const horizonDays = Number(req.query.horizon_days);
    if (!ALLOWED_HORIZONS.includes(horizonDays)) {
      return fail(res, 400, 'INVALID_INPUT', `horizon_days must be one of: ${ALLOWED_HORIZONS.join(', ')}.`);
    }

    const columns = (await db.getColumnMaps(dataset.id)).map(withEffectiveRole);
    const rows = await db.getAllDatasetRows(dataset.id);

    const result = forecastRevenue(columns, rows, { horizonDays });
    if (result.available) {
      await db.createForecast({
        datasetId: dataset.id,
        horizonDays,
        series: result.series,
        methodologyVersion: result.methodology_version,
      });
    }
    return ok(res, { forecast: result });
  });

  // ── Insights: Customer Segmentation / RFM (Milestone 5b) ────────────────

  app.get('/api/datasets/:id/segments', requireAuth, async (req, res) => {
    const dataset = await getAccessibleDataset(req);
    if (!dataset) return fail(res, 404, 'NOT_FOUND', 'Dataset not found.');
    if (dataset.status !== 'ready') {
      return fail(res, 409, 'NOT_READY', `Dataset is ${dataset.status}, not ready.`);
    }

    const columns = (await db.getColumnMaps(dataset.id)).map(withEffectiveRole);
    const rows = await db.getAllDatasetRows(dataset.id);

    const result = segmentCustomers(columns, rows);
    if (result.available) {
      await db.setSegments(dataset.id, result.segments, result.methodology_version);
    }
    return ok(res, { segmentation: result });
  });

  // ── Insights: Anomaly Detection (Milestone 5c) ──────────────────────────

  app.get('/api/datasets/:id/anomalies', requireAuth, async (req, res) => {
    const dataset = await getAccessibleDataset(req);
    if (!dataset) return fail(res, 404, 'NOT_FOUND', 'Dataset not found.');
    if (dataset.status !== 'ready') {
      return fail(res, 409, 'NOT_READY', `Dataset is ${dataset.status}, not ready.`);
    }

    const columns = (await db.getColumnMaps(dataset.id)).map(withEffectiveRole);
    const rows = await db.getAllDatasetRows(dataset.id);

    const result = detectAnomalies(columns, rows, { contaminationRate: cfg.anomalyContaminationRate });
    if (result.available) {
      await db.setAnomalies(dataset.id, result.flagged_rows, result.methodology_version);
      // Enrich the response (not the persisted record) with the actual
      // feature values for each flagged row, so the client can render a
      // meaningful table/chart without a bulk row-fetch endpoint.
      const featureRoles = ['revenue', 'quantity'];
      const featureColumns = columns
        .filter((c) => featureRoles.includes(c.effective_role))
        .map((c) => c.column_name);
      result.flagged_rows = result.flagged_rows.map((f) => ({
        ...f,
        values: Object.fromEntries(featureColumns.map((col) => [col, rows[f.row_index][col]])),
      }));
      result.total_rows = rows.length;
    }
    return ok(res, { anomalies: result });
  });

  // ── AI Chat + Chart Grounding (Milestone 6) ─────────────────────────────
  // Replies are Markdown, rendered client-side by a safe DOM builder
  // (public/js/lib/markdown.js). This only strips what shouldn't reach it:
  // reasoning blocks, a whole-reply code fence, JSON wrappers, and any HTML.
function normalizeReply(input) {
  try {
    if (input == null) return '';

    let s;
    if (typeof input === 'string') s = input;
    else if (typeof input === 'object') s = input.reply ?? input.content ?? input.text ?? JSON.stringify(input);
    else s = String(input);

    // unwrap JSON replies
    const t = s.trim();
    if (t.startsWith('{') && t.endsWith('}')) {
      try {
        const parsed = JSON.parse(t);
        if (parsed && typeof parsed.reply === 'string') s = parsed.reply;
      } catch (_) {}
    }

    s = s.replace(/\r\n/g, '\n');

    // reasoning blocks and code-fence wrappers
    s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
    s = s.replace(/^```(?:html|markdown|md|text)?\n([\s\S]*?)\n```$/i, '$1');

    // HTML -> text (line breaks kept, tags dropped)
    s = s.replace(/<\s*br\s*\/?>/gi, '\n');
    s = s.replace(/<\/?[a-z][a-z0-9]*(\s[^>]*)?>/gi, '');

    // entities
    s = s
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');

    return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  } catch (err) {
    return typeof input === 'string' ? input : '';
  }
}
function publicChatMessage(m) {
  return {
    id: m.id,
    role: m.role,
    content: m.role === 'assistant' ? normalizeReply(m.content) : m.content,
    chart_payload: m.chart_payload,
    grounding_status: m.grounding_status,
    created_at: m.created_at,
  };
}

  app.get('/api/chat', requireAuth, async (req, res) => {
    const { workspace_id: workspaceId, dataset_id: datasetId } = req.query;
    if (!workspaceId || !datasetId) {
      return fail(res, 400, 'INVALID_INPUT', 'workspace_id and dataset_id are required.');
    }
    if (!(await db.isMember(workspaceId, req.user.id))) {
      return fail(res, 404, 'NOT_FOUND', 'Workspace not found.');
    }
    const dataset = await getAccessibleDatasetById(datasetId, req.user.id);
    if (!dataset || dataset.workspace_id !== workspaceId) {
      return fail(res, 404, 'NOT_FOUND', 'Dataset not found.');
    }
    const messages = await db.listChatMessages(workspaceId, datasetId);
    return ok(res, { messages: messages.map(publicChatMessage) });
  });

  app.post('/api/chat', requireAuth, async (req, res) => {
    const { workspace_id: workspaceId, dataset_id: datasetId, message } = req.body || {};
    if (!workspaceId || !datasetId || !message || !message.trim()) {
      return fail(res, 400, 'INVALID_INPUT', 'workspace_id, dataset_id, and a non-empty message are required.');
    }
    if (!(await db.isMember(workspaceId, req.user.id))) {
      return fail(res, 404, 'NOT_FOUND', 'Workspace not found.');
    }
    const dataset = await getAccessibleDatasetById(datasetId, req.user.id);
    if (!dataset || dataset.workspace_id !== workspaceId) {
      return fail(res, 404, 'NOT_FOUND', 'Dataset not found.');
    }
    if (dataset.status !== 'ready') {
      return fail(res, 409, 'NOT_READY', `Dataset is ${dataset.status}, not ready.`);
    }

    const allowed = chatRateLimiter.checkAndRecord(workspaceId, cfg.aiChatMaxMessagesPerWorkspacePerHour, 60 * 60 * 1000);
    if (!allowed) {
      return fail(res, 429, 'RATE_LIMITED', "You've reached the chat limit for this hour — try again shortly.");
    }

    const columns = (await db.getColumnMaps(dataset.id)).map(withEffectiveRole);
    const rows = await db.getAllDatasetRows(dataset.id);
    const contextSummary = buildContextSummary(columns, rows, { maxContextTokens: cfg.aiChatMaxContextTokens });
    const segmentSummary = segmentCustomers(columns, rows).summary_by_label ?? null;
    const conversationHistory = (await db.listChatMessages(workspaceId, datasetId, 10)).map(publicChatMessage);

    await db.addChatMessage({ workspaceId, datasetId, userId: req.user.id, role: 'user', content: message });

    const provider = getProvider(cfg);
    const tools = createChatTools(columns, rows, { anomalyContaminationRate: cfg.anomalyContaminationRate });
    let providerResult;
    try {
      providerResult = await provider.generateReply({
        question: message,
        columns,
        rows,
        contextSummary,
        segmentSummary,
        conversationHistory,
        apiKey: cfg.groqApiKey,
        model: cfg.groqModel,
        tools,
      });
    } catch (err) {
      console.error(
        JSON.stringify({
          function: 'ai-chat',
          workspace_id: workspaceId,
          dataset_id: datasetId,
          error_message: err.message,
          timestamp: new Date().toISOString(),
        })
      );
      providerResult = {
        reply:
          err.code === 'PROVIDER_RATE_LIMITED'
            ? 'The AI service is busy right now (its per-minute limit was reached) — please try again in a few seconds.'
            : 'I ran into a problem answering that — please try again.',
        chart_payload: null,
      };
    }

    let chartPayload = null;
    let groundingStatus = 'n/a';
    if (providerResult.grounded_by_tools) {
      // Tool-grounded reply: charts come straight from tool results (so they
      // need no re-verification), and every figure in the text is checked
      // against what the tools computed plus the dataset summary.
      const reply = normalizeReply(providerResult.reply);
      const figures = verifyReplyNumbers(reply, {
        tools: tools.calls.map((c) => c.result),
        overview: contextSummary.dataset_overview,
        stats: contextSummary.numeric_stats,
      });
      chartPayload = {
        version: 2,
        charts: tools.charts,
        sources: tools.calls.map((c) => c.source),
        figures,
      };
      if (figures.unverified.length > 0) groundingStatus = 'rejected';
      else if (tools.calls.length > 0 || figures.checked > 0) groundingStatus = 'verified';
      providerResult = { ...providerResult, reply: reply || "I couldn't put an answer together for that — please try rephrasing." };
    } else if (providerResult.chart_payload) {
      const verification = verifyChartGrounding(providerResult.chart_payload, rows, {
        threshold: cfg.chartGroundingThreshold,
      });
      groundingStatus = verification.grounding_status;
      if (groundingStatus === 'verified') {
        chartPayload = providerResult.chart_payload;
      }
    }

    const reply = normalizeReply(providerResult.reply);
    // Tool-grounded replies carry their verification in chart_payload.figures
    // (shown as a notice by the client); the notice below is the legacy
    // model-proposed-chart path.
    const replyText =
      groundingStatus === 'rejected' && !providerResult.grounded_by_tools
        ? `${reply}\n\nI couldn't confirm this chart against your data, so I'm not showing it.`
        : reply;

    const assistantMessage = await db.addChatMessage({
      workspaceId,
      datasetId,
      userId: req.user.id,
      role: 'assistant',
      content: replyText,
      chartPayload,
      groundingStatus,
    });

    // §14.1-style structured log; §11.1 approximate token-usage auditing.
    console.log(
      JSON.stringify({
        function: 'ai-chat',
        workspace_id: workspaceId,
        dataset_id: datasetId,
        provider: provider.name,
        approx_tokens: Math.ceil((message.length + replyText.length) / 4),
        grounding_status: groundingStatus,
        timestamp: new Date().toISOString(),
      })
    );

    return ok(res, { message: publicChatMessage(assistantMessage) }, 201);
  });

  // ── Reports & Secure Sharing (Milestone 7) ──────────────────────────────

  function publicShare(share) {
    return {
      id: share.id,
      workspace_id: share.workspace_id,
      dataset_id: share.dataset_id,
      report_type: share.report_type,
      url: `/api/public/shares/${share.token}`,
      created_at: share.created_at,
      expires_at: share.expires_at,
      revoked: share.revoked,
      status: share.revoked ? 'revoked' : new Date(share.expires_at) < new Date() ? 'expired' : 'active',
    };
  }

  function newExpiry() {
    return new Date(Date.now() + cfg.defaultShareLinkExpiryDays * 24 * 60 * 60 * 1000).toISOString();
  }

  // Generating a report immediately issues its share link — report_shares
  // (§2) is the only table that stores a generated file's storage_path,
  // there's no separate "reports" table, so generating IS issuing.
  app.post('/api/datasets/:id/reports', requireAuth, async (req, res) => {
    const dataset = await getAccessibleDataset(req);
    if (!dataset) return fail(res, 404, 'NOT_FOUND', 'Dataset not found.');
    if (dataset.status !== 'ready') {
      return fail(res, 409, 'NOT_READY', `Dataset is ${dataset.status}, not ready.`);
    }

    const { report_type: reportType } = req.body || {};
    if (!REPORT_TYPES.includes(reportType)) {
      return fail(res, 400, 'INVALID_INPUT', `report_type must be one of: ${REPORT_TYPES.join(', ')}.`);
    }

    const columns = (await db.getColumnMaps(dataset.id)).map(withEffectiveRole);
    const rows = await db.getAllDatasetRows(dataset.id);

    let file;
    try {
      file = await generateReport(reportType, { dataset, columns, rows });
    } catch (err) {
      console.error(
        JSON.stringify({
          function: 'generate-report',
          workspace_id: dataset.workspace_id,
          dataset_id: dataset.id,
          error_message: err.message,
          timestamp: new Date().toISOString(),
        })
      );
      return fail(res, 500, 'GENERATE_FAILED', 'Could not generate this report. Please try again.');
    }

    const reportId = crypto.randomUUID();
    const storagePath = await reportStore.saveReport(file.buffer, {
      workspaceId: dataset.workspace_id,
      reportId,
      extension: file.extension,
    });

    const share = await db.createReportShare({
      workspaceId: dataset.workspace_id,
      datasetId: dataset.id,
      reportType,
      storagePath,
      token: crypto.randomUUID(),
      createdBy: req.user.id,
      expiresAt: newExpiry(),
    });

    return ok(res, { share: publicShare(share) }, 201);
  });

  app.get('/api/datasets/:id/reports', requireAuth, async (req, res) => {
    const dataset = await getAccessibleDataset(req);
    if (!dataset) return fail(res, 404, 'NOT_FOUND', 'Dataset not found.');
    const shares = (await db.listSharesForWorkspace(dataset.workspace_id)).filter((s) => s.dataset_id === dataset.id);
    return ok(res, { shares: shares.map(publicShare) });
  });

  app.get('/api/workspaces/:id/shares', requireAuth, async (req, res) => {
    if (!(await db.isMember(req.params.id, req.user.id))) {
      return fail(res, 404, 'NOT_FOUND', 'Workspace not found.');
    }
    const shares = await db.listSharesForWorkspace(req.params.id);
    return ok(res, { shares: shares.map(publicShare) });
  });

  async function getAccessibleShare(req) {
    const share = await db.getShareById(req.params.id);
    if (!share || !(await db.isMember(share.workspace_id, req.user.id))) return null;
    return share;
  }

  app.post('/api/shares/:id/refresh', requireAuth, async (req, res) => {
    const share = await getAccessibleShare(req);
    if (!share) return fail(res, 404, 'NOT_FOUND', 'Share not found.');
    if (!(await requireOwner(share.workspace_id, req.user.id))) {
      return fail(res, 403, 'FORBIDDEN', 'Only the workspace owner can manage share links.');
    }
    const updated = await db.refreshShare(share.id, { token: crypto.randomUUID(), expiresAt: newExpiry() });
    return ok(res, { share: publicShare(updated) });
  });

  app.post('/api/shares/:id/revoke', requireAuth, async (req, res) => {
    const share = await getAccessibleShare(req);
    if (!share) return fail(res, 404, 'NOT_FOUND', 'Share not found.');
    if (!(await requireOwner(share.workspace_id, req.user.id))) {
      return fail(res, 403, 'FORBIDDEN', 'Only the workspace owner can manage share links.');
    }
    const updated = await db.revokeShare(share.id);
    return ok(res, { share: publicShare(updated) });
  });

  // Unauthenticated — the one and only file-serving path. Never resolves or
  // exposes the raw storage_path; the token is checked server-side and the
  // file streamed directly.
  // Under /api/ so Netlify's /api/* rewrite reaches Express (anything else is
  // served from public/ and 404s); the bare /public/ path stays for old links.
  app.get(['/api/public/shares/:token', '/public/shares/:token'], async (req, res) => {
    const share = await db.getShareByToken(req.params.token);
    if (!share) return fail(res, 404, 'NOT_FOUND', 'This link is not valid.');
    if (share.revoked) return fail(res, 403, 'REVOKED', 'This link has been revoked.');
    if (new Date(share.expires_at) < new Date()) return fail(res, 403, 'EXPIRED', 'This link has expired.');

    const buffer = await reportStore.readReport(share.storage_path);
    const extension = path.extname(share.storage_path);
    const mimeType = extension === '.xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf';
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${share.report_type}${extension}"`);
    return res.send(buffer);
  });

  // Catches whatever the async-handler wrapper above forwards via next(err)
  // — an InsForge request failing, a bug, anything — and turns it into a
  // normal error response instead of an unhandled rejection.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    console.error(
      JSON.stringify({ function: 'unhandled-error', path: req.path, error_message: err.message, timestamp: new Date().toISOString() })
    );
    return fail(res, 500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.');
  });

  return app;
}
