import { insforge } from '../insforge-client.js';

const noDatasetState = document.getElementById('no-dataset-state');
const insightsContent = document.getElementById('insights-content');
const forecastUnavailableState = document.getElementById('forecast-unavailable-state');
const forecastUnavailableMessage = document.getElementById('forecast-unavailable-message');
const forecastContent = document.getElementById('forecast-content');

let workspaceId = null;
let datasetId = null;
let currentHorizon = 7;
let forecastChart = null;

// ── Tabs ─────────────────────────────────────────────────────────────────
for (const btn of document.querySelectorAll('.tab-btn')) {
  btn.addEventListener('click', () => {
    for (const b of document.querySelectorAll('.tab-btn')) b.classList.toggle('active', b === btn);
    for (const panel of document.querySelectorAll('.tab-panel')) {
      panel.hidden = panel.id !== `tab-${btn.dataset.tab}`;
    }
  });
}

// ── Horizon selector ─────────────────────────────────────────────────────
for (const btn of document.querySelectorAll('.horizon-btn')) {
  btn.addEventListener('click', () => {
    for (const b of document.querySelectorAll('.horizon-btn')) b.classList.toggle('active', b === btn);
    currentHorizon = Number(btn.dataset.horizon);
    loadForecast();
  });
}

function renderForecastChart(historical, series) {
  const ctx = document.getElementById('forecast-chart');
  forecastChart?.destroy();

  const labels = [...historical.map((p) => p.date), ...series.map((p) => p.date)];
  const actualData = [...historical.map((p) => p.revenue), ...series.map(() => null)];
  const forecastData = historical.map(() => null);
  forecastData[historical.length - 1] = historical[historical.length - 1].revenue; // bridge the two lines visually
  forecastData.push(...series.map((p) => p.predicted_revenue));

  forecastChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Actual revenue',
          data: actualData,
          borderColor: '#16a673',
          backgroundColor: 'rgba(22, 166, 115, 0.08)',
          spanGaps: false,
          tension: 0.2,
        },
        {
          label: 'Forecast',
          data: forecastData,
          borderColor: '#5b8dbe',
          borderDash: [6, 4],
          spanGaps: false,
          tension: 0.2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: true } },
    },
  });
}

async function loadForecast() {
  const { forecast } = await insforge.datasets.getForecast(datasetId, currentHorizon);

  if (!forecast.available) {
    forecastContent.hidden = true;
    forecastUnavailableState.hidden = false;
    forecastUnavailableMessage.textContent = `This dataset has no detected ${forecast.missing.join(' or ')} column. Fix this on the Upload & Clean page.`;
    return;
  }

  forecastUnavailableState.hidden = true;
  forecastContent.hidden = false;
  renderForecastChart(forecast.historical, forecast.series);
}

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
    insightsContent.hidden = false;
    await loadForecast();
  } catch {
    noDatasetState.hidden = false;
  }
});
