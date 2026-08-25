import { insforge } from '../insforge-client.js';
import { el } from '../lib/dom-safe.js';

const noDatasetState = document.getElementById('no-dataset-state');
const reportsContent = document.getElementById('reports-content');
const reportsEmpty = document.getElementById('reports-empty');
const reportsTable = document.getElementById('reports-table');
const reportsTableBody = document.getElementById('reports-table-body');

const REPORT_LABELS = {
  analytics_summary: 'Analytics Summary',
  sales_forecast: 'Sales Forecast',
  customer_segmentation: 'Customer Segmentation',
  cleaned_dataset: 'Cleaned Dataset',
};

let datasetId = null;

function statusPillClass(status) {
  if (status === 'active') return 'pill pill-success';
  if (status === 'expired') return 'pill pill-warning';
  return 'pill pill-default';
}

async function copyLink(url) {
  const fullUrl = `${window.location.origin}${url}`;
  await navigator.clipboard.writeText(fullUrl).catch(() => {});
}

function renderReports(shares) {
  reportsTableBody.replaceChildren();
  if (shares.length === 0) {
    reportsEmpty.hidden = false;
    reportsTable.hidden = true;
    return;
  }
  reportsEmpty.hidden = true;
  reportsTable.hidden = false;

  for (const share of shares) {
    const row = document.createElement('tr');
    row.appendChild(el('td', { text: REPORT_LABELS[share.report_type] || share.report_type }));
    row.appendChild(el('td', { text: new Date(share.created_at).toLocaleString() }));

    const statusCell = document.createElement('td');
    statusCell.appendChild(el('span', { className: statusPillClass(share.status), text: share.status }));
    row.appendChild(statusCell);

    const actionsCell = document.createElement('td');
    const downloadLink = el('a', { text: 'Download', attrs: { href: share.url, target: '_blank', rel: 'noopener' } });
    downloadLink.className = 'pill-action';
    const copyBtn = el('button', { className: 'pill-action', text: 'Copy link', attrs: { type: 'button' } });
    copyBtn.addEventListener('click', () => copyLink(share.url));
    actionsCell.appendChild(downloadLink);
    actionsCell.appendChild(copyBtn);
    row.appendChild(actionsCell);

    reportsTableBody.appendChild(row);
  }
}

async function loadReports() {
  const { shares } = await insforge.reports.list(datasetId);
  renderReports(shares);
}

for (const btn of document.querySelectorAll('[data-report-type]')) {
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Generating…';
    try {
      await insforge.reports.generate(datasetId, btn.dataset.reportType);
      await loadReports();
    } catch (err) {
      window.alert(err.message || 'Could not generate this report.');
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });
}

document.addEventListener('verdant:session-ready', async (e) => {
  const workspaceId = e.detail.activeWorkspaceId;
  datasetId = insforge.datasets.getActiveId(workspaceId);

  if (!datasetId) {
    noDatasetState.hidden = false;
    return;
  }

  try {
    const { dataset } = await insforge.datasets.get(datasetId);
    if (dataset.status !== 'ready') {
      noDatasetState.hidden = false;
      return;
    }
    reportsContent.hidden = false;
    await loadReports();
  } catch {
    noDatasetState.hidden = false;
  }
});
