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

async function request(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
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
};
