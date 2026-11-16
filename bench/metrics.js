'use strict';
// Evaluation metrics for bench/. Pure functions, no dependencies, tested in test/bench.test.js.

/** Wilson score interval for k successes in n trials (95% by default). Returns { p, lo, hi } or null when n = 0. */
function wilson(k, n, z = 1.959963984540054) {
  if (!n) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const m = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { p, lo: Math.max(0, c - m), hi: Math.min(1, c + m) };
}

/** A small seeded random generator (mulberry32), so splits and bootstraps are reproducible. */
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

/** Area under the ROC curve for scores of positives vs negatives (ties count half). null if either side is empty. */
function auroc(pos, neg) {
  if (!pos.length || !neg.length) return null;
  const all = [...pos.map((s) => [s, 1]), ...neg.map((s) => [s, 0])].sort((a, b) => a[0] - b[0]);
  let rank = 0;
  let sumPos = 0;
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j < all.length && all[j][0] === all[i][0]) j++;
    const avg = (rank + 1 + rank + (j - i)) / 2; // average rank of the tied block (1-based)
    for (let k = i; k < j; k++) if (all[k][1]) sumPos += avg;
    rank += j - i;
    i = j;
  }
  return (sumPos - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}

/** Percentile bootstrap interval of a statistic over items (resampled with replacement). */
function bootstrap(items, stat, { reps = 1000, seed = 7, alpha = 0.05 } = {}) {
  if (!items.length) return null;
  const r = rng(seed);
  const vals = [];
  for (let b = 0; b < reps; b++) {
    const sample = Array.from({ length: items.length }, () => items[Math.floor(r() * items.length)]);
    const v = stat(sample);
    if (v != null && Number.isFinite(v)) vals.push(v);
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  return { lo: vals[Math.floor((alpha / 2) * vals.length)], hi: vals[Math.min(vals.length - 1, Math.ceil((1 - alpha / 2) * vals.length) - 1)] };
}

/** Positive predictive value at a base rate (share of AI documents in the population), from TPR and FPR. */
function ppvAt(baseRate, tpr, fpr) {
  const tp = baseRate * tpr;
  const fp = (1 - baseRate) * fpr;
  return tp + fp > 0 ? tp / (tp + fp) : null;
}

/**
 * The largest threshold whose false-positive rate on `humanScores` is at most `targetFpr`
 * (positive means score >= threshold). Used on the DEVELOPMENT split only.
 */
function thresholdForFpr(humanScores, targetFpr) {
  const sorted = [...humanScores].sort((a, b) => b - a);
  const allowed = Math.floor(targetFpr * sorted.length); // how many humans may be flagged
  // threshold just above the (allowed+1)-th highest human score
  const t = sorted[allowed];
  return t == null ? 0 : t + 1e-9;
}

/**
 * Summarise decisions. Each item: { label: 'human'|'ai'|'mixed', decision: true|false|null (null = abstained / error) }.
 * Human and AI items form the confusion matrix; mixed items get a flag rate only.
 */
function summarise(items) {
  const by = (label) => items.filter((x) => x.label === label);
  const decided = (list) => list.filter((x) => x.decision != null);
  const h = by('human');
  const a = by('ai');
  const m = by('mixed');
  const hd = decided(h);
  const ad = decided(a);
  const md = decided(m);
  const fp = hd.filter((x) => x.decision).length;
  const tp = ad.filter((x) => x.decision).length;
  const fpr = wilson(fp, hd.length);
  const tpr = wilson(tp, ad.length);
  return {
    n: { human: h.length, ai: a.length, mixed: m.length },
    abstained: { human: h.length - hd.length, ai: a.length - ad.length, mixed: m.length - md.length },
    abstentionRate: wilson(items.length - decided(items).length, items.length),
    confusion: { tp, fn: ad.length - tp, fp, tn: hd.length - fp },
    falsePositiveRate: fpr,
    detectionRate: tpr,
    mixedFlagRate: wilson(md.filter((x) => x.decision).length, md.length),
    balancedAccuracy: fpr && tpr ? (tpr.p + (1 - fpr.p)) / 2 : null,
    ppv: fpr && tpr ? Object.fromEntries([0.05, 0.1, 0.2, 0.5].map((b) => [b, ppvAt(b, tpr.p, fpr.p)])) : null,
  };
}

module.exports = { wilson, rng, auroc, bootstrap, ppvAt, thresholdForFpr, summarise };
