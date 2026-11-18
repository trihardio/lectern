'use strict';
// Risk checks for feature sets on the version 6 DEV split (and train-only cross-validation). Never reads the holdout.
//   node bench/style/risk-v4.js set:l2:v6w [set:l2:v6w ...]
const C = require('./common-v4');
const { S, M } = C;
const base = [...C.loadV3Rows(), ...C.loadV6('train')], dev = C.loadV6('dev');
let train = base, y = null;
function weights(rows, v6w) {
  const cell = {}; rows.forEach((r) => { const k = C.cellOf(r); cell[k] = (cell[k] || 0) + 1; });
  const n = Object.keys(cell).length;
  return rows.map((r) => (rows.length / n / cell[C.cellOf(r)]) * (r.set === 'v6' ? v6w : 1));
}
const paras = (r) => C.T.segment(C.prep(r.text)).paragraphs.length;
const mean = (a) => a.reduce((x, y2) => x + y2, 0) / (a.length || 1);
for (const spec of process.argv.slice(2)) {
  const [set, l2s, w, aug = '1'] = spec.split(':');
  train = aug === '1' ? C.augment(base) : base; y = train.map((r) => (r.label === 'ai' ? 1 : 0)); const names = C.SETS[set]; const l2 = +l2s, v6w = +w;
  const m = S.fit(C.matrix(train, names), y, { l2, weights: weights(train, v6w), iters: 2500, names });
  const Xd = C.matrix(dev, names); const sc = dev.map((r, i) => ({ ...r, score: S.score(m, Xd[i]), paras: paras(r) }));
  const line = C.lowestLine(sc);
  const rep = C.report(sc, line);
  console.log(`\n=== ${spec}  line ${line.toFixed(3)}  AUROC ${rep.auroc.toFixed(3)}  AI ${rep.aiFlagged}  human ${rep.humanFlagged}  nn ${rep.nonNativeFlagged}`);
  const ai = sc.filter((r) => r.label === 'ai'), hum = sc.filter((r) => r.label === 'human');
  for (const o of ['v5', 'new']) { const a = ai.filter((r) => (/^v5-/.test(r.source) ? 'v5' : 'new') === o); console.log(`  AI ${o}: flagged ${C.pct(a.filter((r) => r.score >= line).length, a.length)}, AUROC vs all human ${M.auroc(a.map((r) => r.score), hum.map((r) => r.score)).toFixed(3)}`); }
  for (const src of [...new Set(hum.map((r) => r.source))]) { const h = hum.filter((r) => r.source === src); console.log(`  human ${src.padEnd(28)} n=${String(h.length).padStart(2)} flagged ${h.filter((r) => r.score >= line).length}  AUROC(AI vs it) ${M.auroc(ai.map((r) => r.score), h.map((r) => r.score)).toFixed(3)}  mean p ${mean(h.map((r) => r.score)).toFixed(2)}`); }
  for (const [lab, f] of [['1 paragraph', (r) => r.paras === 1], ['2+ paragraphs', (r) => r.paras >= 2]]) {
    const a = ai.filter(f), h = hum.filter(f);
    console.log(`  ${lab.padEnd(14)} AI n=${a.length} flagged ${a.filter((r) => r.score >= line).length}; human n=${h.length} flagged ${h.filter((r) => r.score >= line).length}; AUROC ${a.length && h.length ? M.auroc(a.map((r) => r.score), h.map((r) => r.score)).toFixed(3) : 'n/a'}`);
  }
  for (const [lab, f] of [['80-150 words', (r) => r.words <= 150], ['151+ words', (r) => r.words > 150]]) {
    const a = ai.filter(f), h = hum.filter(f);
    console.log(`  ${lab.padEnd(14)} AI n=${a.length} flagged ${a.filter((r) => r.score >= line).length}; human n=${h.length} flagged ${h.filter((r) => r.score >= line).length}; AUROC ${a.length && h.length ? M.auroc(a.map((r) => r.score), h.map((r) => r.score)).toFixed(3) : 'n/a'}`);
  }
  const humOnly = C.lowestLine(sc.map((r) => ({ ...r, nonNative: false })));
  const nn = hum.filter((r) => r.nonNative), nat = hum.filter((r) => !r.nonNative);
  console.log(`  nn: at the human-only line (${humOnly.toFixed(3)}) flagged ${nn.filter((r) => r.score >= humOnly).length}/${nn.length}; nn max ${Math.max(...nn.map((r) => r.score)).toFixed(3)}, nn mean ${mean(nn.map((r) => r.score)).toFixed(3)} vs other human mean ${mean(nat.map((r) => r.score)).toFixed(3)}`);
  const tr = new Set(train.map((r) => C.sha(r.text)));
  const toefl = C.readJsonl(C.ROOT + '/bench/data/holdout.jsonl').filter((r) => r.source === 'Liang2023' && r.label === 'human' && /TOEFL/.test(r.writer || '') && !tr.has(C.sha(r.text)));
  const Xt = C.matrix(toefl, names); const ts = toefl.map((r, i) => S.score(m, Xt[i]));
  console.log(`  TOEFL (informational only; old benchmark, not a choice set) flagged at line ${C.pct(ts.filter((s) => s >= line).length, ts.length)}`);
  const g = (r) => parseInt(C.sha(r.group).slice(0, 8), 16) % 5;
  const X = C.matrix(train, names); const oof = [];
  for (let k = 0; k < 5; k++) {
    const tri = train.map((r, i) => (r.set === 'v6' && g(r) === k ? -1 : i)).filter((i) => i >= 0);
    const mk = S.fit(tri.map((i) => X[i]), tri.map((i) => y[i]), { l2, weights: weights(tri.map((i) => train[i]), v6w), iters: 1500, names });
    train.forEach((r, i) => { if (r.set === 'v6' && !r.crop && g(r) === k) oof.push({ ...r, score: S.score(mk, X[i]) }); });
  }
  const ol = C.lowestLine(oof); const orp = C.report(oof, ol);
  console.log(`  CV on v6 train (5 folds by group): AUROC ${orp.auroc.toFixed(3)} line ${ol.toFixed(3)} AI ${orp.aiFlagged} human ${orp.humanFlagged} nn ${orp.nonNativeFlagged}`);
}
