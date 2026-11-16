'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
const S = require(ROOT + '/server/checks/style'); const M = require(ROOT + '/bench/metrics'); const T = require(ROOT + '/server/checks/text');
const { measure } = require(ROOT + '/server/checks/aiscore');
const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/data/style/model-v3.json'), 'utf8'));
const V1 = JSON.parse(fs.readFileSync(ROOT + '/bench/results/frozen-measured.json', 'utf8')).threshold;
const pct = (k, n) => { if (!n) return '–'; const { lo, hi } = M.wilson(k, n); return `${(100 * k / n).toFixed(1)}% (${(100 * lo).toFixed(1)}–${(100 * hi).toFixed(1)})`; };
const rows = fs.readFileSync(path.join(ROOT, 'bench/data/style/dactyl-test.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).map((r) => {
  const t = T.capWords(T.normalizeText(r.text)).text;
  return { ...r, v3: S.score(model, S.transform(S.features(t))), v1: measure(t).readings.docSignal };
});
const rep = (label, items) => {
  const hum = items.filter((r) => r.label === 'human'), ai = items.filter((r) => r.label === 'ai');
  const line = (sys, thr) => `${sys}: FPR ${pct(hum.filter((r) => r[sys] >= thr).length, hum.length)} | detect ${pct(ai.filter((r) => r[sys] >= thr).length, ai.length)} | AUROC ${hum.length && ai.length ? M.auroc(ai.map((r) => r[sys]), hum.map((r) => r[sys])).toFixed(3) : '–'}`;
  console.log(`[${label}] human ${hum.length}, ai ${ai.length}\n   ${line('v1', V1)}\n   ${line('v3', model.threshold)}`);
};
rep('DACTYL test, all', rows);
const hum = rows.filter((r) => r.label === 'human');
for (const m of [...new Set(rows.filter((r) => r.label === 'ai').map((r) => r.model))].sort()) rep(`model ${m}`, [...hum, ...rows.filter((r) => r.model === m)]);
for (const d of [...new Set(rows.map((r) => r.domain))].sort()) rep(`domain ${d}`, rows.filter((r) => r.domain === d));
fs.writeFileSync(path.join(ROOT, 'bench/results/style-v3-dactyl-scores.json'), JSON.stringify(rows.map(({ text, ...r }) => r)));
