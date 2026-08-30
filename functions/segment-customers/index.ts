// Customer Segmentation / RFM (Master Prompt §9) as a real InsForge Edge
// Function — replaces GET /api/datasets/:id/segments on the Express
// server. Ported verbatim from server/pipeline/segment-customers.js.
import { createClient } from 'npm:@insforge/sdk';

const METHODOLOGY_VERSION = 1;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

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

function quantileScore(items: { key: string; value: number }[]) {
  const n = items.length;
  const sorted = [...items].sort((a, b) => a.value - b.value || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const scores = new Map<string, number>();
  sorted.forEach((item, index) => {
    scores.set(item.key, Math.min(5, Math.floor((index / n) * 5) + 1));
  });
  return scores;
}

function classify(r: number, f: number, m: number) {
  if (r >= 4 && f >= 4 && m >= 4) return 'Champions';
  if (r >= 3 && f >= 4) return 'Loyal';
  if (r >= 4 && f <= 2) return 'New Customers';
  if (r <= 2 && (f >= 3 || m >= 3)) return 'At Risk';
  if (r <= 2 && f <= 2 && m <= 2) return 'Lost';
  return 'Potential';
}

function segmentCustomers(columns: { effective_role: string | null; column_name: string }[], rows: Record<string, unknown>[]) {
  const roles = roleColumnMap(columns);
  const missing = ['date', 'revenue', 'customer'].filter((r) => !roles[r]);
  if (missing.length > 0) return { available: false, missing };

  const { date: dateCol, revenue: revenueCol, customer: customerCol } = roles;

  const byCustomer = new Map<string, { frequency: number; monetary: number; lastDate: string | null }>();
  for (const row of rows) {
    const key = row[customerCol] as string;
    if (!byCustomer.has(key)) byCustomer.set(key, { frequency: 0, monetary: 0, lastDate: null });
    const agg = byCustomer.get(key)!;
    agg.frequency += 1;
    agg.monetary += Number(row[revenueCol]) || 0;
    const rowDate = row[dateCol] as string;
    if (!agg.lastDate || rowDate > agg.lastDate) agg.lastDate = rowDate;
  }

  const maxDate = rows.reduce((max, r) => ((r[dateCol] as string) > max ? (r[dateCol] as string) : max), rows[0][dateCol] as string);

  const customers = [...byCustomer.entries()].map(([key, agg]) => ({
    key,
    recencyDays: Math.round((new Date(maxDate).getTime() - new Date(agg.lastDate!).getTime()) / ONE_DAY_MS),
    frequency: agg.frequency,
    monetary: round2(agg.monetary),
  }));

  const rScores = quantileScore(customers.map((c) => ({ key: c.key, value: -c.recencyDays })));
  const fScores = quantileScore(customers.map((c) => ({ key: c.key, value: c.frequency })));
  const mScores = quantileScore(customers.map((c) => ({ key: c.key, value: c.monetary })));

  const segments = customers.map((c) => {
    const r = rScores.get(c.key)!;
    const f = fScores.get(c.key)!;
    const m = mScores.get(c.key)!;
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

  const byLabel = new Map<string, { segment: string; size: number; totalRevenue: number; totalRecency: number }>();
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

  const { dataset_id: datasetId } = await req.json().catch(() => ({}));
  if (!datasetId) return json({ ok: false, error: { code: 'INVALID_INPUT', message: 'dataset_id is required.' } }, 400);

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

  const result = segmentCustomers(columns, rows);
  if (result.available) {
    await client.database.from('segments').delete().eq('dataset_id', datasetId);
    await client.database.from('segments').insert(
      result.segments!.map((s) => ({ dataset_id: datasetId, ...s }))
    );
  }
  return json({ ok: true, data: { segmentation: result } });
}
