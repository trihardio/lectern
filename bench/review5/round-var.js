'use strict';
// Measures of one paid variant on the fixed development subset, next to the shipped review and the style reading on the same texts.
//   node bench/review5/round-var.js <result file> [score]      (default score meanRating)
const L = require('./cand-lib');
const file = process.argv[2]; const score = process.argv[3] || 'meanRating';
const sub = new Set(require('./dev-subset.json').ids);
const dev = L.rowsFor('dev').filter((r) => sub.has(r.id));
const byId = new Map(dev.map((r) => [r.id, r]));
const run = L.readJson(file).rows.filter((r) => sub.has(r.id));
const rows = run.map((r) => ({ ...r, ...{ styleProb: byId.get(r.id).styleProb, styleLogit: byId.get(r.id).styleLogit, shippedMean: byId.get(r.id).meanRating } }));
console.log(`texts ${rows.length}, scored ${rows.filter((r) => r[score] != null).length}`);
console.log(L.line('shipped @53.8', L.measures(dev, { score: 'meanRating', threshold: 53.8 })));
console.log(L.line('shipped AUROC only', L.measures(dev, { score: 'meanRating', threshold: 9999 })).replace(/\|.*\| AUROC/, '| AUROC'));
console.log(L.line('style @0.772', L.measures(dev, { score: 'styleProb', threshold: 0.772211 })));
console.log(L.line(`variant @53.8`, L.measures(rows, { score, threshold: 53.8 })));
for (const mh of [0, 1]) { const b = L.pickThreshold(rows, score, mh); console.log(L.line(`variant best thr, <=${mh} human of 10`, b.m)); }
const v = rows.filter((r) => r[score] != null); const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length; const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const mA = mean(v.map((r) => r[score])); const sA = sd(v.map((r) => r[score])); const mS = mean(v.map((r) => r.styleLogit)); const sS = sd(v.map((r) => r.styleLogit));
const z = rows.map((r) => ({ ...r, zmix: ((r[score] - mA) / sA + (r.styleLogit - mS) / sS) / 2 }));
const b = L.pickThreshold(z, 'zmix', 0); console.log(L.line('variant+style z-mix, <=0 human', b.m));
const lab = (l) => rows.filter((r) => r.label === l).map((r) => r[score]).sort((x, y) => x - y);
console.log('means by label:', ['human', 'ai', 'edited'].map((l) => `${l} ${mean(lab(l)).toFixed(1)}`).join(', '), '| shipped:', ['human', 'ai', 'edited'].map((l) => `${l} ${mean(dev.filter((r) => r.label === l).map((r) => r.meanRating)).toFixed(1)}`).join(', '));
