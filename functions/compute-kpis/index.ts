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

const METHODOLOGY_VERSION = 2;

type Column = { effective_role: string | null; column_name: string };
type Row = Record<string, unknown>;

const TOP_PRODUCTS_LIMIT = 10;

function roleColumnMap(columns: Column[]) {
  const map: Record<string, string> = {};
  for (const col of columns) {
    if (col.effective_role && !map[col.effective_role]) map[col.effective_role] = col.column_name;
  }
  return map;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function distinctSorted(rows: Row[], col: string | undefined) {
  if (!col) return [];
  return [...new Set(rows.map((r) => r[col]).filter((v) => v !== null && v !== undefined && v !== ''))].sort();
}

// 'YYYY-MM' of the month before `month`.
function previousMonth(month: string) {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

function percentChange(current: number, previous: number) {
  if (!previous) return null; // no baseline — a % change would be meaningless
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function computeKpis(
  columns: Column[],
  rows: Row[],
  { startDate, endDate, region, category }: { startDate?: string; endDate?: string; region?: string; category?: string } = {}
) {
  const roles = roleColumnMap(columns);
  const missing = ['date', 'revenue'].filter((r) => !roles[r]);
  if (missing.length > 0) {
    return { available: false, missing };
  }

  const dateCol = roles.date;
  const revenueCol = roles.revenue;
  const customerCol = roles.customer;
  const orderCol = roles.order;
  const regionCol = roles.region;
  const categoryCol = roles.category;
  const productCol = roles.product;
  const quantityCol = roles.quantity;

  const revenueOf = (r: Row) => Number(r[revenueCol]) || 0;
  const dateOf = (r: Row) => (r[dateCol] === null || r[dateCol] === undefined ? '' : String(r[dateCol]));

  const allDates = rows.map(dateOf).filter(Boolean).sort();
  const dateRange = allDates.length ? { min: allDates[0], max: allDates[allDates.length - 1] } : null;

  const summarize = (list: Row[]) => {
    const totalRevenue = list.reduce((sum, r) => sum + revenueOf(r), 0);
    const totalOrders = orderCol ? new Set(list.map((r) => r[orderCol])).size : list.length;
    return {
      total_revenue: round2(totalRevenue),
      total_orders: totalOrders,
      avg_order_value: round2(totalOrders > 0 ? totalRevenue / totalOrders : 0),
      active_customers: customerCol ? new Set(list.map((r) => r[customerCol])).size : 0,
    };
  };

  // Filter scopes, narrowest last. Category mix ignores the category filter
  // so every bar stays visible (and clickable) while one is drilled into;
  // MoM and customer value ignore the date filter because they need history
  // from outside the selected range.
  const inRegion = region && regionCol ? rows.filter((r) => r[regionCol] === region) : rows;
  const byCategory = (list: Row[]) => (category && categoryCol ? list.filter((r) => r[categoryCol] === category) : list);
  const byDate = (list: Row[]) =>
    list.filter((r) => (!startDate || dateOf(r) >= startDate) && (!endDate || dateOf(r) <= endDate));

  const inRegionAndDate = byDate(inRegion);
  const filtered = byCategory(inRegionAndDate);
  const allTimeScope = byCategory(inRegion);

  const revenueByDate = new Map<string, number>();
  for (const r of filtered) {
    const key = dateOf(r);
    revenueByDate.set(key, (revenueByDate.get(key) || 0) + revenueOf(r));
  }
  const revenueTrend = [...revenueByDate.entries()]
    .map(([date, revenue]) => ({ date, revenue: round2(revenue) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  let categoryMix: { category: unknown; revenue: number }[] = [];
  if (categoryCol) {
    const revenueByCategory = new Map<unknown, number>();
    for (const r of inRegionAndDate) {
      const key = r[categoryCol];
      revenueByCategory.set(key, (revenueByCategory.get(key) || 0) + revenueOf(r));
    }
    categoryMix = [...revenueByCategory.entries()]
      .map(([cat, revenue]) => ({ category: cat, revenue: round2(revenue) }))
      .sort((a, b) => b.revenue - a.revenue);
  }

  let topProducts: Record<string, unknown>[] = [];
  if (productCol) {
    const byProduct = new Map<unknown, { product: unknown; revenue: number; units: number; orders: number }>();
    for (const r of filtered) {
      const key = r[productCol];
      if (key === null || key === undefined || key === '') continue;
      const entry = byProduct.get(key) || { product: key, revenue: 0, units: 0, orders: 0 };
      entry.revenue += revenueOf(r);
      entry.units += quantityCol ? Number(r[quantityCol]) || 0 : 0;
      entry.orders += 1;
      byProduct.set(key, entry);
    }
    const total = filtered.reduce((sum, r) => sum + revenueOf(r), 0);
    topProducts = [...byProduct.values()]
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, TOP_PRODUCTS_LIMIT)
      .map((p) => ({
        product: p.product,
        revenue: round2(p.revenue),
        units: quantityCol ? round2(p.units) : null,
        orders: p.orders,
        share_pct: total > 0 ? Math.round((p.revenue / total) * 1000) / 10 : 0,
      }));
  }

  // Month-over-month: the month containing the end of the selected range
  // (or the latest data) vs the calendar month before it.
  let mom: { current_month: string; previous_month: string; changes: Record<string, unknown> } | null = null;
  const anchorDate = endDate || (dateRange && dateRange.max);
  if (anchorDate) {
    const currentMonth = anchorDate.slice(0, 7);
    const prevMonth = previousMonth(currentMonth);
    const current = summarize(allTimeScope.filter((r) => dateOf(r).startsWith(currentMonth)));
    const previous = summarize(allTimeScope.filter((r) => dateOf(r).startsWith(prevMonth)));
    mom = { current_month: currentMonth, previous_month: prevMonth, changes: {} };
    for (const key of Object.keys(current) as (keyof typeof current)[]) {
      mom.changes[key] = { current: current[key], previous: previous[key], change_pct: percentChange(current[key], previous[key]) };
    }
  }

  // Customer value: lifetime revenue per customer (all time) and how many
  // customers placed their first-ever order inside the selected range — the
  // denominator for CAC once the user supplies marketing spend.
  let customerValue: Record<string, unknown> = { available: false };
  if (customerCol) {
    const firstSeen = new Map<unknown, string>();
    const lifetimeRevenue = new Map<unknown, number>();
    for (const r of allTimeScope) {
      const c = r[customerCol];
      if (c === null || c === undefined || c === '') continue;
      const d = dateOf(r);
      if (!firstSeen.has(c) || d < (firstSeen.get(c) as string)) firstSeen.set(c, d);
      lifetimeRevenue.set(c, (lifetimeRevenue.get(c) || 0) + revenueOf(r));
    }
    const customers = lifetimeRevenue.size;
    const totalLifetime = [...lifetimeRevenue.values()].reduce((a, b) => a + b, 0);
    let newCustomers = 0;
    for (const d of firstSeen.values()) {
      if ((!startDate || d >= startDate) && (!endDate || d <= endDate)) newCustomers += 1;
    }
    customerValue = {
      available: true,
      avg_lifetime_value: round2(customers > 0 ? totalLifetime / customers : 0),
      customers_all_time: customers,
      new_customers: newCustomers,
    };
  }

  return {
    available: true,
    ...summarize(filtered),
    revenue_trend: revenueTrend,
    category_mix: categoryMix,
    top_products: topProducts,
    product_available: Boolean(productCol),
    mom,
    customer_value: customerValue,
    date_range: dateRange,
    available_regions: distinctSorted(rows, regionCol),
    available_categories: distinctSorted(rows, categoryCol),
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

  const { dataset_id: datasetId, start_date: startDate, end_date: endDate, region, category } = await req.json().catch(() => ({}));
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

  const kpis = computeKpis(columns, rows, { startDate, endDate, region, category });
  return json({ ok: true, data: { kpis } });
}
