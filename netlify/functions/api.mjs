import serverless from 'serverless-http';
import { buildApp } from '../../server/build-app.js';

const app = buildApp();

// Requests arrive via the /api/* rewrite in netlify.toml; depending on how
// Netlify invokes us the path may be the rewritten function path, so map it
// back to the /api/... routes Express expects.
const wrapped = serverless(app, {
  binary: ['application/pdf', 'application/octet-stream', 'image/*',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  request(req) {
    if (req.url.startsWith('/.netlify/functions/api')) {
      req.url = '/api' + req.url.slice('/.netlify/functions/api'.length);
    }
  },
});

export const handler = (event, context) => wrapped(event, context);
