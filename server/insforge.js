import jwt from 'jsonwebtoken';

// Thin REST wrapper around InsForge's PostgREST-style Database API
// (`/api/database/records/{table}`), used server-side with the project's
// admin API key — which bypasses Row Level Security, the same way a
// service-role key does. Client-side code (public/js/insforge-client.js)
// talks to InsForge directly with the user's own session instead, subject
// to RLS.
//
// Replaces the entire JSON-file mock (server/db.js used to persist to
// server/data/db.json) now that a real InsForge Postgres project exists
// (see db/insforge-schema.sql).

function need(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required — check .env`);
  return value;
}

export function createInsforgeClient({ baseUrl, apiKey, jwtPublicKey } = {}) {
  const base = baseUrl || need('INSFORGE_PROJECT_URL');
  const key = apiKey || need('INSFORGE_SERVICE_ROLE_KEY');
  const publicKey = (jwtPublicKey || need('INSFORGE_JWT_PUBLIC_KEY')).replace(/\\n/g, '\n');

  async function request(method, path, { body, prefer } = {}) {
    const headers = { Authorization: `Bearer ${key}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (prefer) headers.Prefer = prefer;

    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`InsForge ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  function qs(filters) {
    const params = new URLSearchParams();
    for (const [column, value] of Object.entries(filters || {})) {
      params.set(column, `eq.${value}`);
    }
    return params.toString();
  }

  return {
    // Verifies an InsForge-issued access token (RS256) and returns its
    // claims ({ sub, email, role, iat, exp }) — throws if invalid/expired.
    verifyToken(token) {
      return jwt.verify(token, publicKey, { algorithms: ['RS256'] });
    },

    async select(table, filters, { select, order, limit, offset } = {}) {
      const params = new URLSearchParams(qs(filters));
      if (select) params.set('select', select);
      if (order) params.set('order', order);
      if (limit) params.set('limit', String(limit));
      if (offset) params.set('offset', String(offset));
      const query = params.toString();
      return request('GET', `/api/database/records/${table}${query ? `?${query}` : ''}`);
    },

    async selectOne(table, filters) {
      const rows = await this.select(table, filters, { limit: 1 });
      return rows[0] || null;
    },

    // The Database API pages at up to 1000 rows — datasets can have far
    // more rows than that (MAX_UPLOAD_ROW_COUNT), so this loops until a
    // page comes back short.
    async selectAll(table, filters, { order, pageSize = 1000 } = {}) {
      const out = [];
      let offset = 0;
      for (;;) {
        const page = await this.select(table, filters, { order, limit: pageSize, offset });
        out.push(...page);
        if (page.length < pageSize) return out;
        offset += pageSize;
      }
    },

    async insert(table, rows) {
      const inserted = await request('POST', `/api/database/records/${table}`, {
        body: rows,
        prefer: 'return=representation',
      });
      return inserted;
    },

    // Same page-size limit applies to writes — chunk large row sets (e.g.
    // dataset_rows for a big upload) into several inserts.
    async insertMany(table, rows, chunkSize = 500) {
      const out = [];
      for (let i = 0; i < rows.length; i += chunkSize) {
        out.push(...(await this.insert(table, rows.slice(i, i + chunkSize))));
      }
      return out;
    },

    async update(table, filters, patch) {
      const query = qs(filters);
      return request('PATCH', `/api/database/records/${table}?${query}`, {
        body: patch,
        prefer: 'return=representation',
      });
    },

    async remove(table, filters) {
      const query = qs(filters);
      return request('DELETE', `/api/database/records/${table}?${query}`);
    },

    // Admin user lookups — auth.users isn't exposed via the generic
    // database records API, so these go through InsForge's dedicated admin
    // auth endpoints instead (still admin-key authenticated).
    async getUser(id) {
      return request('GET', `/api/auth/users/${id}`);
    },

    async findUserByEmail(email) {
      const { data: users } = await request('GET', `/api/auth/users?email=${encodeURIComponent(email)}`);
      return users.find((u) => u.email.toLowerCase() === email.toLowerCase()) || null;
    },
  };
}
