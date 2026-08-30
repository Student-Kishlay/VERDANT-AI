// Revenue Forecasting (Master Prompt §8) as a real InsForge Edge Function —
// replaces GET /api/datasets/:id/forecast on the Express server. Ported
// verbatim from server/pipeline/forecast-revenue.js (v2 methodology — see
// docs/edge-function-contracts.md). Uses the caller's own access token so
// Postgres RLS scopes dataset access, same pattern as compute-kpis.
import { createClient } from 'npm:@insforge/sdk';

const METHODOLOGY_VERSION = 2;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ALLOWED_HORIZONS = [7, 30, 90];

function roleColumnMap(columns: { effective_role: string | null; column_name: string }[]) {
  const map: Record<string, string> = {};
  for (const col of columns) {
    if (col.effective_role && !map[col.effective_role]) map[col.effective_role] = col.column_name;
  }
  return map;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function addDays(isoDate: string, days: number) {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function buildDenseSeries(dateCol: string, revenueCol: string, rows: Record<string, unknown>[]) {
  const revenueByDate = new Map<string, number>();
  for (const r of rows) {
    const key = r[dateCol] as string;
    revenueByDate.set(key, (revenueByDate.get(key) || 0) + (Number(r[revenueCol]) || 0));
  }
  const dates = [...revenueByDate.keys()].sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  const totalDays = Math.round((new Date(`${last}T00:00:00.000Z`).getTime() - new Date(`${first}T00:00:00.000Z`).getTime()) / ONE_DAY_MS) + 1;

  const series = [];
  for (let i = 0; i < totalDays; i++) {
    const date = addDays(first, i);
    series.push({ date, revenue: round2(revenueByDate.get(date) || 0) });
  }
  return series;
}

function fitLinearTrend(values: number[]) {
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

function forecastRevenue(
  columns: { effective_role: string | null; column_name: string }[],
  rows: Record<string, unknown>[],
  horizonDays: number
) {
  const roles = roleColumnMap(columns);
  const missing = ['date', 'revenue'].filter((r) => !roles[r]);
  if (missing.length > 0) return { available: false, missing };

  const dense = buildDenseSeries(roles.date, roles.revenue, rows);
  const values = dense.map((p) => p.revenue);
  const { slope, intercept } = fitLinearTrend(values);

  const window = Math.min(7, values.length);
  const movingAverage = values.slice(-window).reduce((s, v) => s + v, 0) / window;
  const lastIndex = dense.length - 1;
  const linearAtLast = intercept + slope * lastIndex;
  const anchor = 0.6 * linearAtLast + 0.4 * movingAverage;

  const lastDate = dense[dense.length - 1].date;
  const series = [];
  for (let k = 1; k <= horizonDays; k++) {
    series.push({ date: addDays(lastDate, k), predicted_revenue: Math.max(0, round2(anchor + slope * k)) });
  }

  return { available: true, historical: dense, series, horizon_days: horizonDays, methodology_version: METHODOLOGY_VERSION };
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

  const authHeader = req.headers.get('Authorization');
  const userToken = authHeader ? authHeader.replace('Bearer ', '') : null;
  if (!userToken) return json({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Missing bearer token.' } }, 401);

  const client = createClient({ baseUrl: Deno.env.get('INSFORGE_BASE_URL'), edgeFunctionToken: userToken });

  const { dataset_id: datasetId, horizon_days: horizonDays } = await req.json().catch(() => ({}));
  if (!datasetId) return json({ ok: false, error: { code: 'INVALID_INPUT', message: 'dataset_id is required.' } }, 400);
  if (!ALLOWED_HORIZONS.includes(horizonDays)) {
    return json({ ok: false, error: { code: 'INVALID_INPUT', message: `horizon_days must be one of: ${ALLOWED_HORIZONS.join(', ')}.` } }, 400);
  }

  const { data: dataset } = await client.database.from('datasets').select('*').eq('id', datasetId).maybeSingle();
  if (!dataset) return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Dataset not found.' } }, 404);
  if (dataset.status !== 'ready') {
    return json({ ok: false, error: { code: 'NOT_READY', message: `Dataset is ${dataset.status}, not ready.` } }, 409);
  }

  const { data: columnMaps } = await client.database.from('column_maps').select('*').eq('dataset_id', datasetId);
  const columns = (columnMaps ?? []).map((c: { user_override: string | null; detected_role: string | null; column_name: string }) => ({
    column_name: c.column_name,
    effective_role: c.user_override ?? c.detected_role,
  }));

  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data: page } = await client.database
      .from('dataset_rows')
      .select('data')
      .eq('dataset_id', datasetId)
      .order('row_index', { ascending: true })
      .range(offset, offset + 999);
    if (!page || page.length === 0) break;
    rows.push(...page.map((r: { data: Record<string, unknown> }) => r.data));
    if (page.length < 1000) break;
  }

  const result = forecastRevenue(columns, rows, horizonDays);
  if (result.available) {
    await client.database.from('forecasts').insert({
      dataset_id: datasetId,
      horizon_days: horizonDays,
      series: result.series,
      methodology_version: result.methodology_version,
    });
  }
  return json({ ok: true, data: { forecast: result } });
}
