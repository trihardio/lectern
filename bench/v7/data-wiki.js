'use strict';
// Human texts for version 7: English Wikipedia article introductions on topic types not used in versions 5 and 6, each from the
// last revision made BEFORE 2022-11-30 (the release of ChatGPT). Written to bench/data/v7/wiki.jsonl (git-ignored). Text is
// available under CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/); each row keeps the title, page id, revision
// id and URL for attribution. Reuses introText() from bench/v6/data-wiki.js.
//
//   node bench/v7/data-wiki.js     fetches every title not yet in wiki.jsonl (two requests per title, at most one per second)
//
// Request etiquette: a generic User-Agent without personal details, one request at a time, a pause between requests.

const fs = require('fs');
const path = require('path');
const { introText } = require('../v6/data-wiki');

const API = 'https://en.wikipedia.org/w/api.php';
const UA = 'Lectern-benchmark/1.0 (research benchmark; low volume; no personal data)';
const CUTOFF = '2022-11-30T00:00:00Z';
const DATA = path.join(__dirname, '..', 'data', 'v7');
const OUT = path.join(DATA, 'wiki.jsonl');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// [kind, Wikipedia title]. Kinds: food, sport and hobby, instrument, maths, health, animal, myth and architecture, economy and language, weather and nature.
// None of these titles is a version 5 or version 6 topic.
const TITLES = [
  ['food', 'Pizza'], ['food', 'Sushi'], ['food', 'Espresso'], ['food', 'Sourdough'], ['food', 'Chocolate'], ['food', 'Tea'], ['food', 'Maple syrup'], ['food', 'Chopsticks'],
  ['sport', 'Chess'], ['sport', 'Poker'], ['sport', 'Basketball'], ['sport', 'Cricket'], ['sport', 'Marathon'], ['sport', 'Yoga'], ['sport', 'Origami'], ['sport', 'Knitting'], ['sport', 'Skateboarding'], ['sport', 'Surfing'],
  ['instrument', 'Violin'], ['instrument', 'Saxophone'], ['instrument', 'Accordion'],
  ['maths', 'Prime number'], ['maths', 'Pythagorean theorem'], ['maths', 'Fibonacci number'],
  ['health', 'Asthma'], ['health', 'Migraine'], ['health', 'Diabetes mellitus'], ['health', 'Sleep'],
  ['animal', 'Zebra'], ['animal', 'Giraffe'], ['animal', 'Penguin'], ['animal', 'Wolf'], ['animal', 'Hummingbird'], ['animal', 'Kangaroo'], ['animal', 'Bat'],
  ['culture', 'Greek mythology'], ['culture', 'Stonehenge'], ['culture', 'Colosseum'], ['culture', 'Gothic architecture'], ['culture', 'Skyscraper'], ['culture', 'Lighthouse'], ['culture', 'Umbrella'],
  ['economy', 'Supply and demand'], ['economy', 'Barter'], ['economy', 'Esperanto'], ['economy', 'Sign language'],
  ['nature', 'Volcano'], ['nature', 'Tornado'], ['nature', 'Glacier'], ['nature', 'Rainforest'], ['nature', 'Tide'], ['nature', 'Aurora'], ['nature', 'Tulip'],
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

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  const have = new Set(fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).query) : []);
  for (const [kind, title] of TITLES.filter(([, t]) => !have.has(t))) {
    try {
      const q = await get({ action: 'query', prop: 'revisions', titles: title, rvstart: CUTOFF, rvlimit: '1', rvprop: 'ids|timestamp', redirects: '1' });
      await sleep(1500);
      const page = q.query && q.query.pages && q.query.pages[0];
      const rev = page && page.revisions && page.revisions[0];
      if (!rev || rev.timestamp >= CUTOFF) { console.error(`${title}: no revision before the cutoff`); continue; }
      const p = await get({ action: 'parse', oldid: String(rev.revid), prop: 'text', section: '0', disablelimitreport: '1', disableeditsection: '1' });
      await sleep(1500);
      const text = introText(p.parse.text);
      const words = (text.match(/\S+/g) || []).length;
      const row = { query: title, kind, group: `topic:wiki:${page.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, title: page.title, pageid: page.pageid, revid: rev.revid, timestamp: rev.timestamp, url: `https://en.wikipedia.org/w/index.php?oldid=${rev.revid}`, licence: 'CC-BY-SA-4.0', words, text };
      fs.appendFileSync(OUT, `${JSON.stringify(row)}\n`);
      console.log(`${title}: rev ${rev.revid} (${rev.timestamp}), ${words} words`);
    } catch (e) { console.error(`${title}: ${e.message}`); }
  }
}
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { TITLES };
