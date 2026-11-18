'use strict';
// Measured style model: interpretable writing-style features and a logistic regression trained on
// public labelled data (bench/style/). Version 3 used 30 features; version 4 adds structure features that describe how
// current models shape a text (evenness, closing sentences, lists of three) and keeps only features the model file names. It is a second, independent reading shown beside the model review; it is
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

function featureMap(raw) {
  const text = clean(raw);
  const { sentences, paragraphs } = T.segment(text);
  const sents = sentences.filter((s) => T.words(s.text).length >= 3);
  const ws = T.words(text);
  const n = Math.max(1, ws.length);
  const lower = ws.map((w) => w.lower);
  const per = (k) => k / n;
  const lens = sents.map((s) => T.words(s.text).length);
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
  Object.assign(v, structure(text, sents, lens, paragraphs, n));
  return v;
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const cv = (a) => { if (a.length < 2) return 0; const m = mean(a); if (!m) return 0; return Math.sqrt(mean(a.map((x) => (x - m) ** 2))) / m; };
// Version 4 features. All describe the shape of the text (paragraphs, sentence rhythm, how it opens and closes) or a
// fixed construction. None counts spelling or grammar mistakes, vocabulary size or formality, because those track
// English proficiency and would make the model wrongly flag non-native writers.
const CLOSER = /^(?:in (?:short|essence|summary|conclusion|the end)|ultimately|overall|at (?:its|their) core|at the end of the day|together|taken together|in many ways|in the end)\b|\b(?:reminds? us|serves? as (?:a|an) (?:reminder|testament)|a testament to|underscor\w+|highlights? (?:the )?(?:importance|need|value)|matters? (?:because|more)|continues? to (?:shape|inspire|influence|evolve)|remains? (?:a|an|one of|essential|crucial|vital|important)|will (?:continue|likely continue) to)\b/i;
const SUPERLATIVE = /\b(?:one of the (?:most|best|largest|biggest|oldest|first|few|key|main|many)|among the (?:most|best|largest|first)|(?:the|a) (?:most|best) (?:\w+ ){0,2}(?:of|in) (?:all|the)\b)/gi;
const THREE = /\b[\w'’-]+(?: [\w'’-]+)?, [\w'’-]+(?: [\w'’-]+)?,? (?:and|or) [\w'’-]+/gi;
const APPOS = /\b[A-Z][\w'’-]+(?: [A-Z][\w'’-]+)*, (?:a|an|the|one of) [^,.;:]{3,70},/g;
const CONTRAST = /\bnot (?:just|only|merely|simply) [^.;!?]{2,60}(?:but|—)|\bnot (?:a|an|the|about) [^.;!?,]{2,40}, but\b|\b(?:isn't|wasn't|aren't|weren't|is not|was not) (?:just|only|merely|simply)\b|\brather than (?:simply|just|merely)\b/gi;
const ING_TAIL = /, (?:\w+ing|which \w+s|allowing|enabling|making|helping|giving|leaving) (?:\w+ ){0,2}(?:the|a|an|its|their|that|how|more|both|many|it|them|these|those|new|future)\b/gi;
const OPENER = /^(?:[^,.;:]{0,60} )?(?:has|have) (?:long|always|become|been|increasingly|recently)\b|\bplays? an? (?:crucial|key|vital|significant|central|important|major) role\b|^(?:in|with) (?:today's|the modern|the digital|recent years|an increasingly)|\b(?:is|are) (?:one of the most|a (?:complex|multifaceted|fascinating|powerful))\b/i;
const HEDGE = /\b(?:often|typically|generally|tends? to|various|variety of|range of|several|many|often|can be|can help|may (?:be|also|not|have)|might|significant(?:ly)?|particularly|especially)\b/gi;
const THE_START = /^(?:the|this|these|that|it|in|as|while|although|when|for)\b/i;
const DEFINE = /^[A-Z][^,.;:]{0,70} (?:is|are|was|were) (?:a|an|the|one of the|among the) /;
const ENT = (t) => (t.match(/\b\d[\d,.]*\b/g) || []).length + (t.match(/(?<=[a-z,;)] )(?:[A-Z][\p{L}'’-]+)(?: [A-Z][\p{L}'’-]+)*/gu) || []).length;

function structure(text, sents, lens, paragraphs, n) {
  const ns = Math.max(1, sents.length);
  const sentTexts = sents.map((s) => s.text.trim());
  const sc = (re) => sentTexts.filter((t) => { re.lastIndex = 0; return re.test(t); }).length;
  const total = (re) => sentTexts.reduce((a, t) => a + (t.match(re) || []).length, 0);
  // rhythm: change from one sentence length to the next, relative to the mean (current models are even)
  let adj = 0; for (let i = 1; i < lens.length; i++) adj += Math.abs(lens[i] - lens[i - 1]);
  const adjDiff = lens.length > 1 ? adj / (lens.length - 1) / (mean(lens) || 1) : 0;
  const band = lens.length ? lens.filter((l) => l >= 14 && l <= 30).length / lens.length : 0;
  // paragraphs by sentences
  const bySent = {}; for (const s of sents) bySent[s.para] = (bySent[s.para] || 0) + 1;
  const pc = Object.values(bySent);
  // the closing sentence of a text of at least two paragraphs, and its length against the mean
  const last = sentTexts[sentTexts.length - 1] || '';
  const lastPara = sents.length ? sents[sents.length - 1].para : 0;
  const multi = paragraphs.length >= 2;
  const closerSum = (CLOSER.test(last) ? 1 : 0) + (sentTexts.length > 3 && CLOSER.test(sentTexts[sentTexts.length - 2]) ? 0.5 : 0);
  const lastParaStart = sentTexts.filter((_, i) => sents[i].para === lastPara)[0] || '';
  const lastParaSum = multi && (CLOSER.test(lastParaStart) || CLOSER.test(last)) ? 1 : 0;
  // evenness of named entities and numbers per sentence
  const ent = sentTexts.map(ENT);
  const entShare = ent.filter((e) => e > 0).length / ns;
  const firstWords = sentTexts[0] ? T.words(sentTexts[0]).length : 0;
  return {
    adjDiff, lenBand: band, sentLenSD: Math.sqrt(mean(lens.map((x) => (x - mean(lens)) ** 2))),
    paraSentCV: pc.length >= 3 ? cv(pc) : 0.5, paraSentMean: pc.length ? mean(pc) : sents.length,
    closerSum, lastParaSum, superlativeRate: total(SUPERLATIVE) / ns, threeRate: total(THREE) / ns,
    appositiveRate: total(APPOS) / ns, colonSentShare: sentTexts.filter((t) => /:(?!\/\/)/.test(t)).length / ns,
    contrastRate: total(CONTRAST) / ns, ingTailRate: total(ING_TAIL) / ns, defineFirst: DEFINE.test(sentTexts[0] || '') ? 1 : 0,
    entShare, entCV: cv(ent), entPerSent: mean(ent), firstLen: firstWords,
    lastLenRatio: lens.length ? lens[lens.length - 1] / (mean(lens) || 1) : 1,
    longSentShare: lens.length ? lens.filter((l) => l > 35).length / lens.length : 0,
  };
}

/** The version 3 feature vector (kept so version 3 can still be scored and compared). */
function features(raw) { const v = featureMap(raw); return NAMES.map((k) => (Number.isFinite(v[k]) ? v[k] : 0)); }
const NAMES4 = ['adjDiff', 'lenBand', 'sentLenSD', 'paraSentCV', 'paraSentMean', 'closerSum', 'lastParaSum', 'superlativeRate', 'threeRate',
  'appositiveRate', 'colonSentShare', 'openerGen', 'hedgeRate', 'commonStartShare', 'contrastRate', 'ingTailRate', 'defineFirst', 'entShare', 'entCV', 'entPerSent', 'firstLen', 'lastLenRatio', 'longSentShare'];
const ALL_NAMES = [...NAMES, ...NAMES4];
/** Feature vector for the named features (default: all), in that order. */
function vector(raw, names = ALL_NAMES) { const v = featureMap(raw); return names.map((k) => (Number.isFinite(v[k]) ? v[k] : 0)); }

/** Rates are skewed: compress with log1p after scaling to "per 100 words" where it applies. */
const RATE = new Set(['hedgeRate', 'superlativeRate', 'threeRate', 'appositiveRate', 'contrastRate', 'ingTailRate', 'entPerSent', 'longWordRate', 'semicolonRate', 'colonRate', 'dashRate', 'parenRate', 'quoteRate', 'questionRate', 'exclaimRate', 'contractionRate', 'firstPersonRate', 'secondPersonRate', 'digitRate', 'properRate', 'strongLexRate', 'weakLexRate', 'phraseRate', 'lyRate', 'nominalRate', 'repeatTrigramRate']);
function transform(x, names = NAMES) { return x.map((v, i) => (RATE.has(names[i]) ? Math.log1p(v * 100) : v)); }

function fit(X, y, { l2 = 1, iters = 3000, lr = 0.1, weights, names = NAMES } = {}) {
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
  return { names, mu, sd, w, b };
}
function score(model, x) {
  let z = model.b;
  for (let j = 0; j < x.length; j++) z += model.w[j] * ((x[j] - model.mu[j]) / model.sd[j]);
  return 1 / (1 + Math.exp(-z));
}
/** One logistic model's probability for a text. */
function scoreText(model, text) { return score(model, transform(vector(text, model.names), model.names)); }
/** Map a model's probability so that its own line lands on 0.5: 0 to line becomes 0 to 0.5, line to 1 becomes 0.5 to 1. */
function lift(p, cut) { return p < cut ? (0.5 * p) / cut : 0.5 + (0.5 * (p - cut)) / (1 - cut); }

/**
 * The trained model's reading of a text: { probability, threshold, flagged, version, tested } (null under 80 words).
 * Version 4 ("either") holds two models, each with its own line: version 3 (older generators) and the version 4 core
 * model (current Claude text). A text is flagged when either model reaches its line; the shown score is the higher of the
 * two lifted readings, so 0.5 is the flag line. `parts` gives each model's own probability.
 */
function styleReading(text, model = MODEL) {
  if (T.words(text).length < 80) return null;
  if (model.kind === 'either') {
    const parts = model.parts.map((m) => ({ name: m.name, probability: scoreText(m, text), cut: m.cut }));
    const s = Math.max(...parts.map((q) => lift(q.probability, q.cut)));
    return {
      probability: +s.toFixed(3), threshold: model.threshold, flagged: parts.some((q) => q.probability >= q.cut),
      version: model.version, tested: model.tested,
      parts: parts.map((q) => ({ name: q.name, probability: +q.probability.toFixed(3), cut: q.cut, flagged: q.probability >= q.cut })),
    };
  }
  const p = scoreText(model, text);
  return { probability: +p.toFixed(3), threshold: model.threshold, flagged: p >= model.threshold, version: model.version, tested: model.tested };
}

module.exports = { NAMES, NAMES4, ALL_NAMES, features, featureMap, vector, transform, fit, score, scoreText, lift, clean, styleReading, MODEL };
