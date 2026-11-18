'use strict';
// One place where every benchmark request to a paper database passes. It replaces global fetch() so the real
// Lectern code (server/sources/*) runs unchanged, and it does four things:
//  1. Caches every answer on disk, keyed by the request with all key and contact parameters removed, so each URL is
//     fetched once and a run can be replayed later with no network (offline mode fails on a miss).
//  2. Paces requests per host (one at a time, with a minimum gap) to stay inside each API's published limits.
//  3. Keeps a team-wide counter file of live requests, and a hard daily stop for OpenAlex (it bills a dollar
//     allowance that the owner's own use of Lectern shares).
//  4. Never stores or logs a key: keys travel only in the request that goes out, never in the cache key or the file.
//
// Limits and where they come from (read 2026-11-18, see README.md): OpenAlex search calls cost 1/1000 of a dollar
// each, filter-only lists a tenth of that, single-entity lookups nothing (agent B read developers.openalex.org);
// Semantic Scholar with a key allows 1 request per second on all endpoints; Crossref's public pool allows 1 list
// request per second, one at a time (crossref.org/blog/announcing-changes-to-rest-api-rate-limits/), so 1.1 s apart; Europe PMC publishes no hard
// figure, so the same 250 ms gap.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const DATA = path.join(__dirname, 'data');
const CACHE_DIR = path.join(DATA, 'cache');
let stateDir = DATA; // where the counter file, the pacing stamps and the host locks live (tests use a temporary folder)
const counterFile = () => path.join(stateDir, 'requests.json');

const SECRET_PARAMS = new Set(['api_key', 'apikey', 'key', 'mailto', 'email']);
const GAPS_MS = {
  'api.openalex.org': 200,
  'api.semanticscholar.org': 1100, // limit is 1 request per second with a key; 1.1 s leaves a margin
  'api.crossref.org': 1100, // public pool: list requests are limited to 1 per second, one at a time, since 2025-12-01
  'www.ebi.ac.uk': 250,
};
const DEFAULT_GAP_MS = 300;
const RETRY_PAUSES_MS = [3000, 8000]; // pauses before the 2nd and 3rd attempt at a request answered 429 or 503
// Dollars-per-1000 units: 750 search calls per UTC day, so 250 stay for the owner. BENCH_OPENALEX_STOP raises it for one
// run when the owner has agreed to spend more of the day's allowance (check x-ratelimit-remaining first).
const OPENALEX_DAILY_STOP = Number(process.env.BENCH_OPENALEX_STOP) || 750;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The request with key and contact parameters removed. This is the cache key and the only form ever written down. */
function cacheUrl(url) {
  const u = new URL(url);
  const keep = [];
  for (const [k, v] of u.searchParams) if (!SECRET_PARAMS.has(k.toLowerCase())) keep.push([k, v]);
  u.search = '';
  for (const [k, v] of keep) u.searchParams.append(k, v);
  return u.toString();
}

function keyOf(method, url, body) {
  const raw = `${method} ${cacheUrl(url)}${body ? `\n${body}` : ''}`;
  return { raw, hash: crypto.createHash('sha256').update(raw).digest('hex') };
}

/**
 * What a live OpenAlex request costs, in search-call units. A request counts as a search if any search parameter is
 * present, as its own parameter or inside filter= (search, search.semantic, search.title_and_abstract,
 * search.title_abstract_keywords); rerank=true counts double. Other list requests cost a tenth; a single entity is free.
 * (Agent B's reading of the OpenAlex pricing, 2026-11-18. The response header x-ratelimit-remaining is logged as a check.)
 */
function openalexCost(url) {
  const u = new URL(url);
  if (u.hostname !== 'api.openalex.org') return 0;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length !== 1) return 0; // /works/<id>, /works/https://doi.org/... : a single entity, free
  const isSearch = [...u.searchParams.keys()].some((k) => k === 'search' || k.startsWith('search.')) || /(^|[,|])search(\.[a-z_]+)?:/.test(u.searchParams.get('filter') || '');
  if (!isSearch) return 0.1;
  return u.searchParams.get('rerank') === 'true' ? 2 : 1;
}

const utcDay = () => new Date().toISOString().slice(0, 10);

/** Run fn while holding a lock directory, so two benchmark processes do not overwrite each other's counts. */
function withLock(fn) {
  const lock = `${counterFile()}.lock`;
  const start = Date.now();
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) fs.rmdirSync(lock); } catch { /* another process took it */ }
      if (Date.now() - start > 15000) throw new Error('The request counter is locked by another process.');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch { /* already gone */ } }
}

function readCounter() {
  try { return JSON.parse(fs.readFileSync(counterFile(), 'utf8')); } catch { return { days: {}, total: {} }; }
}

function writeCounter(c) {
  const tmp = `${counterFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 1));
  fs.renameSync(tmp, counterFile());
}

/** Record one live request; throws (before any request goes out) when OpenAlex's daily stop would be passed. */
function chargeLive(host, cost) {
  return withLock(() => {
    const c = readCounter();
    const day = utcDay();
    const d = c.days[day] || (c.days[day] = { openalexCost: 0, requests: {} });
    if (cost > 0 && d.openalexCost + cost > OPENALEX_DAILY_STOP + 1e-9) {
      const e = new Error(`OpenAlex daily stop: ${d.openalexCost.toFixed(1)} of ${OPENALEX_DAILY_STOP} search calls are used for ${day} (UTC). The rest is kept for the owner.`);
      e.code = 'BENCH_BUDGET';
      throw e;
    }
    d.openalexCost = Math.round((d.openalexCost + cost) * 10) / 10;
    d.requests[host] = (d.requests[host] || 0) + 1;
    c.total[host] = (c.total[host] || 0) + 1;
    writeCounter(c);
    return { openalexCost: d.openalexCost };
  });
}

/** Today's team-wide OpenAlex usage and the all-time live request counts (for run summaries). */
function counterSnapshot() {
  const c = readCounter();
  const d = c.days[utcDay()] || { openalexCost: 0, requests: {} };
  return { day: utcDay(), openalexCostToday: d.openalexCost, openalexStop: OPENALEX_DAILY_STOP, requestsToday: d.requests, requestsTotal: c.total };
}


const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/**
 * An exclusive lock for one host, held while a request to it is in flight and while its gap is waited out, so several
 * benchmark processes together stay inside one host's limit (Semantic Scholar 1 request a second, Crossref one at a time).
 * The lock is a directory holding the owner's pid; it is taken over when that process is gone or the lock is over 2
 * minutes old (a request times out after 20 s at most).
 */
async function acquireHostLock(host) {
  const dir = path.join(stateDir, 'locks');
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, `${host}.lock`);
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
      return () => { try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* already gone */ } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let stale = false;
      try {
        const pid = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8'));
        stale = (pid && !isAlive(pid)) || Date.now() - fs.statSync(lock).mtimeMs > 120000;
      } catch { stale = Date.now() - (fs.existsSync(lock) ? fs.statSync(lock).mtimeMs : 0) > 5000; } // pid not written yet, or the lock just vanished
      if (stale) { try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* someone else took it over */ } continue; }
      if (Date.now() - start > 20 * 60 * 1000) throw new Error(`Waited 20 minutes for the ${host} lock held by another benchmark process.`);
      await sleep(40 + Math.floor(Math.random() * 40));
    }
  }
}

/** When the last request to this host finished, from any process (the modified time of a stamp file). */
const stampFile = (host) => path.join(stateDir, 'locks', `${host}.stamp`);
const lastFinished = (host) => { try { return fs.statSync(stampFile(host)).mtimeMs; } catch { return 0; } };
const markFinished = (host) => { const f = stampFile(host); fs.writeFileSync(f, ''); const t = new Date(); fs.utimesSync(f, t, t); };

/**
 * Replace globalThis.fetch. Returns { stats, restore }.
 *  offline   never touch the network; a request not in the cache throws and is recorded in stats.misses
 *  cacheDir  where answers are kept (default bench/search/data/cache)
 *  maxLive   stop after this many live requests in this process (a guard against a runaway run)
 *  stateDir  where the shared counter, stamps and locks live (default bench/search/data)
 *  gaps      override the per-host gaps in milliseconds (tests)
 *  retryPausesMs  pauses before another attempt at a request answered 429 or 503 (tests)
 */
function install({ offline = false, cacheDir = CACHE_DIR, maxLive = Infinity, stateDir: sd, gaps = {}, retryPausesMs = RETRY_PAUSES_MS } = {}) {
  if (sd) { stateDir = sd; fs.mkdirSync(sd, { recursive: true }); }
  const realFetch = globalThis.fetch;
  fs.mkdirSync(cacheDir, { recursive: true });
  const stats = { hits: 0, live: 0, misses: [], failures: 0, retries: 0, byHost: {}, openalexRemaining: null };
  const tails = new Map(); // host -> promise chain, so each host is asked one request at a time

  const fileFor = (hash) => path.join(cacheDir, hash.slice(0, 2), `${hash}.json.gz`);

  async function cachedFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : (input.url || String(input));
    const u = new URL(url);
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return realFetch(input, init);
    const method = (init.method || 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? init.body : '';
    const { raw, hash } = keyOf(method, url, body);
    const file = fileFor(hash);

    const serveCached = () => {
      const rec = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
      stats.hits++;
      return new Response(rec.body, { status: rec.status, headers: { 'content-type': rec.contentType || 'application/json' } });
    };
    if (fs.existsSync(file)) return serveCached();
    if (offline) {
      stats.misses.push(raw);
      const e = new Error(`Offline replay: no cached answer for ${cacheUrl(url)}`);
      e.code = 'BENCH_CACHE_MISS';
      throw e;
    }
    if (stats.live >= maxLive) {
      const e = new Error(`Run stopped: ${maxLive} live requests already sent in this process (--max-live).`);
      e.code = 'BENCH_BUDGET';
      throw e;
    }

    // One request at a time per host across all benchmark processes, with the host's minimum gap after the last one.
    // The answer's body is read before the lock is released, so "one at a time" covers the whole transfer.
    const host = u.hostname;
    const gap = gaps[host] !== undefined ? gaps[host] : (GAPS_MS[host] || DEFAULT_GAP_MS);
    const prev = tails.get(host) || Promise.resolve();
    const turn = prev.then(async () => {
      const release = await acquireHostLock(host);
      try {
        if (fs.existsSync(file)) return { fromCache: true }; // another process fetched it while this one waited
        // A busy answer (429, or 503) is retried here, still inside the host lock, after a growing pause, so every
        // attempt is paced, counted and charged. Semantic Scholar answers 429 now and then even at one request a second.
        for (let attempt = 0; ; attempt++) {
          const wait = lastFinished(host) + gap - Date.now();
          if (wait > 0) await sleep(wait);
          chargeLive(host, openalexCost(url)); // may throw BENCH_BUDGET: nothing has been sent yet
          stats.live++;
          stats.byHost[host] = (stats.byHost[host] || 0) + 1;
          try {
            const r = await realFetch(input, init);
            // OpenAlex reports the credits left in a header ($1 = 10,000 credits). Only this number is kept, never any header of ours.
            if (host === 'api.openalex.org') { const left = Number(r.headers.get('x-ratelimit-remaining')); if (Number.isFinite(left)) stats.openalexRemaining = left; }
            if ((r.status === 429 || r.status === 503) && attempt < retryPausesMs.length) { stats.retries++; await r.text().catch(() => ''); await sleep(retryPausesMs[attempt]); continue; }
            const keep = r.status === 200 || r.status === 404;
            return { status: r.status, contentType: r.headers.get('content-type') || '', text: keep ? await r.text() : null, response: keep ? null : r };
          } finally { markFinished(host); }
        }
      } finally { release(); }
    });
    tails.set(host, turn.catch(() => {}));
    const got = await turn;
    if (got.fromCache) return serveCached();

    // Keep only complete answers: success, and "not found" (a definite answer). Rate limits and server errors are retried, not kept.
    if (got.text !== null) {
      const rec = { url: cacheUrl(url), status: got.status, contentType: got.contentType, savedAt: new Date().toISOString(), body: got.text };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify(rec)));
      fs.renameSync(tmp, file);
      return new Response(got.text, { status: got.status, headers: { 'content-type': got.contentType || 'application/json' } });
    }
    stats.failures++;
    return got.response;
  }

  globalThis.fetch = cachedFetch;
  return { stats, restore: () => { globalThis.fetch = realFetch; } };
}

module.exports = { install, cacheUrl, keyOf, openalexCost, counterSnapshot, chargeLive, GAPS_MS, OPENALEX_DAILY_STOP, CACHE_DIR, DATA };
