import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createDb } from './db.js';
import { createApp } from './app.js';
import { createStorage } from './storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const PORT = process.env.PORT || 5175;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret';
const DB_FILE = process.env.DB_FILE
  ? path.resolve(__dirname, '..', process.env.DB_FILE)
  : path.join(__dirname, 'data', 'db.json');
const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads');

if (!process.env.JWT_SECRET) {
  console.warn('[verdant-bi] JWT_SECRET not set in .env — using an insecure default for local dev only.');
}

const db = createDb(DB_FILE);
const storage = createStorage(UPLOADS_DIR);
const app = createApp(db, {
  jwtSecret: JWT_SECRET,
  storage,
  config: {
    maxUploadFileSizeMb: Number(process.env.MAX_UPLOAD_FILE_SIZE_MB) || 25,
    maxUploadRowCount: Number(process.env.MAX_UPLOAD_ROW_COUNT) || 200000,
    allowedFileTypes: ['.csv', '.xlsx'],
    anomalyContaminationRate: Number(process.env.ANOMALY_CONTAMINATION_RATE) || 0.05,
  },
});

app.listen(PORT, () => {
  console.log(`Verdant BI mock backend listening on http://localhost:${PORT}`);
});
