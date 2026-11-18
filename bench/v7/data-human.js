'use strict';
// Builds the version 7 human controls from texts never used before, and writes them to bench/data/v7/human/ (git-ignored):
//   texts/<id>.txt   one text per file
//   manifest.jsonl   one row per text: id, label, source, licence, genre, nonNative, group, topic, ref, revision, words, sha256 (no text)
//   summary.json     counts and the hash check
// Sources: (1) Wikipedia introductions from before 2022-11-30 (bench/v7/data-wiki.js, CC BY-SA 4.0); (2) DACTYL validation human
// texts already on disk (MIT card): ELLIPSE essays (ELL = non-native), other student essays, news and abstracts.
// A text is refused if its sha256 (raw, trimmed or whitespace-normalised) is in ANY earlier Lectern set: bench/data/*.jsonl,
// bench/data/style/*.jsonl, bench/data/review/*.jsonl, bench/data/review5/corpus.jsonl and bench/data/v6/*.jsonl.
// Selection is by sha256 order with a fixed seed, written down before any score exists.
//
//   node bench/v7/data-human.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'bench', 'data', 'v7');
const OUT = path.join(DATA, 'human');
const SEED = 'v7-human-2026-11-19';
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const norm = (t) => String(t).toLowerCase().replace(/\s+/g, ' ').trim();
const words = (t) => (String(t).match(/\S+/g) || []).length;
const QUOTA = { ell: 20, essay: 8, news: 4, abstract: 6 }; // plus every usable Wikipedia introduction

function earlierHashes() {
  const files = [];
  for (const d of ['bench/data', 'bench/data/style', 'bench/data/review', 'bench/data/review5', 'bench/data/v6']) {
    for (const f of fs.readdirSync(path.join(ROOT, d))) if (f.endsWith('.jsonl')) files.push(path.join(ROOT, d, f));
  }
  const set = new Set();
  const titles = new Set();
  for (const f of files) {
    for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!l) continue;
      let r; try { r = JSON.parse(l); } catch { continue; }
      if (typeof r.text === 'string') { set.add(sha(r.text)); set.add(sha(r.text.trim())); set.add(sha(norm(r.text))); }
      if (r.title && /wiki/.test(f)) titles.add(String(r.title).toLowerCase());
    }
  }
  return { set, titles, files: files.map((f) => path.relative(ROOT, f)) };
}

function main() {
  fs.mkdirSync(path.join(OUT, 'texts'), { recursive: true });
  const earlier = earlierHashes();
  const used = (t) => earlier.set.has(sha(t)) || earlier.set.has(sha(t.trim())) || earlier.set.has(sha(norm(t)));
  const rows = [];
  const seen = new Set();
  const dropped = { wikipedia: 0, wikipediaTitle: 0, dactyl: 0, short: 0 };
  const add = (o) => { const k = norm(o.text); if (seen.has(k)) return; seen.add(k); rows.push({ ...o, words: words(o.text), sha256: sha(o.text) }); };

  for (const w of fs.readFileSync(path.join(DATA, 'wiki.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)) {
    if (w.words < 80 || w.words > 400) { dropped.short++; continue; }
    if (used(w.text)) { dropped.wikipedia++; continue; }
    if (earlier.titles.has(w.title.toLowerCase())) { dropped.wikipediaTitle++; continue; }
    add({ id: `v7h-wp-${w.group.replace(/^topic:wiki:/, '')}`, label: 'human', writer: 'human', source: 'wikipedia-before-2022-11-30', licence: 'CC-BY-SA-4.0 (attribution: the Wikipedia article revision in ref; share-alike applies to redistribution, so the texts stay local)', genre: 'encyclopedic', kind: w.kind, nonNative: false, group: w.group, topic: w.title, ref: w.url, revision: w.revid, text: w.text });
  }

  const dact = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'data', 'review', 'raw', 'dactyl-validation-150-700.json'), 'utf8'))
    .filter((r) => r.model === 'human' && words(r.text) >= 80 && words(r.text) <= 400)
    .map((r) => { let ci = null; try { ci = r.category_info && r.category_info !== 'null' ? JSON.parse(r.category_info) : null; } catch { ci = null; } return { ...r, ci, ref: `DACTYL/validation/${r.id}` }; })
    .filter((r) => { if (used(r.text)) { dropped.dactyl++; return false; } return true; });
  const order = (arr, key) => arr.slice().sort((a, b) => sha(`${SEED}:${key}:${a.ref}`).localeCompare(sha(`${SEED}:${key}:${b.ref}`)));
  // essays with a topic: at most 2 per topic, so no topic dominates
  const perTopic = (arr, cap, key) => { const m = new Map(); const out = []; for (const r of order(arr, key)) { const n = m.get(r.ci.topic) || 0; if (n < cap) { m.set(r.ci.topic, n + 1); out.push(r); } } return out; };
  const base = { label: 'human', writer: 'human', origin: 'new' };
  const lic = 'MIT (DACTYL dataset card); underlying source not re-checked; local only';
  perTopic(dact.filter((r) => r.domain === 'student_essays' && r.ci && String(r.ci.ELL) === 'True'), 2, 'ell').slice(0, QUOTA.ell)
    .forEach((r, k) => add({ ...base, id: `v7h-ell-${k + 1}`, source: 'DACTYL-ELLIPSE', licence: `${lic}; ELLIPSE essays of US students in grades 8-12, ELL = English language learners`, genre: 'student-essay', nonNative: true, group: `topic:ellipse:${r.ci.topic}`, topic: r.ci.topic, ref: r.ref, text: r.text }));
  // essays with no category info are the Ivy Panda essays (native-speaker student essays scraped from a website); one group each
  order(dact.filter((r) => r.domain === 'student_essays' && !r.ci), 'ivy').slice(0, QUOTA.essay)
    .forEach((r, k) => add({ ...base, id: `v7h-ivy-${k + 1}`, source: 'DACTYL-IvyPanda', licence: `${lic}; essays scraped from a website`, genre: 'student-essay', nonNative: false, group: `single:ivy:${r.ref}`, ref: r.ref, text: r.text }));
  for (const [dom, key, genre, n] of [['news', 'news', 'news', QUOTA.news], ['abstracts', 'abstract', 'abstract', QUOTA.abstract]]) {
    order(dact.filter((r) => r.domain === dom), key).slice(0, n)
      .forEach((r, k) => add({ ...base, id: `v7h-${key}-${k + 1}`, source: `DACTYL-${dom}`, licence: lic, genre, nonNative: false, group: `single:${key}:${r.ref}`, ref: r.ref, text: r.text }));
  }

  // final check: nothing written is an earlier text
  const clash = rows.filter((r) => used(r.text));
  if (clash.length) throw new Error(`${clash.length} texts match an earlier set.`);
  rows.sort((a, b) => a.id.localeCompare(b.id));
  for (const r of rows) fs.writeFileSync(path.join(OUT, 'texts', `${r.id}.txt`), `${r.text}\n`);
  fs.writeFileSync(path.join(OUT, 'manifest.jsonl'), `${rows.map(({ text, ...m }) => JSON.stringify(m)).join('\n')}\n`);
  const count = (f) => rows.reduce((m, o) => { const k = f(o); m[k] = (m[k] || 0) + 1; return m; }, {});
  const summary = {
    built: new Date().toISOString(), seed: SEED, total: rows.length, bySource: count((r) => r.source), byGenre: count((r) => r.genre), nonNative: rows.filter((r) => r.nonNative).length,
    wordsRange: { min: Math.min(...rows.map((r) => r.words)), max: Math.max(...rows.map((r) => r.words)) },
    hashCheck: { rule: 'a text is refused if its sha256 (raw, trimmed or whitespace-normalised) is in any earlier Lectern set', earlierFiles: earlier.files, earlierTextHashes: earlier.set.size, droppedMatches: dropped, finalClashes: 0 },
  };
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify({ total: summary.total, bySource: summary.bySource, nonNative: summary.nonNative, dropped }));
}
if (require.main === module) main();
