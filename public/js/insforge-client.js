// ── InsForge client ──────────────────────────────────────────────────────────
// Auth talks to InsForge directly (real backend — see db/insforge-schema.sql
// and AGENTS.md). Everything else below (workspaces/datasets/chat/reports)
// still goes through this app's own Express server (server/app.js), now
// authenticated with the InsForge access token instead of a token this
// server issues itself — that migration is a later phase.
//
// Known limitation (Phase 1): InsForge access tokens are short-lived
// (~15 min) and this doesn't yet implement refresh — a session will need to
// re-login after expiry rather than silently refreshing. Fine for now, but
// flagged rather than hidden.

const TOKEN_KEY = 'verdant_token';
const ACTIVE_WORKSPACE_KEY = 'verdant_active_workspace';

let insforgeSdkPromise = null;
async function getSdk() {
  if (!insforgeSdkPromise) {
    insforgeSdkPromise = (async () => {
      const cfg = await request('/api/config', { auth: false });
      const { createClient } = await import('https://esm.sh/@insforge/sdk@latest');
      return createClient({ baseUrl: cfg.insforgeBaseUrl, anonKey: cfg.insforgeAnonKey });
    })();
  }
  return insforgeSdkPromise;
}

// Calls a real InsForge Edge Function (see functions/*/index.ts) instead of
// this app's own Express server — used for the analytics routes that have
// been migrated off Express (Phase 3). The function's own response body
// uses the same { ok, data } / { ok: false, error } envelope as Express,
// so this unwraps it the same way `request()` does; the SDK-level
// { data, error } wrapper around that is InsForge's own invoke() contract.
async function invokeFunction(slug, body) {
  const sdk = await getSdk();
  const token = localStorage.getItem(TOKEN_KEY);
  const { data, error } = await sdk.functions.invoke(slug, {
    body,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (error) {
    const err = new Error(error.message || `Function ${slug} failed`);
    err.code = error.error || 'FUNCTION_ERROR';
    throw err;
  }
  if (!data || data.ok === false) {
    const err = new Error(data?.error?.message || `Function ${slug} failed`);
    err.code = data?.error?.code || 'UNKNOWN_ERROR';
    throw err;
  }
  return data.data;
}

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
      const sdk = await getSdk();
      const { data, error } = await sdk.auth.signUp({ email, password, name: displayName });
      if (error) {
        const err = new Error(error.message || 'Sign up failed.');
        err.code = error.error || 'AUTH_ERROR';
        throw err;
      }
      if (!data.accessToken) {
        const err = new Error('Email verification is required before you can sign in.');
        err.code = 'EMAIL_VERIFICATION_REQUIRED';
        throw err;
      }
      localStorage.setItem(TOKEN_KEY, data.accessToken);
      // First /api/auth/me call self-provisions a personal workspace.
      const me = await request('/api/auth/me');
      localStorage.setItem(ACTIVE_WORKSPACE_KEY, me.workspaces[0].id);
      return { user: me.user, workspace: me.workspaces[0] };
    },

    async signIn({ email, password }) {
      const sdk = await getSdk();
      const { data, error } = await sdk.auth.signInWithPassword({ email, password });
      if (error) {
        const err = new Error(error.message || 'Sign in failed.');
        err.code = error.error || 'AUTH_ERROR';
        throw err;
      }
      localStorage.setItem(TOKEN_KEY, data.accessToken);
      return request('/api/auth/me');
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

    async signOut() {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
      try {
        const sdk = await getSdk();
        await sdk.auth.signOut();
      } catch {
        // best-effort — the local token is already cleared either way
      }
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
    create(name) {
      return request('/api/workspaces', { method: 'POST', body: { name } });
    },
    getMembers(workspaceId) {
      return request(`/api/workspaces/${workspaceId}/members`);
    },
    getStats(workspaceId) {
      return request(`/api/workspaces/${workspaceId}/stats`);
    },
    invite(workspaceId, email) {
      return request(`/api/workspaces/${workspaceId}/invitations`, { method: 'POST', body: { email } });
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
    // These four now call real InsForge Edge Functions directly (Phase 3 —
    // see functions/*/index.ts) instead of this app's Express server;
    // Postgres RLS (not a manual membership check) scopes dataset access.
    getKpis(id, { startDate, endDate, region } = {}) {
      return invokeFunction('compute-kpis', { dataset_id: id, start_date: startDate, end_date: endDate, region });
    },
    getForecast(id, horizonDays) {
      return invokeFunction('forecast-revenue', { dataset_id: id, horizon_days: horizonDays });
    },
    getSegments(id) {
      return invokeFunction('segment-customers', { dataset_id: id });
    },
    getAnomalies(id) {
      return invokeFunction('detect-anomalies', { dataset_id: id });
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

  reports: {
    generate(datasetId, reportType) {
      return request(`/api/datasets/${datasetId}/reports`, { method: 'POST', body: { report_type: reportType } });
    },
    list(datasetId) {
      return request(`/api/datasets/${datasetId}/reports`);
    },
  },

  shares: {
    list(workspaceId) {
      return request(`/api/workspaces/${workspaceId}/shares`);
    },
    refresh(shareId) {
      return request(`/api/shares/${shareId}/refresh`, { method: 'POST' });
    },
    revoke(shareId) {
      return request(`/api/shares/${shareId}/revoke`, { method: 'POST' });
    },
  },
};
