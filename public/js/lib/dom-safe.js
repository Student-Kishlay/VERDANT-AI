// XSS-safe rendering helpers (Master Prompt §4.1). Every dataset-, chat-, or
// user-derived string in this app must go through one of these — never via
// innerHTML directly.

const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

// Sets text content safely (preferred over innerHTML for any untrusted value).
export function setText(element, value) {
  element.textContent = value ?? '';
  return element;
}

// Builds a DOM element with attributes/text without ever touching innerHTML.
export function el(tag, { className, text, attrs = {} } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, value);
  }
  return node;
}
