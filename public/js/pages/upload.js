import { insforge } from '../insforge-client.js';
import { el } from '../lib/dom-safe.js';

const ROLE_OPTIONS = [
  { value: '', label: '— none —' },
  { value: 'date', label: 'Date' },
  { value: 'revenue', label: 'Revenue' },
  { value: 'product', label: 'Product' },
  { value: 'region', label: 'Region' },
  { value: 'category', label: 'Category' },
  { value: 'customer', label: 'Customer' },
  { value: 'quantity', label: 'Quantity' },
  { value: 'order', label: 'Order' },
];

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const statusEl = document.getElementById('upload-status');
const dropzoneLimits = document.getElementById('dropzone-limits');
const summarySection = document.getElementById('summary-section');
const summaryPills = document.getElementById('summary-pills');
const columnsSection = document.getElementById('columns-section');
const columnsBody = document.getElementById('columns-table-body');
const previewSection = document.getElementById('preview-section');
const previewHead = document.getElementById('preview-table-head');
const previewBody = document.getElementById('preview-table-body');

let workspaceId = null;
let config = null;

function showStatus(message, kind = 'info') {
  statusEl.hidden = false;
  statusEl.className = `upload-status upload-status-${kind}`;
  statusEl.textContent = message;
}

function clearStatus() {
  statusEl.hidden = true;
  statusEl.textContent = '';
}

function pill(text, kind = 'default') {
  return el('span', { className: `pill pill-${kind}`, text });
}

function renderSummary(summary) {
  summaryPills.replaceChildren();
  if (summary.duplicates_removed > 0) {
    summaryPills.appendChild(pill(`Removed ${summary.duplicates_removed} duplicate row(s)`, 'warning'));
  }
  if (summary.rows_removed_empty > 0) {
    summaryPills.appendChild(pill(`Removed ${summary.rows_removed_empty} empty row(s)`, 'warning'));
  }
  const filledCols = Object.keys(summary.missing_filled);
  if (filledCols.length > 0) {
    summaryPills.appendChild(pill(`Filled missing values in ${filledCols.length} column(s)`, 'warning'));
  }
  if (summary.date_columns.length > 0) {
    summaryPills.appendChild(pill(`Parsed ${summary.date_columns.length} date column(s)`, 'success'));
  }
  if (summary.numeric_columns.length > 0) {
    summaryPills.appendChild(pill(`Detected ${summary.numeric_columns.length} numeric column(s)`, 'success'));
  }
  summaryPills.appendChild(pill(`${summary.final_row_count} rows × ${summary.final_column_count} columns`, 'default'));
  summarySection.hidden = false;
}

function renderColumns(datasetId, columns) {
  columnsBody.replaceChildren();
  for (const col of columns) {
    const row = document.createElement('tr');
    row.appendChild(el('td', { text: col.column_name }));
    row.appendChild(el('td', { text: col.detected_role || '—' }));
    row.appendChild(el('td', { text: `${Math.round(col.confidence * 100)}%` }));

    const overrideCell = document.createElement('td');
    const select = document.createElement('select');
    select.className = 'role-select';
    select.setAttribute('aria-label', `Role override for ${col.column_name}`);
    for (const opt of ROLE_OPTIONS) {
      const optionEl = document.createElement('option');
      optionEl.value = opt.value;
      optionEl.textContent = opt.label;
      if ((col.user_override || '') === opt.value) optionEl.selected = true;
      select.appendChild(optionEl);
    }
    select.addEventListener('change', async () => {
      await insforge.datasets.setColumnOverride(datasetId, col.column_name, select.value || null);
    });
    overrideCell.appendChild(select);
    row.appendChild(overrideCell);
    columnsBody.appendChild(row);
  }
  columnsSection.hidden = false;
}

function renderPreview(columns, previewRows) {
  previewHead.replaceChildren();
  previewBody.replaceChildren();
  if (previewRows.length === 0) {
    previewSection.hidden = true;
    return;
  }

  const headRow = document.createElement('tr');
  for (const col of columns) {
    headRow.appendChild(el('th', { text: col.column_name }));
  }
  previewHead.appendChild(headRow);

  for (const row of previewRows.slice(0, 10)) {
    const tr = document.createElement('tr');
    for (const col of columns) {
      // Dataset-derived values are untrusted — el() sets textContent, never innerHTML (§4.1).
      tr.appendChild(el('td', { text: row[col.column_name] ?? '' }));
    }
    previewBody.appendChild(tr);
  }
  previewSection.hidden = false;
}

function renderReady(dataset) {
  renderSummary(dataset.cleaning_summary);
  renderColumns(dataset.id, dataset.columns);
  renderPreview(dataset.columns, dataset.preview_rows);

  insforge.datasets.setActiveId(workspaceId, dataset.id);
  const sidebarValue = document.querySelector('#sidebar-mount .active-dataset-value');
  if (sidebarValue) sidebarValue.textContent = `${dataset.file_name} · ${dataset.row_count.toLocaleString()} rows`;
}

function resetResultSections() {
  summarySection.hidden = true;
  columnsSection.hidden = true;
  previewSection.hidden = true;
}

async function pollUntilSettled(datasetId) {
  let dataset = (await insforge.datasets.get(datasetId)).dataset;
  while (dataset.status === 'processing') {
    await new Promise((r) => setTimeout(r, 800));
    dataset = (await insforge.datasets.get(datasetId)).dataset;
  }
  return dataset;
}

async function handleFile(file) {
  resetResultSections();

  const ext = `.${file.name.split('.').pop().toLowerCase()}`;
  if (!config.allowedFileTypes.includes(ext)) {
    showStatus(`Only ${config.allowedFileTypes.join(' and ')} files are supported.`, 'error');
    return;
  }
  const maxBytes = config.maxUploadFileSizeMb * 1024 * 1024;
  if (file.size > maxBytes) {
    showStatus(`This file is larger than the ${config.maxUploadFileSizeMb}MB limit.`, 'error');
    return;
  }

  showStatus(`Uploading ${file.name}…`, 'info');
  try {
    const { dataset, alreadyExists } = await insforge.datasets.upload(file, workspaceId);

    if (alreadyExists) {
      showStatus(
        `This file was already uploaded on ${new Date(dataset.uploaded_at).toLocaleDateString()} — opening the existing dataset.`,
        'info'
      );
    } else {
      clearStatus();
    }

    const settled = dataset.status === 'processing' ? await pollUntilSettled(dataset.id) : dataset;

    if (settled.status === 'failed') {
      showStatus(`This file couldn't be processed: ${settled.failure_reason}`, 'error');
      return;
    }

    if (!alreadyExists) clearStatus();
    renderReady(settled);
  } catch (err) {
    showStatus(err.message || 'Upload failed. Please try again.', 'error');
  }
}

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dropzone-active');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dropzone-active'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dropzone-active');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

document.addEventListener('verdant:session-ready', async (e) => {
  workspaceId = e.detail.activeWorkspaceId;
  config = await insforge.config.get();
  dropzoneLimits.textContent = `${config.allowedFileTypes.join(', ')}, up to ${config.maxUploadFileSizeMb}MB`;

  // Returning to this page should show the workspace's existing dataset
  // (summary, columns, preview) rather than a blank dropzone every time.
  const activeId = insforge.datasets.getActiveId(workspaceId);
  if (!activeId) return;
  try {
    const { dataset } = await insforge.datasets.get(activeId);
    if (dataset.status === 'ready') renderReady(dataset);
    else if (dataset.status === 'failed') showStatus(`This file couldn't be processed: ${dataset.failure_reason}`, 'error');
  } catch {
    insforge.datasets.clearActiveId(workspaceId);
  }
});
