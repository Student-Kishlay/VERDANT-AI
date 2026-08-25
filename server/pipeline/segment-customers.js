// Customer Segmentation / RFM (Master Prompt §9). See
// docs/edge-function-contracts.md for the concrete scoring and mapping
// choices made where §9 leaves the mechanics unspecified.
export const METHODOLOGY_VERSION = 1;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function roleColumnMap(columns) {
  const map = {};
  for (const col of columns) {
    if (col.effective_role && !map[col.effective_role]) map[col.effective_role] = col.column_name;
  }
  return map;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Ascending quantile bucketing into scores 1-5, stable on ties (secondary
// sort by key) so results are reproducible. Used directly for
// frequency/monetary (higher value = better = higher score) and, with the
// value negated by the caller, for recency (fewer days = better).
function quantileScore(items) {
  const n = items.length;
  const sorted = [...items].sort((a, b) => a.value - b.value || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const scores = new Map();
  sorted.forEach((item, index) => {
    scores.set(item.key, Math.min(5, Math.floor((index / n) * 5) + 1));
  });
  return scores;
}

// Priority-ordered rule table (first match wins) — a concrete, documented
// choice for the "map composite score patterns to segment labels" step §9
// leaves open. Chosen so all 6 labels are reachable with simple boundaries.
function classify(r, f, m) {
  if (r >= 4 && f >= 4 && m >= 4) return 'Champions';
  if (r >= 3 && f >= 4) return 'Loyal';
  if (r >= 4 && f <= 2) return 'New Customers';
  if (r <= 2 && (f >= 3 || m >= 3)) return 'At Risk';
  if (r <= 2 && f <= 2 && m <= 2) return 'Lost';
  return 'Potential';
}

export function segmentCustomers(columns, rows) {
  const roles = roleColumnMap(columns);
  const missing = ['date', 'revenue', 'customer'].filter((r) => !roles[r]);
  if (missing.length > 0) {
    return { available: false, missing };
  }

  const { date: dateCol, revenue: revenueCol, customer: customerCol } = roles;

  const byCustomer = new Map();
  for (const row of rows) {
    const key = row[customerCol];
    if (!byCustomer.has(key)) byCustomer.set(key, { frequency: 0, monetary: 0, lastDate: null });
    const agg = byCustomer.get(key);
    agg.frequency += 1;
    agg.monetary += Number(row[revenueCol]) || 0;
    if (!agg.lastDate || row[dateCol] > agg.lastDate) agg.lastDate = row[dateCol];
  }

  const maxDate = rows.reduce((max, r) => (r[dateCol] > max ? r[dateCol] : max), rows[0][dateCol]);

  const customers = [...byCustomer.entries()].map(([key, agg]) => ({
    key,
    recencyDays: Math.round((new Date(maxDate) - new Date(agg.lastDate)) / ONE_DAY_MS),
    frequency: agg.frequency,
    monetary: round2(agg.monetary),
  }));

  const rScores = quantileScore(customers.map((c) => ({ key: c.key, value: -c.recencyDays })));
  const fScores = quantileScore(customers.map((c) => ({ key: c.key, value: c.frequency })));
  const mScores = quantileScore(customers.map((c) => ({ key: c.key, value: c.monetary })));

  const segments = customers.map((c) => {
    const r = rScores.get(c.key);
    const f = fScores.get(c.key);
    const m = mScores.get(c.key);
    return {
      customer_key: c.key,
      recency_days: c.recencyDays,
      frequency: c.frequency,
      monetary: c.monetary,
      recency_score: r,
      frequency_score: f,
      monetary_score: m,
      rfm_segment: classify(r, f, m),
      methodology_version: METHODOLOGY_VERSION,
    };
  });

  const byLabel = new Map();
  for (const s of segments) {
    const bucket = byLabel.get(s.rfm_segment) || { segment: s.rfm_segment, size: 0, totalRevenue: 0, totalRecency: 0 };
    bucket.size += 1;
    bucket.totalRevenue += s.monetary;
    bucket.totalRecency += s.recency_days;
    byLabel.set(s.rfm_segment, bucket);
  }
  const summaryByLabel = [...byLabel.values()].map((b) => ({
    segment: b.segment,
    size: b.size,
    avg_revenue: round2(b.totalRevenue / b.size),
    avg_recency: round2(b.totalRecency / b.size),
  }));

  return { available: true, segments, summary_by_label: summaryByLabel, methodology_version: METHODOLOGY_VERSION };
}
