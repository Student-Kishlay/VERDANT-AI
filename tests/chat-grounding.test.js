import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChatTools } from '../server/llm/chat-tools.js';
import { verifyReplyNumbers, extractFigures } from '../server/pipeline/verify-reply-numbers.js';
import { startServer, signupAndGetSession } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const COLUMNS = [
  { column_name: 'order_date', effective_role: 'date' },
  { column_name: 'region', effective_role: 'region' },
  { column_name: 'category', effective_role: 'category' },
  { column_name: 'revenue', effective_role: 'revenue' },
];
const ROWS = [
  { order_date: '2024-01-05', region: 'North', category: 'A', revenue: 100 },
  { order_date: '2024-01-20', region: 'South', category: 'B', revenue: 300 },
  { order_date: '2024-02-03', region: 'North', category: 'A', revenue: 250 },
  { order_date: '2024-02-17', region: 'North', category: 'B', revenue: 50 },
  { order_date: '2024-03-09', region: 'South', category: 'A', revenue: 400 },
];

test('aggregate groups, sorts, filters and computes shares from the real rows', () => {
  const tools = createChatTools(COLUMNS, ROWS);
  const byRegion = tools.run('aggregate', { aggregation: 'sum', metric_column: 'revenue', group_by: 'region' });
  assert.deepEqual(byRegion.groups, [
    { label: 'South', value: 700, share_pct: 63.64 },
    { label: 'North', value: 400, share_pct: 36.36 },
  ]);
  assert.equal(byRegion.grand_total, 1100);

  const north = tools.run('aggregate', {
    aggregation: 'avg',
    metric_column: 'revenue',
    filters: [{ column: 'region', op: 'eq', value: 'North' }],
  });
  assert.equal(north.value, 133.33);
  assert.equal(north.rows_matched, 3);
});

test('aggregate buckets dates by month in time order and builds the chart from the result', () => {
  const tools = createChatTools(COLUMNS, ROWS);
  const trend = tools.run('aggregate', {
    aggregation: 'sum',
    metric_column: 'revenue',
    group_by: 'order_date',
    time_bucket: 'month',
    chart: 'line',
  });
  assert.deepEqual(trend.groups.map((g) => [g.label, g.value]), [['2024-01', 400], ['2024-02', 300], ['2024-03', 400]]);
  assert.equal(tools.charts.length, 1);
  assert.deepEqual(tools.charts[0].labels, ['2024-01', '2024-02', '2024-03']);
  assert.deepEqual(tools.charts[0].series[0].values, [400, 300, 400]);
});

test('unknown columns come back as a tool error, not a guess, and are not recorded as sources', () => {
  const tools = createChatTools(COLUMNS, ROWS);
  const res = tools.run('aggregate', { aggregation: 'sum', metric_column: 'profit' });
  assert.match(res.error, /Unknown column "profit"/);
  assert.equal(tools.calls.length, 0);
});

test('forecast_revenue returns totals and an actual + forecast chart that join at the last actual day', () => {
  const tools = createChatTools(COLUMNS, ROWS);
  const f = tools.run('forecast_revenue', { horizon_days: 14 });
  assert.equal(f.horizon_days, 14);
  assert.equal(f.history_end, '2024-03-09');
  assert.equal(f.first_day.date, '2024-03-10');
  const chart = tools.charts[0];
  assert.equal(chart.series.length, 2);
  const actual = chart.series[0].values;
  const forecast = chart.series[1].values;
  const lastActualIdx = actual.findLastIndex((v) => v !== null);
  assert.equal(forecast[lastActualIdx], actual[lastActualIdx]);
  assert.equal(chart.labels.length, actual.length);
});

test('extractFigures skips dates, years and small counts but keeps money, % and scaled numbers', () => {
  const figs = extractFigures('In 2024 the top 3 regions made $1,234.50 (12.5%) and 1.2M units by 2024-03-09.');
  assert.deepEqual(
    figs.map((f) => f.value),
    [1234.5, 12.5, 1200000]
  );
});

test('verifyReplyNumbers accepts computed and simply-derived figures and flags invented ones', () => {
  const truth = { groups: [{ label: 'South', value: 700, share_pct: 63.64 }, { label: 'North', value: 400 }] };
  const ok = verifyReplyNumbers('South leads with **$700.00** (63.6%), $300 more than North; together $1,100.', truth);
  assert.equal(ok.unverified.length, 0);
  assert.equal(ok.checked, 4);

  const bad = verifyReplyNumbers('South made $700 and East made $950.', truth);
  assert.deepEqual(bad.unverified, ['$950']);
});

// End to end with a stubbed Groq: the "model" asks for a tool, then writes
// one real figure and one invented figure. The server must chart the tool
// result and flag only the invented number.
test('a tool-grounded chat reply carries server-built charts, sources and a figure check', async () => {
  const realFetch = globalThis.fetch;
  let round = 0;
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('api.groq.com')) return realFetch(url, init);
    const body = JSON.parse(init.body);
    assert.ok(body.tools.some((t) => t.function.name === 'aggregate'));
    round++;
    const message =
      round === 1
        ? {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'aggregate',
                  arguments: JSON.stringify({ aggregation: 'sum', metric_column: 'revenue', group_by: 'category', chart: 'bar' }),
                },
              },
            ],
          }
        : { role: 'assistant', content: 'Total is **$5,500.00**, and next year will be $99,999.' };
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const { server, base, insforge } = await startServer({ aiProvider: 'groq', groqApiKey: 'test-key', groqModel: 'test-model' });
  try {
    const { token, workspace } = await signupAndGetSession(base, 'chat-tools@example.com', { insforge });
    const buffer = fs.readFileSync(path.join(__dirname, 'fixtures', 'dashboard-sales.csv'));
    const form = new FormData();
    form.append('workspace_id', workspace.id);
    form.append('file', new Blob([buffer], { type: 'text/csv' }), 'dashboard-sales.csv');
    const up = await realFetch(`${base}/api/datasets/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    const dataset = (await up.json()).data.dataset;

    const res = await realFetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: workspace.id, dataset_id: dataset.id, message: 'Revenue by category?' }),
    });
    const { message } = (await res.json()).data;

    assert.equal(round, 2);
    assert.equal(message.chart_payload.version, 2);
    assert.equal(message.chart_payload.charts.length, 1);
    const chart = message.chart_payload.charts[0];
    const chartTotal = chart.series[0].values.reduce((s, v) => s + v, 0);
    assert.equal(chartTotal, 5500); // chart numbers are the real per-category sums
    assert.equal(message.chart_payload.sources.length, 1);
    assert.deepEqual(message.chart_payload.figures.unverified, ['$99,999']);
    assert.equal(message.grounding_status, 'rejected');
    assert.match(message.content, /\$5,500\.00/); // markdown kept, not flattened
  } finally {
    globalThis.fetch = realFetch;
    server.close();
  }
});
