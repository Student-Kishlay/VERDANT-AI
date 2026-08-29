// Chart grounding (Master Prompt §11, point 3-4) — the core trust
// mechanism. Every label AND value an LLM (mock or real) proposes for a
// chart is independently re-checked here against the actual dataset rows.
// This happens in code, never by asking the model to self-report, and it
// runs identically regardless of which provider produced the chart.
//
// v2: originally this only checked that labels were real column values —
// a chart with real category names but completely fabricated numbers still
// verified. Now each point's value is also compared against the true
// aggregate (sum of value_column grouped by label_column) for its label.
export const METHODOLOGY_VERSION = 2;

const REL_TOLERANCE = 0.01; // 1% — absorbs rounding, not fabrication
const MIN_ABS_TOLERANCE = 0.01;

// chartPayload = { chart_type, label_column, value_column, labels, values }
export function verifyChartGrounding(chartPayload, rows, { threshold = 0.6 } = {}) {
  const { label_column: labelColumn, value_column: valueColumn, labels, values } = chartPayload;

  if (!labelColumn || !Array.isArray(labels) || labels.length === 0) {
    return { grounding_status: 'rejected', verified_ratio: 0 };
  }

  const realLabels = new Set(rows.map((r) => String(r[labelColumn])));

  // Real aggregate per label: sum of value_column over rows sharing that
  // label — matches how both the mock provider and a real LLM are asked to
  // derive chart values (see server/llm/mock-provider.js#aggregateSum).
  const canCheckValues = Boolean(valueColumn) && Array.isArray(values);
  let realTotals = null;
  if (canCheckValues) {
    realTotals = new Map();
    for (const r of rows) {
      const key = String(r[labelColumn]);
      realTotals.set(key, (realTotals.get(key) || 0) + (Number(r[valueColumn]) || 0));
    }
  }

  const matched = labels.filter((label, i) => {
    const key = String(label);
    if (!realLabels.has(key)) return false;
    if (!canCheckValues) return true;

    const real = realTotals.get(key) ?? 0;
    const claimed = Number(values[i]);
    if (Number.isNaN(claimed)) return false;
    const tolerance = Math.max(MIN_ABS_TOLERANCE, Math.abs(real) * REL_TOLERANCE);
    return Math.abs(claimed - real) <= tolerance;
  }).length;
  const verifiedRatio = matched / labels.length;

  return {
    grounding_status: verifiedRatio >= threshold ? 'verified' : 'rejected',
    verified_ratio: Math.round(verifiedRatio * 10000) / 10000,
  };
}
