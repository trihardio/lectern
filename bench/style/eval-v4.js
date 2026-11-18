'use strict';
// Report a style model on the version 6 DEV split (never the holdout): AUROC, AI flagged (all, Claude, by writer), human flagged
// (all, non-native), with Wilson 95% intervals. Compares version 3 on the same texts.
//   node bench/style/eval-v4.js [--model bench/data/style/model-v4.json] [--ship]
// --ship writes server/checks/style-model.json from the model plus these dev numbers (labelled as dev).
const fs = require('fs');
const C = require('./common-v4');
const { S, M } = C;
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const dev = C.loadV6('dev');
function run(label, model, line) {
  const X = C.matrix(dev, model.names);
  const scored = dev.map((r, i) => ({ ...r, score: S.score(model, X[i]) }));
  const rep = C.report(scored, line == null ? model.threshold : line);
  console.log(`\n[${label}] flag line ${rep.line.toFixed(4)} (n: AI ${rep.n.ai}, Claude ${rep.n.claude}, human ${rep.n.human}, non-native ${rep.n.nonNative})`);
  console.log(`  AUROC ${rep.auroc.toFixed(3)} | Claude-only AUROC ${rep.aurocClaude == null ? 'n/a' : rep.aurocClaude.toFixed(3)}`);
  console.log(`  AI flagged ${rep.aiFlagged}\n  Claude flagged ${rep.claudeFlagged}\n  human flagged ${rep.humanFlagged}\n  non-native flagged ${rep.nonNativeFlagged}`);
  for (const [w, v] of Object.entries(rep.byWriter)) console.log(`  by writer ${w}: ${v}`);
  const ed = scored.filter((r) => r.edited); if (ed.length) console.log(`  edited AI flagged ${C.pct(ed.filter((r) => r.score >= rep.line).length, ed.length)}`);
  return { rep, scored };
}
const v3 = JSON.parse(fs.readFileSync(C.ROOT + '/bench/data/style/model-v3.json', 'utf8'));
const v3r = run('version 3 at its own line', v3);
run('version 3 at the dev rule line (same rule as version 4)', v3, C.lowestLine(dev.map((r) => ({ ...r, score: S.score(v3, C.matrix([r], v3.names)[0]) }))));
const v4m = JSON.parse(fs.readFileSync(C.ROOT + '/' + arg('model', 'bench/data/style/model-v4.json'), 'utf8'));
const v4r = run('version 4', v4m);
if (process.argv.includes('--ship')) {
  const r = v4r.rep;
  const shipped = { ...v4m, tested: {
    set: `version 6 DEV split only (not the holdout): ${r.n.ai} AI texts (${r.n.claude} from Claude), ${r.n.human} human texts (${r.n.nonNative} non-native)`,
    split: 'dev', auroc: +r.auroc.toFixed(3), aurocClaude: r.aurocClaude == null ? null : +r.aurocClaude.toFixed(3),
    falsePositive: r.humanFlagged, detection: r.aiFlagged, claudeDetection: r.claudeFlagged, byWriter: r.byWriter,
    nonNativeFalsePositive: arg('toefl', 'not measured') + `; ${r.nonNativeFlagged} of the version 6 dev learner essays (the line was chosen on those texts)`,
    dactylTest: arg('dactyl', 'not measured'),
    nativeStudentFalsePositive: arg('native', 'not measured'), studentEssayAuroc: arg('studentAuroc', 'not measured'),
    version3SameTexts: { auroc: +v3r.rep.auroc.toFixed(3), detection: v3r.rep.aiFlagged, claudeDetection: v3r.rep.claudeFlagged, falsePositive: v3r.rep.humanFlagged, nonNativeFalsePositive: v3r.rep.nonNativeFlagged },
  } };
  fs.writeFileSync(C.ROOT + '/server/checks/style-model.json', JSON.stringify(shipped, null, 1));
  console.log('\nwrote server/checks/style-model.json');
}
