import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// JSON-file-backed store standing in for InsForge Postgres during local
// development. Implements the subset of db/schema.sql needed for Milestones
// 1-2 (users, workspaces, workspace_members). Every lookup that returns
// workspace-scoped data goes through membership, mirroring the RLS policies
// in db/schema.sql so the isolation behavior matches what the real backend
// will enforce.
export function createDb(filePath) {
  let data = { users: [], workspaces: [], workspace_members: [] };

  if (filePath && fs.existsSync(filePath)) {
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      // corrupt/empty file — start fresh rather than crashing the server
      data = { users: [], workspaces: [], workspace_members: [] };
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
  };
}
