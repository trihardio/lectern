'use strict';
// Train style model version 4. Training data: version 3's sources plus the version 6 TRAIN split only. Features,
// regularisation, the weight of the version 6 cells and the flag line are chosen on the version 6 DEV split only
// (lowest line with at most 5% of human and at most 5% of non-native texts flagged). The holdout is never read.
//   node bench/style/train-v4.js            -> grid, prints a table, writes bench/data/style/model-v4.json (best by the rule)
//   node bench/style/train-v4.js --set all --l2 10 --v6w 4   -> one configuration
const fs = require('fs');
const C = require('./common-v4');
const { S, M } = C;
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };

const SETS = C.SETS;
const AUG = arg('aug', '1') === '1';
const base = [...C.loadV3Rows(), ...C.loadV6('train')];
const train = AUG ? C.augment(base) : base;
const dev = C.loadV6('dev');
console.log('train', train.length, 'augmentation', AUG, '(v3', train.filter((r) => r.set === 'v3').length, ', v6', train.filter((r) => r.set === 'v6').length, ') dev', dev.length,
  'dev human', dev.filter((r) => r.label === 'human').length, 'dev non-native', dev.filter((r) => r.nonNative).length, 'dev claude', dev.filter(C.isClaude).length);
const y = train.map((r) => (r.label === 'ai' ? 1 : 0));

function fitConfig(setName, l2, v6w, iters = 1500) {
  const names = SETS[setName];
  const X = C.matrix(train, names);
  // each (source, label) cell gets the same total weight; version 6 cells are multiplied by v6w
  const cell = {}; train.forEach((r) => { const k = C.cellOf(r); cell[k] = (cell[k] || 0) + 1; });
  const nCells = Object.keys(cell).length;
  const W = train.map((r) => (train.length / nCells / cell[C.cellOf(r)]) * (r.set === 'v6' ? v6w : 1));
  const m = S.fit(X, y, { l2, weights: W, iters, names });
  const Xd = C.matrix(dev, names);
  const scored = dev.map((r, i) => ({ ...r, score: S.score(m, Xd[i]) }));
  const line = C.lowestLine(scored);
  return { m, scored, line, rep: C.report(scored, line) };
}

const one = arg('set');
const grid = one ? [[one, +arg('l2', 10), +arg('v6w', 1)]] : (arg('sets') ? arg('sets').split(',') : Object.keys(SETS)).flatMap((s) => [10, 100, 1000].flatMap((l) => [3, 8, 16].map((w) => [s, l, w])));
let best = null;
for (const [s, l2, v6w] of grid) {
  const { m, line, rep } = fitConfig(s, l2, v6w);
  const caught = +rep.aiFlagged.match(/\((?:[\d.]+)-(?:[\d.]+); (\d+)\//)[1];
  console.log(`${s.padEnd(6)} l2=${String(l2).padEnd(4)} v6w=${v6w} | AUROC ${rep.auroc.toFixed(3)} claudeAUROC ${rep.aurocClaude ? rep.aurocClaude.toFixed(3) : 'n/a'} | line ${line.toFixed(3)} | AI ${rep.aiFlagged} | claude ${rep.claudeFlagged} | human ${rep.humanFlagged} | non-native ${rep.nonNativeFlagged}`);
  const key = [caught, rep.auroc];
  if (!best || key[0] > best.key[0] || (key[0] === best.key[0] && key[1] > best.key[1])) best = { key, s, l2, v6w, m, line, rep };
}
console.log(`\nBEST on dev: ${best.s} l2=${best.l2} v6w=${best.v6w} line ${best.line.toFixed(4)}`);
// final fit with more iterations
const fin = fitConfig(best.s, best.l2, best.v6w, 4000);
console.log('final AUROC', fin.rep.auroc.toFixed(3), 'line', fin.line.toFixed(4), 'AI', fin.rep.aiFlagged, 'human', fin.rep.humanFlagged, 'non-native', fin.rep.nonNativeFlagged);
console.log(fin.m.w.map((w, j) => [fin.m.names[j], w]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 14).map(([k, w]) => `${k} ${w.toFixed(2)}`).join(' | '));
fs.writeFileSync(C.ROOT + '/bench/data/style/' + arg('out', 'model-v4.json'), JSON.stringify({ ...fin.m, version: 4, l2: best.l2, v6Weight: best.v6w, featureSet: best.s, threshold: fin.line,
  trainedOn: (AUG ? 'with length augmentation (copies cut at 80-150 words); ' : '') + 'version 3 sources (bench v1 dev HC3 + RAID, MAGE sample, DACTYL train sample) + version 6 train split; equal weight per source and label, version 6 cells x' + best.v6w,
  trainedAt: new Date().toISOString() }, null, 1));
console.log('wrote bench/data/style/model-v4.json');
