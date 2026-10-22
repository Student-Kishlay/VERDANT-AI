import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';

// A tiny in-memory stand-in for server/insforge.js's real REST client, used
// only by tests. Real InsForge (Postgres + Auth) is an external, shared,
// network-dependent service — tests need an isolated, fast, no-network
// substitute that implements the exact same async interface (select/
// selectAll/insert/insertMany/update/remove/verifyToken/getUser/
// findUserByEmail) so server/db.js and server/app.js run unmodified
// against it.
const TEST_JWT_SECRET = 'test-only-insforge-secret';

const TABLES = [
  'workspaces',
  'workspace_members',
  'workspace_invitations',
  'datasets',
  'column_maps',
  'dataset_rows',
  'forecasts',
  'segments',
  'anomalies',
  'chat_messages',
  'report_shares',
];

export function createFakeInsforge() {
  const tables = Object.fromEntries(TABLES.map((t) => [t, []]));
  const users = new Map(); // id -> { id, email, profile: { name } }

  function matches(row, filters) {
    return Object.entries(filters || {}).every(([k, v]) => String(row[k]) === String(v));
  }

  function applyOrder(rows, order) {
    if (!order) return rows;
    const [column, dir] = order.split('.');
    const sorted = [...rows].sort((a, b) => (a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0));
    return dir === 'desc' ? sorted.reverse() : sorted;
  }

  return {
    // ── test-only helper, not part of the real client's interface ────────
    _testSignUp(email, name) {
      const id = randomUUID();
      users.set(id, { id, email, profile: { name: name || email.split('@')[0] } });
      const accessToken = jwt.sign({ sub: id, email, role: 'authenticated' }, TEST_JWT_SECRET, { expiresIn: '1h' });
      return { id, email, accessToken };
    },

    verifyToken(token) {
      return jwt.verify(token, TEST_JWT_SECRET, { algorithms: ['HS256'] });
    },

    async getUser(id) {
      const user = users.get(id);
      if (!user) throw new Error('not found');
      return user;
    },

    async findUserByEmail(email) {
      return [...users.values()].find((u) => u.email.toLowerCase() === email.toLowerCase()) || null;
    },

    // Records instead of sending, so tests can assert on invitation emails.
    sentEmails: [],
    async sendEmail(email) {
      this.sentEmails.push(email);
      return { success: true };
    },

    async select(table, filters, { order, limit, offset = 0 } = {}) {
      let rows = tables[table].filter((row) => matches(row, filters));
      rows = applyOrder(rows, order);
      if (offset) rows = rows.slice(offset);
      if (limit) rows = rows.slice(0, limit);
      return rows;
    },

    async selectOne(table, filters) {
      const rows = await this.select(table, filters, { limit: 1 });
      return rows[0] || null;
    },

    async selectAll(table, filters, { order } = {}) {
      return this.select(table, filters, { order });
    },

    async insert(table, rows) {
      const inserted = rows.map((row) => ({
        id: row.id || randomUUID(),
        created_at: new Date().toISOString(),
        joined_at: new Date().toISOString(),
        status: row.status || (table === 'workspace_invitations' ? 'pending' : undefined),
        ...row,
      }));
      tables[table].push(...inserted);
      return inserted;
    },

    async insertMany(table, rows) {
      return this.insert(table, rows);
    },

    async update(table, filters, patch) {
      const updated = [];
      for (const row of tables[table]) {
        if (matches(row, filters)) {
          Object.assign(row, patch);
          updated.push(row);
        }
      }
      return updated;
    },

    async remove(table, filters) {
      tables[table] = tables[table].filter((row) => !matches(row, filters));
      return null;
    },
  };
}
