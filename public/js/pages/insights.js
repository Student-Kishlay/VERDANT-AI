import { insforge } from '../insforge-client.js';
import { el } from '../lib/dom-safe.js';

const noDatasetState = document.getElementById('no-dataset-state');
const insightsContent = document.getElementById('insights-content');
const forecastUnavailableState = document.getElementById('forecast-unavailable-state');
const forecastUnavailableMessage = document.getElementById('forecast-unavailable-message');
const forecastContent = document.getElementById('forecast-content');
const segmentationUnavailableState = document.getElementById('segmentation-unavailable-state');
const segmentationUnavailableMessage = document.getElementById('segmentation-unavailable-message');
const segmentationContent = document.getElementById('segmentation-content');
const segmentCards = document.getElementById('segment-cards');

const SEGMENT_ORDER = ['Champions', 'Loyal', 'Potential', 'New Customers', 'At Risk', 'Lost'];
const currencyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

let workspaceId = null;
let datasetId = null;
let currentHorizon = 7;
let forecastChart = null;
let segmentMixChart = null;

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

function renderSegmentCards(summaryByLabel) {
  const bySegment = Object.fromEntries(summaryByLabel.map((b) => [b.segment, b]));
  segmentCards.replaceChildren();
  for (const label of SEGMENT_ORDER) {
    const bucket = bySegment[label];
    const card = el('div', { className: 'card stat-card' });
    card.appendChild(el('span', { className: 'stat-label', text: label }));
    card.appendChild(el('span', { className: 'stat-value', text: bucket ? String(bucket.size) : '0' }));
    if (bucket) {
      card.appendChild(
        el('span', {
          className: 'stat-value-muted',
          text: `${currencyFormatter.format(bucket.avg_revenue)} avg · ${bucket.avg_recency}d avg recency`,
        })
      );
    }
    segmentCards.appendChild(card);
  }
}

function renderSegmentMixChart(summaryByLabel) {
  const bySegment = Object.fromEntries(summaryByLabel.map((b) => [b.segment, b]));
  const ctx = document.getElementById('segment-mix-chart');
  segmentMixChart?.destroy();
  segmentMixChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: SEGMENT_ORDER,
      datasets: [
        {
          label: 'Customers',
          data: SEGMENT_ORDER.map((label) => bySegment[label]?.size || 0),
          backgroundColor: '#5b8dbe',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  });
}

async function loadSegments() {
  const { segmentation } = await insforge.datasets.getSegments(datasetId);

  if (!segmentation.available) {
    segmentationContent.hidden = true;
    segmentationUnavailableState.hidden = false;
    segmentationUnavailableMessage.textContent = `This dataset has no detected ${segmentation.missing.join(' or ')} column. Fix this on the Upload & Clean page.`;
    return;
  }

  segmentationUnavailableState.hidden = true;
  segmentationContent.hidden = false;
  renderSegmentCards(segmentation.summary_by_label);
  renderSegmentMixChart(segmentation.summary_by_label);
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
    await Promise.all([loadForecast(), loadSegments()]);
  } catch {
    noDatasetState.hidden = false;
  }
});
