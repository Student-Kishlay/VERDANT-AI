// Column-role detection heuristic (Master Prompt §6). Assigns at most one
// column per role, processed in a fixed priority order so results are
// deterministic when several columns could plausibly match the same role.
export const METHODOLOGY_VERSION = 1;

const NUMERIC_PATTERN = /^-?\d+(\.\d+)?$/;

const ROLE_KEYWORDS = {
  date: ['date', 'timestamp', 'day', 'time'],
  revenue: ['revenue', 'amount', 'sales', 'price', 'total', 'cost'],
  customer: ['customer', 'client', 'buyer', 'name'],
  product: ['product', 'item', 'sku'],
  region: ['region', 'state', 'country', 'city', 'location'],
  category: ['category', 'type', 'segment'],
  quantity: ['quantity', 'qty', 'units', 'count'],
  order: ['order', 'invoice', 'transaction'],
};

// Fixed evaluation order — date/revenue/quantity have a datatype check to
// back up the keyword match, so resolving them first avoids a purely
// name-based role (e.g. "order") claiming a column before a better-evidenced
// one gets the chance.
const ROLE_PRIORITY = ['date', 'revenue', 'customer', 'product', 'region', 'category', 'quantity', 'order'];

const MIN_CONFIDENCE = 0.4;

function isEmptyValue(v) {
  return v === undefined || v === null || String(v).trim() === '';
}

function keywordScore(columnName, keywords) {
  let best = 0;
  for (const kw of keywords) {
    if (columnName === kw) best = Math.max(best, 1);
    else if (columnName.includes(kw)) best = Math.max(best, 0.7);
  }
  return best;
}

function dateValidRatio(values) {
  const nonEmpty = values.filter((v) => !isEmptyValue(v));
  if (nonEmpty.length === 0) return 0;
  const valid = nonEmpty.filter((v) => !Number.isNaN(new Date(v).getTime())).length;
  return valid / nonEmpty.length;
}

function numericRatio(values) {
  const nonEmpty = values.filter((v) => !isEmptyValue(v));
  if (nonEmpty.length === 0) return 0;
  const numeric = nonEmpty.filter((v) => typeof v === 'number' || NUMERIC_PATTERN.test(String(v).trim())).length;
  return numeric / nonEmpty.length;
}

// detectColumns(headers, rows) -> [{ column_name, detected_role, confidence }]
// `rows` is the array of cleaned row objects (as produced by cleanDataset).
export function detectColumns(headers, rows) {
  const columnValues = new Map(headers.map((h) => [h, rows.map((r) => r[h])]));
  const scores = new Map(headers.map((h) => [h, {}]));

  for (const col of headers) {
    for (const role of ROLE_PRIORITY) {
      let score = keywordScore(col, ROLE_KEYWORDS[role]);
      if (score > 0) {
        if (role === 'date') score *= dateValidRatio(columnValues.get(col)) >= 0.5 ? 1 : 0.3;
        if (role === 'revenue' || role === 'quantity') {
          score *= numericRatio(columnValues.get(col)) >= 0.5 ? 1 : 0.3;
        }
      }
      scores.get(col)[role] = score;
    }
  }

  const assigned = new Map(headers.map((h) => [h, null]));

  for (const role of ROLE_PRIORITY) {
    let bestCol = null;
    let bestScore = 0;
    for (const col of headers) {
      if (assigned.get(col)) continue;
      const score = scores.get(col)[role];
      if (score > bestScore) {
        bestScore = score;
        bestCol = col;
      }
    }
    if (bestCol && bestScore >= MIN_CONFIDENCE) {
      assigned.set(bestCol, { role, confidence: bestScore });
    }
  }

  return headers.map((col) => {
    const result = assigned.get(col);
    return {
      column_name: col,
      detected_role: result ? result.role : null,
      confidence: result ? result.confidence : 0,
    };
  });
}
