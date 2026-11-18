'use strict';
// Writes the built-in examples of the Writing desk's test bench into shared/testbench.js, copied exactly from the
// benchmark's training splits (never development or holdout texts, never the owner's). Free: no model is called.
//   node bench/v7/make-testbench-examples.js
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const rd = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const v6 = rd('bench/data/v6/corpus.jsonl');
const v7 = rd('bench/data/v7/corpus.jsonl');
const man = rd('bench/data/v7/ai/manifest.jsonl');

const MODEL = { 'claude-haiku-5-5': 'Claude Haiku 5.5', 'claude-sonnet-5-5': 'Claude Sonnet 5.5', 'claude-opus-5-5': 'Claude Opus 5.5' };
const PICK = [
  ['v6', 'sn-sho-why-is-the-ocean-salty', 'ai'],
  ['v6', 'op-enc-pokemon', 'ai'],
  ['v7', 'hv27', 'ai-human'],
  ['v7', 'hv22', 'ai-human'],
  ['v7', 'rw05', 'rewritten'],
  ['v7', 'rw15', 'rewritten'],
  ['v7', 'v7h-wp-rainforest', 'human'],
  ['v7', 'v7h-wp-skateboarding', 'human'],
  ['v7', 'v7h-wp-chopsticks', 'human'],
];

const out = PICK.map(([set, id, label]) => {
  const r = (set === 'v6' ? v6 : v7).find((x) => x.id === id);
  if (!r) throw new Error(`missing ${set}/${id}`);
  if (r.split !== 'train') throw new Error(`${id} is in ${r.split}, not train`);
  const words = r.text.trim().split(/\s+/).length;
  let source;
  if (label === 'human') {
    const rev = r.revid || r.revision || (r.ref && String(r.ref).match(/\d{6,}/) && String(r.ref).match(/\d{6,}/)[0]);
    if (!rev || !r.topic) throw new Error(`${id}: no article or revision`);
    source = `Wikipedia, "${r.topic}", introduction of revision ${rev} (before 30 November 2022). CC BY-SA 4.0. https://en.wikipedia.org/w/index.php?oldid=${rev}`;
  } else {
    const m = man.find((x) => x.id === id);
    const model = MODEL[r.reportedModel || r.writer] || r.writer;
    if (label === 'ai') source = `Written by ${model} for Lectern's benchmark, asked for ${r.genre === 'shortanswer' ? 'a short answer' : 'an encyclopedic paragraph'}.`;
    else if (label === 'ai-human') source = `Written by ${model} for Lectern's benchmark, asked to sound like a person: "${m.request.split('. ')[0]}."`;
    else source = `An AI text written by a Claude model for Lectern's benchmark, then put through Lectern's Rewrite tool (${m.style} style, ${model}).`;
  }
  return { id: `ex-${id}`, label, words, source, text: r.text.trim() };
});

const file = path.join(ROOT, 'shared', 'testbench.js');
const src = fs.readFileSync(file, 'utf8');
const a = src.indexOf('/* EXAMPLES:START');
const b = src.indexOf('/* EXAMPLES:END */');
if (a < 0 || b < 0) throw new Error('markers not found');
const startLine = src.slice(a, src.indexOf('\n', a) + 1);
const body = `  const EXAMPLES = ${JSON.stringify(out, null, 2).replace(/\n/g, '\n  ')};\n  `;
fs.writeFileSync(file, src.slice(0, a) + startLine + body + src.slice(b));
console.log(out.map((e) => `${e.id} ${e.label} ${e.words} words`).join('\n'));
