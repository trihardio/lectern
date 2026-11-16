'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
const S = require(ROOT + '/server/checks/style'); const M = require(ROOT + '/bench/metrics'); const T = require(ROOT + '/server/checks/text');
const { measure } = require(ROOT + '/server/checks/aiscore');
const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/data/style/model-v2.json'), 'utf8'));
const V1 = JSON.parse(fs.readFileSync(ROOT + '/bench/results/frozen-measured.json', 'utf8')).threshold;
const read = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse);
const pct = (k, n) => { if (!n) return "–"; const { lo, hi } = M.wilson(k, n); return `${(100 * k / Math.max(1, n)).toFixed(1)}% (${(100 * lo).toFixed(1)}–${(100 * hi).toFixed(1)})`; };
function run(name, rows) {
  const scored = rows.map((r) => {
    const t = T.capWords(T.normalizeText(r.text)).text;
    return { ...r, v2: S.score(model, S.transform(S.features(t))), v1: measure(t).readings.docSignal };
  });
  const report = (label, items) => {
    const hum = items.filter((r) => r.label === 'human'), ai = items.filter((r) => r.label === 'ai'), mix = items.filter((r) => r.label === 'mixed');
    const line = (sys, thr) => {
      const fp = hum.filter((r) => r[sys] >= thr).length, tp = ai.filter((r) => r[sys] >= thr).length;
      const au = hum.length && ai.length ? M.auroc(ai.map((r) => r[sys]), hum.map((r) => r[sys])).toFixed(3) : '–';
      return `${sys}: FPR ${pct(fp, hum.length)} | detect ${pct(tp, ai.length)} | AUROC ${au}${mix.length ? ` | mixed flagged ${pct(mix.filter((r) => r[sys] >= thr).length, mix.length)}` : ''}`;
    };
    console.log(`  [${label}] human ${hum.length}, ai ${ai.length}${mix.length ? `, mixed ${mix.length}` : ''}`);
    console.log('    ' + line('v1', V1));
    console.log('    ' + line('v2', model.threshold));
  };
  console.log(`== ${name}`);
  report('all', scored);
  const by = (key) => { const g = {}; for (const r of scored) (g[key(r)] ||= []).push(r); return g; };
  return { scored, by, report };
}
const mage = run('MAGE (primary, fresh)', read(path.join(ROOT, 'bench/data/style/mage.jsonl')));
// by domain (src prefix) and generator family
const dom = mage.by((r) => r.src.split('_')[0]);
for (const [k, v] of Object.entries(dom).sort()) mage.report(`domain ${k}`, v);
const gen = mage.by((r) => (r.label === 'human' ? 'human' : (r.src.match(/(gpt-3\.5-trubo|gpt-3\.5|text-davinci-00\d|gpt_j|gpt-j|opt_\w+|llama_\w+|flan_t5_\w+|GLM130B|bloom_\w+|t0_\w+|neox|gpt-4)/i) || ['other'])[0].toLowerCase().replace(/_\d+b$|_\w+$/, '')));
const humans = gen.human || [];
for (const [k, v] of Object.entries(gen).sort()) if (k !== 'human') mage.report(`generator ${k}`, [...v, ...humans]);
const hold = run('v1 holdout (secondary, seen before for v1 only)', read(ROOT + '/bench/data/holdout.jsonl'));
const bs = hold.by((r) => r.source);
for (const [k, v] of Object.entries(bs).sort()) hold.report(`source ${k}`, v);
fs.writeFileSync(path.join(ROOT, 'bench/results/style-v2-scores.json'), JSON.stringify({ mage: mage.scored.map(({ text, ...r }) => r), holdout: hold.scored.map(({ text, ...r }) => r) }));
