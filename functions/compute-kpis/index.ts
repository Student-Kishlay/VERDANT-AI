// KPI Dashboard (Master Prompt §7) as a real InsForge Edge Function —
// replaces GET /api/datasets/:id/kpis on the Express server. Ported
// verbatim from server/pipeline/compute-kpis.js (edge functions deploy as
// a single file, no relative imports to the rest of the repo, so the pure
// computation is inlined below rather than imported).
//
// Uses the caller's own access token (not an admin key) so Postgres RLS —
// not a manual membership check — is what scopes which dataset_rows/
// column_maps this request can see. A dataset the caller isn't a member of
// simply returns zero rows via RLS, which reads the same as "not found."
import { createClient } from 'npm:@insforge/sdk';

const METHODOLOGY_VERSION = 1;

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

function computeKpis(
  columns: { effective_role: string | null; column_name: string }[],
  rows: Record<string, unknown>[],
  { startDate, endDate, region }: { startDate?: string; endDate?: string; region?: string } = {}
) {
  const roles = roleColumnMap(columns);
  const missing = ['date', 'revenue'].filter((r) => !roles[r]);
  if (missing.length > 0) return { available: false, missing };

  const dateCol = roles.date;
  const revenueCol = roles.revenue;
  const customerCol = roles.customer;
  const orderCol = roles.order;
  const regionCol = roles.region;
  const categoryCol = roles.category;

  const availableRegions = regionCol
    ? [...new Set(rows.map((r) => r[regionCol]).filter((v) => v !== null && v !== undefined))].sort()
    : [];

  let filtered = rows;
  if (startDate) filtered = filtered.filter((r) => (r[dateCol] as string) >= startDate);
  if (endDate) filtered = filtered.filter((r) => (r[dateCol] as string) <= endDate);
  if (region && regionCol) filtered = filtered.filter((r) => r[regionCol] === region);

  const totalRevenue = filtered.reduce((sum, r) => sum + (Number(r[revenueCol]) || 0), 0);
  const totalOrders = orderCol ? new Set(filtered.map((r) => r[orderCol])).size : filtered.length;
  const activeCustomers = customerCol ? new Set(filtered.map((r) => r[customerCol])).size : 0;
  const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

  const revenueByDate = new Map<string, number>();
  for (const r of filtered) {
    const key = r[dateCol] as string;
    revenueByDate.set(key, (revenueByDate.get(key) || 0) + (Number(r[revenueCol]) || 0));
  }
  const revenueTrend = [...revenueByDate.entries()]
    .map(([date, revenue]) => ({ date, revenue: round2(revenue) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  let categoryMix: { category: string; revenue: number }[] = [];
  if (categoryCol) {
    const revenueByCategory = new Map<string, number>();
    for (const r of filtered) {
      const key = r[categoryCol] as string;
      revenueByCategory.set(key, (revenueByCategory.get(key) || 0) + (Number(r[revenueCol]) || 0));
    }
    categoryMix = [...revenueByCategory.entries()]
      .map(([category, revenue]) => ({ category, revenue: round2(revenue) }))
      .sort((a, b) => b.revenue - a.revenue);
  }

  return {
    available: true,
    total_revenue: round2(totalRevenue),
    total_orders: totalOrders,
    avg_order_value: round2(avgOrderValue),
    active_customers: activeCustomers,
    revenue_trend: revenueTrend,
    category_mix: categoryMix,
    available_regions: availableRegions,
    methodology_version: METHODOLOGY_VERSION,
  };
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

  const client = createClient({
    baseUrl: Deno.env.get('INSFORGE_BASE_URL'),
    edgeFunctionToken: userToken,
  });

  const { dataset_id: datasetId, start_date: startDate, end_date: endDate, region } = await req.json().catch(() => ({}));
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

  // dataset_rows can exceed the Database API's 1000-row page size — page
  // through it the same way server/insforge.js#selectAll does.
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

  const kpis = computeKpis(columns, rows, { startDate, endDate, region });
  return json({ ok: true, data: { kpis } });
}
