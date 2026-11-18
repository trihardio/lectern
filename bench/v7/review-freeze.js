'use strict';
// Writes bench/results/review7-frozen.json (pre-registration "Version 7") and checks it before every holdout call.
//   node bench/v7/review-freeze.js write '<json of the choices made on dev>'   after the development analysis, before any holdout call
//   node bench/v7/review-freeze.js check                                       verifies that nothing frozen has changed
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const FILE = path.join(ROOT, 'bench', 'results', 'review7-frozen.json');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');
const FILES = ['server/prompts.js', 'server/checks/aiscore.js', 'server/checks/style.js', 'server/checks/style-model.json', 'bench/data/v7/holdout.sha256', 'bench/v7/review-b0.txt', 'bench/v7/review-prompts.js', 'bench/v7/style-model-b0.json'];
const OPTIONAL = ['bench/v7/review-r1.txt', 'bench/v7/style-model-t1.json']; // present only when a revision was written

const files = () => [...FILES, ...OPTIONAL.filter((f) => fs.existsSync(path.join(ROOT, f)))];

function write(choice) {
  if (fs.existsSync(FILE)) throw new Error('review7-frozen.json exists: the freeze is written once.');
  const frozen = { frozenAt: new Date().toISOString(), choice, sha256: Object.fromEntries(files().map((f) => [f, sha(f)])), note: 'Written before any holdout call (review or style).' };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(frozen, null, 1));
  return frozen;
}
function check() {
  if (!fs.existsSync(FILE)) return { ok: false, why: 'bench/results/review7-frozen.json does not exist: freeze before any holdout call.' };
  const f = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const changed = Object.entries(f.sha256).filter(([k, v]) => !fs.existsSync(path.join(ROOT, k)) || sha(k) !== v).map(([k]) => k);
  if (changed.length) return { ok: false, why: `Changed since the freeze: ${changed.join(', ')}.` };
  const c = require('./split').checkHoldout();
  if (!c.ok) return { ok: false, why: c.why };
  return { ok: true, frozen: f };
}
function assertFrozen() { const c = check(); if (!c.ok) throw Object.assign(new Error(c.why), { fatal: true }); return c.frozen; }

if (require.main === module) {
  if (process.argv[2] === 'write') console.log(JSON.stringify(write(JSON.parse(process.argv[3] || '{}')), null, 1));
  else { const c = check(); console.log(c.ok ? 'frozen files and holdout hashes match' : c.why); process.exitCode = c.ok ? 0 : 1; }
}
module.exports = { write, check, assertFrozen, FILES };
