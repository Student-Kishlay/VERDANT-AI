import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createDb } from './db.js';
import { createApp } from './app.js';
import { createStorage } from './storage.js';
import { createInsforgeClient } from './insforge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const PORT = process.env.PORT || 5175;

const insforge = createInsforgeClient();
const db = createDb(insforge);
const storage = createStorage('raw-uploads');
const reportStorage = createStorage('reports');
const app = createApp(db, {
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

app.listen(PORT, () => {
  console.log(`Verdant BI mock backend listening on http://localhost:${PORT}`);
});
