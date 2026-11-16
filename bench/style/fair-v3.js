'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
const S = require(ROOT + '/server/checks/style'); const M = require(ROOT + '/bench/metrics'); const T = require(ROOT + '/server/checks/text');
const { measure } = require(ROOT + '/server/checks/aiscore');
const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/data/style/model-v3.json'), 'utf8'));
const V1 = JSON.parse(fs.readFileSync(ROOT + '/bench/results/frozen-measured.json', 'utf8')).threshold;
const rows = fs.readFileSync(ROOT + '/bench/data/holdout.jsonl', 'utf8').trim().split('\n').map(JSON.parse).filter((r) => r.source === 'Liang2023');
const pct = (k, n) => { if (!n) return '–'; const { lo, hi } = M.wilson(k, n); return `${(100 * k / n).toFixed(1)}% (${(100 * lo).toFixed(1)}–${(100 * hi).toFixed(1)})`; };
const g = {};
for (const r of rows) { const t = T.capWords(T.normalizeText(r.text)).text; const k = `${r.label}|${r.writer || r.group.split(':')[1] || ''}`; (g[k] ||= []).push({ v3: S.score(model, S.transform(S.features(t))), v1: measure(t).readings.docSignal }); }
console.log(Object.keys(rows[0]).join(','));
for (const [k, v] of Object.entries(g)) console.log(k.padEnd(28), 'n', v.length, '| v1 flagged', pct(v.filter((x) => x.v1 >= V1).length, v.length), '| v3 flagged', pct(v.filter((x) => x.v3 >= model.threshold).length, v.length));
