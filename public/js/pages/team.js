import { insforge } from '../insforge-client.js';
import { el } from '../lib/dom-safe.js';

const membersTableBody = document.getElementById('members-table-body');
const inviteSection = document.getElementById('invite-section');
const memberOnlyNote = document.getElementById('member-only-note');
const inviteForm = document.getElementById('invite-form');
const inviteEmailInput = document.getElementById('invite-email');
const inviteError = document.getElementById('invite-error');
const createWorkspaceForm = document.getElementById('create-workspace-form');
const workspaceNameInput = document.getElementById('workspace-name');

let workspaceId = null;

async function loadMembers() {
  const { members, pending_invitations: pending } = await insforge.workspaces.getMembers(workspaceId);
  membersTableBody.replaceChildren();

  for (const m of members) {
    const row = document.createElement('tr');
    row.appendChild(el('td', { text: m.display_name || '—' }));
    row.appendChild(el('td', { text: m.email || '—' }));
    row.appendChild(el('td', { className: 'role-badge', text: m.role }));
    membersTableBody.appendChild(row);
  }

  for (const p of pending) {
    const row = document.createElement('tr');
    row.appendChild(el('td', { text: '—' }));
    row.appendChild(el('td', { text: p.invited_email }));
    const roleCell = document.createElement('td');
    roleCell.appendChild(el('span', { className: 'pill pill-warning', text: 'pending' }));
    row.appendChild(roleCell);
    membersTableBody.appendChild(row);
  }
}

inviteForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  inviteError.textContent = '';
  const email = inviteEmailInput.value.trim();
  if (!email) return;

  try {
    await insforge.workspaces.invite(workspaceId, email);
    inviteEmailInput.value = '';
    await loadMembers();
  } catch (err) {
    inviteError.textContent = err.message || 'Could not send this invitation.';
  }
});

createWorkspaceForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = workspaceNameInput.value.trim();
  if (!name) return;

  await insforge.workspaces.create(name);
  window.alert(`"${name}" created — switch to it from the workspace selector in the sidebar.`);
  window.location.reload();
});

document.addEventListener('verdant:session-ready', async (e) => {
  workspaceId = e.detail.activeWorkspaceId;
  const activeWorkspace = e.detail.session.workspaces.find((w) => w.id === workspaceId);
  const isOwner = activeWorkspace?.role === 'owner';

  inviteSection.hidden = !isOwner;
  memberOnlyNote.hidden = isOwner;

  await loadMembers();
});
