'use strict';
// Builds the version 6 corpus from the pieces on disk, with fixed rules and a fixed seed (no result is looked at):
//   - the new AI texts (bench/data/v6/texts/<id>.txt, written by data-generate.js from data-plan.js),
//   - human Wikipedia introductions from before 2022-11-30 (bench/data/v6/wiki.jsonl, data-wiki.js; CC BY-SA 4.0),
//   - human student and non-native essays and answers already on disk (Liang et al. TOEFL/CS224N, DACTYL-validation with
//     ELLIPSE and Ivy Panda essays, HC3 and RAID human answers),
//   - the 118 version 5 texts (read-only), which go to train or dev only, never to the holdout.
// Writes bench/data/v6/corpus.jsonl (texts, git-ignored), bench/data/v6/holdout.sha256 and bench/data/v6/manifest.json
// (counts and hashes, no texts).
//
// Splits (written down before any model result): the whole corpus is divided 50% train (style model only), 25% dev
// (choices), 25% holdout (one final run) in units of a GROUP, so no topic or request is in two splits. A group is a
// topic (the AI text(s) and the human Wikipedia introduction on the same topic travel together) or a single human text.
// Version 5 dev texts stay dev; version 5 test texts go to train. Within each stratum (genre and writer for AI texts, the
// source for human texts) groups are ordered by a hash of the group name and cut at the same fractions.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { plan, DATA } = require('./data-plan');

const ROOT = path.join(__dirname, '..', '..');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const words = (t) => (String(t).match(/\S+/g) || []).length;
const norm = (t) => String(t).toLowerCase().replace(/\s+/g, ' ').trim();
const SEED = 'v6-split-2026-11-19';
const readJsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// Human quotas (chosen before any score exists): [source key, count, filters]
const QUOTA = { ellipseEll: 64, ellipseOther: 8, ivypanda: 16, abstracts: 12, news: 10 };

function pick(pool, n, key) { return pool.slice().sort((a, b) => sha(`${SEED}:${key}:${a.ref}`).localeCompare(sha(`${SEED}:${key}:${b.ref}`))).slice(0, n); }

function build() {
  const v5 = readJsonl(path.join(ROOT, 'bench', 'data', 'review5', 'corpus.jsonl'));
  const seenText = new Set(v5.map((r) => norm(r.text)));
  const reviewRefs = new Set([...readJsonl(path.join(ROOT, 'bench', 'data', 'review', 'dev.jsonl')), ...readJsonl(path.join(ROOT, 'bench', 'data', 'review', 'holdout.jsonl'))].map((r) => r.ref));
  // every text in an earlier Lectern training, fairness or benchmark set (versions 1 to 5): a "new" text must not be one of them
  const earlier = new Set();
  const dropped = { wikipedia: 0, ai: 0, dactyl: 0 };
  const eFiles = [];
  for (const d of ['bench/data', 'bench/data/style', 'bench/data/review']) for (const f of fs.readdirSync(path.join(ROOT, d))) if (f.endsWith('.jsonl') && f !== 'corpus.jsonl') eFiles.push(path.join(ROOT, d, f));
  eFiles.push(path.join(ROOT, 'bench', 'data', 'review5', 'corpus.jsonl'));
  for (const f of eFiles) for (const l of fs.readFileSync(f, 'utf8').split('\n')) { if (!l) continue; let r; try { r = JSON.parse(l); } catch { continue; } if (typeof r.text === 'string') { earlier.add(sha(r.text)); earlier.add(sha(r.text.trim())); earlier.add(sha(norm(r.text))); } }
  const items = [];
  const add = (o) => { const k = norm(o.text); if (seenText.has(k)) return; if (o.origin === 'new' && (earlier.has(sha(o.text)) || earlier.has(sha(k)))) { dropped[o.label === 'ai' ? 'ai' : 'wikipedia']++; return; } seenText.add(k); items.push({ ...o, words: words(o.text) }); };

  // --- new AI texts
  const gen = new Map(readJsonl(path.join(DATA, 'gen.jsonl')).filter((g) => !g.rejected).map((g) => [g.id, g]));
  const planned = plan();
  const missing = [];
  for (const p of planned) {
    const f = path.join(DATA, 'texts', `${p.id}.txt`);
    if (!fs.existsSync(f)) { missing.push(p.id); continue; }
    const g = gen.get(p.id) || {};
    add({ id: p.id, label: 'ai', writer: p.writer, reportedModel: g.reportedModel || null, source: 'v6-claude-code', licence: 'model output written for this benchmark; local only', genre: p.genre, nonNative: false, group: p.group, topic: p.topic, style: p.style, text: fs.readFileSync(f, 'utf8').trim(), origin: 'new' });
  }
  const aiGroups = new Set(items.map((i) => i.group));

  // --- human: Wikipedia introductions (matched to the topic of an AI text where there is one)
  for (const w of readJsonl(path.join(DATA, 'wiki.jsonl'))) {
    if (w.words < 80 || w.words > 400) continue;
    add({ id: `wp-${w.group.replace(/^topic:/, '').replace(/[^a-z0-9]+/g, '-')}`, label: 'human', writer: 'human', source: 'wikipedia-before-2022-11-30', licence: 'CC-BY-SA-4.0', genre: aiGroups.has(w.group) ? 'encyclopedic-matched' : 'encyclopedic', nonNative: false, group: w.group, topic: w.title, ref: w.url, revision: w.revid, text: w.text, origin: 'new' });
  }
  if (!items.some((i) => i.source.startsWith('wikipedia'))) throw new Error('No Wikipedia texts: run data-wiki.js first.');

  // --- human: on-disk sources (DACTYL validation only: every other human text on disk is in an earlier Lectern set)
  const dact = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'data', 'review', 'raw', 'dactyl-validation-150-700.json'), 'utf8'))
    .filter((r) => r.model === 'human' && words(r.text) >= 80 && words(r.text) <= 400)
    .map((r) => { let ci = null; try { ci = r.category_info && r.category_info !== 'null' ? JSON.parse(r.category_info) : null; } catch { ci = null; } return { ...r, ci, ref: `DACTYL/validation/${r.id}` }; });
  const fresh = (r) => { if (earlier.has(sha(r.text.trim())) || earlier.has(sha(norm(r.text))) || earlier.has(sha(r.text)) || reviewRefs.has(r.ref)) { dropped.dactyl++; return false; } return !seenText.has(norm(r.text)); };
  const essays = dact.filter((r) => r.domain === 'student_essays' && fresh(r));
  const dactOpts = { source: 'DACTYL-ELLIPSE', licence: 'MIT (DACTYL dataset card); ELLIPSE essays of US students in grades 8-12; local only', genre: 'student-essay' };
  const byTopic = (rows, perTopic) => { const m = new Map(); for (const r of rows.slice().sort((a, b) => sha(`${SEED}:t:${a.ref}`).localeCompare(sha(`${SEED}:t:${b.ref}`)))) { const l = m.get(r.ci.topic) || m.set(r.ci.topic, []).get(r.ci.topic); if (l.length < perTopic) l.push(r); } return [...m.values()].sort((a, b) => sha(`${SEED}:g:${a[0].ci.topic}`).localeCompare(sha(`${SEED}:g:${b[0].ci.topic}`))).flat(); };
  const ell = byTopic(essays.filter((r) => r.ci && String(r.ci.ELL) === 'True'), 2).slice(0, QUOTA.ellipseEll);
  const notEll = byTopic(essays.filter((r) => r.ci && String(r.ci.ELL) !== 'True'), 1).slice(0, QUOTA.ellipseOther);
  ell.forEach((r, k) => add({ id: `hu-ell-${k + 1}`, label: 'human', writer: 'human', group: `topic:ellipse:${r.ci.topic}`, ref: r.ref, topic: r.ci.topic, text: r.text, origin: 'new', ...dactOpts, nonNative: true }));
  notEll.forEach((r, k) => add({ id: `hu-ellipse-${k + 1}`, label: 'human', writer: 'human', group: `topic:ellipse:${r.ci.topic}`, ref: r.ref, topic: r.ci.topic, text: r.text, origin: 'new', ...dactOpts, nonNative: false }));
  pick(essays.filter((r) => !r.ci), QUOTA.ivypanda, 'ivy').forEach((r, k) => add({ id: `hu-ivy-${k + 1}`, label: 'human', writer: 'human', group: `single:ivy:${r.ref}`, ref: r.ref, text: r.text, origin: 'new', source: 'DACTYL-IvyPanda', licence: 'MIT (DACTYL dataset card); essays scraped from a website; local only', genre: 'student-essay', nonNative: false }));
  for (const [dom, key, genre, n] of [['abstracts', 'abstracts', 'abstract', QUOTA.abstracts], ['news', 'news', 'news', QUOTA.news]]) {
    pick(dact.filter((r) => r.domain === dom && fresh(r)), n, key).forEach((r, k) => add({ id: `hu-${key}-${k + 1}`, label: 'human', writer: 'human', group: `single:${key}:${r.ref}`, ref: r.ref, text: r.text, origin: 'new', source: `DACTYL-${dom}`, licence: 'MIT (DACTYL dataset card); underlying source not re-checked; local only', genre, nonNative: false }));
  }

  // --- stratum per group, then splits
  const info = new Map();
  for (const it of items) {
    const g = info.get(it.group) || { ai: null, any: it };
    if (it.label === 'ai') g.ai = it;
    info.set(it.group, g);
  }
  const stratum = (g) => (g.ai ? `ai:${g.ai.genre}:${g.ai.writer}` : `human:${g.any.source}`);
  // collapse writers of a genre where a stratum would be tiny (a stratum smaller than 3 groups is merged into "other")
  const byStratum = new Map();
  for (const [name, g] of info) { const s = stratum(g); (byStratum.get(s) || byStratum.set(s, []).get(s)).push(name); }
  const v5dev = v5.filter((r) => r.split === 'dev').length;
  const total = items.length + v5.length;
  const holdN = Math.round(0.25 * total);
  const devNew = Math.max(0, Math.round(0.25 * total) - v5dev);
  const fH = holdN / items.length;
  const fD = devNew / items.length;
  const splitOf = new Map();
  for (const [s, names] of byStratum) {
    const sorted = names.sort((a, b) => sha(`${SEED}:${a}`).localeCompare(sha(`${SEED}:${b}`)));
    const size = sorted.reduce((n, nm) => n + items.filter((i) => i.group === nm).length, 0);
    let seen = 0;
    for (const nm of sorted) {
      const n = items.filter((i) => i.group === nm).length;
      const pos = (seen + n / 2) / size; // middle of this group inside the stratum, 0..1
      splitOf.set(nm, pos < fH ? 'holdout' : pos < fH + fD ? 'dev' : 'train');
      seen += n;
    }
  }
  for (const it of items) it.split = splitOf.get(it.group);

  // --- version 5 texts (never holdout)
  for (const r of v5) {
    items.push({
      id: `v5-${r.id}`, label: r.label === 'human' ? 'human' : 'ai', edited: r.label === 'edited', writer: r.label === 'human' ? 'human' : r.writer, reportedModel: null,
      source: r.source === 'review5-agents' ? 'v5-claude-code' : `v5-${r.source}`, licence: r.label === 'human' ? 'see source (Liang MIT, RAID MIT, HC3 CC-BY-SA-4.0)' : 'model output written for this benchmark; local only',
      genre: r.genre, nonNative: /TOEFL/.test(r.domain || r.genre || '') || /TOEFL/.test(r.ref || ''), group: `v5:${r.id}`, topic: r.topic || null, style: r.style || null, text: r.text, words: words(r.text), origin: 'v5', split: r.split === 'dev' ? 'dev' : 'train',
    });
  }
  return { items, missing, fH, fD, dropped, earlierCount: earlier.size / 3, earlierFiles: eFiles.map((f) => path.relative(ROOT, f)) };
}

function main() {
  const { items, missing, fH, fD, dropped, earlierCount, earlierFiles } = build();
  if (missing.length) console.warn(`Missing AI texts (not in the corpus): ${missing.join(', ')}`);
  // groups never cross splits
  const gs = new Map();
  for (const it of items) { const s = gs.get(it.group) || new Set(); s.add(it.split); gs.set(it.group, s); }
  for (const [g, s] of gs) if (s.size > 1) throw new Error(`Group ${g} is in more than one split.`);
  if (items.some((i) => i.origin === 'v5' && i.split === 'holdout')) throw new Error('A version 5 text is in the holdout.');
  items.sort((a, b) => a.id.localeCompare(b.id));
  const out = items.map(({ id, label, edited, writer, reportedModel, source, licence, genre, nonNative, words: w, split, group, topic, style, ref, revision, origin, text }) =>
    ({ id, label, writer, source, licence, genre, nonNative: !!nonNative, words: w, split, text, group, origin, ...(edited ? { edited } : {}), ...(reportedModel ? { reportedModel } : {}), ...(topic ? { topic } : {}), ...(style ? { style } : {}), ...(ref ? { ref } : {}), ...(revision ? { revision } : {}) }));
  const hold = out.filter((o) => o.split === 'holdout').map((o) => ({ id: o.id, h: sha(o.text), o }));
  // The holdout review set (pre-registration, version 6): 18 AI texts (at least 14 by Claude) and 18 human texts (at least 6
  // non-native), in order of sha256("v6-review|" + id) within each cell: AI by Claude, AI by another model, human non-native, human other.
  const byReview = (arr) => arr.slice().sort((a, b) => sha(`v6-review|${a.id}`).localeCompare(sha(`v6-review|${b.id}`)));
  const claude = byReview(hold.filter((x) => x.o.label === 'ai' && /^claude/.test(x.o.writer)));
  const otherAi = byReview(hold.filter((x) => x.o.label === 'ai' && !/^claude/.test(x.o.writer)));
  const nn = byReview(hold.filter((x) => x.o.label === 'human' && x.o.nonNative));
  const huOther = byReview(hold.filter((x) => x.o.label === 'human' && !x.o.nonNative));
  const reviewAi = [...claude.slice(0, 18), ...otherAi.slice(0, Math.max(0, 18 - Math.min(18, claude.length)))].slice(0, 18);
  const reviewHu = [...nn.slice(0, 6), ...huOther.slice(0, 12)];
  if (reviewHu.length < 18) reviewHu.push(...nn.slice(6, 6 + 18 - reviewHu.length));
  const reviewIds = new Set([...reviewAi, ...reviewHu].map((x) => x.id));
  for (const o of out) o.review = o.split === 'holdout' && reviewIds.has(o.id);
  fs.writeFileSync(path.join(DATA, 'corpus.jsonl'), `${out.map((o) => JSON.stringify(o)).join('\n')}\n`);
  const lines = hold.map((x) => `${x.h}  ${x.id}${reviewIds.has(x.id) ? '  REVIEW' : ''}`);
  const listHash = sha(hold.map((x) => `${x.id}:${x.h}`).join('\n'));
  const reviewHash = sha([...reviewIds].sort().map((id) => `${id}:${hold.find((x) => x.id === id).h}`).join('\n'));
  fs.writeFileSync(path.join(DATA, 'holdout.sha256'), `${lines.join('\n')}\n${listHash}  HOLDOUT-LIST (sha256 of the lines "id:hash" in id order)\n${reviewHash}  HOLDOUT-REVIEW-SET (${reviewIds.size} texts marked REVIEW; sha256 of their "id:hash" lines in id order; cells ordered by sha256("v6-review|"+id): ${reviewAi.length} AI, ${reviewHu.length} human)\n`);
  const reviewStats = { ai: reviewAi.length, aiClaude: reviewAi.filter((x) => /^claude/.test(x.o.writer)).length, human: reviewHu.length, humanNonNative: reviewHu.filter((x) => x.o.nonNative).length };

  const count = (f) => out.reduce((m, o) => { const k = f(o); m[k] = (m[k] || 0) + 1; return m; }, {});
  const manifest = {
    built: new Date().toISOString(), seed: SEED, rule: 'whole corpus 50% train / 25% dev / 25% holdout by group; v5 dev -> dev, v5 test -> train, no v5 text in holdout', fractionsOfNewTexts: { holdout: +fH.toFixed(3), dev: +fD.toFixed(3) },
    total: out.length, bySplit: count((o) => o.split), byLabel: count((o) => o.label), byWriter: count((o) => o.writer), bySource: count((o) => o.source),
    bySplitLabel: count((o) => `${o.split}:${o.label}`), bySplitWriter: count((o) => `${o.split}:${o.writer}`), byGenre: count((o) => o.genre),
    nonNativeHuman: out.filter((o) => o.label === 'human' && o.nonNative).length, nonNativeHumanBySplit: count((o) => (o.label === 'human' && o.nonNative ? o.split : 'x')),
    wordsRange: { min: Math.min(...out.map((o) => o.words)), max: Math.max(...out.map((o) => o.words)) }, v5Texts: out.filter((o) => o.origin === 'v5').length,
    sources: {
      'wikipedia-before-2022-11-30': { licence: 'CC-BY-SA-4.0', url: 'https://en.wikipedia.org (MediaWiki API; last revision before 2022-11-30T00:00:00Z; title, page id and revision id kept in wiki.jsonl and in each corpus row ref/revision)', note: 'attribution: the Wikipedia article revision named in each row; share-alike applies to any redistribution, so the texts stay local' },
      'Liang2023-TOEFL': { licence: 'MIT', url: 'https://huggingface.co/datasets/WxWx/ChatGPT-Detector-Bias', note: 'non-native English writers; essays are mostly 90-148 words' },
      'DACTYL-ELLIPSE': { licence: 'MIT (DACTYL card)', url: 'https://huggingface.co/datasets/ShantanuT01/DACTYL', note: 'human student essays; ELL=True are English language learners' },
      'HC3-reddit_eli5': { licence: 'CC-BY-SA-4.0', url: 'https://huggingface.co/datasets/Hello-SimpleAI/HC3' },
      'RAID-abstracts/news': { licence: 'MIT', url: 'https://huggingface.co/datasets/liamdugan/raid' },
      'v6-claude-code': { licence: 'model output, local only', note: 'Claude Haiku/Sonnet/Opus 5.5 through Claude Code; reported model recorded per text' },
    },
    holdoutReviewSet: reviewStats, newTextCheck: { rule: 'a new text is dropped if its sha256 (raw, trimmed or whitespace-normalised) is in any earlier Lectern set', earlierTextsChecked: Math.round(earlierCount), earlierFiles, droppedMatches: dropped },
    missingAiTexts: missing,
  };
  fs.writeFileSync(path.join(DATA, 'manifest.json'), JSON.stringify(manifest, null, 1));
  console.log(JSON.stringify({ total: manifest.total, bySplit: manifest.bySplit, byLabel: manifest.byLabel, byWriter: manifest.byWriter, nonNativeHuman: manifest.nonNativeHuman, bySplitLabel: manifest.bySplitLabel }, null, 0));
}
if (require.main === module) main();
module.exports = { build };
