'use strict';
// Measured style model (version 3): 30 interpretable writing-style features and a logistic regression trained on
// public labelled data (bench/style/). It is a second, independent reading shown beside the model review; it is
// never part of the headline score. Tested on a fresh holdout before use; the results and weak spots travel with
// the weights in style-model.json and are shown in the window. See bench/PREREGISTRATION.md, versions 2 and 3.
const T = require('./text');
// The word and phrase lists live in aiscore.js, which also requires this file, so they are read on first use.
let LEX = null;
const lex = () => (LEX ||= require('./aiscore'));
const MODEL = require('./style-model.json');

const STOP = new Set(`a about above after again against all am an and any are as at be because been before being below between both but by can could
did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its
itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than
that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while
who whom why will with would you your yours yourself yourselves`.split(/\s+/));
const FIRST = new Set(['i', 'me', 'my', 'mine', 'myself', "i'm", "i've", "i'd", "i'll"]);
const SECOND = new Set(['you', 'your', 'yours', 'yourself', "you're", "you've", "you'll", "you'd"]);
const SIGNPOST = /^(?:furthermore|moreover|additionally|in addition|consequently|ultimately|overall|notably|importantly|crucially|in conclusion|in summary|thus|hence|therefore|conversely|similarly|indeed|firstly|secondly|lastly|finally)\b/i;

/** Undo tokenizer artefacts some corpora carry ("word ." / "do n't"), so features describe writing, not a dataset. */
function clean(text) {
  return T.normalizeText(text).replace(/ +([.,!?;:%)\]])/g, '$1').replace(/([([]) +/g, '$1').replace(/ n't\b/g, "n't").replace(/ '(s|re|ve|ll|d|m)\b/g, "'$1");
}

const NAMES = ['sentLenMean', 'sentLenCV', 'wordLenMean', 'longWordRate', 'mattr', 'hapaxRate', 'stopRate', 'commaPerSent',
  'semicolonRate', 'colonRate', 'dashRate', 'parenRate', 'quoteRate', 'questionRate', 'exclaimRate', 'contractionRate',
  'firstPersonRate', 'secondPersonRate', 'digitRate', 'properRate', 'strongLexRate', 'weakLexRate', 'phraseRate',
  'signpostShare', 'paraCV', 'lyRate', 'nominalRate', 'repeatTrigramRate', 'starterDiversity', 'lowerStartRate'];

function features(raw) {
  const text = clean(raw);
  const { sentences, paragraphs } = T.segment(text);
  const sents = sentences.filter((s) => T.words(s.text).length >= 3);
  const ws = T.words(text);
  const n = Math.max(1, ws.length);
  const lower = ws.map((w) => w.lower);
  const per = (k) => k / n;
  const lens = sents.map((s) => T.words(s.text).length);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const cv = (a) => { if (a.length < 2) return 0; const m = mean(a); if (!m) return 0; return Math.sqrt(mean(a.map((x) => (x - m) ** 2))) / m; };
  // moving-average type-token ratio over 50-word windows (length-independent)
  let mattr = 0;
  if (lower.length >= 50) { let sum = 0, cnt = 0; for (let i = 0; i + 50 <= lower.length; i += 10) { sum += new Set(lower.slice(i, i + 50)).size / 50; cnt++; } mattr = sum / cnt; } else mattr = new Set(lower).size / n;
  const first300 = lower.slice(0, 300);
  const freq = new Map(); for (const w of first300) freq.set(w, (freq.get(w) || 0) + 1);
  const hapax = [...freq.values()].filter((c) => c === 1).length / Math.max(1, first300.length);
  const tri = new Map(); for (let i = 0; i + 3 <= lower.length; i++) { const k = lower.slice(i, i + 3).join(' '); tri.set(k, (tri.get(k) || 0) + 1); }
  const repeatTri = [...tri.values()].filter((c) => c > 1).reduce((a, c) => a + c - 1, 0) / n;
  let strong = 0, weak = 0;
  const { STRONG, WEAK, PHRASES } = lex();
  for (const w of lower) { if (STRONG.has(w)) strong++; else if (WEAK.has(w)) weak++; }
  let phrases = 0; for (const [re] of PHRASES) { re.lastIndex = 0; phrases += (text.match(re) || []).length; }
  const starters = sents.map((s) => (T.words(s.text)[0] || { lower: '' }).lower);
  const paraLens = paragraphs.map((p) => T.words(text.slice(p.start, p.end)).length).filter((x) => x >= 20);
  const count = (re) => (text.match(re) || []).length;
  const v = {
    sentLenMean: mean(lens), sentLenCV: cv(lens), wordLenMean: mean(ws.map((w) => w.w.length)),
    longWordRate: per(ws.filter((w) => w.w.length >= 9).length), mattr, hapaxRate: hapax,
    stopRate: per(lower.filter((w) => STOP.has(w)).length), commaPerSent: count(/,/g) / Math.max(1, sents.length),
    semicolonRate: per(count(/;/g)), colonRate: per(count(/:(?!\/\/)/g)), dashRate: per(count(/—|–| -- | - /g)),
    parenRate: per(count(/\(/g)), quoteRate: per(count(/["“”]/g)), questionRate: per(count(/\?/g)), exclaimRate: per(count(/!/g)),
    contractionRate: per(lower.filter((w) => /'(s|re|ve|ll|d|m|t)$/.test(w) && w !== "it's" || /n't$/.test(w)).length),
    firstPersonRate: per(lower.filter((w) => FIRST.has(w)).length), secondPersonRate: per(lower.filter((w) => SECOND.has(w)).length),
    digitRate: per(ws.filter((w) => /\d/.test(w.w)).length),
    properRate: per(ws.filter((w, i) => i > 0 && /^\p{Lu}\p{Ll}/u.test(w.w) && !/[.!?]\s*$/.test(text.slice(Math.max(0, w.start - 3), w.start))).length),
    strongLexRate: per(strong), weakLexRate: per(weak), phraseRate: per(phrases),
    signpostShare: sents.length ? sents.filter((s) => SIGNPOST.test(s.text.trim())).length / sents.length : 0,
    paraCV: paraLens.length >= 3 ? cv(paraLens) : 0.5,
    lyRate: per(lower.filter((w) => w.length > 4 && w.endsWith('ly')).length),
    nominalRate: per(lower.filter((w) => w.length > 6 && /(tion|sion|ment|ness|ity|ance|ence)s?$/.test(w)).length),
    repeatTrigramRate: repeatTri, starterDiversity: sents.length ? new Set(starters).size / sents.length : 1,
    lowerStartRate: sents.length ? sents.filter((s) => /^[a-z]/.test(s.text.trim())).length / sents.length : 0,
  };
  return NAMES.map((k) => (Number.isFinite(v[k]) ? v[k] : 0));
}

/** Rates are skewed: compress with log1p after scaling to "per 100 words" where it applies. */
const RATE = new Set(['longWordRate', 'semicolonRate', 'colonRate', 'dashRate', 'parenRate', 'quoteRate', 'questionRate', 'exclaimRate', 'contractionRate', 'firstPersonRate', 'secondPersonRate', 'digitRate', 'properRate', 'strongLexRate', 'weakLexRate', 'phraseRate', 'lyRate', 'nominalRate', 'repeatTrigramRate']);
function transform(x) { return x.map((v, i) => (RATE.has(NAMES[i]) ? Math.log1p(v * 100) : v)); }

function fit(X, y, { l2 = 1, iters = 3000, lr = 0.1, weights } = {}) {
  const d = X[0].length;
  const mu = Array(d).fill(0), sd = Array(d).fill(0);
  for (const x of X) x.forEach((v, j) => { mu[j] += v / X.length; });
  for (const x of X) x.forEach((v, j) => { sd[j] += (v - mu[j]) ** 2 / X.length; });
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const Z = X.map((x) => x.map((v, j) => (v - mu[j]) / sd[j]));
  const w = Array(d).fill(0); let b = 0;
  const W = weights || y.map(() => 1);
  const wsum = W.reduce((a, c) => a + c, 0);
  for (let it = 0; it < iters; it++) {
    const gw = Array(d).fill(0); let gb = 0;
    for (let i = 0; i < Z.length; i++) {
      let z = b; for (let j = 0; j < d; j++) z += w[j] * Z[i][j];
      const p = 1 / (1 + Math.exp(-z));
      const e = (p - y[i]) * W[i];
      for (let j = 0; j < d; j++) gw[j] += e * Z[i][j];
      gb += e;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / wsum + (l2 * w[j]) / wsum);
    b -= lr * (gb / wsum);
  }
  return { names: NAMES, mu, sd, w, b };
}
function score(model, x) {
  let z = model.b;
  for (let j = 0; j < x.length; j++) z += model.w[j] * ((x[j] - model.mu[j]) / model.sd[j]);
  return 1 / (1 + Math.exp(-z));
}
/** The trained model's reading of a text: { probability, threshold, flagged, version, tested } (null under 80 words). */
function styleReading(text) {
  if (T.words(text).length < 80) return null;
  const x = transform(features(text));
  const p = score(MODEL, x);
  return { probability: +p.toFixed(3), threshold: MODEL.threshold, flagged: p >= MODEL.threshold, version: MODEL.version, tested: MODEL.tested };
}

module.exports = { NAMES, features, transform, fit, score, clean, styleReading, MODEL };
