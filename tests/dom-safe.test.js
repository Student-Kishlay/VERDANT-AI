import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from '../public/js/lib/dom-safe.js';

// Regression per Master Prompt §15 "XSS regression" — a malicious dataset
// cell value must render as inert text everywhere it's displayed.
test('escapeHtml neutralizes an injected script/img payload', () => {
  const malicious = '<img src=x onerror=alert(1)>';
  const escaped = escapeHtml(malicious);
  assert.equal(escaped, '&lt;img src=x onerror=alert(1)&gt;');
  assert.ok(!escaped.includes('<img'));
});

test('escapeHtml handles quotes and ampersands used in attribute-injection attempts', () => {
  const malicious = `"><script>alert('x')</script>&`;
  const escaped = escapeHtml(malicious);
  assert.ok(!escaped.includes('<script>'));
  assert.ok(!escaped.includes('"'));
  assert.ok(escaped.includes('&amp;'));
});

test('escapeHtml is safe on null/undefined', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});
