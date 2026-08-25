// Deterministic cleaning pipeline (Master Prompt §5). Same (headers, rows) in
// -> same output every time: no wall-clock, randomness, or external state
// feeds into any transformation decision here.
export const METHODOLOGY_VERSION = 1;

const DATE_NAME_TOKENS = ['date', 'timestamp', 'day', 'time'];
const NUMERIC_PATTERN = /^-?\d+(\.\d+)?$/;

function normalizeColumnName(name) {
  const base =
    String(name ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'column';
  return base;
}

function dedupeColumnNames(names) {
  const seen = new Map();
  return names.map((name) => {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    return count === 0 ? name : `${name}_${count + 1}`;
  });
}

function isEmptyValue(v) {
  return v === undefined || v === null || String(v).trim() === '';
}

function isRowEmpty(rowArr) {
  return rowArr.every((v) => isEmptyValue(v));
}

function parseDateValue(v) {
  if (isEmptyValue(v)) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function median(values) {
  if (values.length === 0) return 0; // no non-null values to derive a median from
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// cleanDataset(rawHeaders, rawRows) -> { headers, rows, summary }
// rawRows is an array of string arrays (one per data row, already padded to
// rawHeaders.length by the parser).
export function cleanDataset(rawHeaders, rawRows) {
  // 1. Column name normalization
  const headers = dedupeColumnNames(rawHeaders.map(normalizeColumnName));

  // 2. Remove fully empty rows
  const nonEmptyRows = rawRows.filter((r) => !isRowEmpty(r));
  const rowsRemovedEmpty = rawRows.length - nonEmptyRows.length;

  // 3. Remove exact duplicate rows, keep first occurrence
  const seen = new Set();
  const deduped = [];
  for (const row of nonEmptyRows) {
    const key = JSON.stringify(row);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  const duplicatesRemoved = nonEmptyRows.length - deduped.length;

  // Convert to row objects keyed by normalized header, for the column-aware steps below
  let rows = deduped.map((row) => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = row[i] ?? '';
    });
    return obj;
  });

  // 4. Date parsing for date-like columns
  const dateColumns = headers.filter((h) => DATE_NAME_TOKENS.some((t) => h.includes(t)));
  for (const col of dateColumns) {
    for (const row of rows) {
      row[col] = parseDateValue(row[col]);
    }
  }

  // 5. Numeric coercion (sampled over all non-null values in the column)
  const numericColumns = [];
  for (const col of headers) {
    if (dateColumns.includes(col)) continue;
    const nonEmpty = rows.map((r) => r[col]).filter((v) => !isEmptyValue(v));
    if (nonEmpty.length === 0) continue;
    const matchCount = nonEmpty.filter((v) => NUMERIC_PATTERN.test(String(v).trim())).length;
    if (matchCount / nonEmpty.length > 0.5) {
      numericColumns.push(col);
      for (const row of rows) {
        const v = row[col];
        if (isEmptyValue(v)) {
          row[col] = null;
        } else if (NUMERIC_PATTERN.test(String(v).trim())) {
          row[col] = Number(v);
        } else {
          row[col] = null; // non-numeric junk in a numeric column becomes missing
        }
      }
    }
  }

  // 6. Missing-value imputation
  const missingFilled = {};

  for (const col of dateColumns) {
    let last = null;
    let fills = 0;
    for (const row of rows) {
      if (row[col] === null) {
        if (last !== null) {
          row[col] = last;
          fills += 1;
        }
      } else {
        last = row[col];
      }
    }
    if (fills > 0) missingFilled[col] = fills;
  }

  for (const col of numericColumns) {
    const nonNull = rows.map((r) => r[col]).filter((v) => v !== null);
    const fillValue = median(nonNull);
    let fills = 0;
    for (const row of rows) {
      if (row[col] === null) {
        row[col] = fillValue;
        fills += 1;
      }
    }
    if (fills > 0) missingFilled[col] = fills;
  }

  const categoricalColumns = headers.filter((h) => !dateColumns.includes(h) && !numericColumns.includes(h));
  for (const col of categoricalColumns) {
    let fills = 0;
    for (const row of rows) {
      if (isEmptyValue(row[col])) {
        row[col] = 'Unknown';
        fills += 1;
      }
    }
    if (fills > 0) missingFilled[col] = fills;
  }

  if (rows.length === 0) {
    // Nothing left after cleaning — an empty, header-only, or entirely-blank
    // file. Surfaced by the caller as dataset status 'failed', per §5.1.
    throw new Error('EMPTY_AFTER_CLEANING');
  }

  const summary = {
    normalized_columns: headers,
    rows_removed_empty: rowsRemovedEmpty,
    duplicates_removed: duplicatesRemoved,
    date_columns: dateColumns,
    numeric_columns: numericColumns,
    missing_filled: missingFilled,
    final_row_count: rows.length,
    final_column_count: headers.length,
  };

  return { headers, rows, summary };
}
