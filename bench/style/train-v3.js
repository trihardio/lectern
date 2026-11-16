'use strict';
const path = require('path');
const fs = require('fs'); const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const S = require(ROOT + '/server/checks/style'); const M = require(ROOT + '/bench/metrics'); const T = require(ROOT + '/server/checks/text');
const read = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse);
const rows = [...read(ROOT + '/bench/data/dev.jsonl'), ...read(path.join(ROOT, 'bench/data/style/mage.jsonl')), ...read(path.join(ROOT, 'bench/data/style/dactyl-train.jsonl'))].filter((r) => r.label === 'human' || r.label === 'ai');
const X = rows.map((r) => S.transform(S.features(T.capWords(T.normalizeText(r.text)).text)));
const y = rows.map((r) => (r.label === 'ai' ? 1 : 0));
// each (source, label) cell gets the same total weight, so no dataset or class dominates
const cell = {}; rows.forEach((r) => { const k = `${r.source}|${r.label}`; cell[k] = (cell[k] || 0) + 1; });
const nCells = Object.keys(cell).length;
const W = rows.map((r) => rows.length / nCells / cell[`${r.source}|${r.label}`]);
const fold = (g) => parseInt(crypto.createHash('sha1').update(g).digest('hex').slice(0, 8), 16) % 5;
const folds = rows.map((r) => fold(r.group));
let best = null;
for (const l2 of [1, 10, 100]) {
  const pos = [], neg = [];
  for (let k = 0; k < 5; k++) {
    const tr = folds.map((f, i) => (f !== k ? i : -1)).filter((i) => i >= 0);
    const te = folds.map((f, i) => (f === k ? i : -1)).filter((i) => i >= 0);
    const m = S.fit(tr.map((i) => X[i]), tr.map((i) => y[i]), { l2, weights: tr.map((i) => W[i]), iters: 1500 });
    for (const i of te) (y[i] ? pos : neg).push(S.score(m, X[i]));
  }
  const a = M.auroc(pos, neg); console.log(`l2=${l2} cv AUROC=${a.toFixed(3)}`);
  if (!best || a > best.a) best = { l2, a };
}
const model = S.fit(X, y, { l2: best.l2, weights: W, iters: 3000 });
const threshold = M.thresholdForFpr(rows.map((r, i) => (y[i] ? null : S.score(model, X[i]))).filter((v) => v != null), 0.05);
console.log('l2', best.l2, 'threshold', threshold.toFixed(4), 'train rows', rows.length, JSON.stringify(cell));
console.log(model.w.map((w, j) => [S.NAMES[j], w]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 12).map(([k, w]) => `${k} ${w.toFixed(2)}`).join(' | '));
fs.writeFileSync(path.join(ROOT, 'bench/data/style/model-v3.json'), JSON.stringify({ ...model, l2: best.l2, threshold, cvAuroc: best.a, trainedOn: 'bench v1 dev (HC3, RAID) + MAGE sample + DACTYL train sample; equal weight per source and label', trainedAt: new Date().toISOString() }, null, 1));
