// Minimal Markdown -> DOM renderer for AI Chat replies. Builds nodes with
// createElement/textContent only — never innerHTML (§4.1) — so a reply
// (or a dataset value quoted inside one) can format text but never inject
// markup. Supports what the chat prompt asks the model to use: paragraphs,
// ### headings, **bold**, *italic*, `code`, bullet/numbered lists, tables.
import { el } from './dom-safe.js';

const INLINE_PATTERN = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;

function appendInline(parent, text) {
  let last = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    if (match.index > last) parent.appendChild(document.createTextNode(text.slice(last, match.index)));
    const token = match[0];
    if (token.startsWith('**')) parent.appendChild(el('strong', { text: token.slice(2, -2) }));
    else if (token.startsWith('`')) parent.appendChild(el('code', { text: token.slice(1, -1) }));
    else parent.appendChild(el('em', { text: token.slice(1, -1) }));
    last = match.index + token.length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  return parent;
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

const isTableRow = (line) => line.trim().startsWith('|');
const isDivider = (line) => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line.trim());
const BULLET = /^\s*[-*•]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;
const NUMERIC_CELL = /^[-+$€£]?\s?[\d,.]+\s?[%kKmMbB]?$/;

function renderTable(lines) {
  const rows = lines.filter((l) => !isDivider(l)).map(splitRow);
  const wrap = el('div', { className: 'md-table-wrap' });
  const table = el('table', { className: 'md-table' });
  const [header, ...body] = rows;

  const thead = el('thead');
  const headRow = el('tr');
  header.forEach((cell) => headRow.appendChild(appendInline(el('th'), cell)));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  for (const cells of body) {
    const tr = el('tr');
    header.forEach((_, i) => {
      const cell = cells[i] ?? '';
      tr.appendChild(appendInline(el('td', { className: NUMERIC_CELL.test(cell) ? 'md-num' : '' }), cell));
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

export function renderMarkdown(source) {
  const root = el('div', { className: 'md' });
  const lines = String(source ?? '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const p = el('p');
    paragraph.forEach((line, idx) => {
      if (idx > 0) p.appendChild(el('br'));
      appendInline(p, line);
    });
    root.appendChild(p);
    paragraph = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      flushParagraph();
      i++;
      continue;
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      root.appendChild(appendInline(el(heading[1].length <= 2 ? 'h3' : 'h4'), heading[2].replace(/#+\s*$/, '')));
      i++;
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushParagraph();
      root.appendChild(el('hr'));
      i++;
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && isDivider(lines[i + 1])) {
      flushParagraph();
      const tableLines = [];
      while (i < lines.length && isTableRow(lines[i])) tableLines.push(lines[i++]);
      root.appendChild(renderTable(tableLines));
      continue;
    }

    if (BULLET.test(line) || NUMBERED.test(line)) {
      flushParagraph();
      const ordered = NUMBERED.test(line);
      const pattern = ordered ? NUMBERED : BULLET;
      const list = el(ordered ? 'ol' : 'ul');
      while (i < lines.length && pattern.test(lines[i])) {
        list.appendChild(appendInline(el('li'), lines[i].replace(pattern, '')));
        i++;
        // Indented continuation lines belong to the previous item.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !BULLET.test(lines[i]) && !NUMBERED.test(lines[i])) {
          list.lastChild.appendChild(document.createTextNode(' '));
          appendInline(list.lastChild, lines[i].trim());
          i++;
        }
      }
      root.appendChild(list);
      continue;
    }

    paragraph.push(line.trim());
    i++;
  }
  flushParagraph();
  return root;
}
