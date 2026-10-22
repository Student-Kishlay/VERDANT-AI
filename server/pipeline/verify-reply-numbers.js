// Answer grounding — the text counterpart of verify-chart-grounding.js.
// Every figure the model writes in its reply is re-checked, in code, against
// the numbers the tools actually computed (plus the dataset summary). A
// figure passes if it matches one of those values, or a simple derivation
// of two of them (sum, difference, ratio, % change), within the rounding
// its own display implies. Anything else is reported back as unverified.
export const METHODOLOGY_VERSION = 1;

const REL_TOLERANCE = 0.01;
const MAX_PAIR_SOURCES = 400; // caps the pairwise-derivation search

function collectNumbers(value, out) {
  if (typeof value === 'number' && Number.isFinite(value)) out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectNumbers(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectNumbers(v, out));
  return out;
}

const SCALE = { k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };

// Pulls the data figures out of a reply, skipping things that are numbers
// but not claims about the data: dates, years, list markers, small counts.
export function extractFigures(text) {
  const cleaned = String(text)
    .replace(/[‐-―−]/g, '-') // typographic dashes / minus
    .replace(/[   ]/g, ' ') // non-breaking / thin spaces
    .replace(/\b\d{4}-\d{2}(-\d{2})?\b/g, ' ') // ISO dates / months
    .replace(/\b\d{4}-Q[1-4]\b/gi, ' ')
    .replace(/^\s*\d+[.)]\s/gm, ' '); // numbered-list markers

  const figures = [];
  const re = /(-?\$?\s?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s?(%|k\b|m\b|mn\b|bn?\b|thousand\b|million\b|billion\b)?/gi;
  let match;
  while ((match = re.exec(cleaned))) {
    const [raw, prefix, intPart, decPart = '', suffixRaw = ''] = match;
    const suffix = suffixRaw.toLowerCase();
    const base = Number(intPart.replace(/,/g, '') + decPart);
    const scale = SCALE[suffix] || 1;
    const value = (prefix.includes('-') ? -1 : 1) * base * scale;
    const decimals = decPart ? decPart.length - 1 : 0;
    const isMoney = prefix.includes('$');

    // A bare integer under 13 ("3 regions", "top 5") or a plain year isn't a data claim worth checking.
    if (!isMoney && !suffix && !decPart && base < 13) continue;
    if (!isMoney && !suffix && !decPart && base >= 1900 && base <= 2100 && !intPart.includes(',')) continue;

    figures.push({
      text: raw.trim(),
      value,
      percent: suffix === '%',
      // Half a unit of the last displayed digit, e.g. "$1.2M" -> ±$50k.
      tolerance: (0.5 * 10 ** -decimals) * scale,
    });
  }
  return figures;
}

export function verifyReplyNumbers(reply, groundTruth) {
  const sources = [...new Set(collectNumbers(groundTruth, []))];
  const figures = extractFigures(reply);
  if (figures.length === 0) return { checked: 0, verified: 0, unverified: [] };

  const close = (claimed, real, tolerance) =>
    Math.abs(claimed - real) <= Math.max(tolerance, Math.abs(real) * REL_TOLERANCE);

  const pairSources = sources.filter((n) => n !== 0).slice(0, MAX_PAIR_SOURCES);

  function matches(fig) {
    const v = Math.abs(fig.value);
    const direct = (real) => close(v, Math.abs(real), fig.tolerance) || (fig.percent && close(v, Math.abs(real * 100), fig.tolerance));
    if (sources.some(direct)) return true;

    for (let i = 0; i < pairSources.length; i++) {
      const a = pairSources[i];
      for (let j = 0; j < pairSources.length; j++) {
        if (i === j) continue;
        const b = pairSources[j];
        if (fig.percent) {
          if (close(v, Math.abs((a / b) * 100), fig.tolerance)) return true;
          if (close(v, Math.abs(((a - b) / b) * 100), fig.tolerance)) return true;
        } else {
          if (j > i && close(v, Math.abs(a + b), fig.tolerance)) return true;
          if (close(v, Math.abs(a - b), fig.tolerance)) return true;
          if (close(v, Math.abs(a / b), fig.tolerance)) return true;
        }
      }
    }
    return false;
  }

  const unverified = figures.filter((f) => !matches(f)).map((f) => f.text);
  return { checked: figures.length, verified: figures.length - unverified.length, unverified: [...new Set(unverified)] };
}
