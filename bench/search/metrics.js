'use strict';
// Metrics for "did Lectern find the papers that matter?". Pure functions, no network, unit-tested in
// test/searchbench.test.js. A gold item is { doi, title, oa } (any of them may be empty except title). A retrieved
// paper is Lectern's paper shape ({ doi, title, oaId, sources }).

const { normDoi, normTitle } = require('../../server/util');

const MIN_TITLE_CHARS = 20; // shorter titles are too generic to match on their own

function goldIndex(gold) {
  const byDoi = new Map(); const byOa = new Map(); const byTitle = new Map();
  gold.forEach((g, i) => {
    for (const d of [g.doi, ...(g.altDois || [])]) { const n = normDoi(d); if (n && !byDoi.has(n)) byDoi.set(n, i); }
    if (g.oa) byOa.set(String(g.oa).toLowerCase(), i);
    const t = normTitle(g.title);
    if (t.length >= MIN_TITLE_CHARS && !byTitle.has(t)) byTitle.set(t, i);
  });
  return { byDoi, byOa, byTitle };
}

/** Which gold item (index) is this paper? DOI first, then OpenAlex id, then identical title. -1 if none. */
function matchPaper(p, idx) {
  const d = normDoi(p.doi);
  if (d && idx.byDoi.has(d)) return idx.byDoi.get(d);
  if (p.oaId && idx.byOa.has(String(p.oaId).toLowerCase())) return idx.byOa.get(String(p.oaId).toLowerCase());
  const t = normTitle(p.title);
  if (t.length >= MIN_TITLE_CHARS && idx.byTitle.has(t)) return idx.byTitle.get(t);
  return -1;
}

/** For each gold item, the 1-based position of the first paper in `papers` that matches it, or null. */
function goldRanks(papers, gold) {
  const idx = goldIndex(gold);
  const ranks = new Array(gold.length).fill(null);
  papers.forEach((p, i) => {
    const g = matchPaper(p, idx);
    if (g >= 0 && ranks[g] === null) ranks[g] = i + 1;
  });
  return ranks;
}

/**
 * Recall at k: the share of gold papers in the top k. With cap, the denominator is min(number of gold, k): a question
 * with 60 gold papers cannot score above 25/60 at k=25 by any ranking, so the capped form says how close to the best
 * possible the list is.
 */
function recallAtK(ranks, k, { cap = false } = {}) {
  if (!ranks.length) return null;
  const hits = ranks.filter((r) => r !== null && r <= k).length;
  const denom = cap ? Math.min(ranks.length, k) : ranks.length;
  return Math.min(1, hits / denom);
}

/** Binary-gain nDCG at k; the ideal list holds min(number of gold, k) gold papers at the top. */
function ndcgAtK(ranks, k) {
  if (!ranks.length) return null;
  let dcg = 0;
  for (const r of ranks) if (r !== null && r <= k) dcg += 1 / Math.log2(r + 1);
  let ideal = 0;
  for (let i = 1; i <= Math.min(ranks.length, k); i++) ideal += 1 / Math.log2(i + 1);
  return dcg / ideal;
}

/** Reciprocal rank of the first gold paper found (0 if none). */
function mrr(ranks) {
  const found = ranks.filter((r) => r !== null);
  return found.length ? 1 / Math.min(...found) : 0;
}

/**
 * Per database: how many gold papers it returned at all (over every query), and how many only it returned.
 * lists = [{ source, qi, papers }] as returned by searchAll.
 */
function perSource(lists, gold) {
  const idx = goldIndex(gold);
  const seen = new Map(); // gold index -> Set of sources
  const sources = new Set();
  for (const { source, papers } of lists) {
    sources.add(source);
    for (const p of papers) {
      const g = matchPaper(p, idx);
      if (g < 0) continue;
      if (!seen.has(g)) seen.set(g, new Set());
      seen.get(g).add(source);
    }
  }
  const out = {};
  for (const s of sources) out[s] = { found: 0, unique: 0 };
  for (const set of seen.values()) {
    for (const s of set) { out[s].found++; if (set.size === 1) out[s].unique++; }
  }
  return out;
}

/** All the numbers for one question. ranked = Lectern's ranked list, pool = the merged list before the cut. */
function questionMetrics({ ranked, pool, lists, gold, ks = [25, 40] }) {
  const ranks = goldRanks(ranked, gold);
  const poolRanks = goldRanks(pool, gold);
  const m = { gold: gold.length };
  for (const k of ks) {
    m[`recall@${k}`] = recallAtK(ranks, k, { cap: true });
    m[`recallAll@${k}`] = recallAtK(ranks, k);
  }
  m['ndcg@25'] = ndcgAtK(ranks, 25);
  m.mrr = mrr(ranks);
  m.foundAnywhere = poolRanks.filter((r) => r !== null).length / gold.length;
  m.pool = pool.length;
  return { metrics: m, ranks, perSource: perSource(lists, gold) };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** mulberry32: a small seeded generator, so a bootstrap gives the same interval every time. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile interval of a sample of numbers (linear interpolation). */
function percentile(sorted, p) {
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos); const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Bootstrap interval for the mean of one list of per-question values (questions are resampled with replacement). */
function bootstrapMean(values, { B = 10000, seed = 20261118 } = {}) {
  const n = values.length;
  const r = rng(seed);
  const means = new Array(B);
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += values[Math.floor(r() * n)];
    means[b] = s / n;
  }
  means.sort((x, y) => x - y);
  return { mean: mean(values), lo: percentile(means, 0.025), hi: percentile(means, 0.975), n };
}

/**
 * Paired bootstrap for the difference in mean (b minus a) between two runs on the same questions: the same resampled
 * questions are used for both runs, so question difficulty cancels out. Returns the mean difference, its 95% interval
 * and the share of resamples where b is not better than a (a rough one-sided p).
 */
function pairedBootstrap(a, b, { B = 10000, seed = 20261118 } = {}) {
  if (a.length !== b.length) throw new Error('Paired runs need the same number of questions.');
  const n = a.length;
  const d = a.map((x, i) => b[i] - x);
  const r = rng(seed);
  const diffs = new Array(B);
  let notBetter = 0;
  for (let k = 0; k < B; k++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += d[Math.floor(r() * n)];
    diffs[k] = s / n;
    if (diffs[k] <= 0) notBetter++;
  }
  diffs.sort((x, y) => x - y);
  return { meanA: mean(a), meanB: mean(b), diff: mean(d), lo: percentile(diffs, 0.025), hi: percentile(diffs, 0.975), pNotBetter: notBetter / B, n };
}

const METRICS = ['recall@25', 'recall@40', 'recallAll@25', 'recallAll@40', 'ndcg@25', 'mrr', 'foundAnywhere'];

/** Means with bootstrap intervals over the questions of one run, overall and by discipline and source, plus per-database gold counts. */
function summarizeRun(questions) {
  const ids = Object.keys(questions);
  const group = (subset) => {
    const g = { n: subset.length };
    for (const m of METRICS) {
      const vals = subset.map((i) => questions[i].metrics[m]).filter((v) => v !== null && v !== undefined);
      g[m] = vals.length ? bootstrapMean(vals) : null;
    }
    g.pool = mean(subset.map((i) => questions[i].metrics.pool));
    return g;
  };
  const by = (field) => {
    const out = {};
    for (const v of [...new Set(ids.map((i) => questions[i][field]))].sort()) out[v] = group(ids.filter((i) => questions[i][field] === v));
    return out;
  };
  const perSourceTotals = {};
  let goldTotal = 0;
  for (const i of ids) {
    goldTotal += questions[i].metrics.gold;
    for (const [s, c] of Object.entries(questions[i].perSource)) {
      const t = perSourceTotals[s] || (perSourceTotals[s] = { found: 0, unique: 0 });
      t.found += c.found; t.unique += c.unique;
    }
  }
  return { overall: group(ids), byDiscipline: by('discipline'), bySource: by('source'), perDatabase: perSourceTotals, goldTotal };
}

module.exports = {
  summarizeRun, METRICS,
  goldIndex, matchPaper, goldRanks, recallAtK, ndcgAtK, mrr, perSource, questionMetrics,
  mean, rng, bootstrapMean, pairedBootstrap, MIN_TITLE_CHARS,
};
