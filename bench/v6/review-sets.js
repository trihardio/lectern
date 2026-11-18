'use strict';
// Fixes the development review set, the stability-repeat set and the Opus gate set of version 6 (pre-registration,
// "Selection" 1-3), by hash order inside each cell, BEFORE the first development call. Writes ids only to
// bench/data/v6/review-sets.json (git-ignored). Budget reasoning: agent C has 130 Sonnet calls; 72 are reserved for the
// holdout (S0 and S2 on 36 texts) and 15 for the stability run, so at most 43 remain for the first S2 development run.
// 40 are used (22 human of which 8 non-native, 18 AI), keeping 3 for a call that returns no reply.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const DATA = path.join(__dirname, '..', 'data', 'v6');
const h = (prefix, id) => crypto.createHash('sha256').update(`${prefix}|${id}`).digest('hex');

function build(corpus) {
  const dev = corpus.filter((x) => x.split === 'dev');
  const cell = (x) => (x.label === 'ai' ? 'ai' : x.nonNative ? 'humanNonNative' : 'humanNative');
  const pick = (pool, prefix, quota) => {
    const out = [];
    for (const [c, n] of Object.entries(quota)) out.push(...pool.filter((x) => cell(x) === c).sort((a, b) => (h(prefix, a.id) < h(prefix, b.id) ? -1 : 1)).slice(0, n).map((x) => x.id));
    return out;
  };
  const review = pick(dev, 'v6-dev', { humanNonNative: 8, humanNative: 14, ai: 18 });
  const inReview = dev.filter((x) => review.includes(x.id));
  const repeat = pick(inReview, 'v6-repeat', { humanNonNative: 2, humanNative: 4, ai: 9 });
  const opus = pick(inReview, 'v6-opus', { humanNonNative: 2, humanNative: 3, ai: 4 });
  return { review, repeat, opus };
}

if (require.main === module) {
  const corpus = fs.readFileSync(path.join(DATA, 'corpus.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const sets = build(corpus);
  const file = path.join(DATA, 'review-sets.json');
  if (fs.existsSync(file)) throw new Error('review-sets.json already exists: the sets are fixed once, before the first development call.');
  fs.writeFileSync(file, JSON.stringify({ fixedAt: new Date().toISOString(), rule: 'sha256("v6-dev|"|"v6-repeat|"|"v6-opus|" + id) ascending within each cell', ...sets }, null, 1));
  console.log(Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, v.length])));
}
module.exports = { build };
