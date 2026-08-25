// Revenue Forecasting (Master Prompt §8). See docs/edge-function-contracts.md
// for the concrete choice made where §8 underspecifies the moving-average
// component for future (not-yet-happened) days.
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

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Every calendar day from the earliest to latest date, zero-filled for gap
// days — a day with no sales is 0 revenue, not a missing value, and this
// keeps the regression's x-spacing even.
function buildDenseSeries(dateCol, revenueCol, rows) {
  const revenueByDate = new Map();
  for (const r of rows) {
    const key = r[dateCol];
    revenueByDate.set(key, (revenueByDate.get(key) || 0) + (Number(r[revenueCol]) || 0));
  }
  const dates = [...revenueByDate.keys()].sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  const totalDays = Math.round((new Date(`${last}T00:00:00.000Z`) - new Date(`${first}T00:00:00.000Z`)) / ONE_DAY_MS) + 1;

  const series = [];
  for (let i = 0; i < totalDays; i++) {
    const date = addDays(first, i);
    series.push({ date, revenue: round2(revenueByDate.get(date) || 0) });
  }
  return series;
}

function fitLinearTrend(values) {
  const n = values.length;
  const sumX = values.reduce((s, _, i) => s + i, 0);
  const sumY = values.reduce((s, v) => s + v, 0);
  const sumXY = values.reduce((s, v, i) => s + i * v, 0);
  const sumX2 = values.reduce((s, _, i) => s + i * i, 0);

  const denom = n * sumX2 - sumX * sumX;
  const slope = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

export function forecastRevenue(columns, rows, { horizonDays } = {}) {
  const roles = roleColumnMap(columns);
  const missing = ['date', 'revenue'].filter((r) => !roles[r]);
  if (missing.length > 0) {
    return { available: false, missing };
  }

  const dense = buildDenseSeries(roles.date, roles.revenue, rows);
  const values = dense.map((p) => p.revenue);
  const { slope, intercept } = fitLinearTrend(values);

  const window = Math.min(7, values.length);
  const movingAverage = values.slice(-window).reduce((s, v) => s + v, 0) / window;

  const lastDate = dense[dense.length - 1].date;
  const series = [];
  for (let k = 1; k <= horizonDays; k++) {
    const x = dense.length - 1 + k;
    const linearTrend = intercept + slope * x;
    const predicted = Math.max(0, round2(0.6 * linearTrend + 0.4 * movingAverage));
    series.push({ date: addDays(lastDate, k), predicted_revenue: predicted });
  }

  return {
    available: true,
    historical: dense,
    series,
    horizon_days: horizonDays,
    methodology_version: METHODOLOGY_VERSION,
  };
}
