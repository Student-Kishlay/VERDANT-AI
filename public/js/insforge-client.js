// ── Mock InsForge client ─────────────────────────────────────────────────────
// This is a stand-in for InsForge's real JS SDK, not a copy of it. The method
// names/shapes below (auth.signUp/signIn/getSession, workspaces.list/switch)
// are OUR OWN abstraction sized to what this app needs — do not assume they
// match InsForge's actual SDK. When migrating off the local mock server:
//   1. Confirm InsForge's real client init + method names via its MCP/docs
//      (Master Prompt §0.5) — do not guess from this file.
//   2. This module is the only place that should need to change; every page
//      script calls through `insforge.*`, never `fetch()` directly.

const TOKEN_KEY = 'verdant_token';
const ACTIVE_WORKSPACE_KEY = 'verdant_active_workspace';

async function request(path, { method = 'GET', body, auth = true, formData } = {}) {
  const headers = {};
  if (auth) {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  let requestBody = formData;
  if (formData === undefined && body !== undefined) {
    headers['Content-Type'] = 'application/json';
    requestBody = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: requestBody });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.ok === false) {
    const err = new Error(json?.error?.message || `Request failed (${res.status})`);
    err.code = json?.error?.code || 'UNKNOWN_ERROR';
    err.status = res.status;
    throw err;
  }
  return json.data;
}

export const insforge = {
  auth: {
    async signUp({ email, password, displayName }) {
      const data = await request('/api/auth/signup', {
        method: 'POST',
        auth: false,
        body: { email, password, display_name: displayName },
      });
      localStorage.setItem(TOKEN_KEY, data.token);
      localStorage.setItem(ACTIVE_WORKSPACE_KEY, data.workspace.id);
      return data;
    },

    async signIn({ email, password }) {
      const data = await request('/api/auth/login', {
        method: 'POST',
        auth: false,
        body: { email, password },
      });
      localStorage.setItem(TOKEN_KEY, data.token);
      return data;
    },

    async getSession() {
      if (!localStorage.getItem(TOKEN_KEY)) return null;
      try {
        return await request('/api/auth/me');
      } catch {
        localStorage.removeItem(TOKEN_KEY);
        return null;
      }
    },

    signOut() {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
    },
  },

  workspaces: {
    list() {
      return request('/api/workspaces');
    },
    async switchTo(workspaceId) {
      const data = await request(`/api/workspaces/${workspaceId}/switch`, { method: 'POST' });
      localStorage.setItem(ACTIVE_WORKSPACE_KEY, data.workspace.id);
      return data;
    },
    getActiveId() {
      return localStorage.getItem(ACTIVE_WORKSPACE_KEY);
    },
  },

  config: {
    get() {
      return request('/api/config', { auth: false });
    },
  },

  datasets: {
    upload(file, workspaceId) {
      const formData = new FormData();
      formData.append('workspace_id', workspaceId);
      formData.append('file', file, file.name);
      return request('/api/datasets/upload', { method: 'POST', formData });
    },
    get(id) {
      return request(`/api/datasets/${id}`);
    },
    list(workspaceId) {
      return request(`/api/datasets?workspace_id=${encodeURIComponent(workspaceId)}`);
    },
    setColumnOverride(datasetId, columnName, role) {
      return request(`/api/datasets/${datasetId}/columns/${encodeURIComponent(columnName)}/override`, {
        method: 'POST',
        body: { role },
      });
    },
    remove(id) {
      return request(`/api/datasets/${id}`, { method: 'DELETE' });
    },
    getKpis(id, { startDate, endDate, region } = {}) {
      const params = new URLSearchParams();
      if (startDate) params.set('start_date', startDate);
      if (endDate) params.set('end_date', endDate);
      if (region) params.set('region', region);
      const qs = params.toString();
      return request(`/api/datasets/${id}/kpis${qs ? `?${qs}` : ''}`);
    },
    getForecast(id, horizonDays) {
      return request(`/api/datasets/${id}/forecast?horizon_days=${horizonDays}`);
    },
    getSegments(id) {
      return request(`/api/datasets/${id}/segments`);
    },
    getAnomalies(id) {
      return request(`/api/datasets/${id}/anomalies`);
    },
    // "Active dataset" has no server-side concept (mirrors the target
    // schema, which has no such column either) — it's just "the last
    // dataset this browser uploaded/viewed for this workspace."
    getActiveId(workspaceId) {
      return localStorage.getItem(`verdant_active_dataset_${workspaceId}`);
    },
    setActiveId(workspaceId, datasetId) {
      localStorage.setItem(`verdant_active_dataset_${workspaceId}`, datasetId);
    },
    clearActiveId(workspaceId) {
      localStorage.removeItem(`verdant_active_dataset_${workspaceId}`);
    },
  },

  chat: {
    history(workspaceId, datasetId) {
      return request(`/api/chat?workspace_id=${workspaceId}&dataset_id=${datasetId}`);
    },
    send(workspaceId, datasetId, message) {
      return request('/api/chat', { method: 'POST', body: { workspace_id: workspaceId, dataset_id: datasetId, message } });
    },
  },
};
