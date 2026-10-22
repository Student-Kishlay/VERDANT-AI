import { insforge } from '../insforge-client.js';
import { el } from '../lib/dom-safe.js';
import { renderMarkdown } from '../lib/markdown.js';

const noDatasetState = document.getElementById('no-dataset-state');
const chatContent = document.getElementById('chat-content');
const chatMessages = document.getElementById('chat-messages');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatSendBtn = document.getElementById('chat-send-btn');

let workspaceId = null;
let datasetId = null;

const SUGGESTIONS = [
  'Forecast revenue for the next 30 days',
  'Show the monthly revenue trend',
  'Which categories bring in the most revenue?',
  'Compare revenue by region',
  'Are there any unusual transactions?',
  'Summarise our customer segments',
];

function scrollToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function cssVar(name, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

const compactNumber = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const fullNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

function seriesColors() {
  return [cssVar('--color-accent', '#12855c'), cssVar('--color-brand-blue', '#4d78a2'), '#c27c0e', '#8a5cb8', '#c2410c', '#0e7490'];
}

// chart = { type, title, labels, series: [{ name, values, style? }], x_label, y_label }
function renderChart(container, chart) {
  const card = el('figure', { className: 'chat-chart' });
  if (chart.title) card.appendChild(el('figcaption', { className: 'chat-chart-title', text: chart.title }));
  const canvasWrap = el('div', { className: 'chat-chart-canvas' });
  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', chart.title || 'Chart');
  canvasWrap.appendChild(canvas);
  card.appendChild(canvasWrap);
  container.appendChild(card);

  const colors = seriesColors();
  const isPie = chart.type === 'pie';
  const multi = chart.series.length > 1;

  new Chart(canvas, {
    type: isPie ? 'doughnut' : chart.type === 'line' ? 'line' : 'bar',
    data: {
      labels: chart.labels,
      datasets: chart.series.map((s, i) => ({
        label: s.name,
        data: s.values,
        backgroundColor: isPie ? chart.labels.map((_, j) => colors[j % colors.length]) : colors[i % colors.length],
        borderColor: colors[i % colors.length],
        borderWidth: chart.type === 'line' ? 2 : 0,
        borderDash: s.style === 'dashed' ? [6, 4] : [],
        borderRadius: chart.type === 'bar' ? 4 : 0,
        pointRadius: chart.type === 'line' && chart.labels.length > 40 ? 0 : 2,
        tension: 0.25,
        spanGaps: false,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: isPie || multi, position: 'bottom', labels: { boxWidth: 12 } },
        tooltip: {
          callbacks: {
            label: (ctx) => `${isPie ? ctx.label : ctx.dataset.label}: ${fullNumber.format(isPie ? ctx.parsed : ctx.parsed.y)}`,
          },
        },
      },
      scales: isPie
        ? {}
        : {
            x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
            y: { beginAtZero: true, ticks: { callback: (v) => compactNumber.format(v) } },
          },
    },
  });
}

function renderGrounding(container, message) {
  const payload = message.chart_payload;
  const figures = payload.figures || { checked: 0, unverified: [] };
  const sources = payload.sources || [];

  if (message.grounding_status === 'rejected' && figures.unverified.length) {
    container.appendChild(
      el('div', {
        className: 'chat-grounding chat-grounding-warn',
        text: `⚠ Couldn't trace ${figures.unverified.join(', ')} to a calculation on your data — treat ${figures.unverified.length > 1 ? 'these figures' : 'this figure'} with caution.`,
      })
    );
  }

  if (sources.length === 0) return;
  const details = el('details', { className: 'chat-sources' });
  const label =
    message.grounding_status === 'verified'
      ? `✓ Grounded in ${sources.length} calculation${sources.length > 1 ? 's' : ''} on your data${figures.checked ? ` · ${figures.checked} figure${figures.checked > 1 ? 's' : ''} checked` : ''}`
      : `Based on ${sources.length} calculation${sources.length > 1 ? 's' : ''} on your data`;
  details.appendChild(el('summary', { text: label }));
  const list = el('ul');
  for (const s of sources) list.appendChild(el('li', { text: s }));
  details.appendChild(list);
  container.appendChild(details);
}

// Every string here — including the user's own typed message — is
// untrusted and rendered via el()/textContent (or renderMarkdown, which
// only uses those) — never innerHTML (§4.1).
function renderMessage(message) {
  const row = el('div', { className: `chat-row chat-row-${message.role}` });
  const bubble = el('div', { className: `chat-message chat-message-${message.role}` });

  if (message.role === 'assistant') bubble.appendChild(renderMarkdown(message.content));
  else bubble.textContent = message.content;
  row.appendChild(bubble);
  chatMessages.appendChild(row);

  const payload = message.chart_payload;
  if (payload?.version === 2) {
    // Built server-side from tool results, so always grounded.
    for (const chart of payload.charts || []) renderChart(bubble, chart);
    renderGrounding(bubble, message);
  } else if (payload && message.grounding_status === 'verified') {
    renderChart(bubble, {
      type: payload.chart_type === 'line' ? 'line' : 'bar',
      labels: payload.labels,
      series: [{ name: payload.value_column, values: payload.values }],
    });
  }
  return row;
}

function renderSuggestions() {
  const wrap = el('div', { className: 'chat-suggestions' });
  for (const text of SUGGESTIONS) {
    const chip = el('button', { className: 'chat-suggestion', text, attrs: { type: 'button' } });
    chip.addEventListener('click', () => send(text));
    wrap.appendChild(chip);
  }
  return wrap;
}

function renderTyping() {
  const row = el('div', { className: 'chat-row chat-row-assistant' });
  const bubble = el('div', { className: 'chat-message chat-message-assistant chat-typing', attrs: { 'aria-label': 'Analysing your data' } });
  bubble.appendChild(el('span', { text: 'Analysing your data' }));
  const dots = el('span', { className: 'chat-typing-dots' });
  for (let i = 0; i < 3; i++) dots.appendChild(el('span'));
  bubble.appendChild(dots);
  row.appendChild(bubble);
  chatMessages.appendChild(row);
  return row;
}

async function loadHistory() {
  const { messages } = await insforge.chat.history(workspaceId, datasetId);
  chatMessages.replaceChildren();
  if (messages.length === 0) {
    renderMessage({
      role: 'assistant',
      content:
        'Ask me anything about this dataset. I work out every figure from your actual rows, chart the result when it helps, and tell you which calculations an answer is based on.',
    });
    chatMessages.appendChild(renderSuggestions());
  } else {
    for (const message of messages) renderMessage(message);
  }
  scrollToBottom();
}

function setBusy(busy) {
  chatInput.disabled = busy;
  chatSendBtn.disabled = busy;
}

async function send(text) {
  chatMessages.querySelector('.chat-suggestions')?.remove();
  renderMessage({ role: 'user', content: text });
  chatInput.value = '';
  setBusy(true);
  const typing = renderTyping();
  scrollToBottom();

  try {
    const { message } = await insforge.chat.send(workspaceId, datasetId, text);
    typing.remove();
    renderMessage(message);
  } catch (err) {
    typing.remove();
    renderMessage({ role: 'assistant', content: err.message || 'Something went wrong. Please try again.' });
  } finally {
    setBusy(false);
    chatInput.focus();
    scrollToBottom();
  }
}

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (text) send(text);
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
    chatContent.hidden = false;
    await loadHistory();
  } catch {
    noDatasetState.hidden = false;
  }
});
