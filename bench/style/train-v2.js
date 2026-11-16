'use strict';
const path = require('path');
// Cross-validate on the v1 development split (by group), pick L2, train, freeze the threshold. Never reads a holdout.
const fs = require('fs'); const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const S = require(ROOT + '/server/checks/style');
const M = require(ROOT + '/bench/metrics');
const T = require(ROOT + '/server/checks/text');
const read = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse);
const dev = read(ROOT + '/bench/data/dev.jsonl').filter((r) => r.label === 'human' || r.label === 'ai');
const prep = (r) => S.transform(S.features(T.capWords(T.normalizeText(r.text)).text));
const X = dev.map(prep); const y = dev.map((r) => (r.label === 'ai' ? 1 : 0));
const nh = y.filter((v) => !v).length, na = y.length - nh;
const W = y.map((v) => (v ? 0.5 / na : 0.5 / nh) * y.length); // balance classes
const fold = (g) => parseInt(crypto.createHash('sha1').update(g).digest('hex').slice(0, 8), 16) % 5;
const folds = dev.map((r) => fold(r.group));
for (const l2 of [0.1, 1, 10, 50]) {
  const pos = [], neg = [];
  for (let k = 0; k < 5; k++) {
    const tr = folds.map((f, i) => (f !== k ? i : -1)).filter((i) => i >= 0);
    const te = folds.map((f, i) => (f === k ? i : -1)).filter((i) => i >= 0);
    const m = S.fit(tr.map((i) => X[i]), tr.map((i) => y[i]), { l2, weights: tr.map((i) => W[i]), iters: 1500 });
    for (const i of te) (y[i] ? pos : neg).push(S.score(m, X[i]));
  }
  console.log(`l2=${l2} cv AUROC=${M.auroc(pos, neg).toFixed(3)}`);
}
const L2 = Number(process.argv[2] || 1);
const model = S.fit(X, y, { l2: L2, weights: W, iters: 3000 });
const humanScores = dev.map((r, i) => (y[i] ? null : S.score(model, X[i]))).filter((v) => v != null);
const threshold = M.thresholdForFpr(humanScores, 0.05);
const order = model.w.map((w, j) => [S.NAMES[j], w]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
console.log('chosen l2', L2, 'threshold (dev FPR<=5%)', threshold);
console.log(order.map(([k, w]) => `${k} ${w.toFixed(2)}`).join(' | '));
fs.writeFileSync(path.join(ROOT, 'bench/data/style/model-v2.json'), JSON.stringify({ ...model, l2: L2, threshold, trainedOn: 'bench v1 dev split (HC3 + RAID), class-balanced', trainedAt: new Date().toISOString() }, null, 1));
