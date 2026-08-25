// Chart grounding (Master Prompt §11, point 3-4) — the core trust
// mechanism. Every label an LLM (mock or real) proposes for a chart is
// independently re-checked here against the actual dataset rows. This
// happens in code, never by asking the model to self-report, and it runs
// identically regardless of which provider produced the chart.
export const METHODOLOGY_VERSION = 1;

// chartPayload = { chart_type, label_column, value_column, labels, values }
export function verifyChartGrounding(chartPayload, rows, { threshold = 0.6 } = {}) {
  const { label_column: labelColumn, labels } = chartPayload;

  if (!labelColumn || !Array.isArray(labels) || labels.length === 0) {
    return { grounding_status: 'rejected', verified_ratio: 0 };
  }

  const realValues = new Set(rows.map((r) => String(r[labelColumn])));
  const matched = labels.filter((label) => realValues.has(String(label))).length;
  const verifiedRatio = matched / labels.length;

  return {
    grounding_status: verifiedRatio >= threshold ? 'verified' : 'rejected',
    verified_ratio: Math.round(verifiedRatio * 10000) / 10000,
  };
}
