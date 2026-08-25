import { insforge } from '../insforge-client.js';
import { el } from '../lib/dom-safe.js';

const noDatasetState = document.getElementById('no-dataset-state');
const chatContent = document.getElementById('chat-content');
const chatMessages = document.getElementById('chat-messages');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatSendBtn = document.getElementById('chat-send-btn');

let workspaceId = null;
let datasetId = null;

function scrollToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Every string here — including the user's own typed message — is
// untrusted and rendered via el()/textContent only, never innerHTML (§4.1).
// Chat is free-text by nature, making this the highest-risk page for the
// exact injection that rule exists to prevent.
function renderMessage(message) {
  const bubble = el('div', {
    className: `chat-message chat-message-${message.role}`,
    text: message.content,
  });
  chatMessages.appendChild(bubble);

  if (message.chart_payload && message.grounding_status === 'verified') {
    const wrap = el('div', { className: 'chat-message-chart-wrap' });
    const canvas = document.createElement('canvas');
    wrap.appendChild(canvas);
    chatMessages.appendChild(wrap);

    const payload = message.chart_payload;
    new Chart(canvas, {
      type: payload.chart_type === 'line' ? 'line' : 'bar',
      data: {
        labels: payload.labels,
        datasets: [{ label: payload.value_column, data: payload.values, backgroundColor: '#5b8dbe', borderColor: '#16a673' }],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
    });
  }
}

async function loadHistory() {
  const { messages } = await insforge.chat.history(workspaceId, datasetId);
  chatMessages.replaceChildren();
  if (messages.length === 0) {
    chatMessages.appendChild(
      el('div', {
        className: 'chat-message chat-message-assistant',
        text: 'Ask me anything about this dataset — revenue totals, trends, category breakdowns, or customer counts.',
      })
    );
  } else {
    for (const message of messages) renderMessage(message);
  }
  scrollToBottom();
}

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;

  renderMessage({ role: 'user', content: text });
  chatInput.value = '';
  chatInput.disabled = true;
  chatSendBtn.disabled = true;
  scrollToBottom();

  try {
    const { message } = await insforge.chat.send(workspaceId, datasetId, text);
    renderMessage(message);
  } catch (err) {
    renderMessage({ role: 'assistant', content: err.message || 'Something went wrong. Please try again.' });
  } finally {
    chatInput.disabled = false;
    chatSendBtn.disabled = false;
    chatInput.focus();
    scrollToBottom();
  }
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
