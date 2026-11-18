'use strict';
// Human texts for the version 6 corpus: English Wikipedia article introductions, each from the last revision made
// BEFORE 2022-11-30 (the release of ChatGPT), so none can be AI-written. Written to bench/data/v6/wiki.jsonl
// (git-ignored). Text is available under CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/); each row
// keeps the page title, page id, revision id and URL for attribution.
//
//   node bench/v6/data-wiki.js          fetches every title not yet in wiki.jsonl (two requests per title, at most one per second)
//
// Request etiquette: a generic User-Agent without personal details, one request at a time, a pause between requests.

const fs = require('fs');
const path = require('path');
const { ENCYCLOPEDIC, DATA } = require('./data-plan');

const API = 'https://en.wikipedia.org/w/api.php';
const UA = 'Lectern-benchmark/1.0 (research benchmark; low volume; no personal data)';
const CUTOFF = '2022-11-30T00:00:00Z';
const OUT = path.join(DATA, 'wiki.jsonl');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pairs for the short-answer questions in data-plan.js: [group id, Wikipedia title].
const EXTRA = [
  ['shortanswer:why-is-the-sky-blue', 'Diffuse sky radiation'], ['shortanswer:how-do-vaccines-work', 'Vaccine'], ['shortanswer:what-causes-inflation', 'Inflation'],
  ['shortanswer:why-do-cats-purr', 'Purr'], ['shortanswer:how-does-a-refrigerator-keep-food-cold', 'Refrigerator'], ['shortanswer:why-do-we-dream', 'Dream'],
  ['shortanswer:how-do-airplanes-stay-in-the-air', 'Lift (force)'], ['shortanswer:what-is-a-blockchain', 'Blockchain'], ['shortanswer:why-is-the-ocean-salty', 'Seawater'],
  ['shortanswer:how-does-compound-interest-work', 'Compound interest'], ['shortanswer:what-happened-to-the-dinosaurs', 'Cretaceous–Paleogene extinction event'],
  ['shortanswer:how-do-noise-cancelling-headphones-work', 'Active noise control'],
  // more topic-type matches for the report, essay and blog genres
  ['blog:why-i-switched-to-a-standing-desk', 'Standing desk'], ['blog:the-joy-of-second-hand-bookshops', 'Used book'], ['blog:how-to-learn-guitar-as-an-adult', 'Guitar'],
  ['blog:why-old-video-games-still-matter', 'Retro gaming'], ['blog:choosing-your-first-road-bike', 'Road bicycle'], ['blog:how-to-start-a-vegetable-garden', 'Vegetable garden'],
];

async function get(params) {
  const url = `${API}?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Api-User-Agent': UA } });
    if (res.status === 429 || res.status >= 500) { await sleep(5000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  throw new Error('Wikipedia kept refusing; stopping.');
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—' };
function decode(s) {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in ENT ? ENT[n.toLowerCase()] : m));
}

/** Paragraph text of the introduction: the <p> elements only (infobox, hatnotes and tables are dropped), references and pronunciations removed. */
function introText(html) {
  let h = html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<table[\s\S]*?<\/table>/g, '').replace(/<sup[^>]*>[\s\S]*?<\/sup>/g, '')
    .replace(/<span[^>]*class="[^"]*(?:noprint|mw-editsection|reference)[^"]*"[^>]*>[\s\S]*?<\/span>/g, '');
  const paras = [];
  for (const m of h.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)) {
    let t = decode(m[1].replace(/<[^>]+>/g, ''));
    t = t.replace(/\[(?:\d+|[a-z]|citation needed|note \d+)\]/gi, '');
    t = t.replace(/\s*\((?:[^()]*[ˈˌəɪʊɒæɛʃʒθðŋ\/][^()]*|[^()]*\blisten\b[^()]*)\)/g, (x) => (/[ˈˌəɪʊɒæɛʃʒθðŋ]|listen|\/[^/]+\//.test(x) ? '' : x));
    t = t.replace(/\(\s*[;,]?\s*\)/g, '').replace(/\s*\(\s*;\s*/g, ' (').replace(/\s+/g, ' ').replace(/ ([,.;:])/g, '$1').trim();
    if (t && !/^coordinates\b/i.test(t)) paras.push(t);
  }
  const words = (t) => (t.match(/\S+/g) || []).length;
  const out = [];
  let n = 0;
  for (const p of paras) { if (out.length && n + words(p) > 400) break; out.push(p); n += words(p); }
  return out.join('\n\n');
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  const have = new Set(fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).group) : []);
  const todo = [...ENCYCLOPEDIC.map(([g, , title]) => [`topic:${g}`, title]), ...EXTRA.map(([g, title]) => [`topic:${g}`, title])].filter(([g]) => !have.has(g));
  for (const [group, title] of todo) {
    try {
      const q = await get({ action: 'query', prop: 'revisions', titles: title, rvstart: CUTOFF, rvlimit: '1', rvprop: 'ids|timestamp', redirects: '1' });
      await sleep(2500);
      const page = q.query && q.query.pages && q.query.pages[0];
      const rev = page && page.revisions && page.revisions[0];
      if (!rev || rev.timestamp >= CUTOFF) { console.error(`${title}: no revision before the cutoff`); continue; }
      const p = await get({ action: 'parse', oldid: String(rev.revid), prop: 'text', section: '0', disablelimitreport: '1', disableeditsection: '1' });
      await sleep(2500);
      const text = introText(p.parse.text);
      const words = (text.match(/\S+/g) || []).length;
      const row = { group, title: page.title, pageid: page.pageid, revid: rev.revid, timestamp: rev.timestamp, url: `https://en.wikipedia.org/w/index.php?oldid=${rev.revid}`, licence: 'CC-BY-SA-4.0', words, text };
      fs.appendFileSync(OUT, `${JSON.stringify(row)}\n`);
      console.log(`${title}: rev ${rev.revid} (${rev.timestamp}), ${words} words`);
    } catch (e) { console.error(`${title}: ${e.message}`); }
  }
}
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { introText };
