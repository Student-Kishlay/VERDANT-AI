import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JS_DIR = path.join(__dirname, '..', 'public', 'js');

// Every value rendered anywhere in this app that could originate from a
// dataset, chat message, or other user input must go through
// textContent/el() (public/js/lib/dom-safe.js), never innerHTML (§4.1) —
// that's what makes dashboard.html/chat.html/reports.html safe against the
// exact payload §15's XSS regression describes, "by construction" rather
// than by remembering to check each page. This is a permanent guard against
// a future page reintroducing an innerHTML assignment, not a one-off check.
function listJsFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJsFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

test('no frontend script assigns to .innerHTML', () => {
  const files = listJsFiles(JS_DIR);
  assert.ok(files.length > 5, 'sanity check: expected to find several frontend JS files');

  const offenders = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    // Matches an actual assignment (`.innerHTML =` / `.innerHTML=`), not the
    // word appearing in a comment explaining why it's avoided.
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      const codePart = line.split('//')[0];
      if (/\.innerHTML\s*=(?!=)/.test(codePart)) {
        offenders.push(`${path.relative(JS_DIR, file)}:${i + 1}`);
      }
    });
  }

  assert.deepEqual(offenders, []);
});
