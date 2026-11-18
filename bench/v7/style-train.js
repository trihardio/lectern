'use strict';
// Style model version 5 (T1), pre-registration "Version 7": the version 4 core model retrained with the version 7 TRAIN split added.
// Everything else is as for version 4 (bench/style/train-v4.js, common-v4.js, select-v4.js): the "core" feature set, length
// augmentation, l2 100, version 6 cells x8 (version 7 texts are weighted as version 6 cells), 4000 iterations. The version 3 part stays
// as it is. The core model's line is chosen on DEV only (v6 dev + v7 dev), as the lowest line at which every human set is at
// or under its version 4 limit, together with the version 3 part at 0.94:
//   v6 + v7 dev human <= 5%, dev non-native <= 5%, TOEFL <= 2 of 86, native student essays <= 3 of 209, DACTYL human <= 2 of 200.
// Never reads the holdout split.
//   node bench/v7/style-train.js --parity    retrain WITHOUT version 7 and compare with the shipped core part (checks this code)
//   node bench/v7/style-train.js             train T1 and print the dev numbers; writes bench/v7/style-model-t1.json (the "either" model)
const fs = require('fs');
const path = require('path');
const C = require('../style/common-v4');
const { S, M, ROOT } = C;
const readJsonl = C.readJsonl;
const DATA = path.join(ROOT, 'bench', 'data', 'v7');

function loadV7(split) {
  if (split !== 'train' && split !== 'dev') throw new Error(`style v5 may only read the v7 train and dev splits, not "${split}"`);
  return readJsonl(path.join(DATA, 'corpus.jsonl')).filter((r) => r.split === split).map((r) => ({
    id: r.id, source: r.label === 'ai' ? 'v7-claude-code' : r.source, label: r.label, words: r.words, group: String(r.group), writer: r.writer || '', genre: r.genre, kind: r.kind, text: r.text,
    nonNative: r.label === 'human' && r.nonNative === true, set: 'v6', origin: 'v7', review: r.review,
  }));
}
const B0 = JSON.parse(fs.readFileSync(path.join(__dirname, 'style-model-b0.json'), 'utf8'));
const B0_V3 = B0.parts.find((p) => p.name === 'v3');
const B0_CORE = B0.parts.find((p) => p.name === 'v4-core');
const L2 = 100, V6W = 8;

function train(rows) {
  const aug = C.augment(rows);
  const names = C.SETS.core;
  const cell = {}; aug.forEach((r) => { const k = C.cellOf(r); cell[k] = (cell[k] || 0) + 1; });
  const nCells = Object.keys(cell).length;
  const W = aug.map((r) => (aug.length / nCells / cell[C.cellOf(r)]) * (r.set === 'v6' ? V6W : 1));
  return S.fit(C.matrix(aug, names), aug.map((r) => (r.label === 'ai' ? 1 : 0)), { l2: L2, weights: W, iters: 4000, names });
}
const sc = (m, rows) => { const X = C.matrix(rows, m.names); return rows.map((r, i) => S.score(m, X[i])); };

function main() {
  const base = [...C.loadV3Rows(), ...C.loadV6('train')];
  if (process.argv.includes('--parity')) {
    const m = train(base);
    const dev = C.loadV6('dev');
    const a = sc(m, dev), b = sc(B0_CORE, dev);
    const maxd = Math.max(...a.map((x, i) => Math.abs(x - b[i])));
    console.log(`parity: max |score difference| of the retrained version 4 core vs the shipped one on ${dev.length} v6 dev texts = ${maxd.toFixed(4)}`);
    return;
  }
  const v7train = loadV7('train');
  const m = train([...base, ...v7train]);
  // dev sets
  const dev = [...C.loadV6('dev'), ...loadV7('dev')];
  const trainHash = new Set([...base, ...v7train].map((r) => C.sha(r.text)));
  const lia = readJsonl(ROOT + '/bench/data/holdout.jsonl').filter((r) => r.source === 'Liang2023' && r.label === 'human' && !trainHash.has(C.sha(r.text)));
  const toefl = lia.filter((r) => /TOEFL/i.test(r.writer || r.domain || '')), native = lia.filter((r) => !/TOEFL/i.test(r.writer || r.domain || ''));
  const dac = readJsonl(ROOT + '/bench/data/style/dactyl-test.jsonl').filter((r) => r.label === 'human' || r.label === 'ai');
  const dacHu = dac.filter((r) => r.label === 'human'), dacAi = dac.filter((r) => r.label === 'ai');
  const lim = { devHuman: 0.05, devNN: 0.05, toefl: 2, native: 3, dacHuman: 2 };
  const v3p = (rows) => sc(B0_V3, rows);
  const flagV3 = (rows) => v3p(rows).map((s) => s >= B0_V3.cut);
  const hum = dev.filter((r) => r.label === 'human'), nn = hum.filter((r) => r.nonNative);
  const sets = { hum, nn, toefl, native, dacHu, dacAi, devAi: dev.filter((r) => r.label === 'ai') };
  const cache = {};
  for (const [k, rows] of Object.entries(sets)) cache[k] = { core: sc(m, rows), v3: flagV3(rows) };
  const count = (k, cut) => cache[k].core.filter((s, i) => s >= cut || cache[k].v3[i]).length;
  const ok = (cut) => count('hum', cut) <= Math.floor(lim.devHuman * hum.length) && count('nn', cut) <= Math.floor(lim.devNN * nn.length) && count('toefl', cut) <= lim.toefl && count('native', cut) <= lim.native && count('dacHu', cut) <= lim.dacHuman;
  let cut = null;
  for (let c = 0.5; c <= 1.0001; c += 0.001) { if (ok(c)) { cut = +c.toFixed(3); break; } }
  if (cut == null) { console.log('No core line satisfies every limit: T1 cannot be built under the rule.'); process.exitCode = 3; return; }
  const model = { ...B0, version: 5, parts: [B0_V3, { ...m, name: 'v4-core', note: 'version 5 core model: the version 4 core retrained with the version 7 train split', cut, version: 5 }] };
  fs.writeFileSync(path.join(__dirname, 'style-model-t1.json'), JSON.stringify(model));
  // report on dev
  const either = (rows) => rows.map((r) => (S.styleReading(r.text, model) || {}).flagged);
  const eitherB0 = (rows) => rows.map((r) => (S.styleReading(r.text, B0) || {}).flagged);
  const rep = (name, rows) => console.log(`${name.padEnd(34)} n=${String(rows.length).padStart(4)}  B0 flagged ${eitherB0(rows).filter(Boolean).length}  T1 flagged ${either(rows).filter(Boolean).length}`);
  console.log(`train rows: base ${base.length} (+ v7 ${v7train.length}: ${v7train.filter((r) => r.label === 'ai').length} AI); core line ${cut} (B0 ${B0_CORE.cut})`);
  const v6dev = C.loadV6('dev'), v7dev = loadV7('dev');
  rep('v6 dev Claude AI', v6dev.filter(C.isClaude)); rep('v6 dev human', v6dev.filter((r) => r.label === 'human')); rep('v6 dev non-native', v6dev.filter((r) => r.nonNative));
  rep('v7 dev AI (all)', v7dev.filter((r) => r.label === 'ai'));
  for (const kd of ['humanvoice', 'rewrite']) rep(`v7 dev AI ${kd}`, v7dev.filter((r) => r.label === 'ai' && r.kind === kd));
  rep('v7 dev human', v7dev.filter((r) => r.label === 'human')); rep('v7 dev human non-native', v7dev.filter((r) => r.nonNative));
  rep('TOEFL', toefl); rep('native student essays', native); rep('DACTYL human', dacHu); rep('DACTYL AI', dacAi);
  console.log('AUROC dev (v7 AI vs v7 human): T1 core', M.auroc(sc(m, v7dev.filter((r) => r.label === 'ai')), sc(m, v7dev.filter((r) => r.label === 'human'))).toFixed(3), 'B0 core', M.auroc(sc(B0_CORE, v7dev.filter((r) => r.label === 'ai')), sc(B0_CORE, v7dev.filter((r) => r.label === 'human'))).toFixed(3));
}
main();
