import { insforge } from '../insforge-client.js';

const noDatasetState = document.getElementById('no-dataset-state');
const unavailableState = document.getElementById('unavailable-state');
const unavailableMessage = document.getElementById('unavailable-message');
const dashboardContent = document.getElementById('dashboard-content');

const startDateInput = document.getElementById('filter-start-date');
const endDateInput = document.getElementById('filter-end-date');
const regionSelect = document.getElementById('filter-region');
const clearFiltersBtn = document.getElementById('filter-clear');

const currencyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

let workspaceId = null;
let datasetId = null;
let regionsPopulated = false;
let revenueTrendChart = null;
let categoryMixChart = null;

function currentFilters() {
  return {
    startDate: startDateInput.value || undefined,
    endDate: endDateInput.value || undefined,
    region: regionSelect.value || undefined,
  };
}

function populateRegions(regions) {
  if (regionsPopulated) return;
  for (const region of regions) {
    const option = document.createElement('option');
    option.value = region;
    option.textContent = region; // dataset-derived value — textContent, never innerHTML
    regionSelect.appendChild(option);
  }
  regionsPopulated = true;
}

function renderKpiCards(kpis) {
  document.getElementById('kpi-total-revenue').textContent = currencyFormatter.format(kpis.total_revenue);
  document.getElementById('kpi-total-orders').textContent = kpis.total_orders.toLocaleString();
  document.getElementById('kpi-aov').textContent = currencyFormatter.format(kpis.avg_order_value);
  document.getElementById('kpi-active-customers').textContent = kpis.active_customers.toLocaleString();
}

function renderRevenueTrend(revenueTrend) {
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
          borderColor: '#16a673',
          backgroundColor: 'rgba(22, 166, 115, 0.12)',
          tension: 0.25,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true } },
    },
  });
}

function renderCategoryMix(categoryMix) {
  const wrap = document.getElementById('category-mix-wrap');
  const emptyNote = document.getElementById('category-mix-empty');

  if (categoryMix.length === 0) {
    wrap.hidden = true;
    emptyNote.hidden = false;
    categoryMixChart?.destroy();
    categoryMixChart = null;
    return;
  }
  wrap.hidden = false;
  emptyNote.hidden = true;

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
          backgroundColor: '#5b8dbe',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true } },
    },
  });
}

async function refresh() {
  const { kpis } = await insforge.datasets.getKpis(datasetId, currentFilters());

  if (!kpis.available) {
    dashboardContent.hidden = true;
    unavailableState.hidden = false;
    unavailableMessage.textContent = `This dataset has no detected ${kpis.missing.join(' or ')} column. Fix this on the Upload & Clean page.`;
    return;
  }

  unavailableState.hidden = true;
  dashboardContent.hidden = false;
  populateRegions(kpis.available_regions);
  renderKpiCards(kpis);
  renderRevenueTrend(kpis.revenue_trend);
  renderCategoryMix(kpis.category_mix);
}

startDateInput.addEventListener('change', refresh);
endDateInput.addEventListener('change', refresh);
regionSelect.addEventListener('change', refresh);
clearFiltersBtn.addEventListener('click', () => {
  startDateInput.value = '';
  endDateInput.value = '';
  regionSelect.value = '';
  refresh();
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
