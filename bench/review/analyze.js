'use strict';
// Analysis for the review benchmark (PREREGISTRATION.md, version 4). Free: reads result files, calls no model.
//
//   node bench/review/analyze.js dev  [--s0 <file>] [--s2 <file>] [--freeze]
//        S0 and S1 (and S2 when given) on the development split; --freeze writes bench/results/review-frozen.json
//   node bench/review/analyze.js holdout --s0 <file> [--new <file>]
//        the one pre-registered holdout comparison: S0 against the frozen choice (S1 uses the S0 file itself)
//
// Result files are the ones bench/review/run.js writes in bench/results. A document with no score counts as not flagged and
// scores -1 in rankings. Candidate scores come from documentScores() in server/checks/aiscore.js (agent A's definitions).

const fs = require('fs');
const path = require('path');
const M = require('../metrics');
const L = require('./lib');
const { replayRows } = require('./replay');

const RESULTS = path.join(L.ROOT, 'bench', 'results');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? fallback : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const SCORE_ORDER = ['strongShare', 'someShare', 'meanRating', 'topQuartileMean', 'overall'];
const RANK = { S0: -1, S1: 0, S1b: 1, S2: 2 }; // tie order after dev AUROC
const S0_FLAG_AT = 20; // the headline rule fixed in version 1
const BOOT = { reps: 2000, seed: 20261119 };

const manifest = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
const itemsById = () => new Map(manifest().items.map((x) => [x.id, x]));
const resolve = (f) => (path.isAbsolute(f) ? f : fs.existsSync(f) ? path.resolve(f) : path.join(RESULTS, f));
const loadRun = (f) => JSON.parse(fs.readFileSync(resolve(f), 'utf8'));

/** The candidate scores of one result row, through the app's own documentScores() when it exists. */
function scoresOf(row) {
  const ai = require('../../server/checks/aiscore');
  const report = {
    sentences: (row.sentences || []).map((s) => ({ i: s.i, eligible: true, review: s.review, rating: s.rating, words: s.words })),
    eligibleWords: row.eligibleWords, overall: row.overall == null ? null : row.overall,
  };
  if (typeof ai.documentScores !== 'function') throw new Error('documentScores() is not in server/checks/aiscore.js yet.');
  const s = ai.documentScores(report);
  return Object.fromEntries(SCORE_ORDER.map((k) => [k, s[k] == null ? null : s[k]]));
}

/** One analysis row per document: id, class, writer group, and a score map. */
function table(run, info) {
  return run.rows.map((r) => {
    const it = info.get(r.id);
    if (!it) throw new Error(`Document ${r.id} is not in the manifest.`);
    // Scores come from the stored per-sentence ratings through documentScores(), never from the code's own `score` field
    // (S0's score is the strong share, the shipped code's score is now the mean rating). The headline of S0 is strongShare.
    const scores = scoresOf(r);
    return { id: r.id, label: it.label, cell: it.cell, writer: it.writer, words: it.words, headline: scores.strongShare, status: r.status, scores };
  });
}
const val = (x) => (x == null ? -1 : x);
const group = (rows, label) => rows.filter((x) => x.label === label);
const positives = (rows) => rows.filter((x) => x.label !== 'human');
const fmt = (w) => (w ? `${(w.p * 100).toFixed(0)}% (${(w.lo * 100).toFixed(0)}-${(w.hi * 100).toFixed(0)}; ${Math.round(w.p * w.n)}/${w.n})` : '-');
const wil = (k, n) => { const w = M.wilson(k, n); return w && { ...w, n }; };
const rate = (rows, flag) => wil(rows.filter(flag).length, rows.length);
const aurocOf = (rows, get) => M.auroc(positives(rows).map(get), group(rows, 'human').map(get));
const humanKind = (x) => (/non-native/.test(x.writer) ? 'non-native (ELL students)' : x.writer === 'student' ? 'student' : x.writer === 'academic' ? 'academic' : 'other');

/** Threshold, detection and AUROC of one (system, score) pair on a set of rows. */
function devPair(rows, get) {
  const humans = group(rows, 'human').map(get);
  const threshold = M.thresholdForFpr(humans, 0.05);
  const flag = (x) => get(x) >= threshold;
  const pos = positives(rows);
  return {
    threshold, humanFlagged: group(rows, 'human').filter(flag).length, humans: humans.length,
    detection: rate(pos, flag), detectionAI: rate(group(rows, 'ai'), flag), detectionEdited: rate(group(rows, 'edited'), flag),
    auroc: aurocOf(rows, get),
    aurocAI: M.auroc(group(rows, 'ai').map(get), humans), aurocEdited: M.auroc(group(rows, 'edited').map(get), humans),
    abstained: rows.filter((x) => x.headline == null).length,
  };
}

function devAnalysis() {
  const info = itemsById();
  const s0run = loadRun(arg('s0', 'review-S0-dev-claude-sonnet-5-5.json'));
  const s0 = table(s0run, info);
  const s1b = table({ ...s0run, rows: replayRows(s0run, 'dev') }, info);
  const s2file = arg('s2', null);
  const s2 = s2file ? table(loadRun(s2file), info) : null;
  const out = { split: 'dev', systems: {}, s0Rule: {} };
  // S0 exactly as shipped: headline at or above 20
  const s0flag = (x) => x.headline != null && x.headline >= S0_FLAG_AT;
  out.s0Rule = {
    falsePositive: rate(group(s0, 'human'), s0flag), detection: rate(positives(s0), s0flag), detectionAI: rate(group(s0, 'ai'), s0flag), detectionEdited: rate(group(s0, 'edited'), s0flag),
    auroc: aurocOf(s0, (x) => val(x.headline)), abstained: s0.filter((x) => x.headline == null).length,
    humanByKind: Object.fromEntries(['non-native (ELL students)', 'student', 'academic', 'other'].map((k) => [k, rate(group(s0, 'human').filter((x) => humanKind(x) === k), s0flag)])),
  };
  const pairs = [];
  { // S0 itself: headline, flag at 20 (the rule fixed in version 1). It must also keep at most 5% of dev humans flagged to be eligible.
    const get = (x) => val(x.headline);
    const humans = group(s0, 'human');
    const p = { threshold: S0_FLAG_AT, humanFlagged: humans.filter((x) => get(x) >= S0_FLAG_AT).length, humans: humans.length, detection: out.s0Rule.detection, detectionAI: out.s0Rule.detectionAI, detectionEdited: out.s0Rule.detectionEdited, auroc: out.s0Rule.auroc, abstained: out.s0Rule.abstained };
    out.systems['S0/headline'] = p;
    if (p.humanFlagged <= Math.floor(0.05 * p.humans)) pairs.push({ name: 'S0', score: 'headline', ...p });
  }
  for (const [name, rows] of [['S1', s0], ['S1b', s1b], ['S2', s2]]) {
    if (!rows) continue;
    for (const score of SCORE_ORDER) {
      if (rows.some((x) => x.headline != null && x.scores[score] == null)) { out.systems[`${name}/${score}`] = { skipped: 'not every scored document has this score' }; continue; }
      const get = (x) => val(x.scores[score]);
      const p = devPair(rows, get);
      p.humanByKind = Object.fromEntries(['non-native (ELL students)', 'student', 'academic', 'other'].map((k) => { const hs = group(rows, 'human').filter((x) => humanKind(x) === k); return [k, { flagged: hs.filter((x) => get(x) >= p.threshold).length, n: hs.length }]; }));
      out.systems[`${name}/${score}`] = p;
      pairs.push({ name, score, ...p });
    }
  }
  // Rule: highest dev detection of AI + edited; ties -> higher dev AUROC, then S1 before S2, then the score order.
  pairs.sort((a, b) => (b.detection.p - a.detection.p) || ((b.auroc || 0) - (a.auroc || 0)) || (RANK[a.name] - RANK[b.name]) || (SCORE_ORDER.indexOf(a.score) - SCORE_ORDER.indexOf(b.score)));
  out.chosen = pairs.length ? { system: pairs[0].name, score: pairs[0].score, threshold: pairs[0].threshold } : null;
  out.s1bNoScore = s1b.filter((x) => x.headline == null).length;
  out.n = { human: group(s0, 'human').length, ai: group(s0, 'ai').length, edited: group(s0, 'edited').length };
  return out;
}

function printDev(o) {
  const f = (w) => fmt(w);
  console.log(`Development split: ${o.n.human} human, ${o.n.ai} AI, ${o.n.edited} AI-edited.`);
  const r = o.s0Rule;
  console.log(`\nS0 as shipped (headline >= ${S0_FLAG_AT}): false positives ${f(r.falsePositive)}; detection AI+edited ${f(r.detection)}, AI ${f(r.detectionAI)}, edited ${f(r.detectionEdited)}; AUROC ${r.auroc == null ? '-' : r.auroc.toFixed(3)}; no score ${r.abstained}.`);
  console.log(`  humans flagged by kind: ${Object.entries(r.humanByKind).map(([k, v]) => `${k} ${f(v)}`).join('; ')}`);
  console.log('\nCandidates with the dev threshold that flags at most 5% of dev humans (score >= threshold):');
  for (const [k, p] of Object.entries(o.systems)) {
    if (p.skipped) { console.log(`  ${k}: skipped (${p.skipped})`); continue; }
    console.log(`  ${k}: threshold ${p.threshold.toFixed(2)}; humans flagged ${p.humanFlagged}/${p.humans}; detection AI+edited ${f(p.detection)}, AI ${f(p.detectionAI)}, edited ${f(p.detectionEdited)}; AUROC ${p.auroc == null ? '-' : p.auroc.toFixed(3)} (AI ${p.aurocAI == null ? '-' : p.aurocAI.toFixed(3)}, edited ${p.aurocEdited == null ? '-' : p.aurocEdited.toFixed(3)})`);
  }
  console.log(`\nS1b: the S0 replies read again by the working tree's parser; documents without a score: ${o.s1bNoScore} (S0: ${o.s0Rule.abstained}).`);
  console.log(`\nChosen by the pre-registered rule: ${o.chosen ? `${o.chosen.system}/${o.chosen.score}, threshold ${o.chosen.threshold.toFixed(3)}` : 'none'}`);
}

/** Paired stratified bootstrap of AUROC(new) - AUROC(S0): documents resampled with replacement inside each class. */
function pairedAuroc(a, b) {
  const r = M.rng(BOOT.seed);
  const strata = ['human', 'ai', 'edited'].map((l) => a.map((x, i) => [x, b[i]]).filter(([x]) => x.label === l));
  const pos = (s) => s.filter(([x]) => x.label !== 'human');
  const diffs = [];
  for (let k = 0; k < BOOT.reps; k++) {
    const s = strata.flatMap((st) => Array.from({ length: st.length }, () => st[Math.floor(r() * st.length)]));
    const h = s.filter(([x]) => x.label === 'human');
    const p = pos(s);
    const da = M.auroc(p.map(([x]) => x.v), h.map(([x]) => x.v));
    const db = M.auroc(p.map(([, y]) => y.v), h.map(([, y]) => y.v));
    if (da != null && db != null) diffs.push(db - da);
  }
  diffs.sort((x, y) => x - y);
  return { lo: diffs[Math.floor(0.025 * diffs.length)], hi: diffs[Math.ceil(0.975 * diffs.length) - 1], reps: diffs.length };
}

// The pre-registered Markdown pattern (deviation 3): bold marks, or a line starting with a heading, bullet or list number.
const MARKDOWN = /\*\*|^#+ |^- |^\d+\. /m;
const holdoutTexts = () => new Map(fs.readFileSync(path.join(L.DATA, 'holdout.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).map((x) => [x.id, x]));

function analyse(a, b, frozen) {
  const flagA = (x) => x.v >= S0_FLAG_AT;
  const flagB = (x) => x.v >= frozen.threshold;
  const side = (rows, flag) => {
    const get = (x) => x.v;
    const hum = group(rows, 'human');
    const kinds = ['non-native (ELL students)', 'student', 'academic', 'other'];
    return {
      falsePositive: rate(hum, flag), humanByKind: Object.fromEntries(kinds.map((k) => [k, rate(hum.filter((x) => humanKind(x) === k), flag)])),
      detection: rate(positives(rows), flag), detectionAI: rate(group(rows, 'ai'), flag), detectionEdited: rate(group(rows, 'edited'), flag),
      auroc: aurocOf(rows, get), aurocAI: M.auroc(group(rows, 'ai').map(get), hum.map(get)), aurocEdited: M.auroc(group(rows, 'edited').map(get), hum.map(get)),
      aurocBootstrap: M.bootstrap(rows, (r) => aurocOf(r, get), { reps: 1000, seed: BOOT.seed }),
      noScore: rows.filter((x) => x.headline == null).map((x) => x.id),
    };
  };
  const words = (rows) => { const hum = group(rows, 'human').map((x) => x.words); return { all: M.auroc(positives(rows).map((x) => x.words), hum), ai: M.auroc(group(rows, 'ai').map((x) => x.words), hum), edited: M.auroc(group(rows, 'edited').map((x) => x.words), hum) }; };
  const pa = positives(a);
  const pb = positives(b);
  const ha = group(a, 'human');
  const hb = group(b, 'human');
  return {
    n: { human: ha.length, ai: group(a, 'ai').length, edited: group(a, 'edited').length },
    S0: side(a, flagA), selected: side(b, flagB), wordCountAuroc: words(a),
    aurocDiff: { diff: aurocOf(b, (x) => x.v) - aurocOf(a, (x) => x.v), ci: pairedAuroc(a, b) },
    discordant: {
      humans: { s0Only: ha.filter((x, i) => flagA(x) && !flagB(hb[i])).length, selectedOnly: ha.filter((x, i) => !flagA(x) && flagB(hb[i])).length },
      positives: { s0Only: pa.filter((x, i) => flagA(x) && !flagB(pb[i])).length, selectedOnly: pa.filter((x, i) => !flagA(x) && flagB(pb[i])).length },
    },
  };
}

function holdoutAnalysis() {
  const frozenFile = arg('frozen', path.join(RESULTS, 'review-frozen.json'));
  if (!fs.existsSync(frozenFile)) throw new Error('Freeze the development choice first: node bench/review/analyze.js dev --freeze');
  const frozen = JSON.parse(fs.readFileSync(frozenFile, 'utf8'));
  const info = itemsById();
  const s0run = loadRun(arg('s0'));
  const s0 = table(s0run, info);
  const nw = frozen.system === 'S0' || frozen.system === 'S1' ? s0 : frozen.system === 'S1b' ? table({ ...s0run, rows: replayRows(s0run, 'holdout') }, info) : table(loadRun(arg('new')), info);
  if (s0.length !== nw.length || s0.some((x, i) => x.id !== nw[i].id)) throw new Error('S0 and the new system must have the same documents in the same order.');
  const texts = holdoutTexts();
  const mark = (x) => MARKDOWN.test(texts.get(x.id).text);
  const a = s0.map((x) => ({ ...x, v: val(x.headline), markdown: mark(x) }));
  const b = nw.map((x) => ({ ...x, v: frozen.system === 'S0' ? val(x.headline) : val(x.scores[frozen.score]), markdown: mark(x) }));
  const keep = (rows) => rows.filter((x) => !x.markdown);
  return { split: 'holdout', frozen, markdownDocuments: { human: a.filter((x) => x.markdown && x.label === 'human').length, ai: a.filter((x) => x.markdown && x.label === 'ai').length, edited: a.filter((x) => x.markdown && x.label === 'edited').length }, all: analyse(a, b, frozen), withoutMarkdown: analyse(keep(a), keep(b), frozen) };
}

function printHoldout(r) {
  const f = fmt;
  console.log(`Selected: ${r.frozen.system}/${r.frozen.score} at >= ${Number(r.frozen.threshold).toFixed(3)}; S0 at headline >= ${S0_FLAG_AT}. Documents with Markdown marks: ${JSON.stringify(r.markdownDocuments)}`);
  for (const [title, x] of [['ALL DOCUMENTS (primary)', r.all], ['WITHOUT MARKDOWN (sensitivity)', r.withoutMarkdown]]) {
    console.log(`\n=== ${title}: ${x.n.human} human, ${x.n.ai} AI, ${x.n.edited} AI-edited ===`);
    for (const [name, s] of [['S0', x.S0], ['selected', x.selected]]) {
      const ci = s.aurocBootstrap ? `${s.aurocBootstrap.lo.toFixed(3)}-${s.aurocBootstrap.hi.toFixed(3)}` : '-';
      console.log(`${name}: false positives ${f(s.falsePositive)}; detection AI+edited ${f(s.detection)}, AI ${f(s.detectionAI)}, edited ${f(s.detectionEdited)}; AUROC ${s.auroc.toFixed(3)} (95% ${ci}; AI ${s.aurocAI.toFixed(3)}, edited ${s.aurocEdited.toFixed(3)}); no score ${s.noScore.length}`);
      console.log(`   humans flagged by kind: ${Object.entries(s.humanByKind).map(([k, v]) => `${k} ${f(v)}`).join('; ')}`);
    }
    console.log(`Paired AUROC difference (selected - S0): ${x.aurocDiff.diff.toFixed(3)} (95% ${x.aurocDiff.ci.lo.toFixed(3)} to ${x.aurocDiff.ci.hi.toFixed(3)}, ${x.aurocDiff.ci.reps} resamples)`);
    console.log(`Discordant: humans flagged by S0 only ${x.discordant.humans.s0Only}, by selected only ${x.discordant.humans.selectedOnly}; positives flagged by S0 only ${x.discordant.positives.s0Only}, by selected only ${x.discordant.positives.selectedOnly}`);
    console.log(`Word count alone, AUROC (longer = positive): all ${x.wordCountAuroc.all.toFixed(3)}, AI ${x.wordCountAuroc.ai.toFixed(3)}, edited ${x.wordCountAuroc.edited.toFixed(3)}`);
  }
}

/** The Opus check documents (deviation 5): holdout, no Markdown marks, seed 20261118; 3 human (one non-native at least), 3 edited, 2 AI. */
function opusIds() {
  const texts = holdoutTexts();
  const info = itemsById();
  const r = M.rng(20261118);
  const pool = (pred) => [...texts.values()].filter((x) => !MARKDOWN.test(x.text) && pred(info.get(x.id))).map((x) => x.id).sort();
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const nn = shuffle(pool((x) => x.label === 'human' && /non-native/.test(x.writer)));
  const otherH = shuffle(pool((x) => x.label === 'human' && !/non-native/.test(x.writer)));
  const ids = [nn[0], otherH[0], otherH[1], ...shuffle(pool((x) => x.label === 'edited')).slice(0, 3), ...shuffle(pool((x) => x.label === 'ai')).slice(0, 2)];
  return ids;
}

function main() {
  const mode = process.argv[2];
  if (mode === 'dev') {
    const o = devAnalysis();
    printDev(o);
    fs.writeFileSync(path.join(RESULTS, 'review-dev-analysis.json'), JSON.stringify(o, null, 1));
    if (arg('freeze', false)) {
      if (!o.chosen) throw new Error('Nothing to freeze.');
      if (o.chosen.system === 'S2' && !arg('s2', null)) throw new Error('S2 chosen without an S2 file.');
      const hashFiles = ['server/checks/aiscore.js', 'server/prompts.js', 'bench/review/analyze.js', 'bench/review/run.js', 'bench/review/lib.js', 'bench/review/manifest.json'];
      const frozen = { ...o.chosen, frozenAt: new Date().toISOString(), devFiles: { s0: arg('s0', 'review-S0-dev-claude-sonnet-5-5.json'), s2: arg('s2', null) }, sha256: Object.fromEntries(hashFiles.map((f) => [f, L.sha(fs.readFileSync(path.join(L.ROOT, f)))])) };
      fs.writeFileSync(path.join(RESULTS, 'review-frozen.json'), JSON.stringify(frozen, null, 1));
      console.log('Frozen: bench/results/review-frozen.json');
    }
  } else if (mode === 'holdout') {
    const r = holdoutAnalysis();
    printHoldout(r);
    fs.writeFileSync(arg('out', path.join(RESULTS, 'review-holdout-analysis.json')), JSON.stringify(r, null, 1));
  } else if (mode === 'opus-ids') console.log(opusIds().join(','));
  else throw new Error('Use: analyze.js dev|holdout|opus-ids');
}

if (require.main === module) { try { main(); } catch (e) { console.error(e.message); process.exit(1); } }
module.exports = { MARKDOWN, opusIds, analyse, scoresOf, devPair, pairedAuroc, humanKind, SCORE_ORDER };
