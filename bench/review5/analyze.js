'use strict';
// Measures for a version 5 run (bench/PREREGISTRATION.md, version 5). Reads only scores, never texts.
//
//   node bench/review5/analyze.js review5-shipped-all-claude-sonnet-5-5.json                 at the shipped line (53.8)
//   node bench/review5/analyze.js <file> --split test --threshold 50 --score topQuartileMean   another line or score
//   node bench/review5/analyze.js <file> --json                                              machine-readable

const fs = require('fs');
const path = require('path');
const M = require('../metrics');

const RESULTS = path.join(__dirname, '..', 'results');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? fallback : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const load = (f) => JSON.parse(fs.readFileSync(path.isAbsolute(f) || fs.existsSync(f) ? f : path.join(RESULTS, f), 'utf8'));

const rate = (k, n) => { const w = M.wilson(k, n); return { k, n, p: n ? k / n : null, lo: w ? w.lo : null, hi: w ? w.hi : null }; };
const pct = (r) => (r && r.n ? `${r.k}/${r.n} = ${(100 * r.p).toFixed(1)}% (${(100 * r.lo).toFixed(0)}-${(100 * r.hi).toFixed(0)})` : '-');

/** All measures for rows at one line on one score. Texts without a score count as not flagged (and rank lowest). */
function measures(rows, { score = 'meanRating', threshold = 53.8 } = {}) {
  const val = (x) => (x[score] == null ? -1 : x[score]);
  const flagged = (x) => x[score] != null && x[score] >= threshold;
  const human = rows.filter((x) => x.label === 'human');
  const ai = rows.filter((x) => x.label === 'ai');
  const edited = rows.filter((x) => x.label === 'edited');
  const pos = [...ai, ...edited];
  const correct = rows.filter((x) => (x.label === 'human' ? !flagged(x) : flagged(x))).length;
  const tpr = pos.length ? pos.filter(flagged).length / pos.length : null;
  const tnr = human.length ? human.filter((x) => !flagged(x)).length / human.length : null;
  const auc = (p, n) => (p.length && n.length ? M.auroc(p.map(val), n.map(val)) : null);
  const by = (list, key) => {
    const g = {};
    for (const x of list) (g[x[key]] = g[x[key]] || []).push(x);
    return Object.fromEntries(Object.entries(g).sort().map(([k, v]) => [k, rate(v.filter(flagged).length, v.length)]));
  };
  const boot = pos.length && human.length ? M.bootstrap(rows, (s) => {
    const p = s.filter((x) => x.label !== 'human').map(val);
    const n = s.filter((x) => x.label === 'human').map(val);
    return p.length && n.length ? M.auroc(p, n) : null;
  }, { reps: 2000, seed: 5 }) : null;
  return {
    score, threshold, texts: rows.length, unscored: rows.filter((x) => x[score] == null).length,
    accuracy: rate(correct, rows.length),
    balancedAccuracy: tpr == null || tnr == null ? null : +(((tpr + tnr) / 2)).toFixed(4),
    humanFlagged: rate(human.filter(flagged).length, human.length),
    caught: { all: rate(pos.filter(flagged).length, pos.length), ai: rate(ai.filter(flagged).length, ai.length), edited: rate(edited.filter(flagged).length, edited.length) },
    auroc: { all: auc(pos, human), ai: auc(ai, human), edited: auc(edited, human), allInterval: boot ? [boot.lo, boot.hi] : null },
    aiByWriter: by(pos, 'writer'), aiByStyle: by(ai, 'style'), aiByGenre: by(pos, 'genre'), humanByDomain: by(human, 'domain'),
    errors: rows.filter((x) => (x.label === 'human' ? flagged(x) : !flagged(x))).map((x) => ({ id: x.id, label: x.label, style: x.style, score: x[score] == null ? null : x[score], meanRating: x.meanRating, status: x.status }))
      .sort((a, b) => (a.label === b.label ? (b.score ?? -1) - (a.score ?? -1) : a.label < b.label ? -1 : 1)),
  };
}

function print(m, title) {
  console.log(`\n${title}  [score ${m.score} >= ${m.threshold}; ${m.texts} texts, ${m.unscored} without a score]`);
  console.log(`  accuracy           ${pct(m.accuracy)}   balanced ${m.balancedAccuracy == null ? '-' : (100 * m.balancedAccuracy).toFixed(1) + '%'}`);
  console.log(`  human flagged      ${pct(m.humanFlagged)}`);
  console.log(`  caught, AI+edited  ${pct(m.caught.all)}`);
  console.log(`  caught, AI         ${pct(m.caught.ai)}`);
  console.log(`  caught, edited     ${pct(m.caught.edited)}`);
  console.log(`  AUROC all ${m.auroc.all == null ? '-' : m.auroc.all.toFixed(3)} (${m.auroc.allInterval ? m.auroc.allInterval.map((v) => v.toFixed(3)).join('-') : '-'}), AI ${m.auroc.ai == null ? '-' : m.auroc.ai.toFixed(3)}, edited ${m.auroc.edited == null ? '-' : m.auroc.edited.toFixed(3)}`);
  for (const [name, g] of [['by writer (AI+edited)', m.aiByWriter], ['by style (AI)', m.aiByStyle], ['by genre (AI+edited)', m.aiByGenre], ['human by source', m.humanByDomain]]) {
    console.log(`  ${name}: ${Object.entries(g).map(([k, r]) => `${k} ${r.k}/${r.n}`).join(', ')}`);
  }
  console.log(`  wrong: ${m.errors.map((e) => `${e.id} (${e.score == null ? 'no score' : e.score})`).join(', ') || 'none'}`);
}

function main() {
  const file = process.argv[2];
  if (!file || file.startsWith('--')) throw new Error('Name a result file from bench/results.');
  const run = load(file);
  const split = String(arg('split', 'all'));
  const rows = split === 'all' ? run.rows : run.rows.filter((x) => x.split === split);
  const m = measures(rows, { score: String(arg('score', 'meanRating')), threshold: Number(arg('threshold', run.flagAt || 53.8)) });
  if (arg('json', false)) console.log(JSON.stringify(m, null, 1));
  else print(m, `${path.basename(file)} (${split})`);
}

if (require.main === module) main();
module.exports = { measures, print, rate, pct };
