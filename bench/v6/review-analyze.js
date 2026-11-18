'use strict';
// Development analysis for version 6 (pre-registration "Selection"): lines, gates, S3 forms and the choice.
//   node bench/v6/review-analyze.js dev       prints the development table and writes bench/results/review6-dev.json
// Reads run files (ids and ratings), never prints text. Uses the working tree's style.js (version 4 once agent B is done).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const S3 = require('./review-s3');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'bench', 'data', 'v6');
const RES = path.join(ROOT, 'bench', 'results');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const jl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
const flag = (v, line) => Number.isFinite(v) && v >= line; // a text without a score is not flagged

/** Lowest line, in steps of 0.1, with at most 5% of the human and at most 5% of the non-native texts flagged. */
function lineFor(rows, score) {
  const hum = rows.filter((r) => r.label !== 'ai');
  const nn = hum.filter((r) => r.nonNative);
  const okH = Math.floor(0.05 * hum.length + 1e-9);
  const okN = Math.floor(0.05 * nn.length + 1e-9);
  for (let t = 0; t <= 1000; t++) {
    const L = t / 10;
    if (hum.filter((r) => flag(score(r), L)).length <= okH && nn.filter((r) => flag(score(r), L)).length <= okN) return L;
  }
  return 100.1;
}
function counts(rows, score, line) {
  const ai = rows.filter((r) => r.label === 'ai');
  const hum = rows.filter((r) => r.label !== 'ai');
  const nn = hum.filter((r) => r.nonNative);
  const f = (a) => a.filter((r) => flag(score(r), line)).length;
  return {
    line, ai: S3.wilson(f(ai), ai.length), human: S3.wilson(f(hum), hum.length), nonNative: S3.wilson(f(nn), nn.length),
    auroc: S3.auroc(ai.map(score), hum.map(score)), noScore: rows.filter((r) => !Number.isFinite(score(r))).length,
  };
}
const median = (a) => { const s = a.slice().sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };

/** S1's 0-100 score: the lifted probability, kept on the same side of 50 as the app's own flag (a 3-decimal rounding can show 0.5 for a text just under its line). */
const s1Score = (r) => (r.flagged ? Math.max(50, r.probability * 100) : Math.min(49.9, r.probability * 100));

function load() {
  const corpus = jl(path.join(DATA, 'corpus.jsonl'));
  const sets = JSON.parse(fs.readFileSync(path.join(DATA, 'review-sets.json'), 'utf8'));
  const { styleReading, MODEL } = require('../../server/checks/style');
  const runs = (name) => new Map(jl(path.join(DATA, 'runs', name)).map((r) => [r.id, r]));
  return { corpus, sets, styleReading, MODEL, runs };
}

function dev() {
  const { corpus, sets, styleReading, MODEL, runs } = load();
  const devAll = corpus.filter((x) => x.split === 'dev');
  const style = new Map(devAll.map((x) => { const r = styleReading(x.text); return [x.id, r ? s1Score(r) : null]; }));
  const s2a = runs('s2-dev-claude-sonnet-5-5-r1-review.jsonl');
  const s2b = runs('s2-dev-claude-sonnet-5-5-r2-repeat.jsonl');
  const opus = runs('s2-dev-claude-opus-5-5-r1-opus.jsonl');
  const review = devAll.filter((x) => sets.review.includes(x.id)).map((x) => ({ id: x.id, label: x.label, nonNative: !!x.nonNative, s1: style.get(x.id), s2: s2a.has(x.id) ? s2a.get(x.id).meanRating : null, overall: s2a.has(x.id) ? s2a.get(x.id).overall : null }));
  const out = { styleVersion: MODEL.version, n: { review: review.length, devAll: devAll.length }, systems: {} };

  // S1 on all development texts for its line, then evaluated on the review set too
  const s1Line = 50; // fixed by lectern-2a / agent B (deviation 8): the shown score lifts both models so that 0.5 is the flag line
  const s1LineRule = lineFor(devAll.map((x) => ({ label: x.label, nonNative: x.nonNative, s1: style.get(x.id) })), (r) => r.s1);
  out.systems.S1 = { line: s1Line, lowestLineUnderRule: s1LineRule, allDev: counts(devAll.map((x) => ({ label: x.label, nonNative: x.nonNative, s1: style.get(x.id) })), (r) => r.s1, s1Line), reviewSet: counts(review, (r) => r.s1, s1Line) };
  // S2
  const s2Line = lineFor(review, (r) => r.s2);
  out.systems.S2 = { line: s2Line, reviewSet: counts(review, (r) => r.s2, s2Line), at538: counts(review, (r) => r.s2, 53.8) };
  // S3 form A: weighted mean, weights in steps of 0.1 (weight on S2 = w, on S1 = 1 - w)
  const wm = [];
  for (let k = 0; k <= 10; k++) {
    const w = k / 10;
    const score = (r) => (Number.isFinite(r.s2) && Number.isFinite(r.s1) ? w * r.s2 + (1 - w) * r.s1 : null);
    const L = lineFor(review, score);
    wm.push({ w, ...counts(review, score, L) });
  }
  wm.sort((a, b) => b.ai.k - a.ai.k || (b.auroc || 0) - (a.auroc || 0) || a.w - b.w);
  out.systems.S3weighted = { best: wm[0], all: wm.map((x) => ({ w: x.w, line: x.line, ai: x.ai.k, human: x.human.k, nn: x.nonNative.k, auroc: x.auroc })) };
  // S3 form B: logistic regression on meanRating and logit(style) (+ overall), fitted on the review set
  const fit = (inputs) => {
    const rows = review.map((r) => ({ y: r.label === 'ai' ? 1 : 0, meanRating: r.s2, styleProbability: r.s1 / 100 }));
    return S3.fitS3(rows);
  };
  const lf = fit();
  const lscore = (r) => S3.scoreS3(lf, r.s2, r.s1 / 100);
  const lL = lineFor(review, lscore);
  out.systems.S3logistic = { formula: lf, line: lL, ...counts(review, lscore, lL) };
  out.sets = { review: sets.review.length, repeat: sets.repeat.length, opus: sets.opus.length };

  // gates
  const byId = new Map(devAll.map((x) => [x.id, x]));
  const scoreFns = {
    S2: { f: (r) => r.s2, line: s2Line },
    S3weighted: { f: (r) => (Number.isFinite(r.s2) && Number.isFinite(r.s1) ? wm[0].w * r.s2 + (1 - wm[0].w) * r.s1 : null), line: wm[0].line },
    S3logistic: { f: lscore, line: lL },
  };
  const rowOf = (id, run) => ({ s2: run.get(id) ? run.get(id).meanRating : null, s1: style.get(id) });
  out.gates = {};
  for (const [name, { f, line }] of Object.entries(scoreFns)) {
    const rep = sets.repeat.map((id) => ({ id, a: f({ s2: s2a.get(id) && s2a.get(id).meanRating, s1: style.get(id) }), b: f({ s2: s2b.get(id) && s2b.get(id).meanRating, s1: style.get(id) }) })).filter((x) => Number.isFinite(x.a) && Number.isFinite(x.b));
    const changes = rep.map((x) => Math.abs(x.a - x.b));
    const flips = rep.filter((x) => flag(x.a, line) !== flag(x.b, line)).length;
    const limitFlips = Math.floor(0.1 * rep.length + 1e-9);
    const op = sets.opus.map((id) => ({ id, human: byId.get(id).label !== 'ai', v: f(rowOf(id, opus)) }));
    const opHumanFlagged = op.filter((x) => x.human && flag(x.v, line)).length;
    out.gates[name] = {
      stability: { n: rep.length, medianAbsChange: median(changes), maxAbsChange: changes.length ? Math.max(...changes) : null, flips, limitFlips, pass: rep.length >= 15 && median(changes) <= 8 && flips <= limitFlips },
      opus: { n: op.length, withScore: op.filter((x) => Number.isFinite(x.v)).length, humanFlagged: opHumanFlagged, aiFlagged: op.filter((x) => !x.human && flag(x.v, line)).length, pass: op.length >= 9 && opHumanFlagged < 2 },
    };
  }
  // S0 on the version 5 development texts (cached replies, free)
  const v5 = jl(path.join(ROOT, 'bench', 'data', 'review5', 'corpus.jsonl'));
  const v5ByHash = new Map(v5.map((x) => [sha(x.text), x.id]));
  const s0 = new Map(jl(path.join(ROOT, 'bench', 'data', 'review5', 'runs', 'shipped-all-claude-sonnet-5-5.jsonl')).map((r) => [r.id, r]));
  const s0rows = devAll.filter((x) => v5ByHash.has(sha(x.text))).map((x) => ({ id: x.id, label: x.label, nonNative: !!x.nonNative, s0: (s0.get(v5ByHash.get(sha(x.text))) || {}).meanRating }));
  out.systems.S0 = { v5TextsInDev: s0rows.length, at538: counts(s0rows, (r) => r.s0, 53.8), inReviewSet: counts(s0rows.filter((r) => sets.review.includes(r.id)), (r) => r.s0, 53.8) };

  // choice (rule 4): gates passed; most AI flagged on the review set; a lead of one text or less is a tie; ties go S1, S2, S3
  const cand = [
    { name: 'S1', ai: out.systems.S1.reviewSet.ai.k, pass: true, line: s1Line },
    { name: 'S2', ai: out.systems.S2.reviewSet.ai.k, pass: out.gates.S2.stability.pass && out.gates.S2.opus.pass, line: s2Line },
    { name: 'S3weighted', ai: out.systems.S3weighted.best.ai.k, pass: out.gates.S3weighted.stability.pass && out.gates.S3weighted.opus.pass, line: wm[0].line },
    { name: 'S3logistic', ai: out.systems.S3logistic.ai.k, pass: out.gates.S3logistic.stability.pass && out.gates.S3logistic.opus.pass, line: lL },
  ];
  const ok = cand.filter((c) => c.pass);
  const top = ok.length ? Math.max(...ok.map((c) => c.ai)) : null;
  const tied = ok.filter((c) => c.ai >= top - 1);
  out.candidates = cand;
  out.choice = tied.length ? tied[0].name : 'S0';
  fs.writeFileSync(path.join(RES, 'review6-dev.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
}

if (require.main === module) { if (process.argv[2] === 'dev') dev(); else console.log('Use: dev'); }
module.exports = { s1Score, lineFor, counts, median, flag };
