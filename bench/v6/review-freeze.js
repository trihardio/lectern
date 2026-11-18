'use strict';
// Writes bench/results/review6-frozen.json (pre-registration "Selection" 5) and checks it before every holdout call.
//   node bench/v6/review-freeze.js write     after the development analysis, before any holdout call
//   node bench/v6/review-freeze.js check     verifies that nothing frozen has changed
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const FILE = path.join(ROOT, 'bench', 'results', 'review6-frozen.json');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');
const FILES = ['server/prompts.js', 'server/checks/aiscore.js', 'server/checks/text.js', 'server/checks/style.js', 'server/checks/style-model.json', 'bench/data/v6/holdout.sha256', 'bench/v6/review-prompts.js'];

function write() {
  if (fs.existsSync(FILE)) throw new Error('review6-frozen.json exists: the freeze is written once.');
  const dev = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'results', 'review6-dev.json'), 'utf8'));
  const best = dev.systems.S3weighted.best;
  const sets = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'data', 'v6', 'review-sets.json'), 'utf8'));
  const frozen = {
    frozenAt: new Date().toISOString(),
    choice: dev.choice,
    headline: { name: 'S3 weighted', formula: `${best.w} * meanRating(S2) + ${+(1 - best.w).toFixed(1)} * styleScore(S1)`, patternWeight: best.w, styleWeight: +(1 - best.w).toFixed(1), flagAt: best.line },
    lines: { S0: 53.8, S1: 50, S2: dev.systems.S2.line, S3: best.line },
    development: { candidates: dev.candidates, gates: dev.gates, styleVersion: dev.styleVersion, reviewSetSize: dev.n.review },
    sha256: Object.fromEntries(FILES.map((f) => [f, sha(f)])),
    reviewSets: { devReviewIdsSha256: crypto.createHash('sha256').update(sets.review.join('\n')).digest('hex') },
    note: 'Written before any holdout call. The S2 development results are in bench/results/review6-dev.json.',
  };
  fs.writeFileSync(FILE, JSON.stringify(frozen, null, 1));
  return frozen;
}
function check() {
  if (!fs.existsSync(FILE)) return { ok: false, why: 'bench/results/review6-frozen.json does not exist: freeze before any holdout call.' };
  const f = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const changed = Object.entries(f.sha256).filter(([k, v]) => sha(k) !== v).map(([k]) => k);
  if (changed.length) return { ok: false, why: `Changed since the freeze: ${changed.join(', ')}.` };
  // every holdout text must still match its recorded hash
  const lines = fs.readFileSync(path.join(ROOT, 'bench', 'data', 'v6', 'holdout.sha256'), 'utf8').trim().split('\n');
  const want = new Map(lines.filter((l) => /^[0-9a-f]{64}  /.test(l)).map((l) => { const [h, id] = l.split(/\s+/); return [id, h]; }));
  const bad = fs.readFileSync(path.join(ROOT, 'bench', 'data', 'v6', 'corpus.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((x) => x.split === 'holdout' && want.get(x.id) !== crypto.createHash('sha256').update(x.text).digest('hex'));
  if (bad.length) return { ok: false, why: `${bad.length} holdout texts do not match holdout.sha256.` };
  return { ok: true, frozen: f };
}
function assertFrozen() { const c = check(); if (!c.ok) throw Object.assign(new Error(c.why), { fatal: true }); return c.frozen; }

if (require.main === module) {
  if (process.argv[2] === 'write') console.log(JSON.stringify(write(), null, 1));
  else { const c = check(); console.log(c.ok ? 'frozen files and holdout hashes match' : c.why); process.exitCode = c.ok ? 0 : 1; }
}
module.exports = { write, check, assertFrozen, FILES };
