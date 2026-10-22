// Every table now lives in real InsForge Postgres (see
// db/insforge-schema.sql) — every method below calls out to `insforge`
// (server/insforge.js in production; tests/fake-insforge.js in tests), a
// thin admin-key REST client. There is no local persistence left here.
export function createDb(insforge) {
  return {
    async findUserByEmail(email) {
      return insforge.findUserByEmail(email);
    },

    async getUserById(id) {
      return insforge.getUser(id).catch(() => null);
    },

    async createWorkspace({ name, type, ownerId }) {
      const [workspace] = await insforge.insert('workspaces', [{ name, type, owner_id: ownerId }]);
      return workspace;
    },

    async addMember({ workspaceId, userId, role }) {
      const [member] = await insforge.insert('workspace_members', [
        { workspace_id: workspaceId, user_id: userId, role },
      ]);
      return member;
    },

    async isMember(workspaceId, userId) {
      return Boolean(await insforge.selectOne('workspace_members', { workspace_id: workspaceId, user_id: userId }));
    },

    async getMemberRole(workspaceId, userId) {
      const member = await insforge.selectOne('workspace_members', { workspace_id: workspaceId, user_id: userId });
      return member ? member.role : null;
    },

    async getMembers(workspaceId) {
      const members = await insforge.select('workspace_members', { workspace_id: workspaceId });
      return Promise.all(
        members.map(async (m) => {
          const user = await insforge.getUser(m.user_id).catch(() => null);
          return {
            user_id: m.user_id,
            display_name: user?.profile?.name ?? null,
            email: user?.email ?? null,
            role: m.role,
            joined_at: m.joined_at,
          };
        })
      );
    },

    async getWorkspacesForUser(userId) {
      const memberships = await insforge.select('workspace_members', { user_id: userId });
      return Promise.all(
        memberships.map(async (m) => {
          const workspace = await insforge.selectOne('workspaces', { id: m.workspace_id });
          return { ...workspace, role: m.role };
        })
      );
    },

    async getWorkspaceById(id) {
      return insforge.selectOne('workspaces', { id });
    },

    // ── home page stats ──────────────────────────────────────────────────
    // Aggregated across every dataset in the workspace — there's no single
    // "active dataset" concept server-side (that's a browser-local pointer,
    // see insforge-client.js), so these are workspace-wide totals.
    async getWorkspaceStats(workspaceId) {
      const workspaceDatasets = await insforge.select('datasets', { workspace_id: workspaceId });
      const lastDataset = [...workspaceDatasets].sort((a, b) => (a.uploaded_at < b.uploaded_at ? 1 : -1))[0];

      const [forecastCounts, chatMessages] = await Promise.all([
        Promise.all(workspaceDatasets.map((d) => insforge.select('forecasts', { dataset_id: d.id }))),
        insforge.select('chat_messages', { workspace_id: workspaceId, role: 'user' }),
      ]);

      return {
        last_dataset_name: lastDataset ? lastDataset.file_name : null,
        total_records: workspaceDatasets.reduce((sum, d) => sum + (d.row_count || 0), 0),
        forecasts_generated: forecastCounts.reduce((sum, f) => sum + f.length, 0),
        chat_questions_asked: chatMessages.length,
      };
    },

    // ── datasets ──────────────────────────────────────────────────────────
    async createDataset({ workspaceId, fileName, fileHash, storagePath, uploadedBy }) {
      const [dataset] = await insforge.insert('datasets', [
        {
          workspace_id: workspaceId,
          file_name: fileName,
          file_hash: fileHash,
          storage_path: storagePath,
          status: 'processing',
          uploaded_by: uploadedBy,
        },
      ]);
      return dataset;
    },

    async updateDataset(id, patch) {
      const [dataset] = await insforge.update('datasets', { id }, patch);
      return dataset || null;
    },

    async getDatasetById(id) {
      return insforge.selectOne('datasets', { id });
    },

    async findDatasetByHash(workspaceId, fileHash) {
      return insforge.selectOne('datasets', { workspace_id: workspaceId, file_hash: fileHash });
    },

    async listDatasetsForWorkspace(workspaceId) {
      return insforge.select('datasets', { workspace_id: workspaceId });
    },

    async deleteDataset(id) {
      // column_maps/dataset_rows cascade via the FK in db/insforge-schema.sql.
      await insforge.remove('datasets', { id });
    },

    // ── column_maps ───────────────────────────────────────────────────────
    async setColumnMaps(datasetId, columns) {
      await insforge.remove('column_maps', { dataset_id: datasetId });
      await insforge.insert(
        'column_maps',
        columns.map((col) => ({
          dataset_id: datasetId,
          column_name: col.column_name,
          detected_role: col.detected_role,
          confidence: col.confidence,
          user_override: null,
        }))
      );
    },

    async getColumnMaps(datasetId) {
      return insforge.select('column_maps', { dataset_id: datasetId });
    },

    async setColumnOverride(datasetId, columnName, role) {
      const [updated] = await insforge.update('column_maps', { dataset_id: datasetId, column_name: columnName }, { user_override: role });
      return updated || null;
    },

    // ── dataset_rows ──────────────────────────────────────────────────────
    async saveDatasetRows(datasetId, rows) {
      await insforge.remove('dataset_rows', { dataset_id: datasetId });
      await insforge.insertMany(
        'dataset_rows',
        rows.map((row, index) => ({ dataset_id: datasetId, row_index: index, data: row }))
      );
    },

    async getDatasetRowsPreview(datasetId, limit = 20) {
      const rows = await insforge.select('dataset_rows', { dataset_id: datasetId }, { order: 'row_index.asc', limit });
      return rows.map((r) => r.data);
    },

    async getAllDatasetRows(datasetId) {
      const rows = await insforge.selectAll('dataset_rows', { dataset_id: datasetId }, { order: 'row_index.asc' });
      return rows.map((r) => r.data);
    },

    // ── forecasts ─────────────────────────────────────────────────────────
    // Append-only log — a new forecast run never overwrites a prior one, per
    // §9/§10's methodology-versioning intent.
    async createForecast({ datasetId, horizonDays, series, methodologyVersion }) {
      const [forecast] = await insforge.insert('forecasts', [
        { dataset_id: datasetId, horizon_days: horizonDays, series, methodology_version: methodologyVersion },
      ]);
      return forecast;
    },

    async listForecasts(datasetId) {
      return insforge.select('forecasts', { dataset_id: datasetId });
    },

    // ── segments ──────────────────────────────────────────────────────────
    // Replace-all, same pattern as setColumnMaps — segments are a "current
    // classification," not a historical log, so a recompute replaces the
    // full set atomically rather than accumulating duplicates.
    async setSegments(datasetId, segments, methodologyVersion) {
      await insforge.remove('segments', { dataset_id: datasetId });
      await insforge.insertMany(
        'segments',
        segments.map((s) => ({ dataset_id: datasetId, methodology_version: methodologyVersion, ...s }))
      );
    },

    async getSegments(datasetId) {
      return insforge.selectAll('segments', { dataset_id: datasetId });
    },

    // ── anomalies ─────────────────────────────────────────────────────────
    // Replace-all, same rationale as setSegments — a current classification,
    // not a historical log.
    async setAnomalies(datasetId, anomalies, methodologyVersion) {
      await insforge.remove('anomalies', { dataset_id: datasetId });
      await insforge.insertMany(
        'anomalies',
        anomalies.map((a) => ({ dataset_id: datasetId, methodology_version: methodologyVersion, ...a }))
      );
    },

    async getAnomalies(datasetId) {
      return insforge.selectAll('anomalies', { dataset_id: datasetId });
    },

    // ── chat_messages ─────────────────────────────────────────────────────
    // No separate conversation_id — workspace + dataset + created_at order
    // is the conversation, matching the target schema (§2) exactly.
    async addChatMessage({ workspaceId, datasetId, userId, role, content, chartPayload, groundingStatus }) {
      const [message] = await insforge.insert('chat_messages', [
        {
          workspace_id: workspaceId,
          dataset_id: datasetId,
          user_id: userId,
          role,
          content,
          chart_payload: chartPayload ?? null,
          grounding_status: groundingStatus ?? 'n/a',
        },
      ]);
      return message;
    },

    async listChatMessages(workspaceId, datasetId, limit = 50) {
      const messages = await insforge.select(
        'chat_messages',
        { workspace_id: workspaceId, dataset_id: datasetId },
        { order: 'created_at.desc', limit }
      );
      return messages.reverse();
    },

    // ── report_shares ─────────────────────────────────────────────────────
    // Doubles as both "the record of a generated report" and "the sharing
    // metadata" — the target schema (§2) has no separate reports table, so
    // generating a report and issuing its share link happen together here.
    async createReportShare({ workspaceId, datasetId, reportType, storagePath, token, createdBy, expiresAt }) {
      const [share] = await insforge.insert('report_shares', [
        {
          workspace_id: workspaceId,
          dataset_id: datasetId,
          report_type: reportType,
          storage_path: storagePath,
          token,
          created_by: createdBy,
          expires_at: expiresAt,
          revoked: false,
        },
      ]);
      return share;
    },

    async getShareById(id) {
      return insforge.selectOne('report_shares', { id });
    },

    async getShareByToken(token) {
      return insforge.selectOne('report_shares', { token });
    },

    async listSharesForWorkspace(workspaceId) {
      return insforge.select('report_shares', { workspace_id: workspaceId });
    },

    async refreshShare(id, { token, expiresAt }) {
      const [share] = await insforge.update('report_shares', { id }, { token, expires_at: expiresAt, revoked: false });
      return share || null;
    },

    async revokeShare(id) {
      const [share] = await insforge.update('report_shares', { id }, { revoked: true });
      return share || null;
    },

    // ── workspace_invitations ────────────────────────────────────────────
    async createInvitation({ workspaceId, invitedEmail, invitedBy }) {
      const [invitation] = await insforge.insert('workspace_invitations', [
        { workspace_id: workspaceId, invited_email: invitedEmail, invited_by: invitedBy },
      ]);
      return invitation;
    },

    async findPendingInvitation(workspaceId, email) {
      const pending = await insforge.select('workspace_invitations', { workspace_id: workspaceId, status: 'pending' });
      return pending.find((i) => i.invited_email.toLowerCase() === email.toLowerCase()) || null;
    },

    async findPendingInvitationsForEmail(email) {
      const pending = await insforge.select('workspace_invitations', { status: 'pending' });
      return pending.filter((i) => i.invited_email.toLowerCase() === email.toLowerCase());
    },

    async listInvitations(workspaceId) {
      return insforge.select('workspace_invitations', { workspace_id: workspaceId });
    },

    async getInvitationById(id) {
      return insforge.selectOne('workspace_invitations', { id });
    },

    async acceptInvitation(id) {
      const [invitation] = await insforge.update('workspace_invitations', { id }, { status: 'accepted' });
      return invitation;
    },

    // 'revoked' doubles as "declined" — the status check constraint only
    // allows pending/accepted/revoked.
    async revokeInvitation(id) {
      const [invitation] = await insforge.update('workspace_invitations', { id }, { status: 'revoked' });
      return invitation;
    },
  };
}
