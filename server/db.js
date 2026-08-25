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
  };
}
