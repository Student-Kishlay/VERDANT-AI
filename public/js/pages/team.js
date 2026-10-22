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

const myInvitationsSection = document.getElementById('my-invitations-section');
const myInvitationsList = document.getElementById('my-invitations-list');
const myInvitationsError = document.getElementById('my-invitations-error');

let workspaceId = null;

// Invitations addressed to the signed-in user's email. ?invite=<id> (the
// link in the invitation email) highlights that one.
async function loadMyInvitations() {
  const { invitations } = await insforge.invitations.listMine();
  const highlightId = new URLSearchParams(window.location.search).get('invite');
  myInvitationsList.replaceChildren();
  myInvitationsSection.hidden = invitations.length === 0;

  if (highlightId && !invitations.some((i) => i.id === highlightId)) {
    myInvitationsSection.hidden = false;
    myInvitationsError.textContent =
      'That invitation is no longer available, or it was sent to a different email than the one you are signed in with.';
  }

  for (const inv of invitations) {
    const item = el('li', { className: inv.id === highlightId ? 'invitation-item highlighted' : 'invitation-item' });
    const by = inv.invited_by ? ` (invited by ${inv.invited_by})` : '';
    item.appendChild(el('span', { text: `${inv.workspace_name || 'A workspace'}${by}` }));

    const accept = el('button', { className: 'btn', text: 'Accept' });
    const decline = el('button', { className: 'btn btn-secondary', text: 'Decline' });
    accept.type = decline.type = 'button';

    accept.addEventListener('click', async () => {
      myInvitationsError.textContent = '';
      try {
        const { workspace } = await insforge.invitations.accept(inv.id);
        await insforge.workspaces.switchTo(workspace.id);
        window.location.href = '/team.html';
      } catch (err) {
        myInvitationsError.textContent = err.message || 'Could not accept this invitation.';
      }
    });
    decline.addEventListener('click', async () => {
      myInvitationsError.textContent = '';
      try {
        await insforge.invitations.decline(inv.id);
        await loadMyInvitations();
      } catch (err) {
        myInvitationsError.textContent = err.message || 'Could not decline this invitation.';
      }
    });

    item.appendChild(accept);
    item.appendChild(decline);
    myInvitationsList.appendChild(item);
  }
}

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
    const result = await insforge.workspaces.invite(workspaceId, email);
    inviteEmailInput.value = '';
    if (result && result.email_sent === false) {
      inviteError.textContent = `Invitation created, but the email to ${email} couldn't be sent. They can still accept it from the Team page after signing in with that email.${result.email_error ? ` Reason: ${result.email_error}` : ''}`;
    }
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

  await Promise.all([loadMembers(), loadMyInvitations()]);
});
