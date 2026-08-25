// Shared app shell: sidebar nav, workspace switcher, active-dataset indicator,
// and user chip. Included on every page except login.html. Guards each page
// behind a session check and renders the identical shell everywhere, per
// Master Prompt §3's shared-shell requirement.
import { insforge } from './insforge-client.js';
import { el } from './lib/dom-safe.js';

const NAV_ITEMS = [
  { href: '/index.html', label: 'Home', eyebrow: 'HOME' },
  { href: '/upload.html', label: 'Upload & Clean', eyebrow: 'DATA' },
  { href: '/dashboard.html', label: 'Dashboard', eyebrow: 'ANALYTICS' },
  { href: '/insights.html', label: 'Insights', eyebrow: 'PREDICTIVE' },
  { href: '/chat.html', label: 'AI Chat', eyebrow: 'ASSISTANT' },
  { href: '/reports.html', label: 'Reports', eyebrow: 'REPORTS' },
  { href: '/shares.html', label: 'Share Manager', eyebrow: 'SHARING' },
  { href: '/team.html', label: 'Team', eyebrow: 'TEAM' },
  { href: '/profile.html', label: 'Profile', eyebrow: 'ACCOUNT' },
];

function currentPage() {
  const path = window.location.pathname;
  return path.substring(path.lastIndexOf('/') + 1) || 'index.html';
}

function buildSidebar(session, workspaces, activeWorkspaceId) {
  const aside = el('div', { className: 'sidebar' });

  const brand = el('div', { className: 'sidebar-brand' });
  brand.appendChild(el('span', { className: 'sidebar-brand-mark', text: 'V' }));
  brand.appendChild(el('span', { className: 'sidebar-brand-name', text: 'Verdant BI' }));
  aside.appendChild(brand);

  // Workspace switcher
  const switcherWrap = el('div', { className: 'workspace-switcher' });
  const select = document.createElement('select');
  select.className = 'workspace-select';
  select.setAttribute('aria-label', 'Active workspace');
  for (const ws of workspaces) {
    const option = document.createElement('option');
    option.value = ws.id;
    option.textContent = ws.name; // .textContent, not innerHTML — safe for untrusted names
    if (ws.id === activeWorkspaceId) option.selected = true;
    select.appendChild(option);
  }
  select.addEventListener('change', async (e) => {
    await insforge.workspaces.switchTo(e.target.value);
    window.location.reload();
  });
  switcherWrap.appendChild(select);
  aside.appendChild(switcherWrap);

  // Active dataset indicator — populated asynchronously by refreshActiveDataset()
  // once this element is in the DOM (it needs to fetch, and possibly render a
  // working delete action).
  const datasetIndicator = el('div', { className: 'active-dataset' });
  datasetIndicator.appendChild(el('span', { className: 'active-dataset-label', text: 'Active dataset' }));
  datasetIndicator.appendChild(el('span', { className: 'active-dataset-value', text: 'None uploaded yet' }));
  aside.appendChild(datasetIndicator);

  // Nav
  const nav = el('nav', { className: 'sidebar-nav' });
  const page = currentPage();
  for (const item of NAV_ITEMS) {
    const link = el('a', { className: 'sidebar-nav-item', text: item.label, attrs: { href: item.href } });
    const isActive = item.href.endsWith(page);
    if (isActive) link.classList.add('active');
    nav.appendChild(link);
  }
  aside.appendChild(nav);

  // User chip
  const chip = el('div', { className: 'user-chip' });
  const initial = (session.user.display_name || session.user.email || '?').charAt(0).toUpperCase();
  const avatar = el('span', { className: 'user-chip-avatar', text: initial });
  const info = el('div', { className: 'user-chip-info' });
  info.appendChild(el('span', { className: 'user-chip-name', text: session.user.display_name }));
  info.appendChild(el('span', { className: 'user-chip-email', text: session.user.email }));
  const logoutBtn = el('button', { className: 'user-chip-logout', text: 'Log out', attrs: { type: 'button' } });
  logoutBtn.addEventListener('click', () => {
    insforge.auth.signOut();
    window.location.href = '/login.html';
  });
  chip.appendChild(avatar);
  chip.appendChild(info);
  chip.appendChild(logoutBtn);
  aside.appendChild(chip);

  return aside;
}

async function refreshActiveDataset(container, workspaceId) {
  const datasetId = insforge.datasets.getActiveId(workspaceId);
  if (!datasetId) return; // stays on the default "None uploaded yet" markup

  let dataset;
  try {
    ({ dataset } = await insforge.datasets.get(datasetId));
  } catch {
    // Deleted elsewhere, or belongs to a workspace we've since switched away
    // from — clear the stale pointer rather than showing a broken indicator.
    insforge.datasets.clearActiveId(workspaceId);
    return;
  }

  const valueEl = container.querySelector('.active-dataset-value');
  const rowCountText = dataset.status === 'ready' ? `${dataset.row_count.toLocaleString()} rows` : dataset.status;
  valueEl.textContent = `${dataset.file_name} · ${rowCountText}`;

  if (!container.querySelector('.active-dataset-delete')) {
    const deleteBtn = el('button', {
      className: 'active-dataset-delete',
      text: 'Delete active dataset',
      attrs: { type: 'button' },
    });
    deleteBtn.addEventListener('click', async () => {
      if (!window.confirm(`Delete "${dataset.file_name}"? This cannot be undone.`)) return;
      await insforge.datasets.remove(dataset.id);
      insforge.datasets.clearActiveId(workspaceId);
      window.location.reload();
    });
    container.appendChild(deleteBtn);
  }
}

function buildTopbar(activeItem) {
  const header = el('div', { className: 'topbar' });
  const hamburger = el('button', {
    className: 'hamburger',
    text: '☰',
    attrs: { type: 'button', 'aria-label': 'Toggle navigation' },
  });
  hamburger.addEventListener('click', () => {
    document.querySelector('.app-layout')?.classList.toggle('sidebar-open');
  });
  header.appendChild(hamburger);

  const titleWrap = el('div', { className: 'topbar-titles' });
  titleWrap.appendChild(el('span', { className: 'eyebrow', text: activeItem?.eyebrow || '' }));
  titleWrap.appendChild(el('h1', { className: 'page-title', text: activeItem?.label || '' }));
  header.appendChild(titleWrap);

  return header;
}

async function init() {
  const session = await insforge.auth.getSession();
  if (!session) {
    window.location.href = '/login.html';
    return;
  }

  let activeWorkspaceId = insforge.workspaces.getActiveId();
  const hasActive = session.workspaces.some((w) => w.id === activeWorkspaceId);
  if (!hasActive) {
    activeWorkspaceId = session.workspaces[0]?.id;
  }

  const sidebarMount = document.getElementById('sidebar-mount');
  const topbarMount = document.getElementById('topbar-mount');
  if (!sidebarMount || !topbarMount) return;

  const page = currentPage();
  const activeItem = NAV_ITEMS.find((item) => item.href.endsWith(page));

  sidebarMount.replaceChildren(buildSidebar(session, session.workspaces, activeWorkspaceId));
  topbarMount.replaceChildren(buildTopbar(activeItem));

  if (activeWorkspaceId) {
    refreshActiveDataset(sidebarMount.querySelector('.active-dataset'), activeWorkspaceId);
  }

  document.dispatchEvent(new CustomEvent('verdant:session-ready', { detail: { session, activeWorkspaceId } }));
}

init();
