import { insforge } from '../insforge-client.js';
import { el } from '../lib/dom-safe.js';

const sharesEmpty = document.getElementById('shares-empty');
const sharesTable = document.getElementById('shares-table');
const sharesTableBody = document.getElementById('shares-table-body');

const REPORT_LABELS = {
  analytics_summary: 'Analytics Summary',
  sales_forecast: 'Sales Forecast',
  customer_segmentation: 'Customer Segmentation',
  cleaned_dataset: 'Cleaned Dataset',
};

let workspaceId = null;

function statusPillClass(status) {
  if (status === 'active') return 'pill pill-success';
  if (status === 'expired') return 'pill pill-warning';
  return 'pill pill-default';
}

async function copyLink(url) {
  const fullUrl = `${window.location.origin}${url}`;
  await navigator.clipboard.writeText(fullUrl).catch(() => {});
}

async function loadShares() {
  const { shares } = await insforge.shares.list(workspaceId);
  renderShares(shares);
}

function renderShares(shares) {
  sharesTableBody.replaceChildren();
  if (shares.length === 0) {
    sharesEmpty.hidden = false;
    sharesTable.hidden = true;
    return;
  }
  sharesEmpty.hidden = true;
  sharesTable.hidden = false;

  for (const share of shares) {
    const row = document.createElement('tr');
    row.appendChild(el('td', { text: REPORT_LABELS[share.report_type] || share.report_type }));
    row.appendChild(el('td', { text: new Date(share.created_at).toLocaleString() }));
    row.appendChild(el('td', { text: new Date(share.expires_at).toLocaleString() }));

    const statusCell = document.createElement('td');
    statusCell.appendChild(el('span', { className: statusPillClass(share.status), text: share.status }));
    row.appendChild(statusCell);

    const actionsCell = document.createElement('td');

    const copyBtn = el('button', { className: 'pill-action', text: 'Copy', attrs: { type: 'button' } });
    copyBtn.addEventListener('click', () => copyLink(share.url));

    const openLink = el('a', { className: 'pill-action', text: 'Open', attrs: { href: share.url, target: '_blank', rel: 'noopener' } });

    const refreshBtn = el('button', { className: 'pill-action', text: 'Refresh', attrs: { type: 'button' } });
    refreshBtn.addEventListener('click', async () => {
      await insforge.shares.refresh(share.id);
      await loadShares();
    });

    const revokeBtn = el('button', {
      className: 'pill-action pill-action-danger',
      text: 'Revoke',
      attrs: { type: 'button' },
    });
    revokeBtn.disabled = share.revoked;
    revokeBtn.addEventListener('click', async () => {
      if (!window.confirm('Revoke this share link? It will stop working immediately.')) return;
      await insforge.shares.revoke(share.id);
      await loadShares();
    });

    actionsCell.appendChild(copyBtn);
    actionsCell.appendChild(openLink);
    actionsCell.appendChild(refreshBtn);
    actionsCell.appendChild(revokeBtn);
    row.appendChild(actionsCell);

    sharesTableBody.appendChild(row);
  }
}

document.addEventListener('verdant:session-ready', async (e) => {
  workspaceId = e.detail.activeWorkspaceId;
  await loadShares();
});
