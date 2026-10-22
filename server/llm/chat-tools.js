// AI Chat tools — the grounding layer. Instead of the model estimating
// answers from a summary, it calls these, and every number it can cite is
// computed here, in code, over the dataset's real rows. Charts are built
// from these results too (never from numbers the model writes), so a chart
// is grounded by construction. Each call is recorded so the server can show
// its sources and check the reply's figures (see verify-reply-numbers.js).
import { forecastRevenue } from '../pipeline/forecast-revenue.js';
import { computeKpis } from '../pipeline/compute-kpis.js';
import { detectAnomalies } from '../pipeline/detect-anomalies.js';
import { segmentCustomers } from '../pipeline/segment-customers.js';

const MAX_GROUPS = 50;
const DEFAULT_GROUPS = 20;
const MAX_CHARTS = 3;
const FORECAST_HISTORY_DAYS = 90;

function round2(n) {
  return Math.round(n * 100) / 100;
}

function roleColumnMap(columns) {
  const map = {};
  for (const col of columns) {
    if (col.effective_role && !map[col.effective_role]) map[col.effective_role] = col.column_name;
  }
  return map;
}

// ISO-ish week bucket: the Monday that starts the week, as YYYY-MM-DD.
function weekStart(isoDate) {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  const offset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

function bucketDate(value, bucket) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value);
  switch (bucket) {
    case 'week':
      return weekStart(s.slice(0, 10));
    case 'month':
      return s.slice(0, 7);
    case 'quarter':
      return `${s.slice(0, 4)}-Q${Math.floor((Number(s.slice(5, 7)) - 1) / 3) + 1}`;
    case 'year':
      return s.slice(0, 4);
    default:
      return s.slice(0, 10);
  }
}

function matchesFilter(row, { column, op = 'eq', value }) {
  const cell = row[column];
  const num = Number(cell);
  switch (op) {
    case 'neq':
      return String(cell) !== String(value);
    case 'in':
      return Array.isArray(value) && value.map(String).includes(String(cell));
    case 'gt':
      return num > Number(value);
    case 'gte':
      // Dates are YYYY-MM-DD strings, so string comparison orders them too.
      return typeof cell === 'number' ? num >= Number(value) : String(cell) >= String(value);
    case 'lt':
      return num < Number(value);
    case 'lte':
      return typeof cell === 'number' ? num <= Number(value) : String(cell) <= String(value);
    case 'contains':
      return String(cell ?? '').toLowerCase().includes(String(value).toLowerCase());
    default:
      return String(cell) === String(value);
  }
}

function aggregateValues(values, aggregation) {
  if (aggregation === 'count') return values.length;
  if (aggregation === 'count_distinct') return new Set(values.map(String)).size;
  const nums = values.map(Number).filter(Number.isFinite);
  if (nums.length === 0) return 0;
  if (aggregation === 'avg') return round2(nums.reduce((s, v) => s + v, 0) / nums.length);
  if (aggregation === 'min') return Math.min(...nums);
  if (aggregation === 'max') return Math.max(...nums);
  return round2(nums.reduce((s, v) => s + v, 0));
}

const FILTERS_SCHEMA = {
  type: 'array',
  description: 'Optional row filters, all of which must match. Use exact values from the dataset (see list_values).',
  items: {
    type: 'object',
    properties: {
      column: { type: 'string' },
      op: { type: 'string', enum: ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'contains'] },
      value: { description: 'A value, or an array for "in". Dates as YYYY-MM-DD.' },
    },
    required: ['column', 'value'],
  },
};

const CHART_SCHEMA = {
  type: 'string',
  enum: ['none', 'bar', 'line', 'pie'],
  description: 'Render this result as a chart. Use line for time series, bar for comparisons, pie only for a few shares of a whole.',
};

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'aggregate',
      description:
        'Compute a metric over the dataset, optionally grouped by a column or by time, with filters. ' +
        'Use this for totals, averages, counts, rankings, breakdowns and trends.',
      parameters: {
        type: 'object',
        properties: {
          aggregation: { type: 'string', enum: ['sum', 'avg', 'count', 'count_distinct', 'min', 'max'] },
          metric_column: { type: 'string', description: 'Column to aggregate. Not needed for count.' },
          group_by: { type: 'string', description: 'Optional column to group by.' },
          time_bucket: {
            type: 'string',
            enum: ['day', 'week', 'month', 'quarter', 'year'],
            description: 'When group_by is a date column, bucket dates this way.',
          },
          filters: FILTERS_SCHEMA,
          sort: { type: 'string', enum: ['value_desc', 'value_asc', 'label'], description: 'Time buckets default to label order.' },
          limit: { type: 'integer', description: `Max groups to return (default ${DEFAULT_GROUPS}, max ${MAX_GROUPS}).` },
          chart: CHART_SCHEMA,
          title: { type: 'string', description: 'Short chart title.' },
        },
        required: ['aggregation'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'forecast_revenue',
      description:
        'Predict future daily revenue with the app\'s forecasting model (linear trend blended with a 7-day moving average). ' +
        'Use for any prediction or "what will revenue be" question. Filters narrow the history it learns from.',
      parameters: {
        type: 'object',
        properties: {
          horizon_days: { type: 'integer', description: 'Days ahead to predict, 7 to 180.' },
          filters: FILTERS_SCHEMA,
          chart: { type: 'string', enum: ['none', 'line'], description: 'Defaults to line.' },
        },
        required: ['horizon_days'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_kpis',
      description: 'Headline KPIs (total revenue, orders, average order value, active customers, month-over-month change).',
      parameters: {
        type: 'object',
        properties: {
          start_date: { type: 'string', description: 'YYYY-MM-DD' },
          end_date: { type: 'string', description: 'YYYY-MM-DD' },
          region: { type: 'string' },
          category: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'detect_anomalies',
      description: 'Find unusual rows (outliers) in the dataset.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'customer_segments',
      description: 'RFM customer segments (e.g. Champions, At Risk) with sizes and value.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_values',
      description: 'Distinct values of a column with row counts — use before filtering to get exact spellings.',
      parameters: {
        type: 'object',
        properties: { column: { type: 'string' }, limit: { type: 'integer', description: 'Default 30, max 100.' } },
        required: ['column'],
      },
    },
  },
];

export function createChatTools(columns, rows, { anomalyContaminationRate = 0.05 } = {}) {
  const columnNames = new Set(columns.map((c) => c.column_name));
  const roles = roleColumnMap(columns);
  const calls = []; // { name, args, result, source }
  const charts = [];

  function requireColumn(name, label) {
    if (!name) return `${label} is required.`;
    if (!columnNames.has(name)) return `Unknown column "${name}". Columns: ${[...columnNames].join(', ')}.`;
    return null;
  }

  function applyFilters(filters = []) {
    for (const f of filters) {
      const err = requireColumn(f.column, 'filter column');
      if (err) return { error: err };
    }
    return { rows: filters.length ? rows.filter((r) => filters.every((f) => matchesFilter(r, f))) : rows };
  }

  function describeFilters(filters = []) {
    return filters.map((f) => `${f.column} ${f.op || 'eq'} ${Array.isArray(f.value) ? f.value.join('/') : f.value}`).join(', ');
  }

  function addChart(chart) {
    if (charts.length < MAX_CHARTS) charts.push(chart);
  }

  function aggregate(args) {
    const { aggregation = 'sum', metric_column: metric, group_by: groupBy, time_bucket: bucket, filters = [] } = args;
    if (aggregation !== 'count') {
      const err = requireColumn(metric, 'metric_column');
      if (err) return { error: err };
    }
    if (groupBy) {
      const err = requireColumn(groupBy, 'group_by');
      if (err) return { error: err };
    }
    const filtered = applyFilters(filters);
    if (filtered.error) return filtered;
    const subset = filtered.rows;
    const valueOf = (r) => (aggregation === 'count' ? 1 : r[metric]);

    if (!groupBy) {
      return {
        value: aggregateValues(subset.map(valueOf), aggregation),
        rows_matched: subset.length,
        total_rows: rows.length,
      };
    }

    const isDate = groupBy === roles.date || Boolean(bucket);
    const groups = new Map();
    for (const r of subset) {
      const key = isDate ? bucketDate(r[groupBy], bucket || 'day') : r[groupBy] === null || r[groupBy] === undefined ? '(blank)' : String(r[groupBy]);
      if (key === null) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(valueOf(r));
    }

    let result = [...groups.entries()].map(([label, values]) => ({ label, value: aggregateValues(values, aggregation) }));
    const sort = args.sort || (isDate ? 'label' : 'value_desc');
    if (sort === 'label') result.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    else if (sort === 'value_asc') result.sort((a, b) => a.value - b.value);
    else result.sort((a, b) => b.value - a.value);

    // Shares only make sense for additive metrics.
    const additive = aggregation === 'sum' || aggregation === 'count';
    const grandTotal = additive ? round2(result.reduce((s, g) => s + g.value, 0)) : null;
    if (additive && grandTotal) {
      result = result.map((g) => ({ ...g, share_pct: round2((g.value / grandTotal) * 100) }));
    }

    const limit = Math.min(Math.max(Number(args.limit) || (isDate ? MAX_GROUPS : DEFAULT_GROUPS), 1), MAX_GROUPS);
    // For time series keep the most recent buckets, for rankings the top ones.
    const shown = sort === 'label' && isDate ? result.slice(-limit) : result.slice(0, limit);

    if (args.chart && args.chart !== 'none' && shown.length > 0) {
      const metricLabel = aggregation === 'count' ? 'Rows' : `${aggregation === 'sum' ? '' : `${aggregation} `}${metric}`.trim();
      addChart({
        type: args.chart === 'pie' && shown.length > 8 ? 'bar' : args.chart,
        title: args.title || `${metricLabel} by ${groupBy}${bucket ? ` (${bucket})` : ''}`,
        labels: shown.map((g) => g.label),
        series: [{ name: metricLabel, values: shown.map((g) => g.value) }],
        x_label: groupBy,
        y_label: metricLabel,
      });
    }

    return {
      groups: shown,
      groups_total: result.length,
      truncated: shown.length < result.length,
      grand_total: grandTotal,
      rows_matched: subset.length,
    };
  }

  function forecast(args) {
    const horizon = Math.min(Math.max(Math.round(Number(args.horizon_days) || 30), 7), 180);
    const filtered = applyFilters(args.filters);
    if (filtered.error) return filtered;
    if (filtered.rows.length === 0) return { error: 'No rows match those filters.' };

    const f = forecastRevenue(columns, filtered.rows, { horizonDays: horizon });
    if (!f.available) return { error: `Forecasting needs a ${f.missing.join(' and ')} column.` };

    const history = f.historical;
    const sum = (list, key) => round2(list.reduce((s, p) => s + p[key], 0));
    const predictedTotal = sum(f.series, 'predicted_revenue');
    // Only compare against a previous period of the same length, if there is one.
    const comparable = history.length >= horizon;
    const recentTotal = comparable ? sum(history.slice(-horizon), 'revenue') : null;

    // Monthly roll-up of the prediction, so long horizons can be stated per month.
    const byMonth = new Map();
    for (const p of f.series) {
      const m = p.date.slice(0, 7);
      byMonth.set(m, round2((byMonth.get(m) || 0) + p.predicted_revenue));
    }

    if (args.chart !== 'none') {
      const shownHistory = history.slice(-FORECAST_HISTORY_DAYS);
      const labels = [...shownHistory.map((p) => p.date), ...f.series.map((p) => p.date)];
      const pad = (n) => Array(n).fill(null);
      // The forecast line starts at the last actual point so the two connect.
      const last = shownHistory[shownHistory.length - 1];
      addChart({
        type: 'line',
        title: `Revenue forecast — next ${horizon} days`,
        labels,
        series: [
          { name: 'Actual', values: [...shownHistory.map((p) => p.revenue), ...pad(f.series.length)] },
          {
            name: 'Forecast',
            style: 'dashed',
            values: [...pad(shownHistory.length - 1), last.revenue, ...f.series.map((p) => p.predicted_revenue)],
          },
        ],
        x_label: roles.date,
        y_label: roles.revenue,
      });
    }

    return {
      horizon_days: horizon,
      history_start: history[0].date,
      history_end: history[history.length - 1].date,
      history_days: history.length,
      predicted_total: predictedTotal,
      predicted_daily_avg: round2(predictedTotal / horizon),
      first_day: f.series[0],
      last_day: f.series[f.series.length - 1],
      predicted_by_month: [...byMonth.entries()].map(([month, revenue]) => ({ month, revenue })),
      actual_total_previous_period: recentTotal,
      change_vs_previous_period_pct: recentTotal ? round2(((predictedTotal - recentTotal) / recentTotal) * 100) : null,
      reliability:
        history.length < 30
          ? `low — only ${history.length} days of history; treat as a rough indication`
          : history.length < horizon * 2
            ? 'moderate — history is shorter than twice the horizon'
            : 'normal',
      method: 'Linear trend over the full daily history, anchored on a 0.6/0.4 blend with the 7-day moving average. No seasonality.',
    };
  }

  function kpis(args) {
    const k = computeKpis(columns, rows, {
      startDate: args.start_date,
      endDate: args.end_date,
      region: args.region,
      category: args.category,
    });
    if (!k.available) return { error: `KPIs need a ${k.missing.join(' and ')} column.` };
    return {
      total_revenue: k.total_revenue,
      total_orders: k.total_orders,
      avg_order_value: k.avg_order_value,
      active_customers: k.active_customers,
      month_over_month: k.mom,
      date_range: k.date_range,
    };
  }

  function anomalies() {
    const a = detectAnomalies(columns, rows, { contaminationRate: anomalyContaminationRate });
    if (!a.available) return { error: 'Anomaly detection is not available for this dataset.' };
    const top = [...a.flagged_rows].sort((x, y) => y.anomaly_score - x.anomaly_score).slice(0, 10);
    return {
      flagged_count: a.flagged_rows.length,
      total_rows: rows.length,
      top_flagged: top.map((f) => ({ row_number: f.row_index + 1, anomaly_score: f.anomaly_score, row: rows[f.row_index] })),
    };
  }

  function segments() {
    const s = segmentCustomers(columns, rows);
    if (!s.available) return { error: 'Customer segmentation needs customer, date and revenue columns.' };
    return { segments: s.summary_by_label, customers_total: s.segments.length };
  }

  function listValues(args) {
    const err = requireColumn(args.column, 'column');
    if (err) return { error: err };
    const counts = new Map();
    for (const r of rows) {
      const v = r[args.column];
      if (v === null || v === undefined || v === '') continue;
      counts.set(String(v), (counts.get(String(v)) || 0) + 1);
    }
    const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
    const values = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
    return { distinct_count: counts.size, values: values.map(([value, count]) => ({ value, count })) };
  }

  function sourceFor(name, args, result) {
    const where = args.filters?.length ? ` where ${describeFilters(args.filters)}` : '';
    switch (name) {
      case 'aggregate': {
        const what = args.aggregation === 'count' ? 'Row count' : `${args.aggregation} of ${args.metric_column}`;
        const by = args.group_by ? ` by ${args.group_by}${args.time_bucket ? ` (${args.time_bucket})` : ''}` : '';
        return `${what}${by}${where} — ${result.rows_matched} rows`;
      }
      case 'forecast_revenue':
        return `Revenue forecast, ${result.horizon_days} days, from ${result.history_days} days of history${where}`;
      case 'get_kpis':
        return 'Dashboard KPIs';
      case 'detect_anomalies':
        return `Anomaly detection — ${result.flagged_count} of ${result.total_rows} rows flagged`;
      case 'customer_segments':
        return `RFM segmentation — ${result.customers_total} customers`;
      case 'list_values':
        return `Distinct values of ${args.column}`;
      default:
        return name;
    }
  }

  const handlers = {
    aggregate,
    forecast_revenue: forecast,
    get_kpis: kpis,
    detect_anomalies: anomalies,
    customer_segments: segments,
    list_values: listValues,
  };

  return {
    definitions: TOOL_DEFINITIONS,
    run(name, args = {}) {
      const handler = handlers[name];
      let result;
      try {
        result = handler ? handler(args) : { error: `Unknown tool "${name}".` };
      } catch (err) {
        result = { error: `Tool failed: ${err.message}` };
      }
      if (!result.error) calls.push({ name, args, result, source: sourceFor(name, args, result) });
      return result;
    },
    get calls() {
      return calls;
    },
    get charts() {
      return charts;
    },
  };
}
