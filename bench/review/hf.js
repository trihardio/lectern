'use strict';
// Polite, cached access to public Hugging Face pages for bench/review. No login, no bypass: on a 429 it waits and retries.
// Cache files live under bench/data/review/cache (git-ignored). The User-Agent says what this is.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE = path.join(__dirname, '..', 'data', 'review', 'cache');
const UA = { 'user-agent': 'Lectern-bench/0.2 (research evaluation of a writing-pattern review)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cacheFile = (url, json = true) => path.join(CACHE, crypto.createHash('sha1').update(url).digest('hex') + (json ? '.json' : '.txt'));

/** GET a URL as text or JSON, cached by URL. Retries with growing waits on 429 and 5xx. */
async function get(url, { json = true, spacingMs = 500 } = {}) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = cacheFile(url, json);
  if (fs.existsSync(file)) { const s = fs.readFileSync(file, 'utf8'); return json ? JSON.parse(s) : s; }
  let last = '';
  for (let i = 0; i < 8; i++) {
    await sleep(spacingMs * (i + 1));
    try {
      const r = await fetch(url, { headers: UA, redirect: 'follow' });
      if (r.ok) { const s = await r.text(); fs.writeFileSync(file, s); return json ? JSON.parse(s) : s; }
      last = `HTTP ${r.status}`;
      if (r.status !== 429 && r.status < 500) break;
      await sleep(3000 * 2 ** i);
    } catch (e) { last = e.message; await sleep(2000 * 2 ** i); }
  }
  throw new Error(`Could not fetch ${url}: ${last}`);
}

module.exports = { get, sleep, CACHE, cacheFile };
