'use strict';
// Download a reproducible, labelled sample of human, AI and AI-edited writing for the benchmark.
//
//   node bench/fetch.js            -> bench/data/items.jsonl (texts, git-ignored) and bench/data/manifest.json (no texts)
//
// Sources (all public, no account needed; labels are each dataset's own claim, not verified by Lectern):
//   HC3   Hello-SimpleAI/HC3, config "all", CC-BY-SA-4.0. Human answers vs ChatGPT (Dec 2022-Jan 2023) answers.
//         Rows 0-99 are EXCLUDED: the AI score accuracy audit (2026-11-15) inspected them.
//   RAID  liamdugan/raid, config "raid", split "train", MIT. Human text and 11 generators, 8 domains, attacks.
//   Liang WxWx/ChatGPT-Detector-Bias, MIT. TOEFL essays by non-native writers, the same essays polished by GPT-4,
//         native student essays and GPT-3 essays. Used ONLY in the holdout, as an independent, out-of-domain set.
// Sampling is seeded and recorded, so the same command gives the same sample while the sources are unchanged.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { rng } = require('./metrics');

const OUT = path.join(__dirname, 'data');
const UA = { 'user-agent': 'Lectern-bench/0.1 (research evaluation of a writing-pattern review)' };
const SEED = 20261115;
const API = 'https://datasets-server.huggingface.co/rows';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wordCount = (s) => (String(s).match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) || []).length;
const hash = (s) => crypto.createHash('sha256').update(String(s).replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex');
const MIN_WORDS = 80;
const MAX_WORDS = 1200;
const skipped = []; // pages the server would not return; recorded in the manifest
const RAID_DOMAINS = new Set(['abstracts', 'books', 'news', 'reddit', 'reviews', 'wiki']); // English prose only

/** GET JSON with a page cache (bench/data/cache) and patient retries for rate limits. */
async function getJson(url, tries = 7) {
  const file = path.join(OUT, 'cache', `${crypto.createHash('sha1').update(url).digest('hex')}.json`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* not cached yet */ }
  let last = '';
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (r.ok) { const j = await r.json(); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(j)); return j; }
      last = `HTTP ${r.status}`;
      if (r.status !== 429 && r.status < 500) break;
    } catch (e) { last = e.message; }
    await sleep(2000 * 2 ** i);
  }
  throw new Error(`${last} for ${url}`);
}
const rows = (dataset, config, split, offset, length = 100) => getJson(`${API}?${new URLSearchParams({ dataset, config, split, offset: String(offset), length: String(length) })}`);

/** Seeded page offsets in [lo, hi), multiples of 100, no repeats. */
function pages(seed, lo, hi, count) {
  const r = rng(seed);
  const set = new Set();
  while (set.size < count) set.add(lo + Math.floor((r() * (hi - lo)) / 100) * 100);
  return [...set].sort((a, b) => a - b);
}

async function hc3(items) {
  const total = 24322;
  for (const offset of pages(SEED, 100, total - 100, 8)) {
    let page;
    try { page = await rows('Hello-SimpleAI/HC3', 'all', 'train', offset); } catch (e) { skipped.push(`HC3/all/train offset ${offset}: ${e.message}`); console.log(`skipped HC3 page ${offset}`); continue; }
    page.rows.forEach(({ row, row_idx: idx }) => {
      const human = (row.human_answers || [])[0];
      const ai = (row.chatgpt_answers || [])[0];
      if (idx < 100) return; // never the audit's rows
      for (const [label, text] of [['human', human], ['ai', ai]]) {
        const n = wordCount(text);
        if (!text || n < MIN_WORDS || n > MAX_WORDS) continue;
        items.push({ source: 'HC3', ref: `HC3/all/train/${idx}/${label}`, group: `hc3:${row.id}`, label, text, words: n,
          domain: row.source || 'unknown', generator: label === 'ai' ? 'ChatGPT (2022-23)' : 'human', attack: 'none', writer: 'unspecified' });
      }
    });
    await sleep(300);
  }
}

async function raid(items) {
  const total = 2270000;
  for (const offset of pages(SEED + 1, 0, total - 100, 36)) {
    let page;
    try { page = await rows('liamdugan/raid', 'raid', 'train', offset); } catch (e) { skipped.push(`raid/train offset ${offset}: ${e.message}`); console.log(`skipped RAID page ${offset}`); continue; }
    for (const { row, row_idx: idx } of page.rows) {
      if (!RAID_DOMAINS.has(row.domain)) continue;
      const n = wordCount(row.generation);
      if (n < MIN_WORDS || n > MAX_WORDS) continue;
      const human = row.model === 'human';
      items.push({ source: 'RAID', ref: `raid/train/${idx}`, group: `raid:${row.domain}:${row.title}`, label: human ? 'human' : 'ai', text: row.generation, words: n,
        domain: row.domain, generator: human ? 'human' : row.model, attack: row.attack || 'none', writer: 'unspecified', decoding: row.decoding || null });
    }
    await sleep(300);
  }
}

/** RAID's human texts sit in small blocks between long runs of one generator, so random pages miss them:
 *  sample them per domain through the datasets server's filter endpoint (seeded offsets). */
async function raidHumans(items) {
  let d = 0;
  for (const domain of RAID_DOMAINS) {
    const where = `"model"='human' AND "attack"='none' AND "domain"='${domain}'`;
    const url = (offset) => `https://datasets-server.huggingface.co/filter?${new URLSearchParams({ dataset: 'liamdugan/raid', config: 'raid', split: 'train', where, offset: String(offset), length: '100' })}`;
    let first;
    try { first = await getJson(url(0)); } catch (e) { skipped.push(`raid humans ${domain}: ${e.message}`); continue; }
    const total = first.num_rows_total || 0;
    const offsets = total > 200 ? pages(SEED + 10 + d, 0, total - 100, 2) : [0];
    for (const offset of offsets) {
      let page;
      try { page = offset === 0 ? first : await getJson(url(offset)); } catch (e) { skipped.push(`raid humans ${domain} offset ${offset}: ${e.message}`); continue; }
      for (const { row, row_idx: idx } of page.rows) {
        const n = wordCount(row.generation);
        if (n < MIN_WORDS || n > MAX_WORDS) continue;
        items.push({ source: 'RAID', ref: `raid/train/${idx}`, group: `raid:${row.domain}:${row.title}`, label: 'human', text: row.generation, words: n,
          domain: row.domain, generator: 'human', attack: 'none', writer: 'unspecified', decoding: null });
      }
      await sleep(300);
    }
    d++;
  }
}

async function liang(items) {
  const r = await fetch('https://huggingface.co/datasets/WxWx/ChatGPT-Detector-Bias/resolve/main/all_data.json', { headers: UA });
  if (!r.ok) throw new Error(`Liang data: HTTP ${r.status}`);
  const data = await r.json();
  const seen = new Map();
  for (const x of data) {
    const n = wordCount(x.text);
    if (n < 40) continue; // the review needs at least 40 words; shorter essays are skipped and counted in the manifest
    const k = seen.get(x.domain) || 0;
    seen.set(x.domain, k + 1);
    const polished = /gpt4polished/i.test(x.domain);
    const label = polished ? 'mixed' : x.kind === 'Human-Written' ? 'human' : 'ai';
    items.push({ source: 'Liang2023', ref: `Liang2023/${x.domain}/${k}`, group: `liang:${x.domain}:${k}`, label, text: x.text, words: n,
      domain: x.domain.replace(/_\d+$/, ''), generator: label === 'human' ? 'human' : x.model, attack: polished ? 'human text polished by GPT-4' : 'none',
      writer: /TOEFL/i.test(x.domain) ? 'non-native (TOEFL)' : 'student, unspecified', holdoutOnly: true });
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const items = [];
  const log = [];
  for (const [name, f] of [['HC3', hc3], ['RAID', raid], ['RAID humans', raidHumans], ['Liang2023', liang]]) {
    const before = items.length;
    await f(items);
    log.push(`${name}: ${items.length - before} items`);
    console.log(log[log.length - 1]);
  }
  // exact duplicates (after whitespace and case folding) are kept once
  const byHash = new Map();
  for (const it of items) { it.hash = hash(it.text); if (!byHash.has(it.hash)) byHash.set(it.hash, it); }
  const unique = [...byHash.values()];
  fs.writeFileSync(path.join(OUT, 'items.jsonl'), unique.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const count = (f) => unique.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
  const manifest = {
    created: new Date().toISOString(), seed: SEED, minWords: MIN_WORDS, maxWords: MAX_WORDS,
    sources: {
      HC3: { url: 'https://huggingface.co/datasets/Hello-SimpleAI/HC3', license: 'CC-BY-SA-4.0', citation: 'Guo et al. 2023, arXiv:2301.07597', note: 'config all, train; rows 0-99 excluded (audit sample)' },
      RAID: { url: 'https://huggingface.co/datasets/liamdugan/raid', license: 'MIT', citation: 'Dugan et al. 2024, ACL, arXiv:2405.07940', note: `config raid, train; domains ${[...RAID_DOMAINS].join(', ')}` },
      Liang2023: { url: 'https://huggingface.co/datasets/WxWx/ChatGPT-Detector-Bias', license: 'MIT', citation: 'Liang et al. 2023, Patterns, doi:10.1016/j.patter.2023.100779', note: 'holdout only; TOEFL gpt4polished is labelled "mixed" (human text edited by AI)' },
    },
    duplicatesDropped: items.length - unique.length,
    skippedPages: skipped,
    counts: { bySource: count((x) => x.source), byLabel: count((x) => x.label), bySourceLabel: count((x) => `${x.source}:${x.label}`) },
    items: unique.map(({ text, ...rest }) => rest), // everything but the text: ids, labels, groups, hashes
  };
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
  console.log(`unique items: ${unique.length} (dropped ${manifest.duplicatesDropped} duplicates)`, JSON.stringify(manifest.counts.bySourceLabel));
})().catch((e) => { console.error(e); process.exit(1); });
