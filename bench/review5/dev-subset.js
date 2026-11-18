'use strict';
// Fixed development subset for the version 5 prompt variants: 10 human, 15 AI, 5 edited, seed 5, written before any variant runs.
const fs = require('fs');
const path = require('path');
const { corpus } = require('./cand-lib');
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rnd = mulberry32(5);
const pick = (label, n) => {
  const ids = corpus().filter((x) => x.split === 'dev' && x.label === label).map((x) => x.id).sort();
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  return ids.slice(0, n).sort();
};
const out = { seed: 5, human: pick('human', 10), ai: pick('ai', 15), edited: pick('edited', 5) };
out.ids = [...out.human, ...out.ai, ...out.edited];
fs.writeFileSync(path.join(__dirname, 'dev-subset.json'), JSON.stringify(out, null, 1));
console.log(out.ids.length, out.ids.join(','));
