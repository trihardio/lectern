'use strict';
// Compare two labelled runs on the same questions with paired bootstrap 95% intervals (B minus A).
//   node bench/search/compare.js <labelA> <labelB> [--by discipline|source] [--write]
// A is the reference (before), B the change (after). Only questions that are complete in both runs are used.
const fs = require('fs');
const path = require('path');
const { pairedBootstrap, METRICS } = require('./metrics');
const { pct } = require('./report');

const RESULTS = path.join(__dirname, 'results');
const load = (label) => {
  const f = path.join(RESULTS, `${label}.json`);
  if (!fs.existsSync(f)) throw new Error(`No results for label "${label}" (${f}).`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
};

function compare(runA, runB, ids) {
  const rows = {};
  for (const m of METRICS) {
    const a = ids.map((i) => runA.questions[i].metrics[m]);
    const b = ids.map((i) => runB.questions[i].metrics[m]);
    if (a.some((v) => v === null || v === undefined) || b.some((v) => v === null || v === undefined)) continue;
    rows[m] = pairedBootstrap(a, b);
  }
  return rows;
}

function table(title, rows) {
  const L = [`### ${title} (n = ${Object.values(rows)[0] ? Object.values(rows)[0].n : 0})`, '', '| Metric | A | B | B minus A | 95% interval | Resamples where B is not better |', '|---|---|---|---|---|---|'];
  for (const [m, r] of Object.entries(rows)) {
    const f = m === 'mrr' ? (x) => x.toFixed(3) : pct;
    const sign = (x) => (x >= 0 ? '+' : '') + f(x);
    const sig = r.lo > 0 ? ' (B better)' : r.hi < 0 ? ' (B worse)' : '';
    L.push(`| ${m} | ${f(r.meanA)} | ${f(r.meanB)} | ${sign(r.diff)} | ${sign(r.lo)} to ${sign(r.hi)}${sig} | ${(r.pNotBetter * 100).toFixed(1)}% |`);
  }
  return L.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const [la, lb] = argv.filter((x) => !x.startsWith('--') && argv[argv.indexOf(x) - 1] !== '--by');
  if (!la || !lb) throw new Error('Usage: node bench/search/compare.js <labelA> <labelB> [--by discipline|source] [--write]');
  const by = argv.includes('--by') ? argv[argv.indexOf('--by') + 1] : '';
  const A = load(la); const B = load(lb);
  if (A.meta.split !== B.meta.split) throw new Error(`The runs use different splits (${A.meta.split} and ${B.meta.split}).`);
  const both = Object.keys(A.questions).filter((i) => B.questions[i]);
  const ids = both.filter((i) => A.questions[i].complete && B.questions[i].complete);
  const out = [`# Compare ${la} (A) with ${lb} (B)`, '', `Split ${A.meta.split}. Questions in both runs: ${both.length}; complete in both: ${ids.length}${both.length !== ids.length ? ` (${both.length - ids.length} left out for a database error)` : ''}. Only in A: ${Object.keys(A.questions).length - both.length}; only in B: ${Object.keys(B.questions).length - both.length}.`,
    `A: queries ${A.meta.queriesMode}${A.meta.planLabel ? ` (${A.meta.planLabel})` : ''}, code ${A.meta.code.commit}; B: queries ${B.meta.queriesMode}${B.meta.planLabel ? ` (${B.meta.planLabel})` : ''}, code ${B.meta.code.commit}.`, ''];
  if (!ids.length) throw new Error('No question is complete in both runs.');
  out.push(table('All questions', compare(A, B, ids)));
  if (by) {
    for (const v of [...new Set(ids.map((i) => A.questions[i][by]))].sort()) {
      const sub = ids.filter((i) => A.questions[i][by] === v);
      if (sub.length >= 5) out.push('', table(`${by}: ${v}`, compare(A, B, sub)));
    }
  }
  const text = out.join('\n') + '\n';
  console.log(text);
  if (argv.includes('--write')) fs.writeFileSync(path.join(RESULTS, `compare-${la}-vs-${lb}.md`), text);
}

if (require.main === module) { try { main(); } catch (e) { console.error(e.message); process.exit(1); } }
module.exports = { compare };
