'use strict';
// Apply the instant rules (shared/proofrules.js) to every CWEB line of a split, with no model requests.
//   node bench/grammar/rules.js --split dev     # all of CWEB-G.dev and CWEB-S.dev (6,729 lines)
//   node bench/grammar/rules.js --split test    # all of CWEB-G.test and CWEB-S.test (6,845 lines), run once
// Writes data/full/<split>.{source,ann1,ann2} and data/out/rules-full<split>.hyp; score with
//   bench/grammar/.venv/bin/python bench/grammar/score.py --split full<split> --label rules
const fs = require('fs');
const path = require('path');
const R = require('../../shared/proofrules');
const P = require('../../server/checks/proofread');

const i = process.argv.indexOf('--split');
const split = i === -1 ? 'dev' : process.argv[i + 1];
if (!['dev', 'test'].includes(split)) throw new Error('--split dev or test');
const DIR = path.join(__dirname, 'data');
const read = (name) => fs.readFileSync(path.join(DIR, 'cweb', name), 'utf8').replace(/\n$/, '').split('\n');
const out = { source: [], ann1: [], ann2: [] };
for (const d of ['G', 'S']) for (const k of Object.keys(out)) out[k].push(...read(`CWEB-${d}.${split}.${k}`));
fs.mkdirSync(path.join(DIR, 'full'), { recursive: true });
for (const k of Object.keys(out)) fs.writeFileSync(path.join(DIR, 'full', `full${split}.${k}`), out[k].join('\n') + '\n');
const byRule = {};
const hyp = out.source.map((line) => {
  const found = R.check(line);
  for (const f of found) byRule[f.rule] = (byRule[f.rule] || 0) + 1;
  return P.applySuggestions(line, found);
});
fs.mkdirSync(path.join(DIR, 'out'), { recursive: true });
fs.writeFileSync(path.join(DIR, 'out', `rules-full${split}.hyp`), hyp.join('\n') + '\n');
// Each rule's edits, line by line, so its own precision can be scored too.
fs.writeFileSync(path.join(DIR, 'out', `rules-full${split}.byrule.json`), JSON.stringify(out.source.map((line) => R.check(line).map((f) => [f.rule, f.start, f.end, f.to]))));
console.log(`${split}: ${out.source.length} lines; ${hyp.filter((h, k) => h !== out.source[k]).length} changed; suggestions by rule ${JSON.stringify(byRule)}`);
