import { createDb } from './db.js';
import { createApp } from './app.js';
import { createStorage } from './storage.js';
import { createInsforgeClient } from './insforge.js';

// Shared by the local server (server/index.js) and the Netlify Function
// (netlify/functions/api.mjs). Expects env vars to already be loaded.
export function buildApp() {
  const insforge = createInsforgeClient();
  const db = createDb(insforge);
  const storage = createStorage('raw-uploads');
  const reportStorage = createStorage('reports');
  return createApp(db, {
    insforge,
    storage,
    reportStorage,
    config: {
      maxUploadFileSizeMb: Number(process.env.MAX_UPLOAD_FILE_SIZE_MB) || 25,
      maxUploadRowCount: Number(process.env.MAX_UPLOAD_ROW_COUNT) || 200000,
      allowedFileTypes: ['.csv', '.xlsx'],
      anomalyContaminationRate: Number(process.env.ANOMALY_CONTAMINATION_RATE) || 0.05,
      aiProvider: process.env.AI_PROVIDER || 'mock',
      groqApiKey: process.env.GROQ_API_KEY || '',
      groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      chartGroundingThreshold: Number(process.env.CHART_GROUNDING_THRESHOLD) || 0.6,
      aiChatMaxMessagesPerWorkspacePerHour: Number(process.env.AI_CHAT_MAX_MESSAGES_PER_WORKSPACE_PER_HOUR) || 60,
      aiChatMaxContextTokens: Number(process.env.AI_CHAT_MAX_CONTEXT_TOKENS) || 4000,
      defaultShareLinkExpiryDays: Number(process.env.DEFAULT_SHARE_LINK_EXPIRY_DAYS) || 7,
      insforgeBaseUrl: process.env.INSFORGE_PROJECT_URL || '',
      insforgeAnonKey: process.env.INSFORGE_ANON_KEY || '',
    },
  });
}
