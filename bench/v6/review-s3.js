'use strict';
// S3, the version 6 headline candidate: a fixed formula that combines S2's word-weighted mean sentence rating with the
// style model's probability. Logistic regression on two inputs, fitted on the development split only:
//   p = sigmoid(b0 + b1 * (meanRating / 10) + b2 * logit(styleProbability))
// The score is 100 * p. The weights are written to bench/data/v6/frozen.json before the holdout is touched.
// No dependencies; deterministic (Newton steps from zero, a small ridge penalty on the weights, not on the intercept).

const clip = (p) => Math.min(1 - 1e-4, Math.max(1e-4, p));
const logit = (p) => Math.log(clip(p) / (1 - clip(p)));
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const features = (meanRating, styleProbability) => [meanRating / 10, logit(styleProbability)];

/** rows: [{ meanRating, styleProbability, y }] with y 1 for AI (and AI-edited) and 0 for human. Rows without both inputs are ignored. */
function fitS3(rows, { l2 = 0.1, iterations = 50 } = {}) {
  const d = rows.filter((r) => Number.isFinite(r.meanRating) && Number.isFinite(r.styleProbability) && (r.y === 0 || r.y === 1));
  if (d.filter((r) => r.y === 1).length < 3 || d.filter((r) => r.y === 0).length < 3) throw new Error('S3 needs at least 3 texts of each label with both inputs.');
  const X = d.map((r) => [1, ...features(r.meanRating, r.styleProbability)]);
  const w = [0, 0, 0];
  for (let it = 0; it < iterations; it++) {
    const g = [0, 0, 0];
    const H = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    X.forEach((x, i) => {
      const p = sigmoid(x[0] * w[0] + x[1] * w[1] + x[2] * w[2]);
      for (let a = 0; a < 3; a++) {
        g[a] += (p - d[i].y) * x[a];
        for (let b = 0; b < 3; b++) H[a][b] += p * (1 - p) * x[a] * x[b];
      }
    });
    for (let a = 1; a < 3; a++) { g[a] += l2 * w[a]; H[a][a] += l2; }
    const step = solve3(H, g);
    let move = 0;
    for (let a = 0; a < 3; a++) { w[a] -= step[a]; move = Math.max(move, Math.abs(step[a])); }
    if (move < 1e-9) break;
  }
  return { version: 'S3-1', inputs: ['meanRating/10', 'logit(styleProbability)'], intercept: +w[0].toFixed(6), weights: [+w[1].toFixed(6), +w[2].toFixed(6)], l2, n: d.length };
}

/** Solve a 3x3 system by Gaussian elimination with partial pivoting. */
function solve3(A, b) {
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) throw new Error('S3 fit: singular system.');
    for (let r = c + 1; r < 3; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = [0, 0, 0];
  for (let r = 2; r >= 0; r--) { let s = M[r][3]; for (let k = r + 1; k < 3; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
  return x;
}

/** The S3 score, 0-100, or null when either input is missing. */
function scoreS3(formula, meanRating, styleProbability) {
  if (!formula || !Number.isFinite(meanRating) || !Number.isFinite(styleProbability)) return null;
  const f = features(meanRating, styleProbability);
  return +(100 * sigmoid(formula.intercept + formula.weights[0] * f[0] + formula.weights[1] * f[1])).toFixed(1);
}

// ---- measures shared by the analysis scripts
/** Wilson 95% interval for k of n, as percentages. */
function wilson(k, n, z = 1.96) {
  if (!n) return { k, n, pct: null, lo: null, hi: null };
  const p = k / n;
  const den = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / den;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return { k, n, pct: +(100 * p).toFixed(1), lo: +(100 * (c - h)).toFixed(1), hi: +(100 * (c + h)).toFixed(1) };
}
/** AUROC of positives against negatives (ties count half). A missing score is -1, as the pre-registration says. */
function auroc(pos, neg) {
  const v = (x) => (Number.isFinite(x) ? x : -1);
  if (!pos.length || !neg.length) return null;
  let s = 0;
  for (const a of pos) for (const b of neg) s += v(a) > v(b) ? 1 : v(a) === v(b) ? 0.5 : 0;
  return +(s / (pos.length * neg.length)).toFixed(3);
}

// ---- S3 weighted, the form that was frozen for the version 6 holdout (bench/results/review6-frozen.json) and is NOT shipped
/** The style reading as a 0-100 score, on the same side of 50 as the style model's own flag (its shown probability is rounded to 3 decimals). */
const styleScoreOf = (reading) => (reading && Number.isFinite(reading.probability) ? (reading.flagged ? Math.max(50, reading.probability * 100) : Math.min(49.9, reading.probability * 100)) : null);
/** 0.3 x pattern score + 0.7 x style score, flagged at 41.1 (the frozen S3). */
const headlineScore = (meanRating, styleScore, w = 0.3) => (Number.isFinite(meanRating) && Number.isFinite(styleScore) ? w * meanRating + (1 - w) * styleScore : null);
const S3_LINE = 41.1;

module.exports = { styleScoreOf, headlineScore, S3_LINE, fitS3, scoreS3, features, logit, sigmoid, wilson, auroc };
