// Default AI Chat provider — no external API, no credentials needed.
// Deterministic and keyword-matched rather than a real LLM, but every
// answer is read directly from the real dataset aggregates, never
// fabricated. This is what "grounded" means when there's no live model:
// there's nothing here that *could* hallucinate.
export const PROVIDER_NAME = 'mock';

function aggregateSum(rows, groupCol, valueCol) {
  const totals = new Map();
  for (const r of rows) {
    const key = r[groupCol];
    totals.set(key, (totals.get(key) || 0) + (Number(r[valueCol]) || 0));
  }
  return [...totals.entries()].map(([label, value]) => ({ label, value: Math.round(value * 100) / 100 }));
}

function currency(n) {
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function generateReply({ question, columns, rows, contextSummary, segmentSummary }) {
  const q = question.toLowerCase();
  const roles = contextSummary.dataset_overview.roles;

  if (/^\s*(hi|hello|hey)\b/.test(q)) {
    const cols = columns.map((c) => c.column_name).join(', ');
    return {
      reply: `Hi! This dataset has ${contextSummary.dataset_overview.row_count} rows across these columns: ${cols}. Ask me about revenue, trends, categories, or customers.`,
      chart_payload: null,
    };
  }

  if (/revenue/.test(q) && /(total|how much|sum)/.test(q)) {
    if (!roles.revenue) {
      return { reply: "I don't see a revenue column in this dataset, so I can't total it up.", chart_payload: null };
    }
    const sum = contextSummary.numeric_stats[roles.revenue]?.sum;
    return { reply: `Total revenue across all ${rows.length} rows is ${currency(sum)}.`, chart_payload: null };
  }

  if (/trend|over time/.test(q)) {
    if (!roles.date || !roles.revenue) {
      return {
        reply: "I can't chart a revenue trend without both a date and a revenue column detected in this dataset.",
        chart_payload: null,
      };
    }
    const series = aggregateSum(rows, roles.date, roles.revenue).sort((a, b) => (a.label < b.label ? -1 : 1));
    return {
      reply: `Here's revenue by day across the ${series.length} day(s) in this dataset.`,
      chart_payload: {
        chart_type: 'line',
        label_column: roles.date,
        value_column: roles.revenue,
        labels: series.map((p) => p.label),
        values: series.map((p) => p.value),
      },
    };
  }

  if (/categor|breakdown/.test(q)) {
    if (!roles.category || !roles.revenue) {
      return {
        reply: "I don't see a category column (with an override, if needed) alongside revenue, so I can't break this down by category.",
        chart_payload: null,
      };
    }
    const mix = aggregateSum(rows, roles.category, roles.revenue).sort((a, b) => b.value - a.value);
    const top = mix[0];
    return {
      reply: `"${top.label}" is the top category by revenue (${currency(top.value)}), out of ${mix.length} categories.`,
      chart_payload: {
        chart_type: 'bar',
        label_column: roles.category,
        value_column: roles.revenue,
        labels: mix.map((p) => p.label),
        values: mix.map((p) => p.value),
      },
    };
  }

  if (/customer/.test(q) && /(how many|count|active)/.test(q)) {
    if (!roles.customer) {
      return { reply: "I don't see a customer column in this dataset.", chart_payload: null };
    }
    const distinct = new Set(rows.map((r) => r[roles.customer])).size;
    return { reply: `There are ${distinct} distinct customers in this dataset.`, chart_payload: null };
  }

  if (/segment/.test(q)) {
    if (!segmentSummary || segmentSummary.length === 0) {
      return {
        reply: 'No customer segments have been computed for this dataset yet — visit Insights → Customer Segmentation first.',
        chart_payload: null,
      };
    }
    const parts = segmentSummary.map((s) => `${s.segment} (${s.size})`).join(', ');
    return { reply: `Current customer segments: ${parts}.`, chart_payload: null };
  }

  return {
    reply:
      "I can help with questions about revenue, revenue trends, category breakdowns, and customer counts in this dataset. Try asking something like \"what's the total revenue?\" or \"show revenue by category.\"",
    chart_payload: null,
  };
}
