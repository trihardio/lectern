'use strict';
// Numbers for one split of version 7, from the run files and the style readings (ids, labels and scores only; no text).
//   node bench/v7/review-analyze.js dev       writes bench/results/review7-dev.json
//   node bench/v7/review-analyze.js holdout   writes bench/results/review7-holdout.json (needs the holdout runs; checks the freeze)
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const M = require(path.join(ROOT, 'bench', 'metrics'));
const S = require(path.join(ROOT, 'server', 'checks', 'style'));
const split = process.argv[2];
if (!['dev', 'holdout'].includes(split)) throw new Error('Use dev or holdout.');
if (split === 'holdout') require('./review-freeze').assertFrozen();
const run = (sys) => JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'data', 'v7', 'runs', `${sys}-${split}-claude-sonnet-5-5-r1.result.json`), 'utf8'));
const corpus = fs.readFileSync(path.join(ROOT, 'bench', 'data', 'v7', 'corpus.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((x) => x.split === split);
const byId = Object.fromEntries(corpus.map((x) => [x.id, x]));
const ci = (k, n) => { const w = M.wilson(k, n); return { k, n, rate: n ? +(k / n).toFixed(3) : null, lo: +w.lo.toFixed(3), hi: +w.hi.toFixed(3) }; };
const sys = {};
for (const name of ['b0', 'r1']) { try { sys[name] = run(name); } catch { /* not run */ } }
const out = { split, version: 7, made: new Date().toISOString(), review: {}, style: {}, paired: {} };
const rowsOf = (r) => r.rows.map((x) => ({ ...x, c: byId[x.id] }));
const cells = {
  ai: (x) => x.c.label === 'ai', humanvoice: (x) => x.c.kind === 'humanvoice', rewrite: (x) => x.c.kind === 'rewrite', human: (x) => x.c.label === 'human', nonNative: (x) => x.c.label === 'human' && x.c.nonNative,
};
for (const [name, r] of Object.entries(sys)) {
  const rows = rowsOf(r);
  out.review[name] = { promptSha256: r.promptSha256, flagAt: r.flagAt, scoringVersion: r.scoringVersion, scored: rows.filter((x) => x.meanRating != null).length, texts: rows.length };
  for (const [cn, f] of Object.entries(cells)) { const sel = rows.filter(f); out.review[name][cn] = ci(sel.filter((x) => x.reportFlagged === true).length, sel.length); }
  const ai = rows.filter(cells.ai).map((x) => x.meanRating), hu = rows.filter(cells.human).map((x) => x.meanRating);
  out.review[name].auroc = ai.every((v) => v != null) && hu.every((v) => v != null) ? +M.auroc(ai, hu).toFixed(3) : null;
  out.review[name].flaggedHumanIds = rows.filter((x) => cells.human(x) && x.reportFlagged).map((x) => x.id);
  out.review[name].missedAiIds = rows.filter((x) => cells.ai(x) && x.reportFlagged !== true).map((x) => x.id);
  out.review[name].ratings = Object.fromEntries(rows.map((x) => [x.id, x.meanRating == null ? null : +x.meanRating.toFixed(1)]));
}
if (sys.b0 && sys.r1) {
  const a = Object.fromEntries(sys.b0.rows.map((x) => [x.id, x.reportFlagged === true])), b = Object.fromEntries(sys.r1.rows.map((x) => [x.id, x.reportFlagged === true]));
  for (const [cn, f] of [['ai', (c) => c.label === 'ai'], ['human', (c) => c.label === 'human']]) {
    const ids = Object.keys(a).filter((id) => f(byId[id]));
    out.paired[cn] = { bothFlag: ids.filter((i) => a[i] && b[i]).length, onlyR1: ids.filter((i) => !a[i] && b[i]).length, onlyB0: ids.filter((i) => a[i] && !b[i]).length, neither: ids.filter((i) => !a[i] && !b[i]).length };
  }
}
// style readings: B0 model (shipped), on every text of the split
const b0 = JSON.parse(fs.readFileSync(path.join(__dirname, 'style-model-b0.json'), 'utf8'));
const sty = corpus.map((x) => ({ x, r: S.styleReading(x.text, b0) }));
const sc = {
  ai: (o) => o.x.label === 'ai', humanvoice: (o) => o.x.kind === 'humanvoice', rewrite: (o) => o.x.kind === 'rewrite', human: (o) => o.x.label === 'human', nonNative: (o) => o.x.label === 'human' && o.x.nonNative,
  wikipedia: (o) => o.x.label === 'human' && /wikipedia/.test(o.x.source), student: (o) => o.x.label === 'human' && o.x.genre === 'student-essay',
};
out.style.B0 = { model: 'version 4 either (server/checks/style-model.json at the start of version 7)', texts: corpus.length };
for (const [cn, f] of Object.entries(sc)) { const sel = sty.filter(f); out.style.B0[cn] = ci(sel.filter((o) => o.r && o.r.flagged).length, sel.length); }
const sa = sty.filter(sc.ai).map((o) => (o.r ? o.r.probability : 0)), sh = sty.filter(sc.human).map((o) => (o.r ? o.r.probability : 0));
out.style.B0.auroc = +M.auroc(sa, sh).toFixed(3);
out.style.B0.flaggedHumanIds = sty.filter((o) => sc.human(o) && o.r && o.r.flagged).map((o) => o.x.id);
const file = path.join(ROOT, 'bench', 'results', `review7-${split}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 1));
const p = (c) => `${c.k}/${c.n} (${(100 * c.lo).toFixed(0)}-${(100 * c.hi).toFixed(0)}%)`;
for (const [name, v] of Object.entries(out.review)) console.log(`review ${name}: AI ${p(v.ai)} [humanvoice ${p(v.humanvoice)}, rewrite ${p(v.rewrite)}], human ${p(v.human)}, non-native ${p(v.nonNative)}, AUROC ${v.auroc}`);
console.log('paired', JSON.stringify(out.paired));
console.log(`style B0: AI ${p(out.style.B0.ai)} [humanvoice ${p(out.style.B0.humanvoice)}, rewrite ${p(out.style.B0.rewrite)}], human ${p(out.style.B0.human)} [wikipedia ${p(out.style.B0.wikipedia)}, student ${p(out.style.B0.student)}], non-native ${p(out.style.B0.nonNative)}, AUROC ${out.style.B0.auroc}`);
