import { insforge } from '../insforge-client.js';

document.addEventListener('verdant:session-ready', async (e) => {
  const { session, activeWorkspaceId } = e.detail;
  const welcome = document.getElementById('welcome-message');
  if (welcome) {
    welcome.textContent = `Welcome back, ${session.user.display_name}.`;
  }

  if (!activeWorkspaceId) return;
  const { stats } = await insforge.workspaces.getStats(activeWorkspaceId);

  const lastDatasetEl = document.getElementById('stat-last-dataset');
  if (stats.last_dataset_name) {
    lastDatasetEl.textContent = stats.last_dataset_name;
    lastDatasetEl.classList.remove('stat-value-muted');
  }

  document.getElementById('stat-total-records').textContent = stats.total_records.toLocaleString();
  document.getElementById('stat-forecasts').textContent = stats.forecasts_generated.toLocaleString();
  document.getElementById('stat-chat-questions').textContent = stats.chat_questions_asked.toLocaleString();
});
