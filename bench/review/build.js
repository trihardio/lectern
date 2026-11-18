'use strict';
// Build the review benchmark (PREREGISTRATION.md, version 4): human, AI and AI-then-human-edited academic and student
// writing, 150-700 words each, split into development and holdout by source group.
//
//   node bench/review/fetch-beemo.js            (once; cached)
//   venv/bin/python bench/review/extract-dactyl.py <parquet> <json>   (once; see that file)
//   node bench/review/build.js                  writes bench/data/review/{dev,holdout}.jsonl (texts, git-ignored)
//                                                and bench/review/manifest.json (no texts, tracked)
//
// Nothing here calls a model. Texts stay in bench/data/review (git-ignored); the manifest holds hashes only.

const fs = require('fs');
const path = require('path');
const M = require('../metrics');
const L = require('./lib');
const { get } = require('./hf');
const aiscore = require('../../server/checks/aiscore');
const T = require('../../server/checks/text');

const RAW = path.join(L.DATA, 'raw');
const SEED = 20261118;
const wc = (s) => (String(s).match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) || []).length;
const textHash = (s) => L.sha(String(s).replace(/\s+/g, ' ').trim().toLowerCase());

// How many documents each cell gives to development and to holdout. Fixed here, before any model review was run.
const CELLS = [
  // label, cell, dev, holdout
  ['human', 'nonnative-ell-essay', 4, 8],
  ['human', 'student-essay-ivypanda', 3, 4],
  ['human', 'student-essay-liang', 2, 3],
  ['human', 'abstract', 2, 3],
  ['human', 'beemo-human', 3, 4],
  ['ai', 'ell-style-essay-ai', 2, 3],
  ['ai', 'student-essay-ai', 3, 4],
  ['ai', 'abstract-ai', 2, 3],
  ['ai', 'beemo-machine', 3, 4],
  ['ai', 'liang-essay-ai', 1, 2],
  ['edited', 'beemo-expert-edited', 9, 13],
  ['edited', 'mixset-human-adapted', 2, 3],
];
const PREAMBLE = /^\s*(sure|certainly|of course|okay|ok|here(?:'s| is| are)|as an ai)\b/i; // chat boilerplate would give the AI class away

function loadCandidates() {
  const c = [];
  // DACTYL validation split (MIT card). Human student essays carry an "ELL" tag when the writer is an English language learner.
  const dactyl = JSON.parse(fs.readFileSync(path.join(RAW, 'dactyl-validation-150-700.json'), 'utf8'));
  for (const o of dactyl) {
    const ci = o.category_info ? JSON.parse(o.category_info) : {};
    const ell = ci.ELL === 'True';
    const base = { source: 'DACTYL-validation', ref: `DACTYL/validation/${o.id}`, domain: o.domain, generator: o.model, text: o.text, group: ell ? `ell-topic:${ci.topic}` : `dactyl:${o.id}` };
    if (o.domain === 'student_essays' && o.target === 0) c.push({ ...base, label: 'human', cell: ell ? 'nonnative-ell-essay' : 'student-essay-ivypanda', writer: ell ? 'non-native (ELL students)' : 'student', generator: 'human' });
    else if (o.domain === 'student_essays' && o.target === 1) c.push({ ...base, label: 'ai', cell: ell ? 'ell-style-essay-ai' : 'student-essay-ai', writer: ell ? 'non-native style (AI)' : 'student style (AI)' });
    else if (o.domain === 'abstracts' && o.target === 0) c.push({ ...base, label: 'human', cell: 'abstract', writer: 'academic', generator: 'human' });
    else if (o.domain === 'abstracts' && o.target === 1) c.push({ ...base, label: 'ai', cell: 'abstract-ai', writer: 'academic style (AI)' });
  }
  // Beemo: human reference, machine output and expert-edited machine output for the same prompt (MIT card; see manifest for the rest).
  const beemo = [];
  for (let off = 0; off < 2187; off += 100) beemo.push(...require('./fetch-beemo').pageRows(off));
  for (const r of beemo) {
    const base = { source: 'Beemo', domain: `Beemo: ${r.category}`, group: `beemo:${r.prompt_id}` };
    c.push({ ...base, ref: `Beemo/${r.id}/human_output`, label: 'human', cell: 'beemo-human', writer: 'crowd writers (No Robots)', generator: 'human', text: r.human_output });
    c.push({ ...base, ref: `Beemo/${r.id}/model_output`, label: 'ai', cell: 'beemo-machine', writer: 'open-source LLM (AI)', generator: r.model, text: r.model_output });
    c.push({ ...base, ref: `Beemo/${r.id}/human_edits`, label: 'edited', cell: 'beemo-expert-edited', writer: 'expert-edited LLM output', generator: r.model, text: r.human_edits });
  }
  // MixSet: the human-adapted machine text ("MGT_polish_*" = the paper's Adapt operation, manual annotation of machine text).
  for (const file of ['Mixset_train.json', 'Mixset_test.json']) {
    const rows = JSON.parse(fs.readFileSync(path.join(RAW, file), 'utf8'));
    rows.forEach((r, i) => {
      if (!/^MGT_polish_(token|sentence)$/.test(r.mixset_category)) return;
      c.push({ source: 'MixSet', ref: `MixSet/${file}/${i}`, domain: `MixSet: ${r.category}`, group: `mixset:${textHash(r.original).slice(0, 16)}`, label: 'edited', cell: 'mixset-human-adapted', writer: 'human-adapted machine text', generator: r.mixset_category, text: r.revised });
    });
  }
  // Liang et al. 2023 (MIT): essays already cached by bench/fetch.js. No TOEFL essay there has 150 words or more.
  const items = fs.readFileSync(path.join(L.ROOT, 'bench', 'data', 'items.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((x) => x.source === 'Liang2023');
  for (const x of items) {
    if (x.label === 'human' && x.writer === 'student, unspecified') c.push({ source: 'Liang2023', ref: x.ref, domain: 'Liang: student essay', group: x.group, label: 'human', cell: 'student-essay-liang', writer: 'student', generator: 'human', text: x.text });
    else if (x.label === 'ai' && x.writer === 'student, unspecified') c.push({ source: 'Liang2023', ref: x.ref, domain: 'Liang: student essay', group: x.group, label: 'ai', cell: 'liang-essay-ai', writer: 'AI (GPT-3/4)', generator: x.generator, text: x.text });
  }
  return c;
}

/** The same limits for every class: 150-700 words, one review call, enough prose, no chat preamble. */
function usable(x) {
  const text = T.normalizeText(x.text);
  const n = wc(text);
  if (n < 150 || n > 700 || PREAMBLE.test(text)) return false;
  const m = aiscore.measure(text);
  if (aiscore.batches(m.prose).length !== 1) return false;
  const eligible = m.prose.reduce((s, u) => s + wc(u.text), 0);
  return eligible >= 120 && eligible >= 0.8 * n;
}

function build() {
  const rand = M.rng(SEED);
  const all = loadCandidates();
  const stats = { candidates: all.length, usable: 0 };
  const byCell = new Map();
  const seenHash = new Set();
  for (const x of all) {
    const h = textHash(x.text);
    if (seenHash.has(h) || !usable(x)) continue;
    seenHash.add(h);
    stats.usable++;
    x.hash = h;
    if (!byCell.has(x.cell)) byCell.set(x.cell, []);
    byCell.get(x.cell).push(x);
  }
  const usedGroups = new Set();
  const dev = [];
  const hold = [];
  const shortage = [];
  for (const [label, cell, nDev, nHold] of CELLS) {
    const pool = (byCell.get(cell) || []).sort((a, b) => (a.hash < b.hash ? -1 : 1));
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const take = (n, into, split) => {
      let got = 0;
      for (const x of pool) {
        if (got >= n) break;
        if (usedGroups.has(x.group)) continue; // a group goes to one split only, and contributes one document
        usedGroups.add(x.group);
        into.push({ id: L.sha(`${x.group}|${x.cell}`).slice(0, 10), split, ...x, label });
        got++;
      }
      if (got < n) shortage.push(`${cell} ${split}: wanted ${n}, found ${got}`);
    };
    take(nDev, dev, 'dev');
    take(nHold, hold, 'holdout');
  }
  for (const x of [...dev, ...hold]) { x.words = wc(T.normalizeText(x.text)); }
  return { dev, hold, stats, shortage };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };

function main() {
  const { dev, hold, stats, shortage } = build();
  if (shortage.length) throw new Error(`Not enough usable documents: ${shortage.join('; ')}`);
  const groupsDev = new Set(dev.map((x) => x.group));
  const clash = hold.filter((x) => groupsDev.has(x.group));
  if (clash.length) throw new Error('A source group is in both development and holdout.');
  const hashes = new Set(dev.map((x) => x.hash));
  if (hold.some((x) => hashes.has(x.hash))) throw new Error('A text is in both development and holdout.');
  for (const [name, list] of [['dev', dev], ['holdout', hold]]) {
    fs.writeFileSync(path.join(L.DATA, `${name}.jsonl`), `${list.map((x) => JSON.stringify(x)).join('\n')}\n`);
  }
  const count = (list, key) => list.reduce((o, x) => { const k = key(x); o[k] = (o[k] || 0) + 1; return o; }, {});
  const summary = (list) => ({
    n: list.length, byLabel: count(list, (x) => x.label), byCell: count(list, (x) => x.cell), byWriter: count(list, (x) => x.writer),
    groups: new Set(list.map((x) => x.group)).size,
    medianWords: Object.fromEntries(['human', 'ai', 'edited'].map((l) => [l, median(list.filter((x) => x.label === l).map((x) => x.words))])),
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
  manifest.built = { at: new Date().toISOString(), seed: SEED, filters: { words: [150, 700], reviewCalls: 'exactly one batch (aiscore.batches)', eligibleWords: '>= 120 and >= 80% of the words', chatPreamble: String(PREAMBLE), duplicates: 'exact text after case and space folding' }, candidates: stats.candidates, usable: stats.usable, cells: CELLS.map(([label, cell, d, h]) => ({ label, cell, dev: d, holdout: h })) };
  manifest.splits = { dev: summary(dev), holdout: summary(hold), sourceGroupsShared: 0 };
  manifest.items = [...dev, ...hold].map(({ text, ...r }) => r);
  fs.writeFileSync(path.join(__dirname, 'manifest.json'), JSON.stringify(manifest, null, 1));
  console.log(JSON.stringify(manifest.splits, null, 1));
  console.log(`candidates ${stats.candidates}, usable ${stats.usable}`);
}

if (require.main === module) main();
module.exports = { build, usable, CELLS };
