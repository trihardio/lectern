'use strict';
// Shared helpers for the style model version 4 scripts (train-v4.js, eval-v4.js, fair-v4.js). Nothing here reads a
// holdout split: loadV6('train' | 'dev') refuses any other split name.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const S = require(ROOT + '/server/checks/style');
const M = require(ROOT + '/bench/metrics');
const T = require(ROOT + '/server/checks/text');

const readJsonl = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
const prep = (text) => T.capWords(T.normalizeText(text)).text;

/** Version 3's training sources: bench v1 dev (HC3, RAID), a MAGE sample and a DACTYL train sample. */
function loadV3Rows() {
  const f = [ROOT + '/bench/data/dev.jsonl', ROOT + '/bench/data/style/mage.jsonl', ROOT + '/bench/data/style/dactyl-train.jsonl'];
  return f.flatMap(readJsonl).filter((r) => r.label === 'human' || r.label === 'ai').map((r) => ({
    id: r.ref, source: r.source, label: r.label, group: r.group || r.ref, writer: r.generator || r.model || r.writer || '', text: r.text, nonNative: false, set: 'v3',
  }));
}

const NN = /non-?native|toefl|\bell\b|\besl\b|\bl2\b/i;
/** Version 6 rows of one split. 'edited' texts count as AI (light model edits) and carry edited:true. */
function loadV6(split) {
  if (split !== 'train' && split !== 'dev') throw new Error(`style v4 may only read the v6 train and dev splits, not "${split}"`);
  const file = ROOT + '/bench/data/v6/corpus.jsonl';
  if (!fs.existsSync(file)) throw new Error('bench/data/v6/corpus.jsonl does not exist yet (agent A has not finished)');
  return readJsonl(file).filter((r) => r.split === split && r.label !== 'mixed').map((r) => ({
    id: r.id, source: r.source || 'v6', label: r.label === 'human' ? 'human' : 'ai', edited: r.label === 'edited', words: r.words,
    group: String(r.group || r.topic || r.request || r.id), writer: r.writer || r.model || r.generator || '', genre: r.genre, text: r.text,
    // non-native is a property of human texts only (an AI text asked to write "as a B2 student" is still AI)
    nonNative: r.label === 'human' && (r.nonNative === true || NN.test([r.source, r.genre, r.population].join(' '))),
    set: 'v6',
  }));
}
const isClaude = (r) => r.label === 'ai' && /claude/i.test(r.writer);

// Feature cache keyed by the feature code, so the app's code and training's numbers cannot drift apart unseen.
const CODE = sha(fs.readFileSync(ROOT + '/server/checks/style.js', 'utf8') + fs.readFileSync(ROOT + '/server/checks/text.js', 'utf8') + fs.readFileSync(ROOT + '/server/checks/aiscore.js', 'utf8'));
const CACHE_FILE = ROOT + '/bench/data/style/cache-v4.json';
let cache = null;
function allFeatures(rows) {
  if (!cache) { try { const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); cache = c.code === CODE ? c : { code: CODE, f: {} }; } catch { cache = { code: CODE, f: {} }; } }
  let added = 0;
  const out = rows.map((r) => {
    const k = sha(r.text);
    if (!cache.f[k]) { const v = S.featureMap(prep(r.text)); cache.f[k] = S.ALL_NAMES.map((n) => (Number.isFinite(v[n]) ? v[n] : 0)); added++; }
    return cache.f[k];
  });
  if (added) fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  return out;
}
/** Transformed vectors for the given feature names. */
function matrix(rows, names) {
  const all = allFeatures(rows);
  const idx = names.map((n) => S.ALL_NAMES.indexOf(n));
  if (idx.some((i) => i < 0)) throw new Error('unknown feature in ' + names.join(','));
  return all.map((v) => S.transform(idx.map((i) => (Number.isFinite(v[i]) ? v[i] : 0)), names));
}

const pct = (k, n) => { if (!n) return 'n/a'; const w = M.wilson(k, n); return `${(100 * k / n).toFixed(1)}% (${(100 * w.lo).toFixed(1)}-${(100 * w.hi).toFixed(1)}; ${k}/${n})`; };

/** The lowest line with at most `max` (5%) of human texts and of non-native texts flagged. rows: [{score,label,nonNative}] */
function lowestLine(rows, max = 0.05) {
  // pre-registered rule: lowest value rounded UP to one decimal on the 0-100 scale (three decimals of probability)
  const raw = rawLine(rows, max);
  return Math.min(1, Math.ceil(raw * 1000 - 1e-9) / 1000);
}
function rawLine(rows, max) {
  const hum = rows.filter((r) => r.label === 'human'), nn = rows.filter((r) => r.label === 'human' && r.nonNative);
  const cands = [...new Set(hum.map((r) => r.score))].sort((a, b) => a - b).map((s) => s + 1e-9);
  cands.unshift(0);
  for (const t of cands) {
    const fh = hum.filter((r) => r.score >= t).length, fn = nn.filter((r) => r.score >= t).length;
    if (fh <= Math.floor(max * hum.length) && fn <= Math.floor(max * nn.length)) return t;
  }
  return 1;
}

/** Everything the brief asks for, for scored rows at a line. */
function report(rows, line) {
  const ai = rows.filter((r) => r.label === 'ai'), hum = rows.filter((r) => r.label === 'human');
  const cl = ai.filter(isClaude), nn = hum.filter((r) => r.nonNative);
  const fl = (a) => a.filter((r) => r.score >= line).length;
  const out = {
    n: { ai: ai.length, claude: cl.length, human: hum.length, nonNative: nn.length },
    auroc: M.auroc(ai.map((r) => r.score), hum.map((r) => r.score)),
    aurocClaude: M.auroc(cl.map((r) => r.score), hum.map((r) => r.score)),
    line, aiFlagged: pct(fl(ai), ai.length), claudeFlagged: pct(fl(cl), cl.length), humanFlagged: pct(fl(hum), hum.length), nonNativeFlagged: pct(fl(nn), nn.length),
    byWriter: {},
  };
  for (const w of [...new Set(ai.map((r) => r.writer || 'unknown'))].sort()) { const a = ai.filter((r) => (r.writer || 'unknown') === w); out.byWriter[w] = pct(fl(a), a.length); }
  return out;
}
const PROFICIENCY = /^(wordLenMean|longWordRate|mattr|hapaxRate|nominalRate|properRate|digitRate|parenRate|ent.*|firstLen)$/;
const SETS = {
  v3: S.NAMES,
  all: S.ALL_NAMES,
  // version 4 features without the ones that count named entities or numbers (they can track how personal or abstract a topic is)
  noent: S.ALL_NAMES.filter((n) => !/^ent|^digitRate|^properRate/.test(n)),
  // without paragraph-shape features (many human texts are one paragraph; paragraphs may only reflect format)
  nopara: S.ALL_NAMES.filter((n) => !/^para|^lastParaSum$/.test(n)),
  noentpara: S.ALL_NAMES.filter((n) => !/^ent|^digitRate|^properRate|^para|^lastParaSum$/.test(n)),
  // 'fair': drops what tracks English proficiency, formality or topic (word length, vocabulary diversity, nominal endings, named entities, numbers,
  // proper nouns, parentheses), following the brief's ban list. Diagnosis: these made essays with no named entities (learners) read as AI.
  fair: S.ALL_NAMES.filter((n) => !PROFICIENCY.test(n)),
  fairnopara: S.ALL_NAMES.filter((n) => !PROFICIENCY.test(n) && !/^para|^lastParaSum$/.test(n)),
  // 'formfree': no paragraph, topic or word-form features; keeps lexical diversity (mattr, hapax, repeats), which can only make a learner's text read as human
  formfree: S.ALL_NAMES.filter((n) => !/^(wordLenMean|longWordRate|nominalRate|properRate|digitRate|parenRate|ent.*|firstLen|para.*|lastParaSum)$/.test(n)),
  // 'core': fairnopara without sentence-length features (sentence length mostly reflects how a corpus was punctuated: run-on student essays vs well-punctuated learner essays)
  core: S.ALL_NAMES.filter((n) => !PROFICIENCY.test(n) && !/^para|^lastParaSum$|^sentLen|^longSentShare$|^lenBand$|^adjDiff$|^lastLenRatio$/.test(n)),
  // only structure and rhythm: no vocabulary or lexicon features at all
  shape: ['sentLenMean', 'sentLenCV', 'commaPerSent', 'starterDiversity', 'signpostShare', ...S.NAMES4.filter((n) => !/^ent|^para|^lastParaSum$/.test(n))],
};

/** Cell used for weighting: version 3's sources keep their own; version 6 texts form a few cells so tiny groups cannot dominate. */
function cellOf(r) {
  if (r.set !== 'v6') return `${r.source}|${r.label}`;
  if (r.label === 'ai') return 'v6|ai';
  return r.nonNative ? 'v6|human-nonnative' : /wikipedia/i.test(r.source) ? 'v6|human-wikipedia' : 'v6|human-other';
}
module.exports = { SETS, cellOf, ROOT, S, M, T, readJsonl, sha, prep, loadV3Rows, loadV6, isClaude, matrix, pct, lowestLine, report };

/**
 * Length augmentation for TRAINING rows only: every text longer than 170 words also gets a copy cut at a sentence end
 * after 80-150 words (the length is drawn from the text's own hash, so it is reproducible). Short texts are common in
 * practice (essays, answers) and several style features move with length; this teaches the model that short is not AI.
 */
function augment(rows) {
  const out = [];
  for (const r of rows) {
    out.push(r);
    const text = prep(r.text);
    if (T.words(text).length <= 170) continue;
    const target = 80 + (parseInt(sha(r.text).slice(0, 6), 16) % 71);
    let words = 0, end = -1;
    for (const s of T.segment(text).sentences) { words += T.words(s.text).length; if (words >= target) { end = s.end; break; } }
    if (end < 0) continue;
    const cut = text.slice(0, end);
    if (T.words(cut).length >= 80) out.push({ ...r, text: cut, crop: true });
  }
  return out;
}
module.exports.augment = augment;
