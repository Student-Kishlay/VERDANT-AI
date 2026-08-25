// Anomaly Detection — Isolation Forest, built from scratch (Master Prompt
// §10). No numeric threshold is hardcoded; the top `contaminationRate` of
// rows by score are flagged, whatever the score distribution turns out to
// be for this specific dataset.
export const METHODOLOGY_VERSION = 1;

const TREE_COUNT = 100;
const MAX_SUBSAMPLE = 256;
const EULER_MASCHERONI = 0.5772156649;

// Fixed-seed PRNG (mulberry32) instead of Math.random(): the algorithm is
// still a genuine randomized-tree ensemble, but the same dataset always
// produces the same forest and the same flagged rows — required for the
// "exactly these rows, every time" acceptance bar, and consistent with the
// project's broader determinism principle (§5).
function mulberry32(seed) {
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

function roleColumnMap(columns) {
  const map = {};
  for (const col of columns) {
    if (col.effective_role && !map[col.effective_role]) map[col.effective_role] = col.column_name;
  }
  return map;
}

// Expected path length of an unbuilt subtree of `size` points (standard
// Isolation Forest correction term).
function cFactor(size) {
  if (size <= 1) return 0;
  if (size === 2) return 1;
  return 2 * (Math.log(size - 1) + EULER_MASCHERONI) - (2 * (size - 1)) / size;
}

function seededShuffle(array, rng) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function buildTree(indices, data, features, depth, maxDepth, rng) {
  if (depth >= maxDepth || indices.length <= 1) {
    return { leaf: true, size: indices.length };
  }

  const feature = features[Math.floor(rng() * features.length)];
  const values = indices.map((i) => data[i][feature]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) {
    return { leaf: true, size: indices.length }; // no variance left to split on
  }

  const splitValue = min + rng() * (max - min);
  const left = indices.filter((i) => data[i][feature] < splitValue);
  const right = indices.filter((i) => data[i][feature] >= splitValue);

  return {
    leaf: false,
    feature,
    splitValue,
    left: buildTree(left, data, features, depth + 1, maxDepth, rng),
    right: buildTree(right, data, features, depth + 1, maxDepth, rng),
  };
}

function pathLength(point, node, depth) {
  if (node.leaf) return depth + cFactor(node.size);
  return point[node.feature] < node.splitValue
    ? pathLength(point, node.left, depth + 1)
    : pathLength(point, node.right, depth + 1);
}

export function detectAnomalies(columns, rows, { contaminationRate = 0.05 } = {}) {
  const roles = roleColumnMap(columns);
  if (!roles.revenue) {
    return { available: false, missing: ['revenue'] };
  }

  const features = [roles.revenue];
  if (roles.quantity) features.push(roles.quantity);

  const n = rows.length;
  const subsampleSize = Math.min(MAX_SUBSAMPLE, n);
  const maxDepth = Math.ceil(Math.log2(Math.max(subsampleSize, 2)));
  const rng = mulberry32(SEED);
  const allIndices = rows.map((_, i) => i);

  const trees = [];
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
    [...scored]
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, flagCount)
      .map((s) => s.index)
  );

  const flaggedRows = scored
    .filter((s) => flaggedIndices.has(s.index))
    .sort((a, b) => a.index - b.index)
    .map((s) => ({ row_index: s.index, anomaly_score: Math.round(s.score * 10000) / 10000 }));

  return {
    available: true,
    flagged_rows: flaggedRows,
    contamination_rate: contaminationRate,
    methodology_version: METHODOLOGY_VERSION,
  };
}
