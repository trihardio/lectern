'use strict';
// Round 1 of the version 5 candidate search: free candidates, development split only (no model call).
//   node bench/review5/round1.js
const L = require('./cand-lib');
const rows = L.rowsFor('dev');
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
console.log(`dev texts ${rows.length}; human ${rows.filter((r) => r.label === 'human').length}; no meanRating ${rows.filter((r) => r.meanRating == null).length}; no style ${rows.filter((r) => r.styleProb == null).length}`);

const out = {};
const show = (name, m) => { out[name] = m; console.log(L.line(name, m)); };

const shipped = L.measures(rows, { score: 'meanRating', threshold: 53.8 });
show('shipped (53.8)', shipped);
for (const mh of [0, 1]) { const b = L.pickThreshold(rows, 'meanRating', mh); show(`(a) mean rating, thr re-chosen, <=${mh} human`, b.m); }
show('(b) style alone (0.772211)', L.measures(rows, { score: 'styleProb', threshold: 0.772211 }));

// (c) shipped flag OR style flag
const orRows = rows.map((r) => ({ ...r, orFlag: (r.meanRating != null && r.meanRating >= 53.8) || (r.styleProb != null && r.styleProb >= 0.772211) ? 1 : 0, orScore: Math.max(r.meanRating == null ? -1 : r.meanRating / 100, r.styleProb == null ? -1 : r.styleProb) }));
show('(c) shipped OR style', L.measures(orRows, { score: 'orFlag', threshold: 1 }));

// (d) mean of z-scores (dev mean/sd; style as logit)
const rr = rows.filter((r) => r.meanRating != null);
const mM = mean(rr.map((r) => r.meanRating)); const sM = sd(rr.map((r) => r.meanRating));
const mS = mean(rows.map((r) => r.styleLogit)); const sS = sd(rows.map((r) => r.styleLogit));
const zRows = rows.map((r) => ({ ...r, zmix: r.meanRating == null || r.styleLogit == null ? null : ((r.meanRating - mM) / sM + (r.styleLogit - mS) / sS) / 2 }));
console.log(`z params: mean rating ${mM.toFixed(3)} sd ${sM.toFixed(3)}; style logit ${mS.toFixed(3)} sd ${sS.toFixed(3)}`);
for (const mh of [0, 1]) { const b = L.pickThreshold(zRows, 'zmix', mh); show(`(d) z-mix, <=${mh} human`, b.m); }

console.log('roberta (comparison only, dev, thr 0.5):'); show('roberta 0.5', L.measures(rows, { score: 'roberta', threshold: 0.5 }));
console.log('human texts scores (id meanRating style):', rows.filter((r) => r.label === 'human').map((r) => `${r.id}:${r.meanRating}/${r.styleProb}`).join(' '));
require('fs').writeFileSync(require('path').join(L.RESULTS, 'review5-round1.json'), JSON.stringify({ params: { mM, sM, mS, sS }, out }, null, 1));
