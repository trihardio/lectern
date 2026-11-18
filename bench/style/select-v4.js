'use strict';
// Round 2 selection (deviation 7): choose a version 4 configuration under, in this order:
//  (a) version 6 DEV: at most 5% of human and 5% of non-native flagged at the line (the dev rule line);
//  (b) at that line: old TOEFL essays flagged <= 11/86 and Liang native student essays <= 14/209 (version 3's own numbers);
//  (c) at that line: DACTYL test sample AUROC >= 0.85 and AI flagged >= 35.15% (half of version 3's 70.3%).
// Among those that pass: most Claude dev AI flagged; within one text, the fairer one (fewer TOEFL, then native, flags).
// Reads version 6 train and dev only (never the holdout). Writes bench/data/style/select-v4-results.json and the winner to
// bench/data/style/model-v4.json.   node bench/style/select-v4.js [--write]
const fs = require('fs');
const C = require('./common-v4');
const { S, M } = C;

const base = [...C.loadV3Rows(), ...C.loadV6('train')];
const train = C.augment(base);
const dev = C.loadV6('dev');
const y = train.map((r) => (r.label === 'ai' ? 1 : 0));
const trainHash = new Set(base.map((r) => C.sha(r.text)));
const lia = C.readJsonl(C.ROOT + '/bench/data/holdout.jsonl').filter((r) => r.source === 'Liang2023' && r.label === 'human' && !trainHash.has(C.sha(r.text)));
const toefl = lia.filter((r) => /TOEFL/i.test(r.writer || r.domain || ''));
const native = lia.filter((r) => !/TOEFL/i.test(r.writer || r.domain || ''));
const dac = C.readJsonl(C.ROOT + '/bench/data/style/dactyl-test.jsonl').filter((r) => r.label === 'human' || r.label === 'ai');

// feature groups added to the base set. Base ("core") keeps the AI-word lists (strongLexRate, weakLexRate, phraseRate) always.
const CORE = C.SETS.core;
const GROUPS = {
  sent: ['sentLenMean', 'sentLenCV', 'sentLenSD', 'longSentShare', 'lenBand', 'adjDiff', 'lastLenRatio'],
  vocab: ['mattr', 'hapaxRate'],
  word: ['wordLenMean', 'longWordRate', 'nominalRate'],
  entity: ['properRate', 'digitRate', 'parenRate', 'entShare', 'entCV', 'entPerSent'],
};
const gnames = Object.keys(GROUPS);
const SETS = {};
for (let m = 0; m < 1 << gnames.length; m++) {
  const on = gnames.filter((_, i) => m & (1 << i));
  SETS['core' + on.map((g) => '+' + g).join('')] = [...CORE, ...on.flatMap((g) => GROUPS[g])];
}
for (const must of ['strongLexRate', 'weakLexRate', 'phraseRate']) for (const [k, v] of Object.entries(SETS)) if (!v.includes(must)) throw new Error(`${k} lacks ${must}`);

const weights = (v6w, dw) => {
  const cell = {}; train.forEach((r) => { const k = C.cellOf(r); cell[k] = (cell[k] || 0) + 1; });
  const n = Object.keys(cell).length;
  return train.map((r) => (train.length / n / cell[C.cellOf(r)]) * (r.set === 'v6' ? v6w : /^DACTYL/.test(r.source) ? dw : 1));
};
const results = [];
const FINAL = process.argv.includes('--final') ? process.argv[process.argv.indexOf('--final') + 1].split(':') : null; // set:l2:v6w:dw
let finalModel = null;
const only = FINAL ? [FINAL[0]] : process.argv.includes('--sets') ? process.argv[process.argv.indexOf('--sets') + 1].split(',') : Object.keys(SETS);
const argv = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1].split(',').map(Number) : d; };
const L2 = FINAL ? [+FINAL[1]] : argv('l2', [10, 100]), V6W = FINAL ? [+FINAL[2]] : argv('v6w', [1, 3, 8]), DW = FINAL ? [+FINAL[3]] : argv('dw', [1, 4]);
const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'select-v4-results.json';
for (const setName of only) {
  const names = SETS[setName];
  const X = C.matrix(train, names), Xd = C.matrix(dev, names), Xt = C.matrix(toefl, names), Xn = C.matrix(native, names), Xc = C.matrix(dac, names);
  for (const l2 of L2) for (const v6w of V6W) for (const dw of DW) {
    const m = S.fit(X, y, { l2, weights: weights(v6w, dw), iters: 1500, names });
    const sc = dev.map((r, i) => ({ ...r, score: S.score(m, Xd[i]) }));
    const line = C.lowestLine(sc);
    if (FINAL) finalModel = { ...m, version: 4, featureSet: setName, l2, v6Weight: v6w, dactylWeight: dw, threshold: line,
      trainedOn: `length augmentation (copies cut at 80-150 words); version 3 sources (bench v1 dev HC3 + RAID, MAGE sample, DACTYL train sample, DACTYL cells x${dw}) + version 6 train split (cells x${v6w}); equal weight per source and label; chosen by select-v4.js (deviation 7)`, trainedAt: new Date().toISOString() };
    const rep = C.report(sc, line);
    const cnt = (s) => s.filter((r) => r.score >= line).length;
    const ts = toefl.map((_, i) => S.score(m, Xt[i])), ns = native.map((_, i) => S.score(m, Xn[i])), ds = dac.map((r, i) => ({ label: r.label, score: S.score(m, Xc[i]) }));
    const dai = ds.filter((r) => r.label === 'ai'), dhu = ds.filter((r) => r.label === 'human');
    const row = {
      set: setName, l2, v6w, dw, line,
      devAI: cnt(sc.filter((r) => r.label === 'ai')), devAIn: rep.n.ai, devHuman: cnt(sc.filter((r) => r.label === 'human')), devNN: cnt(sc.filter((r) => r.nonNative)), devAuroc: rep.auroc,
      toefl: ts.filter((s) => s >= line).length, toeflN: ts.length, native: ns.filter((s) => s >= line).length, nativeN: ns.length,
      dacAuroc: M.auroc(dai.map((r) => r.score), dhu.map((r) => r.score)), dacAI: dai.filter((r) => r.score >= line).length, dacAIn: dai.length, dacHuman: dhu.filter((r) => r.score >= line).length, dacHn: dhu.length,
    };
    row.passB = row.toefl <= 11 && row.native <= 14;
    row.passC = row.dacAuroc >= 0.85 && row.dacAI / row.dacAIn >= 0.3515;
    results.push(row);
  }
}
if (FINAL) { fs.writeFileSync(C.ROOT + '/bench/data/style/model-v4.json', JSON.stringify(finalModel, null, 1)); console.log('wrote bench/data/style/model-v4.json'); }
else fs.writeFileSync(C.ROOT + '/bench/data/style/' + OUT, JSON.stringify(results, null, 1));
const fmt = (r) => `${r.set.padEnd(26)} l2=${String(r.l2).padEnd(3)} v6w=${r.v6w} dw=${r.dw} line ${r.line.toFixed(3)} | dev AI ${r.devAI}/${r.devAIn} hum ${r.devHuman} nn ${r.devNN} AUROC ${r.devAuroc.toFixed(3)} | TOEFL ${r.toefl}/${r.toeflN} native ${r.native}/${r.nativeN} | DACTYL AUROC ${r.dacAuroc.toFixed(3)} AI ${r.dacAI}/${r.dacAIn} (${(100 * r.dacAI / r.dacAIn).toFixed(1)}%) hum ${r.dacHuman}/${r.dacHn}`;
const ok = results.filter((r) => r.passB && r.passC);
console.log(`${results.length} configurations; pass (b): ${results.filter((r) => r.passB).length}; pass (c): ${results.filter((r) => r.passC).length}; pass both: ${ok.length}`);
if (ok.length) {
  const top = Math.max(...ok.map((r) => r.devAI));
  const near = ok.filter((r) => r.devAI >= top - 1).sort((a, b) => a.toefl - b.toefl || a.native - b.native || b.devAI - a.devAI);
  console.log('\nPASS both (top, within one text of the best dev AI):'); near.slice(0, 12).forEach((r) => console.log(fmt(r)));
}
console.log('\nBest by (c) alone, then (b) (fallback report):');
results.filter((r) => r.passB).sort((a, b) => b.dacAuroc - a.dacAuroc).slice(0, 8).forEach((r) => console.log(fmt(r)));
console.log('\nBest DACTYL AUROC overall:');
results.sort((a, b) => b.dacAuroc - a.dacAuroc).slice(0, 5).forEach((r) => console.log(fmt(r)));
