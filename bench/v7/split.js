'use strict';
// Builds the version 7 corpus and its splits (bench/PREREGISTRATION.md, "Version 7"), with fixed rules and a fixed seed.
// No score is looked at. Inputs (all git-ignored, under bench/data/v7/):
//   ai/manifest.jsonl     the AI texts written by agent H (one row per text: id, kind, genre, topic, writer, style, ...; text in the row,
//                         or in ai/<id>.txt, or in ai/results.json under the id)
//   human/manifest.jsonl  the fresh human controls (bench/v7/data-human.js), texts in human/texts/<id>.txt
// Splits are in units of a GROUP (a topic, or one single text), so no topic is in two splits:
//   train about 45% (the style model only), dev about 25% (choices), holdout about 30% (one final run).
// Within each stratum (AI kind and genre; human source) groups are ordered by sha256(seed + group) and cut at the same
// fractions, so every split holds every kind. The holdout list is hashed into bench/data/v7/holdout.sha256 before any score
// exists, and the file is written once. Review subsets (10 AI + 10 human for dev, the same for holdout) are the first ten of each
// label by sha256("v7-review|" + id), marked "review" in corpus.jsonl.
//
//   node bench/v7/split.js            writes corpus.jsonl, holdout.sha256, manifest.json (refuses to overwrite holdout.sha256)
//   node bench/v7/split.js --check    verifies every holdout text still matches holdout.sha256

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'bench', 'data', 'v7');
const SEED = 'v7-split-2026-11-19';
const FRACTION = { holdout: 0.30, dev: 0.25 }; // the rest (45%) is train
const REVIEW_N = 10;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const words = (t) => (String(t).match(/\S+/g) || []).length;
const norm = (t) => String(t).toLowerCase().replace(/\s+/g, ' ').trim();
const readJsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

function loadHuman() {
  const dir = path.join(DATA, 'human');
  return readJsonl(path.join(dir, 'manifest.jsonl')).map((m) => ({ ...m, text: fs.readFileSync(path.join(dir, 'texts', `${m.id}.txt`), 'utf8').trim(), origin: 'v7' }));
}

function loadAi() {
  const dir = path.join(DATA, 'ai');
  const rows = readJsonl(path.join(dir, 'manifest.jsonl'));
  let results = null;
  const fromResults = (id) => { if (results === null) { try { results = JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8')); } catch { results = {}; } } return results[id] && results[id].text; };
  return rows.filter((m) => !m.rejected).map((m) => {
    const f = [path.join(dir, `${m.id}.txt`), path.join(dir, 'texts', `${m.id}.txt`)].find((x) => fs.existsSync(x));
    const text = typeof m.text === 'string' ? m.text : f ? fs.readFileSync(f, 'utf8') : fromResults(m.id);
    if (typeof text !== 'string') throw new Error(`AI text ${m.id} has no text.`);
    // a rewrite stays with the text it was rewritten from; a plain request is its own group (its topic)
    const group = m.group || (m.kind === 'rewrite' ? `rewrite-of:${m.source || m.topic}` : `topic:${m.kind}:${m.id}`);
    return { ...m, label: 'ai', writer: m.writer || 'claude-haiku-5-5', group, text: text.trim(), origin: 'v7' };
  });
}

function assign(items) {
  const info = new Map();
  for (const it of items) { const g = info.get(it.group) || { ai: null, any: it, n: 0 }; if (it.label === 'ai') g.ai = it; g.n++; info.set(it.group, g); }
  const stratum = (g) => (g.ai ? `ai:${g.ai.kind || 'ai'}` : `human:${g.any.source}`);
  const by = new Map();
  for (const [name, g] of info) { const s = stratum(g); (by.get(s) || by.set(s, []).get(s)).push([name, g.n]); }
  const splitOf = new Map();
  for (const [, groups] of by) {
    groups.sort((a, b) => sha(`${SEED}:${a[0]}`).localeCompare(sha(`${SEED}:${b[0]}`)));
    const size = groups.reduce((n, g) => n + g[1], 0);
    let seen = 0;
    for (const [name, n] of groups) {
      const pos = (seen + n / 2) / size; // middle of this group inside the stratum, 0..1
      splitOf.set(name, pos < FRACTION.holdout ? 'holdout' : pos < FRACTION.holdout + FRACTION.dev ? 'dev' : 'train');
      seen += n;
    }
  }
  for (const it of items) it.split = splitOf.get(it.group);
}

function build() {
  const items = [];
  const seen = new Set();
  for (const it of [...loadAi(), ...loadHuman()]) {
    const k = norm(it.text);
    if (seen.has(k)) throw new Error(`Duplicate text: ${it.id}.`);
    seen.add(k);
    items.push({ ...it, words: words(it.text) });
  }
  const ids = new Set(items.map((i) => i.id));
  if (ids.size !== items.length) throw new Error('Duplicate ids.');
  assign(items);
  const gs = new Map();
  for (const it of items) { const s = gs.get(it.group) || new Set(); s.add(it.split); gs.set(it.group, s); }
  for (const [g, s] of gs) if (s.size > 1) throw new Error(`Group ${g} is in more than one split.`);
  const byHash = (arr) => arr.slice().sort((a, b) => sha(`v7-review|${a.id}`).localeCompare(sha(`v7-review|${b.id}`)));
  const reviewIds = { dev: new Set(), holdout: new Set() };
  for (const split of ['dev', 'holdout']) {
    for (const label of ['ai', 'human']) byHash(items.filter((i) => i.split === split && i.label === label)).slice(0, REVIEW_N).forEach((i) => reviewIds[split].add(i.id));
  }
  for (const it of items) it.review = it.split !== 'train' && reviewIds[it.split].has(it.id);
  items.sort((a, b) => a.id.localeCompare(b.id));
  return { items, reviewIds };
}

function checkHoldout() {
  const file = path.join(DATA, 'holdout.sha256');
  if (!fs.existsSync(file)) return { ok: false, why: 'bench/data/v7/holdout.sha256 does not exist.' };
  const want = new Map(fs.readFileSync(file, 'utf8').split('\n').filter((l) => /^[0-9a-f]{64}  /.test(l)).map((l) => { const [h, id] = l.split(/\s+/); return [id, h]; }));
  const corpus = readJsonl(path.join(DATA, 'corpus.jsonl')).filter((x) => x.split === 'holdout');
  const bad = corpus.filter((x) => want.get(x.id) !== sha(x.text));
  if (bad.length || corpus.length !== [...want.keys()].filter((k) => !k.startsWith('HOLDOUT')).length) return { ok: false, why: `${bad.length} holdout texts do not match holdout.sha256 (or the count differs).` };
  return { ok: true, n: corpus.length };
}

function main() {
  if (process.argv.includes('--check')) { const c = checkHoldout(); console.log(c.ok ? `holdout matches (${c.n} texts)` : c.why); process.exitCode = c.ok ? 0 : 1; return; }
  const hashFile = path.join(DATA, 'holdout.sha256');
  if (fs.existsSync(hashFile)) throw new Error('holdout.sha256 exists: the holdout is hashed once. Delete nothing; use --check.');
  const { items, reviewIds } = build();
  const out = items.map(({ id, label, writer, source, licence, genre, kind, nonNative, words: w, split, group, topic, style, ref, revision, origin, review, reportedModel, text }) =>
    ({ id, label, writer, source: source || 'v7-claude-code', licence: licence || 'model output written for this benchmark; local only', genre, ...(kind ? { kind } : {}), nonNative: !!nonNative, words: w, split, review, text, group, origin, ...(reportedModel ? { reportedModel } : {}), ...(topic ? { topic } : {}), ...(style ? { style } : {}), ...(ref ? { ref } : {}), ...(revision ? { revision } : {}) }));
  fs.writeFileSync(path.join(DATA, 'corpus.jsonl'), `${out.map((o) => JSON.stringify(o)).join('\n')}\n`);
  const hold = out.filter((o) => o.split === 'holdout').map((o) => ({ id: o.id, h: sha(o.text) }));
  const reviewLine = (x) => `${x.id}:${x.h}`;
  const reviewHold = hold.filter((x) => reviewIds.holdout.has(x.id));
  const lines = hold.map((x) => `${x.h}  ${x.id}${reviewIds.holdout.has(x.id) ? '  REVIEW' : ''}`);
  fs.writeFileSync(hashFile, `${lines.join('\n')}\n${sha(hold.map(reviewLine).join('\n'))}  HOLDOUT-LIST (sha256 of the lines "id:hash" in id order)\n${sha(reviewHold.map(reviewLine).join('\n'))}  HOLDOUT-REVIEW-SET (${reviewHold.length} texts marked REVIEW, ${REVIEW_N} AI + ${REVIEW_N} human by sha256("v7-review|"+id))\n`);
  const count = (f) => out.reduce((m, o) => { const k = f(o); m[k] = (m[k] || 0) + 1; return m; }, {});
  const manifest = {
    built: new Date().toISOString(), seed: SEED, rule: 'in units of a group, stratified by AI kind / human source: holdout 30%, dev 25%, train 45%',
    total: out.length, bySplit: count((o) => o.split), bySplitLabel: count((o) => `${o.split}:${o.label}`), bySplitKind: count((o) => `${o.split}:${o.label === 'ai' ? o.kind : 'human'}`),
    byWriter: count((o) => o.writer), bySource: count((o) => o.source), byGenre: count((o) => o.genre),
    nonNativeHuman: out.filter((o) => o.label === 'human' && o.nonNative).length, nonNativeHumanBySplit: count((o) => (o.label === 'human' && o.nonNative ? o.split : 'x')),
    reviewSets: { dev: { ai: out.filter((o) => o.split === 'dev' && o.review && o.label === 'ai').length, human: out.filter((o) => o.split === 'dev' && o.review && o.label === 'human').length }, holdout: { ai: reviewHold.filter((x) => out.find((o) => o.id === x.id).label === 'ai').length, human: reviewHold.filter((x) => out.find((o) => o.id === x.id).label === 'human').length } },
    wordsRange: { min: Math.min(...out.map((o) => o.words)), max: Math.max(...out.map((o) => o.words)) },
  };
  fs.writeFileSync(path.join(DATA, 'manifest.json'), JSON.stringify(manifest, null, 1));
  console.log(JSON.stringify({ total: manifest.total, bySplitLabel: manifest.bySplitLabel, bySplitKind: manifest.bySplitKind, nonNativeHumanBySplit: manifest.nonNativeHumanBySplit, reviewSets: manifest.reviewSets }));
}
if (require.main === module) main();
module.exports = { build, assign, checkHoldout, DATA };
