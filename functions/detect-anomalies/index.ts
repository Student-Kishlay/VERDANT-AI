// Anomaly Detection — Isolation Forest (Master Prompt §10) as a real
// InsForge Edge Function — replaces GET /api/datasets/:id/anomalies on the
// Express server. Ported verbatim from server/pipeline/detect-anomalies.js.
import { createClient } from 'npm:@insforge/sdk';

const METHODOLOGY_VERSION = 1;
const TREE_COUNT = 100;
const MAX_SUBSAMPLE = 256;
const EULER_MASCHERONI = 0.5772156649;

function mulberry32(seed: number) {
  let a = seed;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = 0x5eed1257;

function roleColumnMap(columns: { effective_role: string | null; column_name: string }[]) {
  const map: Record<string, string> = {};
  for (const col of columns) {
    if (col.effective_role && !map[col.effective_role]) map[col.effective_role] = col.column_name;
  }
  return map;
}

function cFactor(size: number) {
  if (size <= 1) return 0;
  if (size === 2) return 1;
  return 2 * (Math.log(size - 1) + EULER_MASCHERONI) - (2 * (size - 1)) / size;
}

function seededShuffle<T>(array: T[], rng: () => number) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

type TreeNode =
  | { leaf: true; size: number }
  | { leaf: false; feature: string; splitValue: number; left: TreeNode; right: TreeNode };

function buildTree(
  indices: number[],
  data: Record<string, unknown>[],
  features: string[],
  depth: number,
  maxDepth: number,
  rng: () => number
): TreeNode {
  if (depth >= maxDepth || indices.length <= 1) return { leaf: true, size: indices.length };

  const feature = features[Math.floor(rng() * features.length)];
  const values = indices.map((i) => Number(data[i][feature]));
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return { leaf: true, size: indices.length };

  const splitValue = min + rng() * (max - min);
  const left = indices.filter((i) => Number(data[i][feature]) < splitValue);
  const right = indices.filter((i) => Number(data[i][feature]) >= splitValue);

  return { leaf: false, feature, splitValue, left: buildTree(left, data, features, depth + 1, maxDepth, rng), right: buildTree(right, data, features, depth + 1, maxDepth, rng) };
}

function pathLength(point: Record<string, unknown>, node: TreeNode, depth: number): number {
  if (node.leaf) return depth + cFactor(node.size);
  return Number(point[node.feature]) < node.splitValue
    ? pathLength(point, node.left, depth + 1)
    : pathLength(point, node.right, depth + 1);
}

function detectAnomalies(
  columns: { effective_role: string | null; column_name: string }[],
  rows: Record<string, unknown>[],
  contaminationRate: number
) {
  const roles = roleColumnMap(columns);
  if (!roles.revenue) return { available: false, missing: ['revenue'] };

  const features = [roles.revenue];
  if (roles.quantity) features.push(roles.quantity);

  const n = rows.length;
  const subsampleSize = Math.min(MAX_SUBSAMPLE, n);
  const maxDepth = Math.ceil(Math.log2(Math.max(subsampleSize, 2)));
  const rng = mulberry32(SEED);
  const allIndices = rows.map((_, i) => i);

  const trees: TreeNode[] = [];
  for (let t = 0; t < TREE_COUNT; t++) {
    const sample = seededShuffle(allIndices, rng).slice(0, subsampleSize);
    trees.push(buildTree(sample, rows, features, 0, maxDepth, rng));
  }

  const normalization = cFactor(subsampleSize);
  const scored = rows.map((row, index) => {
    const avgPath = trees.reduce((sum, tree) => sum + pathLength(row, tree, 0), 0) / trees.length;
    return { index, score: Math.pow(2, -avgPath / normalization) };
  });

  const flagCount = Math.max(1, Math.round(contaminationRate * n));
  const flaggedIndices = new Set(
    [...scored].sort((a, b) => b.score - a.score || a.index - b.index).slice(0, flagCount).map((s) => s.index)
  );

  const flaggedRows = scored
    .filter((s) => flaggedIndices.has(s.index))
    .sort((a, b) => a.index - b.index)
    .map((s) => ({ row_index: s.index, anomaly_score: Math.round(s.score * 10000) / 10000 }));

  return { available: true, flagged_rows: flaggedRows, contamination_rate: contaminationRate, methodology_version: METHODOLOGY_VERSION };
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

  const client = createClient({ baseUrl: Deno.env.get('INSFORGE_BASE_URL'), edgeFunctionToken: userToken });

  const { dataset_id: datasetId, contamination_rate: contaminationRate = 0.05 } = await req.json().catch(() => ({}));
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

  const result = detectAnomalies(columns, rows, contaminationRate);
  if (result.available) {
    await client.database.from('anomalies').delete().eq('dataset_id', datasetId);
    await client.database.from('anomalies').insert(
      result.flagged_rows!.map((f) => ({ dataset_id: datasetId, methodology_version: result.methodology_version, ...f }))
    );

    const featureRoles = ['revenue', 'quantity'];
    const featureColumns = columns.filter((c) => featureRoles.includes(c.effective_role ?? '')).map((c) => c.column_name);
    (result as Record<string, unknown>).flagged_rows = result.flagged_rows!.map((f) => ({
      ...f,
      values: Object.fromEntries(featureColumns.map((col) => [col, rows[f.row_index][col]])),
    }));
    (result as Record<string, unknown>).total_rows = rows.length;
  }
  return json({ ok: true, data: { anomalies: result } });
}
