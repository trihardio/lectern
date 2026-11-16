'use strict';
// Draw the development and holdout samples from CWEB (fixed seed; see PREREGISTRATION.md).
//   node bench/grammar/sample.js
// dev     = 150 lines from CWEB-G.dev  + 150 from CWEB-S.dev
// holdout = 150 lines from CWEB-G.test + 150 from CWEB-S.test
// Only lines of 5 to 120 words are drawn. Writes data/sample/<split>.{source,ann1,ann2,ids} (git-ignored) and
// data/splits.json (line numbers and hashes only, committed).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SEED = 20261117;
const PER = 150;
const DIR = path.join(__dirname, 'data');

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const read = (name) => fs.readFileSync(path.join(DIR, 'cweb', name), 'utf8').replace(/\n$/, '').split('\n');
const words = (s) => s.trim().split(/\s+/).filter(Boolean).length;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

const rand = mulberry32(SEED);
const splits = {};
fs.mkdirSync(path.join(DIR, 'sample'), { recursive: true });
for (const [split, part] of [['dev', 'dev'], ['holdout', 'test']]) {
  const out = { source: [], ann1: [], ann2: [], ids: [] };
  for (const domain of ['G', 'S']) {
    const base = `CWEB-${domain}.${part}`;
    const src = read(`${base}.source`);
    const a1 = read(`${base}.ann1`);
    const a2 = read(`${base}.ann2`);
    const pool = src.map((s, i) => i).filter((i) => { const n = words(src[i]); return n >= 5 && n <= 120; });
    for (let k = pool.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [pool[k], pool[j]] = [pool[j], pool[k]]; }
    const take = pool.slice(0, PER).sort((x, y) => x - y);
    for (const i of take) {
      out.source.push(src[i]); out.ann1.push(a1[i]); out.ann2.push(a2[i]);
      out.ids.push({ file: base, line: i + 1, sha: sha(src[i]) });
    }
  }
  for (const k of ['source', 'ann1', 'ann2']) fs.writeFileSync(path.join(DIR, 'sample', `${split}.${k}`), out[k].join('\n') + '\n');
  fs.writeFileSync(path.join(DIR, 'sample', `${split}.ids`), JSON.stringify(out.ids));
  const changed = out.source.filter((s, i) => s !== out.ann1[i] || s !== out.ann2[i]).length;
  const clean = out.source.filter((s, i) => s === out.ann1[i] && s === out.ann2[i]).length;
  splits[split] = { seed: SEED, filter: '5 to 120 words', lines: out.ids.length, correctedByAnAnnotator: changed, unchangedByBoth: clean, ids: out.ids };
  console.log(`${split}: ${out.ids.length} lines; corrected by at least one annotator ${changed}; unchanged by both ${clean}`);
}
fs.writeFileSync(path.join(DIR, 'splits.json'), JSON.stringify(splits) + '\n');
