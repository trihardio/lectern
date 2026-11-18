'use strict';
// Leave-one-out check of the z-mix candidates on the development subset (free): for each text, z parameters and the threshold
// are re-fitted on the other 29 texts (the same rule: highest threshold with the best balanced accuracy, at most 0 human flagged),
// then the left-out text is judged. Gives an honest estimate of what choosing the threshold on 30 texts costs.
//   node bench/review5/loo.js <result file> unchanged
const L = require('./cand-lib');
const file = process.argv[2]; const score = process.argv[3] || 'unchanged';
const sub = new Set(require('./dev-subset.json').ids);
const dev = new Map(L.rowsFor('dev').filter((r) => sub.has(r.id)).map((r) => [r.id, r]));
const rows = L.readJson(file).rows.filter((r) => sub.has(r.id)).map((r) => ({ ...r, styleLogit: dev.get(r.id).styleLogit, styleProb: dev.get(r.id).styleProb }));
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length; const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
function fit(train, maxHuman) {
  const p = { mA: mean(train.map((r) => r[score])), sA: sd(train.map((r) => r[score])), mS: mean(train.map((r) => r.styleLogit)), sS: sd(train.map((r) => r.styleLogit)) };
  const f = (r) => ((r[score] - p.mA) / p.sA + (r.styleLogit - p.mS) / p.sS) / 2;
  const tr = train.map((r) => ({ ...r, zmix: f(r) }));
  const b = L.pickThreshold(tr, 'zmix', maxHuman);
  return { p, f, t: b.t, m: b.m };
}
const full = fit(rows, 0);
console.log('full-subset fit:', JSON.stringify({ ...full.p, threshold: full.t }), `bal ${(100 * full.m.balancedAccuracy).toFixed(1)}%`);
const zs = rows.map((r) => ({ id: r.id, label: r.label, z: full.f(r) }));
const hmax = Math.max(...zs.filter((x) => x.label === 'human').map((x) => x.z)); const pmins = zs.filter((x) => x.label !== 'human').map((x) => x.z).sort((a, b) => a - b);
console.log(`highest human z ${hmax.toFixed(3)}; lowest 4 positive z ${pmins.slice(0, 4).map((x) => x.toFixed(3)).join(', ')}; missed positives ${zs.filter((x) => x.label !== 'human' && x.z < full.t).map((x) => x.id).join(', ')}`);
const res = rows.map((r) => { const tr = rows.filter((x) => x.id !== r.id); const m = fit(tr, 0); return { label: r.label, flag: m.f(r) >= m.t }; });
const H = res.filter((x) => x.label === 'human'); const P = res.filter((x) => x.label !== 'human');
const tnr = H.filter((x) => !x.flag).length / H.length; const tpr = P.filter((x) => x.flag).length / P.length;
console.log(`leave-one-out: human flagged ${H.filter((x) => x.flag).length}/${H.length}, AI+edited caught ${P.filter((x) => x.flag).length}/${P.length}, balanced ${(100 * (tnr + tpr) / 2).toFixed(1)}%`);
