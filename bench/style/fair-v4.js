'use strict';
// Fairness check for a style model: how often it flags non-native writers' texts.
//  1. version 6 DEV non-native texts (the choice set: the line was picked so at most 5% are flagged).
//  2. Liang et al. TOEFL essays and native student essays from bench v1 holdout (the set version 3's own fairness test used:
//     13.3% of 90 TOEFL essays). Informational only, never used to choose anything. Any text that is also in the version 6
//     train split (same text hash) is left out, so the check is not on texts the model learned.
//   node bench/style/fair-v4.js [--model bench/data/style/model-v4.json]
const fs = require('fs');
const C = require('./common-v4');
const { S } = C;
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const v4 = JSON.parse(fs.readFileSync(C.ROOT + '/' + arg('model', 'bench/data/style/model-v4.json'), 'utf8'));
const v3 = JSON.parse(fs.readFileSync(C.ROOT + '/bench/data/style/model-v3.json', 'utf8'));
const trainHashes = new Set(C.loadV6('train').map((r) => C.sha(r.text)));
const lia = C.readJsonl(C.ROOT + '/bench/data/holdout.jsonl').filter((r) => r.source === 'Liang2023' && r.label === 'human');
const keep = lia.filter((r) => !trainHashes.has(C.sha(r.text)));
console.log(`Liang human essays ${lia.length}; ${lia.length - keep.length} also in the version 6 train split (left out)`);
const sets = [['v6 dev non-native', C.loadV6('dev').filter((r) => r.label === 'human' && r.nonNative)],
  ['v6 dev native human', C.loadV6('dev').filter((r) => r.label === 'human' && !r.nonNative)],
  ['Liang TOEFL (non-native)', keep.filter((r) => /TOEFL/i.test(r.writer || r.domain || ''))],
  ['Liang native student essays', keep.filter((r) => !/TOEFL/i.test(r.writer || r.domain || ''))]];
for (const [name, rows] of sets) {
  const f = (model) => { const X = C.matrix(rows, model.names); return rows.filter((r, i) => S.score(model, X[i]) >= model.threshold).length; };
  console.log(name.padEnd(30), 'v3 flagged', C.pct(f(v3), rows.length), '| v4 flagged', C.pct(f(v4), rows.length));
}

// DACTYL test sample (2024-25 models; version 3's own test set). Informational: it is not a choice set, but version 3 was tested on it.
{
  const rows = C.readJsonl(C.ROOT + '/bench/data/style/dactyl-test.jsonl').filter((r) => r.label === 'human' || r.label === 'ai');
  const M = C.M;
  const rep = (label, items) => {
    const out = [];
    for (const [nm, model] of [['v3', v3], ['v4', v4]]) {
      const X = C.matrix(items, model.names); const sc = items.map((r, i) => ({ label: r.label, s: S.score(model, X[i]) }));
      const ai = sc.filter((r) => r.label === 'ai'), hu = sc.filter((r) => r.label === 'human');
      out.push(`${nm}: AUROC ${M.auroc(ai.map((r) => r.s), hu.map((r) => r.s)).toFixed(3)}, AI flagged ${C.pct(ai.filter((r) => r.s >= model.threshold).length, ai.length)}, human flagged ${C.pct(hu.filter((r) => r.s >= model.threshold).length, hu.length)}`);
    }
    console.log(`DACTYL test ${label}: ${out.join(' | ')}`);
  };
  rep('all', rows);
  rep('student essays', rows.filter((r) => /student/i.test(r.domain)));
}
