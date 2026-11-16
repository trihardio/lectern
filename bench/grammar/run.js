'use strict';
// Run Lectern's proofreader (server/checks/proofread.js, exactly as the app runs it) on a CWEB sample.
//   node bench/grammar/run.js --split dev --dry                      # how many requests it would send; sends nothing
//   node bench/grammar/run.js --split dev --label v1 --yes-spend     # USES MODEL CREDITS: one request per part
// Options: --model <id> (default claude-opus-5-5), --engine claude-code, --variant auto.
// Writes data/out/<label>-<split>.hyp (one corrected line per source line) and .json (suggestions, provenance).
// Score it with: bench/grammar/.venv/bin/python bench/grammar/score.py --split <split> --label <label>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Config } = require('../../server/config');
const P = require('../../server/checks/proofread');

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? fallback : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const split = arg('split', 'dev');
const label = arg('label', 'v1');
const engine = arg('engine', 'claude-code');
const model = arg('model', 'claude-opus-5-5');
const variant = arg('variant', 'auto');
const DIR = path.join(__dirname, 'data');

const limit = Number(arg('limit', 0)) || 0; // a smoke test on the first N lines (scored files are only written for full runs)
const lines = fs.readFileSync(path.join(DIR, 'sample', `${split}.source`), 'utf8').replace(/\n$/, '').split('\n').slice(0, limit || undefined);
const text = lines.join('\n\n'); // one paragraph per line, so every suggestion maps back to its line
const units = P.unitsOf(text);
const parts = P.batches(units);
console.log(`${split}: ${lines.length} lines, ${units.length} sentences, ${parts.length} requests at ${P.PROOF.batchUnits} sentences / ${P.PROOF.batchChars} characters each`);
if (arg('dry', false)) process.exit(0);
if (!arg('yes-spend', false)) { console.log('Add --yes-spend to send these requests (they use your plan).'); process.exit(1); }

(async () => {
  const config = new Config(fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-grammar-')));
  config.update({ bins: { claude: arg('claude-bin', path.join(os.homedir(), '.local', 'bin', 'claude')), codex: '/nonexistent/codex' } });
  const t0 = Date.now();
  const r = await P.runProofread({
    text, config, engine, selectedModel: model, variant, useCache: false,
    emit: (e, d) => { if (e === 'step' && d.detail) process.stdout.write(`\r${d.detail}        `); if (e === 'notice') console.log(`\n${d.text}`); },
  });
  console.log(`\nfinished in ${((Date.now() - t0) / 1000).toFixed(0)} s; ${r.suggestions.length} suggestions; dropped ${JSON.stringify(r.dropped)}`);
  const hyp = P.applySuggestions(text, r.suggestions).split('\n\n');
  if (hyp.length !== lines.length) throw new Error(`corrected text has ${hyp.length} lines, expected ${lines.length}`);
  fs.mkdirSync(path.join(DIR, 'out'), { recursive: true });
  if (limit) {
    const shown = r.suggestions.map((s) => `  ${JSON.stringify(s.from)} -> ${JSON.stringify(s.to)} [${s.kind}${s.type ? ' ' + s.type : ''}] ${s.why}`);
    console.log(`smoke test (${limit} lines), not scored:\n${shown.join('\n') || '  no suggestions'}`);
    fs.writeFileSync(path.join(DIR, 'out', `smoke-${label}-${split}.json`), JSON.stringify(r, null, 1));
    return;
  }
  fs.writeFileSync(path.join(DIR, 'out', `${label}-${split}.hyp`), hyp.join('\n') + '\n');
  fs.writeFileSync(path.join(DIR, 'out', `${label}-${split}.json`), JSON.stringify({ split, label, model, engine, variant, requests: r.provenance.batches.length, result: r }, null, 1));
  const failed = r.provenance.batches.filter((b) => b.status !== 'complete');
  console.log(`requests: ${r.provenance.batches.length}; not complete: ${failed.length}; reported models: ${r.provenance.reportedModels.join(', ')}; mean seconds per request: ${(r.provenance.batches.reduce((s, b) => s + b.ms, 0) / r.provenance.batches.length / 1000).toFixed(1)}`);
})().catch((e) => { console.error('\n' + e.message); process.exit(1); });
