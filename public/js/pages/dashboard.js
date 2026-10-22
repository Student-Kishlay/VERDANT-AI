import { insforge } from '../insforge-client.js';
import { el } from '../lib/dom-safe.js';

const noDatasetState = document.getElementById('no-dataset-state');
const unavailableState = document.getElementById('unavailable-state');
const unavailableMessage = document.getElementById('unavailable-message');
const dashboardContent = document.getElementById('dashboard-content');

const startDateInput = document.getElementById('filter-start-date');
const endDateInput = document.getElementById('filter-end-date');
const regionSelect = document.getElementById('filter-region');
const categorySelect = document.getElementById('filter-category');
const categoryField = document.getElementById('filter-category-field');
const clearFiltersBtn = document.getElementById('filter-clear');
const presetButtons = [...document.querySelectorAll('.range-presets .preset')];
const rangeNote = document.getElementById('range-note');
const spendInput = document.getElementById('cv-spend');

const currencyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const compactCurrency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact' });

const SERIES_COLOR = '#12855c'; // --color-accent
const BAR_COLOR = '#4d78a2'; // --color-brand-blue
const BAR_MUTED = '#c9d6e3';

let workspaceId = null;
let datasetId = null;
let optionsPopulated = false;
let revenueTrendChart = null;
let categoryMixChart = null;
let lastKpis = null;
let requestSeq = 0;

// ── Dates ──────────────────────────────────────────────────────────────
// Dates are plain 'YYYY-MM-DD' strings throughout; do the arithmetic in UTC
// so a local timezone offset can never shift a day.

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function monthLabel(yearMonth) {
  const [y, m] = yearMonth.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// Presets count back from the latest date in the dataset, not today, so a
// historical upload never opens on an empty "Last 7 days".
function presetRange(preset, latest) {
  switch (preset) {
    case '7d':
      return { start: addDays(latest, -6), end: latest };
    case '30d':
      return { start: addDays(latest, -29), end: latest };
    case 'this-month':
      return { start: `${latest.slice(0, 7)}-01`, end: latest };
    case 'last-month': {
      const firstOfThis = `${latest.slice(0, 7)}-01`;
      const lastOfPrev = addDays(firstOfThis, -1);
      return { start: `${lastOfPrev.slice(0, 7)}-01`, end: lastOfPrev };
    }
    default:
      return { start: '', end: '' };
  }
}

function setActivePreset(preset) {
  for (const btn of presetButtons) btn.setAttribute('aria-pressed', String(btn.dataset.preset === preset));
}

function currentFilters() {
  return {
    startDate: startDateInput.value || undefined,
    endDate: endDateInput.value || undefined,
    region: regionSelect.value || undefined,
    category: categorySelect.value || undefined,
  };
}

function describeFilters() {
  const f = currentFilters();
  const parts = [];
  if (f.startDate || f.endDate) parts.push(`${f.startDate || 'start'} to ${f.endDate || 'latest'}`);
  else parts.push('All time');
  if (f.region) parts.push(`Region: ${f.region}`);
  if (f.category) parts.push(`Category: ${f.category}`);
  return parts.join(' · ');
}

// ── Rendering ──────────────────────────────────────────────────────────

function populateSelect(select, values) {
  for (const value of values) {
    // dataset-derived value — textContent, never innerHTML
    select.appendChild(el('option', { text: value, attrs: { value } }));
  }
}

function populateOptions(kpis) {
  if (optionsPopulated) return;
  populateSelect(regionSelect, kpis.available_regions || []);
  const categories = kpis.available_categories || [];
  populateSelect(categorySelect, categories);
  categoryField.hidden = categories.length === 0;
  optionsPopulated = true;
}

function renderKpiCards(kpis) {
  document.getElementById('kpi-total-revenue').textContent = currencyFormatter.format(kpis.total_revenue);
  document.getElementById('kpi-total-orders').textContent = kpis.total_orders.toLocaleString();
  document.getElementById('kpi-aov').textContent = currencyFormatter.format(kpis.avg_order_value);
  document.getElementById('kpi-active-customers').textContent = kpis.active_customers.toLocaleString();
}

function renderMomBadges(mom) {
  for (const key of ['total_revenue', 'total_orders', 'avg_order_value', 'active_customers']) {
    const badge = document.getElementById(`mom-${key}`);
    badge.replaceChildren();
    badge.className = 'mom-badge';
    const change = mom?.changes?.[key];
    if (!change) continue;

    const period = `${monthLabel(mom.current_month)} vs ${monthLabel(mom.previous_month)}`;
    if (change.change_pct === null) {
      badge.classList.add('mom-flat');
      badge.append(el('span', { text: `No ${monthLabel(mom.previous_month)} data to compare` }));
      continue;
    }
    const pct = change.change_pct;
    const direction = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
    const arrow = direction === 'up' ? '▲' : direction === 'down' ? '▼' : '■';
    const sign = pct > 0 ? '+' : '';
    badge.classList.add(`mom-${direction}`);
    badge.append(
      el('span', { className: 'mom-change', text: `${arrow} ${sign}${pct}%` }),
      el('span', { className: 'mom-period', text: period }),
    );
  }
}

function renderRevenueTrend(revenueTrend, category) {
  document.getElementById('revenue-trend-title').textContent = category ? `Revenue Trend — ${category}` : 'Revenue Trend';
  const ctx = document.getElementById('revenue-trend-chart');
  revenueTrendChart?.destroy();
  revenueTrendChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: revenueTrend.map((p) => p.date),
      datasets: [
        {
          label: 'Revenue',
          data: revenueTrend.map((p) => p.revenue),
          borderColor: SERIES_COLOR,
          backgroundColor: 'rgba(18, 133, 92, 0.1)',
          borderWidth: 2,
          pointRadius: revenueTrend.length > 60 ? 0 : 3,
          pointHoverRadius: 5,
          tension: 0.25,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (item) => ` ${currencyFormatter.format(item.parsed.y)}` } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } },
        y: { beginAtZero: true, grid: { color: 'rgba(16, 25, 21, 0.06)' }, ticks: { callback: (v) => compactCurrency.format(v) } },
      },
    },
  });
}

function renderCategoryMix(categoryMix, selected) {
  const wrap = document.getElementById('category-mix-wrap');
  const emptyNote = document.getElementById('category-mix-empty');
  const hint = document.getElementById('category-mix-hint');

  if (categoryMix.length === 0) {
    wrap.hidden = true;
    hint.hidden = true;
    emptyNote.hidden = false;
    categoryMixChart?.destroy();
    categoryMixChart = null;
    return;
  }
  wrap.hidden = false;
  hint.hidden = false;
  emptyNote.hidden = true;
  hint.textContent = selected
    ? `Showing ${selected} only. Click it again (or Clear filters) to see every category.`
    : 'Click a bar to filter the dashboard to that category.';

  const ctx = document.getElementById('category-mix-chart');
  categoryMixChart?.destroy();
  categoryMixChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: categoryMix.map((c) => c.category),
      datasets: [
        {
          label: 'Revenue',
          data: categoryMix.map((c) => c.revenue),
          backgroundColor: categoryMix.map((c) => (!selected || c.category === selected ? BAR_COLOR : BAR_MUTED)),
          borderRadius: 4,
          maxBarThickness: 48,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      onClick: (_evt, elements) => {
        if (!elements.length) return;
        const clicked = categoryMix[elements[0].index].category;
        categorySelect.value = categorySelect.value === clicked ? '' : clicked;
        refresh();
      },
      onHover: (evt, elements) => {
        evt.native.target.style.cursor = elements.length ? 'pointer' : 'default';
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (item) => ` ${currencyFormatter.format(item.parsed.y)}` } },
      },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, grid: { color: 'rgba(16, 25, 21, 0.06)' }, ticks: { callback: (v) => compactCurrency.format(v) } },
      },
    },
  });
}

function renderTopProducts(kpis) {
  const body = document.getElementById('top-products-body');
  const wrap = document.getElementById('top-products-wrap');
  const empty = document.getElementById('top-products-empty');
  const products = kpis.top_products || [];
  body.replaceChildren();

  if (!kpis.product_available || products.length === 0) {
    wrap.hidden = true;
    empty.hidden = false;
    empty.textContent = kpis.product_available
      ? 'No product sales in the selected range.'
      : 'No product column detected. Mark a column as "product" on the Upload & Clean page to rank items.';
    return;
  }
  wrap.hidden = false;
  empty.hidden = true;

  const maxShare = Math.max(...products.map((p) => p.share_pct), 1);
  products.forEach((p, i) => {
    const bar = el('span', { className: 'share-bar' });
    bar.style.width = `${(p.share_pct / maxShare) * 100}%`;
    const shareCell = el('td', { className: 'share-cell' });
    shareCell.append(el('span', { className: 'share-track' }), el('span', { className: 'share-pct', text: `${p.share_pct}%` }));
    shareCell.firstChild.append(bar);

    const row = el('tr');
    row.append(
      el('td', { className: 'rank', text: String(i + 1) }),
      el('td', { className: 'product', text: String(p.product) }),
      el('td', { className: 'num', text: currencyFormatter.format(p.revenue) }),
      el('td', { className: 'num', text: p.units === null ? '—' : p.units.toLocaleString() }),
      shareCell,
    );
    body.append(row);
  });
}

function spendStorageKey() {
  const f = currentFilters();
  return `verdant_marketing_spend_${datasetId}_${f.startDate || ''}_${f.endDate || ''}_${f.region || ''}_${f.category || ''}`;
}

function loadSpend() {
  try {
    spendInput.value = localStorage.getItem(spendStorageKey()) || '';
  } catch {
    spendInput.value = '';
  }
}

function renderCustomerValue() {
  const cv = lastKpis?.customer_value;
  const body = document.getElementById('customer-value-body');
  const empty = document.getElementById('customer-value-empty');
  if (!cv?.available) {
    body.hidden = true;
    empty.hidden = false;
    return;
  }
  body.hidden = false;
  empty.hidden = true;

  document.getElementById('cv-ltv').textContent = currencyFormatter.format(cv.avg_lifetime_value);
  document.getElementById('cv-new').textContent = cv.new_customers.toLocaleString();

  const cacEl = document.getElementById('cv-cac');
  const ratioEl = document.getElementById('cv-ratio');
  ratioEl.replaceChildren();
  const spend = Number(spendInput.value);
  if (!spendInput.value || !(spend >= 0)) {
    cacEl.textContent = '—';
    ratioEl.append(el('span', { className: 'metric-placeholder', text: 'Enter spend below' }));
    return;
  }
  if (cv.new_customers === 0) {
    cacEl.textContent = '—';
    ratioEl.append(el('span', { className: 'metric-placeholder', text: 'No new customers in this range' }));
    return;
  }
  const cac = spend / cv.new_customers;
  cacEl.textContent = currencyFormatter.format(cac);
  if (cac === 0) {
    ratioEl.textContent = '—';
    return;
  }
  const ratio = cv.avg_lifetime_value / cac;
  const [status, label] = ratio >= 3 ? ['good', 'Healthy'] : ratio >= 1 ? ['warning', 'Thin margin'] : ['critical', 'Losing money'];
  ratioEl.append(
    el('span', { text: `${ratio.toFixed(1)} : 1 ` }),
    el('span', { className: `pill pill-status-${status}`, text: label }),
  );
}

async function refresh() {
  const seq = ++requestSeq;
  const filters = currentFilters();
  let kpis;
  try {
    ({ kpis } = await insforge.datasets.getKpis(datasetId, filters));
  } catch (err) {
    if (seq === requestSeq) rangeNote.textContent = `Couldn't load the dashboard: ${err.message}`;
    return;
  }
  if (seq !== requestSeq) return; // a newer filter change already superseded this one

  if (!kpis.available) {
    dashboardContent.hidden = true;
    unavailableState.hidden = false;
    unavailableMessage.textContent = `This dataset has no detected ${kpis.missing.join(' or ')} column. Fix this on the Upload & Clean page.`;
    return;
  }

  lastKpis = kpis;
  unavailableState.hidden = true;
  dashboardContent.hidden = false;
  populateOptions(kpis);

  const range = kpis.date_range;
  rangeNote.textContent = range
    ? `Showing ${describeFilters()}. Data covers ${range.min} to ${range.max}; quick ranges count back from ${range.max}.`
    : `Showing ${describeFilters()}.`;
  if (range) {
    startDateInput.min = endDateInput.min = range.min;
    startDateInput.max = endDateInput.max = range.max;
  }

  renderKpiCards(kpis);
  renderMomBadges(kpis.mom);
  renderRevenueTrend(kpis.revenue_trend, filters.category);
  renderCategoryMix(kpis.category_mix, filters.category);
  renderTopProducts(kpis);
  loadSpend();
  renderCustomerValue();
}

// ── Export ─────────────────────────────────────────────────────────────

function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  // Dataset-derived text starting with = + - @ would run as a formula when
  // the CSV is opened in Excel/Sheets — neutralize it.
  if (/^[=+\-@\t\r]/.test(text) && Number.isNaN(Number(text))) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportCsv() {
  if (!lastKpis) return;
  const k = lastKpis;
  const lines = [];
  const push = (...cells) => lines.push(cells.map(csvCell).join(','));

  push('Verdant BI dashboard export');
  push('Filters', describeFilters());
  push('Exported at', new Date().toISOString());
  push();
  push('Metric', 'Value', 'MoM current', 'MoM previous', 'MoM change %');
  const labels = { total_revenue: 'Total revenue', total_orders: 'Total orders', avg_order_value: 'Average order value', active_customers: 'Active customers' };
  for (const [key, label] of Object.entries(labels)) {
    const c = k.mom?.changes?.[key];
    push(label, k[key], c?.current, c?.previous, c?.change_pct);
  }
  if (k.mom) push('MoM months', `${k.mom.current_month} vs ${k.mom.previous_month}`);
  if (k.customer_value?.available) {
    push('Avg. customer lifetime value', k.customer_value.avg_lifetime_value);
    push('New customers in range', k.customer_value.new_customers);
    if (spendInput.value) push('Marketing spend (entered)', spendInput.value);
  }
  push();
  push('Date', 'Revenue');
  for (const p of k.revenue_trend) push(p.date, p.revenue);
  if (k.category_mix.length) {
    push();
    push('Category', 'Revenue');
    for (const c of k.category_mix) push(c.category, c.revenue);
  }
  if (k.top_products?.length) {
    push();
    push('Rank', 'Product', 'Revenue', 'Units', 'Orders', 'Share %');
    k.top_products.forEach((p, i) => push(i + 1, p.product, p.revenue, p.units, p.orders, p.share_pct));
  }

  const blob = new Blob([`${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { attrs: { href: url, download: `verdant-dashboard-${new Date().toISOString().slice(0, 10)}.csv` } });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Events ─────────────────────────────────────────────────────────────

for (const btn of presetButtons) {
  btn.addEventListener('click', () => {
    const latest = lastKpis?.date_range?.max;
    const preset = btn.dataset.preset;
    const { start, end } = latest ? presetRange(preset, latest) : { start: '', end: '' };
    startDateInput.value = start;
    endDateInput.value = end;
    setActivePreset(preset);
    refresh();
  });
}

for (const input of [startDateInput, endDateInput]) {
  input.addEventListener('change', () => {
    setActivePreset(startDateInput.value || endDateInput.value ? null : 'all');
    refresh();
  });
}
regionSelect.addEventListener('change', refresh);
categorySelect.addEventListener('change', refresh);
clearFiltersBtn.addEventListener('click', () => {
  startDateInput.value = '';
  endDateInput.value = '';
  regionSelect.value = '';
  categorySelect.value = '';
  setActivePreset('all');
  refresh();
});

spendInput.addEventListener('input', () => {
  try {
    if (spendInput.value) localStorage.setItem(spendStorageKey(), spendInput.value);
    else localStorage.removeItem(spendStorageKey());
  } catch {
    // storage unavailable (private mode) — CAC still works for this visit
  }
  renderCustomerValue();
});

document.getElementById('export-csv').addEventListener('click', exportCsv);
document.getElementById('export-pdf').addEventListener('click', () => window.print());
window.addEventListener('beforeprint', () => {
  revenueTrendChart?.resize();
  categoryMixChart?.resize();
});

document.addEventListener('verdant:session-ready', async (e) => {
  workspaceId = e.detail.activeWorkspaceId;
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
    await refresh();
  } catch {
    noDatasetState.hidden = false;
  }
});
