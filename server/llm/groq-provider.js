// Real alternate provider (Master Prompt §0/§2.5: "Groq/Llama 3.3 70B as a
// configurable alternative"). Implemented against Groq's documented
// OpenAI-compatible chat-completions endpoint, but NOT exercised by any
// test in this build — there is no Groq API key available in this
// environment. Treat this as implemented-but-unverified until it's run
// against a real key.
export const PROVIDER_NAME = 'groq';

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const CHART_JSON_PATTERN = /CHART_JSON:\s*(\{[\s\S]*\})\s*$/;

function buildMessages(contextSummary, conversationHistory, question) {
  const datasetContext = JSON.stringify({
    dataset_overview: contextSummary.dataset_overview,
    numeric_stats: contextSummary.numeric_stats,
    categorical_top_values: contextSummary.categorical_top_values,
    sample_rows: contextSummary.sample_rows,
  });

  const systemMessage =
    `${contextSummary.system_preamble}\n\nDATASET CONTEXT:\n${datasetContext}\n\n` +
    'If (and only if) a chart would help answer the question, end your reply with one line exactly of the form ' +
    '`CHART_JSON: {"chart_type":"bar|line","label_column":"<a real column name>","value_column":"<a real column name>",' +
    '"labels":[...],"values":[...]}` — omit that line entirely otherwise. Never invent numbers not derivable from ' +
    'the dataset context above.';

  const history = conversationHistory.map((m) => ({ role: m.role, content: m.content }));
  return [{ role: 'system', content: systemMessage }, ...history, { role: 'user', content: question }];
}

export async function generateReply({ question, contextSummary, conversationHistory, apiKey, model }) {
  const res = await fetch(GROQ_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: buildMessages(contextSummary, conversationHistory, question),
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Groq API error (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content ?? '';

  const match = content.match(CHART_JSON_PATTERN);
  let chartPayload = null;
  let reply = content;
  if (match) {
    reply = content.slice(0, match.index).trim();
    try {
      chartPayload = JSON.parse(match[1]);
    } catch {
      chartPayload = null; // malformed chart JSON from the model — drop it, don't guess
    }
  }

  return { reply, chart_payload: chartPayload };
}
