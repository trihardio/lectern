'use strict';
// Builds the version 5 corpus (bench/PREREGISTRATION.md, version 5):
//   - the AI and AI-then-edited texts written by the Claude agents (bench/data/review5/texts/<id>.txt), and
//   - 40 human texts drawn with a fixed seed from the measured-index holdout (bench/data/holdout.jsonl: Liang et al.
//     2023, RAID and HC3, all written before 2023), which the model review has never read or been tuned on.
// Writes bench/data/review5/corpus.jsonl (texts, git-ignored) and bench/review5/manifest.json (hashes and labels, no texts).
//
//   node bench/review5/build.js            refuses to finish if a planned text is missing or out of the length range

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { plan, DATA } = require('./plan');

const ROOT = path.join(__dirname, '..', '..');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const countWords = (t) => (String(t).match(/\S+/g) || []).length;
const MIN_WORDS = 150;
const MAX_WORDS = 700;
const SEED = 'review5-human-2026-11-19';

// Human controls: source/domain quotas, chosen before any review result.
const HUMAN_QUOTA = [
  ['Liang2023', 'CS224N_real', 7, 'student'],
  ['Liang2023', 'CollegeEssay_real', 7, 'student'],
  ['Liang2023', 'TOEFL_real', 8, 'non-native student', 90], // every TOEFL essay is under 150 words; the app scores from 80 reviewed words
  ['RAID', 'abstracts', 6, 'academic'],
  ['RAID', 'news', 6, 'journalist'],
  ['RAID', 'books', 3, 'other'],
  ['HC3', 'reddit_eli5', 3, 'other'],
];

function humans() {
  const rows = fs.readFileSync(path.join(ROOT, 'bench', 'data', 'holdout.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const out = [];
  for (const [source, domain, n, writer, minWords = MIN_WORDS] of HUMAN_QUOTA) {
    const pool = rows
      .filter((r) => r.label === 'human' && r.source === source && r.domain === domain && (!r.attack || r.attack === 'none'))
      .filter((r) => { const w = countWords(r.text); return w >= minWords && w <= MAX_WORDS; })
      .sort((a, b) => sha(SEED + a.hash).localeCompare(sha(SEED + b.hash)));
    if (pool.length < n) throw new Error(`Only ${pool.length} human texts in ${source}/${domain} between ${minWords} and ${MAX_WORDS} words; ${n} needed.`);
    pool.slice(0, n).forEach((r, k) => out.push({
      id: `hu-${domain.toLowerCase().replace(/_real$/, '').replace(/[^a-z0-9]+/g, '')}-${k + 1}`,
      label: 'human', writer, source, domain, genre: domain, style: 'human', ref: r.ref || r.hash,
      split: k % 2 === 0 ? 'dev' : 'test', text: r.text,
    }));
  }
  return out;
}

function main() {
  const dir = path.join(DATA, 'texts');
  const problems = [];
  const items = [];
  for (const p of plan()) {
    const file = path.join(dir, `${p.id}.txt`);
    if (!fs.existsSync(file)) { problems.push(`${p.id}: missing`); continue; }
    const text = fs.readFileSync(file, 'utf8').trim();
    const w = countWords(text);
    if (w < MIN_WORDS || w > MAX_WORDS) problems.push(`${p.id}: ${w} words (allowed ${MIN_WORDS}-${MAX_WORDS})`);
    if (/^#{1,6} |^\s*[-*] |\*\*/m.test(text)) problems.push(`${p.id}: contains Markdown marks`);
    const item = { id: p.id, label: p.label, writer: p.writer, source: 'review5-agents', genre: p.genre, style: p.style, topic: p.topic, split: p.split, text };
    if (p.label === 'edited') {
      const draftFile = path.join(dir, `${p.id}.draft.txt`);
      if (!fs.existsSync(draftFile)) problems.push(`${p.id}: draft missing`);
      else item.editShare = editShare(fs.readFileSync(draftFile, 'utf8'), text);
    }
    items.push(item);
  }
  if (problems.length) { console.error(`Corpus not built:\n  ${problems.join('\n  ')}`); process.exitCode = 1; return; }
  const all = [...items, ...humans()].map((x) => ({ ...x, words: countWords(x.text), hash: sha(x.text) }));
  fs.writeFileSync(path.join(DATA, 'corpus.jsonl'), `${all.map((x) => JSON.stringify(x)).join('\n')}\n`);
  const manifest = { builtAt: new Date().toISOString(), minWords: MIN_WORDS, maxWords: MAX_WORDS, humanSeed: SEED, items: all.map(({ text, ...rest }) => rest) };
  fs.writeFileSync(path.join(__dirname, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  const count = {};
  for (const x of all) { const k = `${x.split} ${x.label}`; count[k] = (count[k] || 0) + 1; }
  console.log(`Corpus: ${all.length} texts.`, count);
}

/** Share of the edited text's words that are not in the draft's word sequence (a word-level LCS), 0-1. */
function editShare(draft, edited) {
  const a = draft.toLowerCase().match(/[a-z0-9']+/g) || [];
  const b = edited.toLowerCase().match(/[a-z0-9']+/g) || [];
  const prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const keep = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(prev[j], prev[j - 1]);
      diag = keep;
    }
  }
  return b.length ? +(1 - prev[b.length] / b.length).toFixed(3) : 0;
}

if (require.main === module) main();
module.exports = { humans, editShare, HUMAN_QUOTA };
