// KPI Dashboard (Master Prompt §7). All filtering happens once, right here —
// the route that calls this never pre- or post-filters, so "server-side
// recompute" is structurally true rather than just a label on top of a
// client-side filter.
export const METHODOLOGY_VERSION = 1;

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

export function computeKpis(columns, rows, { startDate, endDate, region } = {}) {
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

  const availableRegions = regionCol
    ? [...new Set(rows.map((r) => r[regionCol]).filter((v) => v !== null && v !== undefined))].sort()
    : [];

  let filtered = rows;
  if (startDate) filtered = filtered.filter((r) => r[dateCol] >= startDate);
  if (endDate) filtered = filtered.filter((r) => r[dateCol] <= endDate);
  if (region && regionCol) filtered = filtered.filter((r) => r[regionCol] === region);

  const totalRevenue = filtered.reduce((sum, r) => sum + (Number(r[revenueCol]) || 0), 0);
  const totalOrders = orderCol
    ? new Set(filtered.map((r) => r[orderCol])).size
    : filtered.length;
  const activeCustomers = customerCol ? new Set(filtered.map((r) => r[customerCol])).size : 0;
  const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

  const revenueByDate = new Map();
  for (const r of filtered) {
    const key = r[dateCol];
    revenueByDate.set(key, (revenueByDate.get(key) || 0) + (Number(r[revenueCol]) || 0));
  }
  const revenueTrend = [...revenueByDate.entries()]
    .map(([date, revenue]) => ({ date, revenue: round2(revenue) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  let categoryMix = [];
  if (categoryCol) {
    const revenueByCategory = new Map();
    for (const r of filtered) {
      const key = r[categoryCol];
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
