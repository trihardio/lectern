'use strict';
// Style reading (free, no model) of the version 7 texts with a given style model file. Writes ids and scores only.
//   node bench/v7/style-read.js --model bench/v7/style-model-b0.json --splits train,dev --out bench/data/v7/style-b0-traindev.json
// The holdout split is refused unless bench/results/review7-frozen.json exists and matches (the freeze is checked).
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const S = require(path.join(ROOT, 'server', 'checks', 'style'));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i === -1 ? d : process.argv[i + 1]; };

function read(modelFile, splits) {
  if (splits.includes('holdout')) require('./review-freeze').assertFrozen();
  const model = JSON.parse(fs.readFileSync(path.resolve(ROOT, modelFile), 'utf8'));
  const corpus = fs.readFileSync(path.join(ROOT, 'bench', 'data', 'v7', 'corpus.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((x) => splits.includes(x.split));
  return corpus.map((x) => { const r = S.styleReading(x.text, model); return { id: x.id, label: x.label, kind: x.kind || null, genre: x.genre, nonNative: x.nonNative, split: x.split, words: x.words, review: x.review, score: r ? r.probability : null, flagged: r ? r.flagged : null, parts: r && r.parts ? r.parts.map((p) => ({ name: p.name, p: p.probability, flagged: p.flagged })) : null }; });
}
if (require.main === module) {
  const rows = read(arg('model'), String(arg('splits', 'train,dev')).split(','));
  const out = arg('out');
  if (out) fs.writeFileSync(path.resolve(ROOT, out), JSON.stringify(rows));
  const by = {};
  for (const r of rows) { const k = `${r.split}:${r.label === 'ai' ? r.kind : 'human'}`; const b = by[k] || (by[k] = { n: 0, flagged: 0 }); b.n++; if (r.flagged) b.flagged++; }
  console.log(JSON.stringify(by));
}
module.exports = { read };
