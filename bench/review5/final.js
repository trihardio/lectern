'use strict';
// Round 5 of the version 5 candidate search: freeze the chosen system on development data, then measure it once on the test split.
//   node bench/review5/final.js freeze     writes bench/results/review5-frozen.json (development data only)
//   node bench/review5/final.js test       needs the frozen file and the P3 rewrite run on the test split; checks the file hashes first
// Chosen system "P3+style": z = ( (U - mA)/sA + (logit(styleProb) - mS)/sS ) / 2, flagged when z >= threshold, where U = 100 x share of
// words left unchanged when the model is asked to rewrite the text more concisely (rewrite-dist.js, variant P3, claude-sonnet-5-5), and
// styleProb is the app's style reading (server/checks/style.js, version 3, no model call). mA, sA, mS, sS and the threshold are fitted
// on the fixed 30-text development subset (bench/review5/dev-subset.json) by the rule: highest threshold with the best balanced accuracy
// and no human text flagged.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const L = require('./cand-lib');
const ROOT = path.join(__dirname, '..', '..');
const FROZEN = path.join(L.RESULTS, 'review5-frozen.json');
const FILES = ['bench/review5/final.js', 'bench/review5/cand-lib.js', 'bench/review5/rewrite-dist.js', 'bench/review5/run.js', 'bench/review5/analyze.js', 'bench/review5/dev-subset.json', 'bench/review/lib.js', 'bench/metrics.js', 'server/checks/style.js', 'server/checks/text.js', 'server/llm/index.js', 'server/llm/claudecode.js', 'bench/data/review5/corpus.jsonl', 'bench/results/review5-P3-dev-claude-sonnet-5-5-subset.json', 'bench/results/review5-shipped-all-claude-sonnet-5-5.json'];
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length; const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const SCORE = 'unchanged';
const withZ = (rows, p) => rows.map((r) => ({ ...r, zmix: r[SCORE] == null || r.styleLogit == null ? null : ((r[SCORE] - p.mA) / p.sA + (r.styleLogit - p.mS) / p.sS) / 2 }));

function devRows() {
  const sub = new Set(require('./dev-subset.json').ids);
  const dev = new Map(L.rowsFor('dev').filter((r) => sub.has(r.id)).map((r) => [r.id, r]));
  return L.readJson('review5-P3-dev-claude-sonnet-5-5-subset.json').rows.filter((r) => sub.has(r.id)).map((r) => ({ ...r, styleLogit: dev.get(r.id).styleLogit, styleProb: dev.get(r.id).styleProb, shippedMean: dev.get(r.id).meanRating }));
}
const brief = (m) => ({ balancedAccuracy: m.balancedAccuracy, accuracy: m.accuracy, humanFlagged: m.humanFlagged, caughtAi: m.caught.ai, caughtEdited: m.caught.edited, auroc: m.auroc });

function freeze() {
  if (fs.existsSync(FROZEN)) throw new Error('Already frozen.');
  const rows = devRows();
  const p = { mA: mean(rows.map((r) => r[SCORE])), sA: sd(rows.map((r) => r[SCORE])), mS: mean(rows.map((r) => r.styleLogit)), sS: sd(rows.map((r) => r.styleLogit)) };
  const z = withZ(rows, p); const b = L.pickThreshold(z, 'zmix', 0);
  const shipped = L.measures(rows.map((r) => ({ ...r, meanRating: r.shippedMean })), { score: 'meanRating', threshold: 53.8 });
  const out = {
    frozenAt: new Date().toISOString(), version: 5, system: 'P3+style',
    description: 'z-mix of the unchanged share after a concise-rewrite request (claude-sonnet-5-5) and the logit of the app style reading',
    scoreDefinition: 'z = ((U - mA)/sA + (logit(styleProb) - mS)/sS)/2; U = 100*(1 - wordEditDistance(original, rewrite)/originalWords) with lowercased punctuation-free word tokens; styleProb from server/checks/style.js styleReading; logit clamps p to [0.001, 0.999]; withheld under 80 words or 50 original words',
    params: p, threshold: b.t, rule: 'highest threshold with the best balanced accuracy and 0 of 10 human flagged, on the fixed 30-text development subset',
    development: { subset: 'bench/review5/dev-subset.json (10 human, 15 AI, 5 edited)', chosen: brief(b.m), shippedSameTexts: brief(shipped) },
    rewritePrompt: { variant: 'P3', system: require('./rewrite-dist').SYSTEM, prompt: require('./rewrite-dist').prompt('<text>') },
    sha256: Object.fromEntries(FILES.map((f) => [f, sha(f)])),
  };
  fs.writeFileSync(FROZEN, JSON.stringify(out, null, 1));
  console.log(`frozen: threshold ${b.t}, dev subset balanced ${(100 * b.m.balancedAccuracy).toFixed(1)}%`);
}

function test() {
  const fz = JSON.parse(fs.readFileSync(FROZEN, 'utf8'));
  const changed = Object.entries(fz.sha256).filter(([f, h]) => sha(f) !== h && f !== 'bench/results/review5-shipped-all-claude-sonnet-5-5.json');
  if (changed.length) throw new Error(`Frozen files changed: ${changed.map((x) => x[0]).join(', ')}`);
  const rows = L.rowsFor('test');
  const rw = new Map(L.readJson('review5-P3-test-claude-sonnet-5-5.json').rows.map((r) => [r.id, r]));
  const t = withZ(rows.map((r) => ({ ...r, [SCORE]: rw.has(r.id) ? rw.get(r.id)[SCORE] : null })), fz.params);
  const res = {
    texts: t.length, unscored: t.filter((r) => r.zmix == null).length,
    chosen: L.measures(t, { score: 'zmix', threshold: fz.threshold }),
    shipped: L.measures(t, { score: 'meanRating', threshold: 53.8 }),
    styleAlone: L.measures(t, { score: 'styleProb', threshold: 0.772211 }),
    rewriteAlone: L.measures(t, { score: SCORE, threshold: 9999 }),
    roberta: L.measures(t, { score: 'roberta', threshold: 0.5 }),
  };
  for (const k of ['chosen', 'shipped', 'styleAlone', 'roberta']) console.log(L.line(k, res[k]));
  console.log('rewrite alone AUROC', res.rewriteAlone.auroc.all.toFixed(3), `| chosen AUROC 95% interval ${res.chosen.auroc.allInterval.map((v) => v.toFixed(3)).join('-')}`);
  const c = res.chosen;
  console.log('chosen by writer:', JSON.stringify(Object.fromEntries(Object.entries(c.aiByWriter).map(([k, r]) => [k, `${r.k}/${r.n}`]))), 'by style(AI):', JSON.stringify(Object.fromEntries(Object.entries(c.aiByStyle).map(([k, r]) => [k, `${r.k}/${r.n}`]))));
  console.log('by genre:', JSON.stringify(Object.fromEntries(Object.entries(c.aiByGenre).map(([k, r]) => [k, `${r.k}/${r.n}`]))), 'human by source:', JSON.stringify(Object.fromEntries(Object.entries(c.humanByDomain).map(([k, r]) => [k, `${r.k}/${r.n}`]))));
  console.log('wrong:', c.errors.map((e) => `${e.id}(${e.label},${e.score == null ? '-' : e.score.toFixed(2)})`).join(' '));
  console.log('acc CI', c.accuracy.lo.toFixed(3), c.accuracy.hi.toFixed(3), 'human flagged CI', c.humanFlagged.lo.toFixed(3), c.humanFlagged.hi.toFixed(3));
  fs.writeFileSync(path.join(L.RESULTS, 'review5-test-result.json'), JSON.stringify({ at: new Date().toISOString(), frozenAt: fz.frozenAt, res }, null, 1));
}
({ freeze, test })[process.argv[2]]();
