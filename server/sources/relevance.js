'use strict';
// A relevance score that needs no model: how well each paper's title and abstract match the words of the
// student's question and of the planned search queries.
//
// Why it exists: reciprocal-rank fusion (sources/index.js) trusts each database's own order. A database that
// matches loosely (Crossref matches bibliographic words, not topics) can put an off-topic paper at its top, and
// fusion then carries that paper into the list the model reads. Scoring every candidate's own text against the
// question catches that filler.
//
// How: a BM25F-style score (Robertson and Zaragoza, "The Probabilistic Relevance Framework: BM25 and Beyond",
// Foundations and Trends in IR 3(4), 2009, sections 3.4 to 3.6) over two fields, title and abstract, with each
// query word weighted by how many of the search strings use it (see queryModel). The score is a weighted average
// of saturated term frequencies, so it lies between 0 and 1 and reads as "how much of the question this paper
// covers". No dependencies, no network, no model.

/**
 * English function words, question words, and words that every research question and abstract uses without
 * saying what it is about ("effect", "study"). Matching them would reward every paper alike.
 */
const STOPWORDS = new Set((
  'a about above after again against all also am an and any are as at be because been before being below between both but by ' +
  'can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into ' +
  'is it its itself just me more most my no nor not of off on once only or other our ours out over own same she should so some such ' +
  'than that the their theirs them then there these they this those through to too under until up us very was we were what when ' +
  'where which while who whom why will with within without would you your ' +
  'affect affects effect effects impact impacts influence influences role evidence research study studies paper papers literature ' +
  'relationship relationships association associations associated relation link linked compare compared comparison versus vs'
).split(/\s+/));

/**
 * Words of asking and judging rather than of a topic ("what does research say makes a good..."). They come from how
 * students phrase questions; abstracts use them loosely ("we found", "well known"), so a match says nothing.
 */
const ASKING = new Set((
  'say says said tell tells told know knows known show shows showed shown find finds found make makes made ' +
  'good bad well better best really actually much many way ways thing things'
).split(/\s+/));
const STOP_SETS = { base: STOPWORDS, asking: new Set([...STOPWORDS, ...ASKING]) };

/** Greek letters as their names, so "β-amyloid" and "beta-amyloid", or "TNF-α" and "TNF-alpha", are the same words. */
const GREEK = {
  α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', ε: 'epsilon', ζ: 'zeta', η: 'eta', θ: 'theta', ι: 'iota', κ: 'kappa',
  λ: 'lambda', μ: 'mu', ν: 'nu', ξ: 'xi', ο: 'omicron', π: 'pi', ρ: 'rho', σ: 'sigma', ς: 'sigma', τ: 'tau', υ: 'upsilon',
  φ: 'phi', χ: 'chi', ψ: 'psi', ω: 'omega',
};
const GREEK_RE = new RegExp(`[${Object.keys(GREEK).join('')}]`, 'g');

/**
 * Lower case, accents removed, Greek letters spelled out. Letters of every script are kept, so a Chinese or
 * Russian title is still text here (util.normTitle keeps only a to z and digits).
 */
function foldText(s) {
  return String(s || '').toLowerCase().replace(GREEK_RE, (c) => GREEK[c])
    .normalize('NFKD').replace(/\p{M}+/gu, '');
}

/**
 * Harman's "S" stemmer: it joins plural and singular forms and nothing else (D. Harman, "How effective is
 * suffixing?", JASIS 42(1), 1991; rules as listed in NIST IR 4873, www-nlpir.nist.gov/projects/irlib, read
 * 2026-11-18). Heavier stemmers also join words of different meaning, and abstracts are short enough that a
 * missed plural costs more than a missed "-ing".
 */
function sStem(w) {
  if (w.length < 3) return w;
  if (w.endsWith('ies') && !w.endsWith('eies') && !w.endsWith('aies')) return `${w.slice(0, -3)}y`;
  if (w.endsWith('es') && !w.endsWith('aes') && !w.endsWith('ees') && !w.endsWith('oes')) return w.slice(0, -1);
  if (w.endsWith('s') && !w.endsWith('us') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/**
 * Step 1 of Porter's stemmer (M. F. Porter, "An algorithm for suffix stripping", Program 14(3), 1980): plurals,
 * "-ed" and "-ing", and a final "y". It joins "working" with "work" and "studies" with "study", which the S stemmer
 * does not, and leaves derivations ("productive", "productivity") apart, as steps 2 to 5 would not.
 */
function isCons(w, i) {
  const c = w[i];
  if ('aeiou'.includes(c)) return false;
  if (c === 'y') return i === 0 ? true : !isCons(w, i - 1);
  return true;
}
function measure(s) {
  let m = 0;
  let i = 0;
  while (i < s.length && isCons(s, i)) i++;
  while (i < s.length) {
    while (i < s.length && !isCons(s, i)) i++;
    if (i >= s.length) break;
    while (i < s.length && isCons(s, i)) i++;
    m++;
  }
  return m;
}
const hasVowel = (s) => { for (let i = 0; i < s.length; i++) if (!isCons(s, i)) return true; return false; };
const endsDouble = (s) => s.length > 1 && s[s.length - 1] === s[s.length - 2] && isCons(s, s.length - 1);
const endsCvc = (s) => {
  const n = s.length;
  return n >= 3 && isCons(s, n - 3) && !isCons(s, n - 2) && isCons(s, n - 1) && !'wxy'.includes(s[n - 1]);
};
function porterStep1(w) {
  if (w.length < 3) return w;
  if (w.endsWith('sses') || w.endsWith('ies')) w = w.slice(0, -2);
  else if (!w.endsWith('ss') && w.endsWith('s')) w = w.slice(0, -1);
  let tidy = false;
  if (w.endsWith('eed')) { if (measure(w.slice(0, -3)) > 0) w = w.slice(0, -1); }
  else if (w.endsWith('ed') && hasVowel(w.slice(0, -2))) { w = w.slice(0, -2); tidy = true; }
  else if (w.endsWith('ing') && hasVowel(w.slice(0, -3))) { w = w.slice(0, -3); tidy = true; }
  if (tidy) {
    if (/(at|bl|iz)$/.test(w)) w += 'e';
    else if (endsDouble(w) && !/[lsz]$/.test(w)) w = w.slice(0, -1);
    else if (measure(w) === 1 && endsCvc(w)) w += 'e';
  }
  if (w.endsWith('y') && hasVowel(w.slice(0, -1))) w = `${w.slice(0, -1)}i`;
  return w;
}

const STEMMERS = { s: sStem, porter1: porterStep1, none: (w) => w };
const DEFAULT_STEMMER = 's';
const DEFAULT_STOP = 'asking';

/**
 * British to American spelling, so a student who writes "randomised", "behaviour" or "paediatric" matches the
 * literature, most of which uses the American forms. Applied to both sides, before stemming, so a rule that also
 * changes some unrelated word (e.g. "flour" to "flor") still compares like with like.
 */
const SPELLING = [
  [/isation/g, 'ization'], [/(?<=\w\w)is(e|ed|es|ing)$/, 'iz$1'], [/(?<=\w)ys(e|ed|es|ing)$/, 'yz$1'],
  [/(?<=\w\w)our(s|ed|ing|al|able)?$/, 'or$1'], [/paed/g, 'ped'], [/haem/g, 'hem'], [/aemi/g, 'emi'],
  [/^oe(?=[sd])/, 'e'], [/^foet/, 'fet'], [/(?<=\w\w)([bt])re(s?)$/, '$1er$2'], [/(?<=\w\w)ogue(s?)$/, 'og$1'], [/^programme/, 'program'],
];
function spell(w) {
  if (w.length < 5) return w;
  for (const [re, to] of SPELLING) w = w.replace(re, to);
  return w;
}

/**
 * Text -> the sequence of index words: folded, split on anything that is not a letter or digit, stopwords out,
 * spelling made American, stemmed. Words with letters outside a to z are kept whole (no English stemmer applies).
 */
function analyse(text, stemmer = DEFAULT_STEMMER, stop = DEFAULT_STOP) {
  const stem = STEMMERS[stemmer] || sStem;
  const stops = STOP_SETS[stop] || STOP_SETS[DEFAULT_STOP];
  const out = [];
  for (const raw of foldText(text).split(/[^\p{L}\p{N}]+/u)) {
    if (!raw || stops.has(raw)) continue;
    if (raw.length < 2 && !/\d/.test(raw)) continue;
    out.push(/^[a-z]+$/.test(raw) ? stem(spell(raw)) : raw);
  }
  return out;
}

/** A follow-up ("and in schools?") leans on earlier turns; the planned queries carry that context, so its own words count less. */
const FOLLOW_UP_WEIGHT = 0.5;

/**
 * The query side. Every search string (the question and each planned query) is one voice; a word's weight is the
 * share of voices that use it. The topic words that every query repeats weigh 1, a synonym tried in one query of
 * five weighs 0.2. This needs no collection statistics, which matters because the candidate pool was retrieved
 * for these very words: within it, the topic words are common, so a pool-based IDF would weigh them least.
 * Adjacent word pairs ("remote work") are kept the same way, for the optional phrase part of the score.
 */
function queryModel({ question = '', queries = [], followUp = false, stemmer = DEFAULT_STEMMER, stop = DEFAULT_STOP } = {}) {
  const voices = [];
  if (String(question || '').trim()) voices.push({ words: analyse(question, stemmer, stop), w: followUp ? FOLLOW_UP_WEIGHT : 1 });
  const seen = new Set();
  for (const q of queries || []) {
    const key = String(q || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    voices.push({ words: analyse(q, stemmer, stop), w: 1 });
  }
  const total = voices.reduce((s, v) => s + v.w, 0);
  const terms = new Map();
  const pairs = new Map();
  for (const v of voices) {
    for (const t of new Set(v.words)) terms.set(t, (terms.get(t) || 0) + v.w / total);
    const ps = new Set();
    for (let i = 1; i < v.words.length; i++) if (v.words[i] !== v.words[i - 1]) ps.add(`${v.words[i - 1]} ${v.words[i]}`);
    for (const p of ps) pairs.set(p, (pairs.get(p) || 0) + v.w / total);
  }
  return { terms, pairs };
}

/**
 * The parameters, each with its reason. Defaults were chosen on the development split of bench/search
 * (see the ranking report); change one at a time and re-run it.
 *   k1          term-frequency saturation. 1.2 is the usual default; Robertson and Zaragoza (2009, section 3.5)
 *               report 1.2 < k1 < 2 as "reasonably good in many circumstances".
 *   b           how much a long abstract is discounted; same source: 0.5 < b < 0.8.
 *   titleWeight a title word counts this many times an abstract word (BM25F stream weight, section 3.6). A title
 *               states what a paper is about; an abstract also mentions background and methods.
 *   pairWeight  weight of adjacent query-word pairs relative to single words (0 = single words only).
 *   stop        'asking' drops the function words and the words of asking (ASKING); 'base' only the first list.
 *   stemmer     's' (plurals only) or 'porter1' (plurals, "-ed", "-ing"); see the two functions above.
 *   idf         'none' weighs words only by how many search strings use them; 'pool' also multiplies by an IDF
 *               computed over the candidate pool (Lucene's non-negative form, log(1 + (N - n + 0.5) / (n + 0.5))).
 */
const DEFAULTS = { k1: 1.2, b: 0.75, titleWeight: 2, pairWeight: 0, idf: 'none', stemmer: DEFAULT_STEMMER, stop: DEFAULT_STOP };

function countsOf(words) {
  const tf = new Map();
  for (const w of words) tf.set(w, (tf.get(w) || 0) + 1);
  return tf;
}

function pairCounts(words) {
  const tf = new Map();
  for (let i = 1; i < words.length; i++) {
    const p = `${words[i - 1]} ${words[i]}`;
    tf.set(p, (tf.get(p) || 0) + 1);
  }
  return tf;
}

/**
 * Score every paper in `papers` against the question and the planned queries. Returns an array of numbers in
 * [0, 1), in the same order as `papers`: 0 when the paper shares no query word, near 1 when its title and abstract
 * use every query word, more than once. All zeros when there is nothing to score against.
 */
function scorePool(papers, { question = '', queries = [], followUp = false, ...opts } = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const { terms, pairs } = queryModel({ question, queries, followUp, stemmer: cfg.stemmer, stop: cfg.stop });
  if (!papers.length || !terms.size) return papers.map(() => 0);
  const usePairs = cfg.pairWeight > 0 && pairs.size > 0;

  const docs = papers.map((p) => {
    const title = analyse(p.title, cfg.stemmer, cfg.stop);
    const body = analyse(p.abstract || p.tldr || '', cfg.stemmer, cfg.stop);
    return {
      len: cfg.titleWeight * title.length + body.length,
      title: countsOf(title), body: countsOf(body),
      titlePairs: usePairs ? pairCounts(title) : null, bodyPairs: usePairs ? pairCounts(body) : null,
    };
  });
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / docs.length || 1;

  const idf = new Map();
  if (cfg.idf === 'pool') {
    const N = docs.length;
    const df = (key, isPair) => docs.filter((d) => (isPair ? d.titlePairs.has(key) || d.bodyPairs.has(key) : d.title.has(key) || d.body.has(key))).length;
    for (const t of terms.keys()) { const n = df(t, false); idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5))); }
    if (usePairs) for (const p of pairs.keys()) { const n = df(p, true); idf.set(`pair:${p}`, Math.log(1 + (N - n + 0.5) / (n + 0.5))); }
  }
  const idfOf = (key) => (cfg.idf === 'pool' ? idf.get(key) : 1);

  let maxTotal = 0;
  for (const [t, w] of terms) maxTotal += w * idfOf(t);
  if (usePairs) for (const [p, w] of pairs) maxTotal += cfg.pairWeight * w * idfOf(`pair:${p}`);
  if (!(maxTotal > 0)) return papers.map(() => 0);

  return docs.map((d) => {
    const norm = cfg.k1 * ((1 - cfg.b) + cfg.b * (d.len / avgLen));
    const sat = (tf) => (tf > 0 ? tf / (norm + tf) : 0);
    let s = 0;
    for (const [t, w] of terms) s += w * idfOf(t) * sat(cfg.titleWeight * (d.title.get(t) || 0) + (d.body.get(t) || 0));
    if (usePairs) {
      for (const [p, w] of pairs) {
        s += cfg.pairWeight * w * idfOf(`pair:${p}`) * sat(cfg.titleWeight * (d.titlePairs.get(p) || 0) + (d.bodyPairs.get(p) || 0));
      }
    }
    return s / maxTotal;
  });
}

module.exports = { scorePool, queryModel, analyse, sStem, porterStep1, spell, foldText, STOPWORDS, ASKING, DEFAULTS, FOLLOW_UP_WEIGHT };
