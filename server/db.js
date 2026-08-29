import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// JSON-file-backed store standing in for InsForge Postgres during local
// development. Implements the subset of db/schema.sql needed for Milestones
// 1-2 (users, workspaces, workspace_members). Every lookup that returns
// workspace-scoped data goes through membership, mirroring the RLS policies
// in db/schema.sql so the isolation behavior matches what the real backend
// will enforce.
const EMPTY_DATA = {
  users: [],
  workspaces: [],
  workspace_members: [],
  datasets: [],
  column_maps: [],
  dataset_rows: [],
  forecasts: [],
  segments: [],
  anomalies: [],
  chat_messages: [],
  report_shares: [],
  workspace_invitations: [],
};

export function createDb(filePath) {
  let data = { ...EMPTY_DATA };

  if (filePath && fs.existsSync(filePath)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      data = { ...EMPTY_DATA, ...loaded };
    } catch {
      // corrupt/empty file — start fresh rather than crashing the server
      data = { ...EMPTY_DATA };
    }
  }

  function persist() {
    if (!filePath) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }

  return {
    findUserByEmail(email) {
      return data.users.find((u) => u.email.toLowerCase() === email.toLowerCase()) || null;
    },

    getUserById(id) {
      return data.users.find((u) => u.id === id) || null;
    },

    createUser({ email, passwordHash, displayName }) {
      const user = {
        id: randomUUID(),
        email,
        password_hash: passwordHash,
        display_name: displayName || email.split('@')[0],
        created_at: new Date().toISOString(),
      };
      data.users.push(user);
      persist();
      return user;
    },

    createWorkspace({ name, type, ownerId }) {
      const workspace = {
        id: randomUUID(),
        name,
        type,
        owner_id: ownerId,
        created_at: new Date().toISOString(),
      };
      data.workspaces.push(workspace);
      persist();
      return workspace;
    },

    addMember({ workspaceId, userId, role }) {
      const member = {
        workspace_id: workspaceId,
        user_id: userId,
        role,
        joined_at: new Date().toISOString(),
      };
      data.workspace_members.push(member);
      persist();
      return member;
    },

    isMember(workspaceId, userId) {
      return data.workspace_members.some(
        (m) => m.workspace_id === workspaceId && m.user_id === userId
      );
    },

    getMemberRole(workspaceId, userId) {
      const member = data.workspace_members.find((m) => m.workspace_id === workspaceId && m.user_id === userId);
      return member ? member.role : null;
    },

    getMembers(workspaceId) {
      return data.workspace_members
        .filter((m) => m.workspace_id === workspaceId)
        .map((m) => {
          const user = data.users.find((u) => u.id === m.user_id);
          return { user_id: m.user_id, display_name: user?.display_name, email: user?.email, role: m.role, joined_at: m.joined_at };
        });
    },

    getWorkspacesForUser(userId) {
      const memberships = data.workspace_members.filter((m) => m.user_id === userId);
      return memberships.map((m) => {
        const workspace = data.workspaces.find((w) => w.id === m.workspace_id);
        return { ...workspace, role: m.role };
      });
    },

    getWorkspaceById(id) {
      return data.workspaces.find((w) => w.id === id) || null;
    },

    // ── home page stats ──────────────────────────────────────────────────
    // Aggregated across every dataset in the workspace — there's no single
    // "active dataset" concept server-side (that's a browser-local pointer,
    // see insforge-client.js), so these are workspace-wide totals.
    getWorkspaceStats(workspaceId) {
      const datasets = data.datasets.filter((d) => d.workspace_id === workspaceId);
      const datasetIds = new Set(datasets.map((d) => d.id));
      const lastDataset = datasets
        .slice()
        .sort((a, b) => (a.uploaded_at < b.uploaded_at ? 1 : -1))[0];

      return {
        last_dataset_name: lastDataset ? lastDataset.file_name : null,
        total_records: datasets.reduce((sum, d) => sum + (d.row_count || 0), 0),
        forecasts_generated: data.forecasts.filter((f) => datasetIds.has(f.dataset_id)).length,
        chat_questions_asked: data.chat_messages.filter((m) => m.workspace_id === workspaceId && m.role === 'user').length,
      };
    },

    // ── datasets ──────────────────────────────────────────────────────────
    createDataset({ workspaceId, fileName, fileHash, storagePath, uploadedBy }) {
      const dataset = {
        id: randomUUID(),
        workspace_id: workspaceId,
        file_name: fileName,
        file_hash: fileHash,
        row_count: null,
        column_count: null,
        storage_path: storagePath,
        cleaning_summary: null,
        methodology_version: null,
        status: 'processing',
        failure_reason: null,
        uploaded_by: uploadedBy,
        uploaded_at: new Date().toISOString(),
      };
      data.datasets.push(dataset);
      persist();
      return dataset;
    },

    updateDataset(id, patch) {
      const dataset = data.datasets.find((d) => d.id === id);
      if (!dataset) return null;
      Object.assign(dataset, patch);
      persist();
      return dataset;
    },

    getDatasetById(id) {
      return data.datasets.find((d) => d.id === id) || null;
    },

    findDatasetByHash(workspaceId, fileHash) {
      return data.datasets.find((d) => d.workspace_id === workspaceId && d.file_hash === fileHash) || null;
    },

    listDatasetsForWorkspace(workspaceId) {
      return data.datasets.filter((d) => d.workspace_id === workspaceId);
    },

    deleteDataset(id) {
      data.datasets = data.datasets.filter((d) => d.id !== id);
      data.column_maps = data.column_maps.filter((c) => c.dataset_id !== id);
      data.dataset_rows = data.dataset_rows.filter((r) => r.dataset_id !== id);
      persist();
    },

    // ── column_maps ───────────────────────────────────────────────────────
    setColumnMaps(datasetId, columns) {
      data.column_maps = data.column_maps.filter((c) => c.dataset_id !== datasetId);
      for (const col of columns) {
        data.column_maps.push({
          dataset_id: datasetId,
          column_name: col.column_name,
          detected_role: col.detected_role,
          confidence: col.confidence,
          user_override: null,
        });
      }
      persist();
    },

    getColumnMaps(datasetId) {
      return data.column_maps.filter((c) => c.dataset_id === datasetId);
    },

    setColumnOverride(datasetId, columnName, role) {
      const entry = data.column_maps.find((c) => c.dataset_id === datasetId && c.column_name === columnName);
      if (!entry) return null;
      entry.user_override = role;
      persist();
      return entry;
    },

    // ── dataset_rows ──────────────────────────────────────────────────────
    saveDatasetRows(datasetId, rows) {
      data.dataset_rows = data.dataset_rows.filter((r) => r.dataset_id !== datasetId);
      rows.forEach((row, index) => {
        data.dataset_rows.push({ id: randomUUID(), dataset_id: datasetId, row_index: index, data: row });
      });
      persist();
    },

    getDatasetRowsPreview(datasetId, limit = 20) {
      return data.dataset_rows
        .filter((r) => r.dataset_id === datasetId)
        .sort((a, b) => a.row_index - b.row_index)
        .slice(0, limit)
        .map((r) => r.data);
    },

    getAllDatasetRows(datasetId) {
      return data.dataset_rows
        .filter((r) => r.dataset_id === datasetId)
        .sort((a, b) => a.row_index - b.row_index)
        .map((r) => r.data);
    },

    // ── forecasts ─────────────────────────────────────────────────────────
    // Append-only log — a new forecast run never overwrites a prior one, per
    // §9/§10's methodology-versioning intent.
    createForecast({ datasetId, horizonDays, series, methodologyVersion }) {
      const forecast = {
        id: randomUUID(),
        dataset_id: datasetId,
        horizon_days: horizonDays,
        generated_at: new Date().toISOString(),
        series,
        methodology_version: methodologyVersion,
      };
      data.forecasts.push(forecast);
      persist();
      return forecast;
    },

    listForecasts(datasetId) {
      return data.forecasts.filter((f) => f.dataset_id === datasetId);
    },

    // ── segments ──────────────────────────────────────────────────────────
    // Replace-all, same pattern as setColumnMaps — segments are a "current
    // classification," not a historical log, so a recompute replaces the
    // full set atomically rather than accumulating duplicates.
    setSegments(datasetId, segments) {
      data.segments = data.segments.filter((s) => s.dataset_id !== datasetId);
      for (const s of segments) {
        data.segments.push({ id: randomUUID(), dataset_id: datasetId, computed_at: new Date().toISOString(), ...s });
      }
      persist();
    },

    getSegments(datasetId) {
      return data.segments.filter((s) => s.dataset_id === datasetId);
    },

    // ── anomalies ─────────────────────────────────────────────────────────
    // Replace-all, same rationale as setSegments — a current classification,
    // not a historical log.
    setAnomalies(datasetId, anomalies) {
      data.anomalies = data.anomalies.filter((a) => a.dataset_id !== datasetId);
      for (const a of anomalies) {
        data.anomalies.push({ id: randomUUID(), dataset_id: datasetId, flagged_at: new Date().toISOString(), ...a });
      }
      persist();
    },

    getAnomalies(datasetId) {
      return data.anomalies.filter((a) => a.dataset_id === datasetId);
    },

    // ── chat_messages ─────────────────────────────────────────────────────
    // No separate conversation_id — workspace + dataset + created_at order
    // is the conversation, matching the target schema (§2) exactly.
    addChatMessage({ workspaceId, datasetId, userId, role, content, chartPayload, groundingStatus }) {
      const message = {
        id: randomUUID(),
        workspace_id: workspaceId,
        dataset_id: datasetId,
        user_id: userId,
        role,
        content,
        chart_payload: chartPayload ?? null,
        grounding_status: groundingStatus ?? 'n/a',
        created_at: new Date().toISOString(),
      };
      data.chat_messages.push(message);
      persist();
      return message;
    },

    listChatMessages(workspaceId, datasetId, limit = 50) {
      return data.chat_messages
        .filter((m) => m.workspace_id === workspaceId && m.dataset_id === datasetId)
        .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
        .slice(-limit);
    },

    // ── report_shares ─────────────────────────────────────────────────────
    // Doubles as both "the record of a generated report" and "the sharing
    // metadata" — the target schema (§2) has no separate reports table, so
    // generating a report and issuing its share link happen together here.
    createReportShare({ workspaceId, datasetId, reportType, storagePath, token, createdBy, expiresAt }) {
      const share = {
        id: randomUUID(),
        workspace_id: workspaceId,
        dataset_id: datasetId,
        report_type: reportType,
        storage_path: storagePath,
        token,
        created_by: createdBy,
        created_at: new Date().toISOString(),
        expires_at: expiresAt,
        revoked: false,
      };
      data.report_shares.push(share);
      persist();
      return share;
    },

    getShareById(id) {
      return data.report_shares.find((s) => s.id === id) || null;
    },

    getShareByToken(token) {
      return data.report_shares.find((s) => s.token === token) || null;
    },

    listSharesForWorkspace(workspaceId) {
      return data.report_shares.filter((s) => s.workspace_id === workspaceId);
    },

    refreshShare(id, { token, expiresAt }) {
      const share = data.report_shares.find((s) => s.id === id);
      if (!share) return null;
      share.token = token;
      share.expires_at = expiresAt;
      share.revoked = false;
      persist();
      return share;
    },

    revokeShare(id) {
      const share = data.report_shares.find((s) => s.id === id);
      if (!share) return null;
      share.revoked = true;
      persist();
      return share;
    },

    // ── workspace_invitations ────────────────────────────────────────────
    createInvitation({ workspaceId, invitedEmail, invitedBy }) {
      const invitation = {
        id: randomUUID(),
        workspace_id: workspaceId,
        invited_email: invitedEmail,
        status: 'pending',
        invited_by: invitedBy,
        created_at: new Date().toISOString(),
      };
      data.workspace_invitations.push(invitation);
      persist();
      return invitation;
    },

    findPendingInvitation(workspaceId, email) {
      return (
        data.workspace_invitations.find(
          (i) => i.workspace_id === workspaceId && i.status === 'pending' && i.invited_email.toLowerCase() === email.toLowerCase()
        ) || null
      );
    },

    findPendingInvitationsForEmail(email) {
      return data.workspace_invitations.filter(
        (i) => i.status === 'pending' && i.invited_email.toLowerCase() === email.toLowerCase()
      );
    },

    listInvitations(workspaceId) {
      return data.workspace_invitations.filter((i) => i.workspace_id === workspaceId);
    },

    acceptInvitation(id) {
      const invitation = data.workspace_invitations.find((i) => i.id === id);
      if (!invitation) return null;
      invitation.status = 'accepted';
      persist();
      return invitation;
    },
  };
}
