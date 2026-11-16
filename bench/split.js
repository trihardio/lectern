'use strict';
// Split the sample into a development set and an independent holdout.
//
//   node bench/split.js   -> bench/data/dev.jsonl, bench/data/holdout.jsonl, bench/data/splits.json (ids only)
//
// Rules (see PREREGISTRATION.md):
// - Split by GROUP, never by document: an HC3 question (its human and ChatGPT answers), a RAID source title (the
//   human text and every generation and attack made from it) and each Liang essay stay on one side.
// - The Liang et al. set (non-native TOEFL essays, their GPT-4 polished versions, native essays) is holdout only:
//   an out-of-domain test nothing was tuned on.
// - About 40% of the remaining groups go to development, chosen by a hash of the group name (no randomness to rerun).
// - Exact duplicates were removed in fetch.js; a text whose hash appears in the holdout is also dropped from dev.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA = path.join(__dirname, 'data');
const SALT = 'lectern-bench-split-v1';
const DEV_SHARE = 0.4;

/** Deterministic split for one item. */
function splitOf(item) {
  if (item.holdoutOnly) return 'holdout';
  const h = crypto.createHash('sha256').update(`${SALT}:${item.group}`).digest();
  return h.readUInt32BE(0) / 2 ** 32 < DEV_SHARE ? 'dev' : 'holdout';
}

function split(items) {
  const holdout = items.filter((x) => splitOf(x) === 'holdout');
  const held = new Set(holdout.map((x) => x.hash));
  const dev = items.filter((x) => splitOf(x) === 'dev' && !held.has(x.hash));
  return { dev, holdout };
}

if (require.main === module) {
  const items = fs.readFileSync(path.join(DATA, 'items.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const { dev, holdout } = split(items);
  fs.writeFileSync(path.join(DATA, 'dev.jsonl'), dev.map((x) => JSON.stringify(x)).join('\n') + '\n');
  fs.writeFileSync(path.join(DATA, 'holdout.jsonl'), holdout.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const tally = (list) => list.reduce((m, x) => { const k = `${x.source}:${x.label}`; m[k] = (m[k] || 0) + 1; return m; }, {});
  const groupsDev = new Set(dev.map((x) => x.group));
  const leaked = holdout.filter((x) => groupsDev.has(x.group)).length;
  fs.writeFileSync(path.join(DATA, 'splits.json'), JSON.stringify({ salt: SALT, devShare: DEV_SHARE, leakedGroups: leaked, dev: { n: dev.length, counts: tally(dev), refs: dev.map((x) => x.ref) }, holdout: { n: holdout.length, counts: tally(holdout), refs: holdout.map((x) => x.ref) } }, null, 1));
  console.log(`dev ${dev.length} ${JSON.stringify(tally(dev))}\nholdout ${holdout.length} ${JSON.stringify(tally(holdout))}\ngroups shared between splits: ${leaked}`);
}

module.exports = { splitOf, split, SALT, DEV_SHARE };
