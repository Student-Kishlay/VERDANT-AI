// KPI Dashboard (Master Prompt §7). All filtering happens once, right here —
// the route that calls this never pre- or post-filters, so "server-side
// recompute" is structurally true rather than just a label on top of a
// client-side filter.
//
// Mirrored verbatim in functions/compute-kpis/index.ts (the edge function
// the browser actually calls) — change both together.
export const METHODOLOGY_VERSION = 2;

const TOP_PRODUCTS_LIMIT = 10;

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

function distinctSorted(rows, col) {
  if (!col) return [];
  return [...new Set(rows.map((r) => r[col]).filter((v) => v !== null && v !== undefined && v !== ''))].sort();
}

// 'YYYY-MM' of the month before `month`.
function previousMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

function percentChange(current, previous) {
  if (!previous) return null; // no baseline — a % change would be meaningless
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export function computeKpis(columns, rows, { startDate, endDate, region, category } = {}) {
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

  const revenueOf = (r) => Number(r[revenueCol]) || 0;
  const dateOf = (r) => (r[dateCol] === null || r[dateCol] === undefined ? '' : String(r[dateCol]));

  const allDates = rows.map(dateOf).filter(Boolean).sort();
  const dateRange = allDates.length ? { min: allDates[0], max: allDates[allDates.length - 1] } : null;

  const summarize = (list) => {
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
  const byCategory = (list) => (category && categoryCol ? list.filter((r) => r[categoryCol] === category) : list);
  const byDate = (list) =>
    list.filter((r) => (!startDate || dateOf(r) >= startDate) && (!endDate || dateOf(r) <= endDate));

  const inRegionAndDate = byDate(inRegion);
  const filtered = byCategory(inRegionAndDate);
  const allTimeScope = byCategory(inRegion);

  const revenueByDate = new Map();
  for (const r of filtered) {
    const key = dateOf(r);
    revenueByDate.set(key, (revenueByDate.get(key) || 0) + revenueOf(r));
  }
  const revenueTrend = [...revenueByDate.entries()]
    .map(([date, revenue]) => ({ date, revenue: round2(revenue) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  let categoryMix = [];
  if (categoryCol) {
    const revenueByCategory = new Map();
    for (const r of inRegionAndDate) {
      const key = r[categoryCol];
      revenueByCategory.set(key, (revenueByCategory.get(key) || 0) + revenueOf(r));
    }
    categoryMix = [...revenueByCategory.entries()]
      .map(([cat, revenue]) => ({ category: cat, revenue: round2(revenue) }))
      .sort((a, b) => b.revenue - a.revenue);
  }

  let topProducts = [];
  if (productCol) {
    const byProduct = new Map();
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
  let mom = null;
  const anchorDate = endDate || (dateRange && dateRange.max);
  if (anchorDate) {
    const currentMonth = anchorDate.slice(0, 7);
    const prevMonth = previousMonth(currentMonth);
    const current = summarize(allTimeScope.filter((r) => dateOf(r).startsWith(currentMonth)));
    const previous = summarize(allTimeScope.filter((r) => dateOf(r).startsWith(prevMonth)));
    mom = { current_month: currentMonth, previous_month: prevMonth, changes: {} };
    for (const key of Object.keys(current)) {
      mom.changes[key] = { current: current[key], previous: previous[key], change_pct: percentChange(current[key], previous[key]) };
    }
  }

  // Customer value: lifetime revenue per customer (all time) and how many
  // customers placed their first-ever order inside the selected range — the
  // denominator for CAC once the user supplies marketing spend.
  let customerValue = { available: false };
  if (customerCol) {
    const firstSeen = new Map();
    const lifetimeRevenue = new Map();
    for (const r of allTimeScope) {
      const c = r[customerCol];
      if (c === null || c === undefined || c === '') continue;
      const d = dateOf(r);
      if (!firstSeen.has(c) || d < firstSeen.get(c)) firstSeen.set(c, d);
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
