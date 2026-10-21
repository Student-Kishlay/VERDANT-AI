import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { buildApp } from './build-app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const PORT = process.env.PORT || 5175;

const app = buildApp();

app.listen(PORT, () => {
  console.log(`Verdant BI mock backend listening on http://localhost:${PORT}`);
});
