'use strict';
// Similarity (plagiarism) check. A source is reported only after its text has been fetched and compared
// with the submission word by word here, so a model can suggest where to look but can never invent a
// match. Candidate sources come from three places:
//   1. the paper databases Lectern already uses (titles and abstracts),
//   2. papers saved in the user's Library,
//   3. web pages found by the signed-in model's web search for the text's most distinctive passages.
// Matching: identical runs of 6-word sequences ("shingles", Broder 1997), merged across small edits, and
// close paraphrase (most of a sentence's content words appear together in one source sentence).
// Limits, stated in the window: no access to other students' submissions or paywalled full texts.

const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');
const { Readable } = require('stream');
const llm = require('../llm');
const Prompts = require('../prompts');
const { extractJson, httpUrl } = require('../util');
const { searchAll, merge } = require('../sources');
const { htmlText, pdfText, decodeEntities } = require('./extract');
const T = require('./text');

const K = 6;               // words per shingle
const MIN_MATCH = 8;       // shortest run of matching words that counts
const MAX_GAP = 3;         // words that may differ inside one matching run
const PAGE_BYTES = 6 * 1024 * 1024;
const UA = `Lectern/${require('../../package.json').version} (desktop research app; similarity check)`;
const ROBOTS_RULE_MAX = 512;   // characters; a longer robots.txt rule is ignored
const ROBOTS_RULES_MAX = 4000; // rules kept from one robots.txt

const STOP = new Set(`a about above after again against all also am an and any are as at be because been before being below between both but by can
could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its itself just
me more most my no nor not now of off on once only or other our ours out over own same she should so some such than that the their theirs them then
there these they this those through to too under until up very was we were what when where which while who whom why will with would you your
yours however thus therefore also may might must shall one two three first second new used using use based within without among upon via per`.split(/\s+/));

const stem = (w) => w.replace(/'s$/, '').replace(/(?:ingly|edly|ations?|ments?|ness|ities|ity|ingly|ing|ed|ly|ies|es|s)$/, (m) => (w.length - m.length >= 4 ? '' : m));
const contentStems = (ws) => ws.map((w) => w.lower).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)).map(stem);

function hashGram(ws, i) {
  let h = 2166136261;
  for (let k = i; k < i + K; k++) {
    const s = ws[k].lower;
    for (let c = 0; c < s.length; c++) { h ^= s.charCodeAt(c); h = Math.imul(h, 16777619); }
    h ^= 32; h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Index a source once: shingles, sentences, content words. */
function indexSource(text) {
  const ws = T.words(text);
  const grams = new Map();
  for (let i = 0; i + K <= ws.length; i++) {
    const g = hashGram(ws, i);
    const list = grams.get(g);
    if (!list) grams.set(g, [i]); else if (list.length < 8) list.push(i);
  }
  const { sentences } = T.segment(text);
  const sents = sentences.map((s) => ({ start: s.start, end: s.end, stems: new Set(contentStems(T.words(s.text))) })).filter((s) => s.stems.size >= 5);
  const inverted = new Map();
  sents.forEach((s, k) => { for (const st of s.stems) { const l = inverted.get(st); if (!l) inverted.set(st, [k]); else if (l.length < 400) l.push(k); } });
  return { text, ws, grams, sents, inverted };
}

/**
 * Compare a submission with one indexed source.
 * Returns [{ from, to, type, srcStart, srcEnd }] in submission word positions (to exclusive).
 */
function compare(sub, src, { skip }) {
  const n = sub.ws.length;
  const hit = new Int32Array(n).fill(-1); // source word position aligned with each submission word
  for (let i = 0; i + K <= n; i++) {
    const list = (src.grams.get(sub.gramAt[i]) || []).filter((p) =>
      sub.ws.slice(i, i + K).every((w, k) => w.lower === src.ws[p + k].lower));
    if (!list.length) continue;
    // Prefer the source position that continues the previous match (keeps one alignment per run).
    let p = list[0];
    if (i > 0 && hit[i - 1] >= 0) { const want = hit[i - 1] + 1; if (list.includes(want)) p = want; }
    for (let k = 0; k < K; k++) if (hit[i + k] < 0) hit[i + k] = p + k;
  }
  const out = [];
  let i = 0;
  while (i < n) {
    if (hit[i] < 0 || skip[i]) { i++; continue; }
    let j = i;
    let last = i;
    while (j < n) {
      if (hit[j] >= 0 && !skip[j]) { last = j; j++; continue; }
      let gap = 0;
      while (j + gap < n && (hit[j + gap] < 0 || skip[j + gap]) && gap <= MAX_GAP) gap++;
      if (gap <= MAX_GAP && j + gap < n && hit[j + gap] >= 0 && Math.abs(hit[j + gap] - hit[last] - (j + gap - last)) <= MAX_GAP) { j += gap; continue; }
      break;
    }
    const matched = [];
    for (let k = i; k <= last; k++) if (hit[k] >= 0) matched.push(hit[k]);
    if (last - i + 1 >= MIN_MATCH) out.push({ from: i, to: last + 1, type: 'exact', srcFrom: Math.min(...matched), srcTo: Math.max(...matched) + 1 });
    i = last + 1;
  }

  // Close paraphrase, sentence by sentence, where no exact run already covers most of the sentence.
  for (const s of sub.sents) {
    if (s.to - s.from < 8 || s.stems.size < 6) continue;
    let covered = 0;
    for (const m of out) covered += Math.max(0, Math.min(m.to, s.to) - Math.max(m.from, s.from));
    if (covered > (s.to - s.from) / 2) continue;
    let skipCount = 0;
    for (let k = s.from; k < s.to; k++) if (skip[k]) skipCount++;
    if (skipCount > (s.to - s.from) / 2) continue;
    const counts = new Map();
    for (const st of s.stems) for (const k of src.inverted.get(st) || []) counts.set(k, (counts.get(k) || 0) + 1);
    let best = -1;
    let bestScore = 0;
    for (const [k, c] of counts) {
      const size = src.sents[k].stems.size;
      if (c < 6 || size > s.stems.size * 3) continue;
      const containment = c / s.stems.size;
      const dice = (2 * c) / (s.stems.size + size);
      const score = Math.min(containment, dice + 0.15);
      if (score > bestScore) { bestScore = score; best = k; }
    }
    if (best >= 0 && bestScore >= 0.6) {
      out.push({ from: s.from, to: s.to, type: 'paraphrase', similarity: Math.round(bestScore * 100), srcStart: src.sents[best].start, srcEnd: src.sents[best].end });
    }
  }
  return out;
}

/** Prepare the submission once: words, shingles, sentences in word positions, and excluded words. */
function prepareSubmission(text, options) {
  const ws = T.words(text);
  const gramAt = new Uint32Array(Math.max(0, ws.length));
  for (let i = 0; i + K <= ws.length; i++) gramAt[i] = hashGram(ws, i);
  const excluded = T.exclusions(text, options);
  const skip = new Uint8Array(ws.length);
  ws.forEach((w, k) => { if (T.inRanges(w.start, excluded)) skip[k] = 1; });
  const { sentences } = T.segment(text);
  let wi = 0;
  const sents = sentences.map((s) => {
    while (wi < ws.length && ws[wi].start < s.start) wi++;
    const from = wi;
    while (wi < ws.length && ws[wi].start < s.end) wi++;
    return { ...s, from, to: wi, stems: new Set(contentStems(ws.slice(from, wi))) };
  });
  return { text, ws, gramAt, skip, sents, excluded };
}

/** The most distinctive passages: long words, numbers and names, spread across the text. */
function pickPassages(sub, count = 10) {
  const scored = sub.sents
    .filter((s) => s.to - s.from >= 10 && s.to - s.from <= 70 && !sub.skip[s.from])
    .map((s) => {
      const ws = sub.ws.slice(s.from, s.to);
      const score = ws.filter((w) => w.w.length >= 7).length + 2 * ws.filter((w) => /\d/.test(w.w)).length + ws.slice(1).filter((w) => /^\p{Lu}/u.test(w.w)).length;
      return { s, score };
    });
  if (!scored.length) return [];
  const per = Math.max(1, Math.ceil(scored.length / count));
  const out = [];
  for (let k = 0; k < scored.length; k += per) {
    const group = scored.slice(k, k + per).sort((a, b) => b.score - a.score);
    out.push(group[0].s);
  }
  return out.slice(0, count);
}

/** A keyword query for the paper databases from one passage: its most distinctive words, in order. */
function passageQuery(sub, s) {
  const ws = sub.ws.slice(s.from, s.to).filter((w) => !STOP.has(w.lower) && w.w.length > 2);
  const ranked = ws.map((w, k) => ({ w, k, score: w.w.length + (/\d/.test(w.w) ? 4 : 0) })).sort((a, b) => b.score - a.score).slice(0, 9).sort((a, b) => a.k - b.k);
  return ranked.map((x) => x.w.w).join(' ');
}

// ------------------------------------------------------------------ safe fetching of web pages

/** An IPv6 address as eight 16-bit numbers, or null. Handles "::" and a dotted IPv4 tail ("::ffff:10.0.0.1"). */
function ipv6Words(ip) {
  let v = String(ip).toLowerCase().replace(/%.*$/, ''); // drop a zone ("fe80::1%en0")
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (tail) {
    if (!net.isIPv4(tail[1])) return null;
    const [a, b, c, d] = tail[1].split('.').map(Number);
    v = v.slice(0, -tail[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = v.split('::');
  if (halves.length > 2) return null;
  const part = (s) => (s ? s.split(':') : []);
  const head = part(halves[0]);
  const rest = halves.length === 2 ? part(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const words = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...rest];
  if (words.some((w) => !/^[0-9a-f]{1,4}$/.test(w))) return null;
  return words.map((w) => parseInt(w, 16));
}

const ipv4Of = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * Is this address on this computer, on the local network, or otherwise not a public web server?
 * IPv6 forms that carry an IPv4 address (mapped, compatible, NAT64, 6to4) are judged by that IPv4 address.
 */
function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const w = ipv6Words(ip);
  if (!w) return true; // not an address we can judge: refuse it
  const zeros = (from, to) => w.slice(from, to).every((x) => x === 0);
  if (zeros(0, 8)) return true;                                   // ::
  if ((w[0] & 0xfe00) === 0xfc00) return true;                    // fc00::/7 unique local
  if ((w[0] & 0xffc0) === 0xfe80 || (w[0] & 0xffc0) === 0xfec0) return true; // fe80::/10 link-local, fec0::/10 site-local
  if ((w[0] & 0xff00) === 0xff00) return true;                    // ff00::/8 multicast
  if (zeros(0, 6)) return privateAddress(ipv4Of(w[6], w[7]));     // ::/96 IPv4-compatible (and ::1)
  if (zeros(0, 5) && w[5] === 0xffff) return privateAddress(ipv4Of(w[6], w[7])); // ::ffff:0:0/96 IPv4-mapped
  if (zeros(0, 4) && w[4] === 0xffff && w[5] === 0) return privateAddress(ipv4Of(w[6], w[7])); // ::ffff:0:0:0/96 translated
  if (w[0] === 0x64 && w[1] === 0xff9b && (zeros(2, 6) || w[2] === 1)) return privateAddress(ipv4Of(w[6], w[7])); // 64:ff9b::/96, 64:ff9b:1::/48 NAT64
  if (w[0] === 0x2002) return privateAddress(ipv4Of(w[1], w[2])); // 2002::/16 6to4
  return false;
}

/**
 * GET a URL over a connection pinned to the addresses that were already checked (closes the DNS-rebinding gap).
 * Resolves a fetch Response. A status that a Response cannot carry (outside 200-599, such as the 999 LinkedIn
 * sends to robots) is an error, and 204, 205 and 304 get an empty body: building a Response from them would
 * throw inside the socket callback, where nothing can catch it, and stop the whole app.
 */
function publicRequest(url, options, addresses) {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).get(url, {
      headers: options.headers, signal: options.signal,
      lookup: (_host, opts, cb) => opts.all ? cb(null, addresses) : cb(null, addresses[0].address, addresses[0].family),
    }, (res) => {
      const status = res.statusCode;
      if (!(status >= 200 && status <= 599)) {
        res.destroy();
        reject(Object.assign(new Error(`the site answered ${status}`), { status }));
        return;
      }
      try {
        const empty = status === 204 || status === 205 || status === 304;
        if (empty) res.resume();
        resolve(new Response(empty ? null : Readable.toWeb(res), { status, headers: res.headers }));
      } catch (e) {
        res.destroy();
        reject(Object.assign(new Error('the site sent a reply that could not be read'), { status, cause: e }));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Fetch a public web page. Refuses addresses on this computer or the local network (a page suggested
 * by a model must never reach the user's router or this app's own server), follows at most 4
 * redirects (each one checked), caps the size and the time.
 */
async function safeFetch(url, { signal, lookup = dns.lookup, accept = 'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.8', timeout = 12000 } = {}) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    let u;
    try { u = new URL(current); } catch { throw new Error('not a valid address'); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('not a web address');
    if (u.username || u.password) throw new Error('address with a password');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (/^(localhost|.*\.local|.*\.localhost|.*\.internal|.*\.lan|.*\.home)$/i.test(host)) throw new Error('local address');
    const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    if (!addrs.length || addrs.some((a) => privateAddress(a.address))) throw new Error('local network address');
    if (u.port && u.port !== '80' && u.port !== '443') throw new Error('unusual port');
    const ctrl = AbortSignal.timeout(timeout);
    const requestOptions = {
      redirect: 'manual',
      headers: { 'user-agent': UA, accept, 'accept-language': 'en' },
      signal: signal ? AbortSignal.any([signal, ctrl]) : ctrl,
    };
    // An injected lookup is used by the offline fixtures with mocked fetch.
    const res = lookup === dns.lookup ? await publicRequest(u, requestOptions, addrs) : await fetch(u.href, requestOptions);
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel();
      current = new URL(res.headers.get('location'), u).href;
      continue;
    }
    if (!res.ok) { await res.body?.cancel(); throw Object.assign(new Error(`the site answered ${res.status}`), { status: res.status }); }
    const type = String(res.headers.get('content-type') || '').toLowerCase();
    const chunks = [];
    let size = 0;
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > PAGE_BYTES) { try { await reader.cancel(); } catch { /* closed */ } break; }
        chunks.push(Buffer.from(value));
      }
    } else {
      chunks.push(Buffer.from(await res.arrayBuffer()));
    }
    return { url: u.href, type, data: Buffer.concat(chunks) };
  }
  throw new Error('too many redirects');
}

const robotsCache = new Map();
/** Does the site's robots.txt allow automated reading of this page? A missing file means yes. */
async function robotsAllow(url, opts) {
  const u = new URL(url);
  let rules = robotsCache.get(u.origin);
  if (!rules) {
    rules = [];
    try {
      const r = await safeFetch(`${u.origin}/robots.txt`, { ...opts, accept: 'text/plain', timeout: 5000 });
      if (/text\/plain|^$/.test(r.type) || !/html/.test(r.type)) rules = parseRobots(r.data.toString('utf8'));
    } catch (e) {
      if (e.status !== 404 && e.status !== 410) throw new Error('the site’s automated-reading policy could not be checked');
    }
    robotsCache.set(u.origin, rules);
  }
  const path = u.pathname + u.search;
  let best = null;
  for (const r of rules) {
    if (!r.path) continue;
    if (robotsMatch(r.path, path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return !best || best.allow;
}

/**
 * Does a robots.txt rule match a path? "*" stands for any run of characters and a final "$" anchors the end
 * (RFC 9309). Literal pieces are found left to right with indexOf, so a hostile rule cannot make matching slow.
 */
function robotsMatch(rule, path) {
  const anchored = rule.endsWith('$');
  const pieces = (anchored ? rule.slice(0, -1) : rule).split('*');
  if (!path.startsWith(pieces[0])) return false;
  let at = pieces[0].length;
  const last = pieces.length - 1;
  for (let k = 1; k <= last; k++) {
    const piece = pieces[k];
    if (k === last && anchored) return path.length - piece.length >= at && path.endsWith(piece);
    if (!piece) continue;
    const found = path.indexOf(piece, at);
    if (found === -1) return false;
    at = found + piece.length;
  }
  return !anchored || at === path.length;
}

function parseRobots(txt) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === 'user-agent') {
      if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(m[2].toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (key === 'allow' || key === 'disallow') && m[2].length <= ROBOTS_RULE_MAX && cur.rules.length < ROBOTS_RULES_MAX) cur.rules.push({ allow: key === 'allow', path: m[2] });
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a.includes('lectern')));
  const any = groups.filter((g) => g.agents.includes('*'));
  return (mine.length ? mine : any).flatMap((g) => g.rules);
}

/** The text of a page's first <title>, found in one pass (a page full of unclosed <title> tags cannot slow it). */
function titleOf(html) {
  const open = /<title\b[^<>]*>/i.exec(html);
  if (!open) return '';
  const from = open.index + open[0].length;
  const close = /<\/title\s*>/gi;
  close.lastIndex = from;
  const end = close.exec(html);
  return end ? decodeEntities(html.slice(from, end.index)).replace(/\s+/g, ' ').trim().slice(0, 300) : '';
}

/** Fetch a page and return its readable text, or { skipped: reason }. */
async function readPage(url, opts) {
  try {
    if (!(await robotsAllow(url, opts))) return { skipped: 'the site does not allow automated reading' };
    const r = await safeFetch(url, opts);
    let text = '';
    if (r.type.includes('pdf') || r.data.subarray(0, 4).toString('latin1') === '%PDF') text = pdfText(r.data);
    else if (r.type.includes('html') || r.type.includes('xml') || /^\s*</.test(r.data.subarray(0, 200).toString('utf8'))) text = htmlText(r.data.toString('utf8'));
    else if (r.type.startsWith('text/')) text = r.data.toString('utf8');
    else return { skipped: 'not a readable page' };
    const title = titleOf(r.data.toString('utf8', 0, 200000));
    if (text.replace(/\s/g, '').length < 200) return { skipped: 'no readable text (it may need a sign-in or JavaScript)' };
    return { url: r.url, text: text.slice(0, 600000), title };
  } catch (e) {
    if (opts.signal && opts.signal.aborted) throw e;
    return { skipped: e.message || 'could not be read' };
  }
}

// ------------------------------------------------------------------ the check

/**
 * emit(event, data): 'step' { id, state, detail }, 'notice' { text }, 'result' { ...report }.
 * options: { quotes: bool, references: bool, web: bool, papers: bool }
 */
async function runSimilarityCheck({ text: input, options = {}, config, store, signal, emit = () => {}, engine: preferred, selectedModel, lookup }) {
  const opts = { quotes: options.quotes !== false, references: options.references !== false, web: options.web !== false, papers: options.papers !== false };
  const normal = T.normalizeText(input);
  const { text, trimmed, totalWords } = T.capWords(normal);
  if (T.words(text).length < 25) throw Object.assign(new Error('Add at least 25 words of text to check.'), { status: 400 });

  emit('step', { id: 'prepare', state: 'now' });
  const sub = prepareSubmission(text, opts);
  const passages = pickPassages(sub, 10);
  emit('step', { id: 'prepare', state: 'done', detail: `${passages.length} distinctive passages chosen` });

  const settings = config.get();
  const notes = [];
  if (trimmed) notes.push(`Only the first ${T.MAX_WORDS.toLocaleString('en')} of ${totalWords.toLocaleString('en')} words were checked.`);
  const candidates = [];
  const skipped = [];

  // 1. Paper databases and the Library.
  if (opts.papers) {
    emit('step', { id: 'papers', state: 'now' });
    let papers = [];
    try {
      const queries = passages.slice(0, 6).map((s) => passageQuery(sub, s)).filter(Boolean);
      if (queries.length) papers = merge(await searchAll({ queries, settings, signal })).slice(0, 60);
    } catch (e) {
      if (signal && signal.aborted) throw e;
      emit('notice', { text: `The paper databases could not be searched (${e.message}).` });
    }
    const library = (store && store.getLibrary ? store.getLibrary() : []) || [];
    const seen = new Set();
    for (const p of [...papers, ...library]) {
      const body = [p.title, p.abstract].filter(Boolean).join('. ');
      const key = p.doi || p.url || p.title;
      if (!body || body.length < 120 || seen.has(key)) continue;
      seen.add(key);
      candidates.push({ kind: library.includes(p) ? 'library' : 'paper', title: p.title || 'Untitled', url: p.url || (p.doi ? `https://doi.org/${p.doi}` : ''), doi: p.doi || '', authors: (p.authors || []).slice(0, 4).map((a) => (typeof a === 'string' ? a : [a.given, a.family].filter(Boolean).join(' '))), year: p.year || null, venue: p.venue || p.journal || '', text: body, part: 'title and abstract' });
    }
    emit('step', { id: 'papers', state: 'done', detail: `${candidates.length} papers compared` });
  }

  // 2. The web, through the model's web search. Its URLs are only candidates: each page is fetched and compared here.
  // The provider and model chosen in the window search, or the check says why the web was not searched: it never
  // quietly switches to another provider or model (the same rule as the AI-writing review and the proofreader).
  if (opts.web) {
    let engine = null;
    if (preferred) {
      const choice = (await llm.engineStatus(settings)).find((s) => s.id === preferred);
      if (choice && choice.ready) engine = preferred;
    } else engine = await llm.pickEngine(settings);
    const requestedModel = engine ? (selectedModel || settings.models[engine] || '') : '';
    if (!engine && preferred) {
      notes.push('The selected model provider is not connected, so the web was not searched. Sign in, or choose a connected provider, to include web pages.');
      emit('step', { id: 'web', state: 'skipped', detail: 'selected provider not connected' });
    } else if (!engine) {
      notes.push('No model is connected, so the web was not searched. Sign in to Claude or ChatGPT to include web pages.');
      emit('step', { id: 'web', state: 'skipped', detail: 'no model connected' });
    } else if (!passages.length) {
      emit('step', { id: 'web', state: 'skipped', detail: 'no passages long enough to search' });
    } else {
      emit('step', { id: 'web', state: 'now', detail: 'searching for distinctive passages' });
      let urls = [];
      try {
        const out = await llm.complete({
          engine, role: 'main', settings, effort: 'low', web: true,
          model: requestedModel || undefined, strictModel: !!requestedModel,
          system: Prompts.SOURCE_HUNT_SYSTEM,
          prompt: Prompts.sourceHuntPrompt(passages.map((s, k) => ({ n: k + 1, text: s.text }))),
          signal, onEvent: (ev) => { if (ev.type === 'status' && /search|read/i.test(ev.text)) emit('step', { id: 'web', state: 'now', detail: ev.text }); },
        });
        const json = extractJson(out.text) || {};
        urls = [...new Set((Array.isArray(json.sources) ? json.sources : []).map((s) => httpUrl(s && s.url)).filter(Boolean))].slice(0, 12);
      } catch (e) {
        if (signal && signal.aborted) throw e;
        emit('notice', { text: `The web search did not finish (${e.message}). Papers were still compared.` });
      }
      emit('step', { id: 'web', state: 'now', detail: urls.length ? `reading ${urls.length} pages` : 'no candidate pages found' });
      const queue = urls.slice();
      let read = 0;
      const worker = async () => {
        while (queue.length) {
          const url = queue.shift();
          const page = await readPage(url, { signal, lookup });
          if (page.skipped) { skipped.push({ url, why: page.skipped }); continue; }
          read++;
          let host = '';
          try { host = new URL(page.url).hostname.replace(/^www\./, ''); } catch { /* kept empty */ }
          candidates.push({ kind: 'web', title: page.title || host || page.url, url: page.url, host, text: page.text, part: 'web page' });
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      emit('step', { id: 'web', state: 'done', detail: `${read} of ${urls.length} pages read` });
    }
  } else {
    emit('step', { id: 'web', state: 'skipped', detail: 'web search turned off' });
  }

  // 3. Compare every candidate, then give each matching word to the source that explains the most text.
  emit('step', { id: 'compare', state: 'now' });
  const found = [];
  for (const c of candidates) {
    const idx = indexSource(c.text);
    const matches = compare(sub, idx, { skip: sub.skip });
    if (!matches.length) continue;
    for (const m of matches) {
      if (m.type === 'exact') { m.srcStart = idx.ws[m.srcFrom].start; m.srcEnd = idx.ws[m.srcTo - 1].end; }
    }
    const total = matches.reduce((n, m) => n + (m.to - m.from), 0);
    found.push({ c, idx, matches, total });
  }
  found.sort((a, b) => b.total - a.total || (a.c.kind === 'web') - (b.c.kind === 'web'));
  const owner = new Int16Array(sub.ws.length).fill(-1);
  const kindAt = new Uint8Array(sub.ws.length);
  const sources = [];
  for (const f of found) {
    const n = sources.length;
    let mine = 0;
    for (const m of f.matches) for (let k = m.from; k < m.to; k++) if (owner[k] < 0 && !sub.skip[k]) { owner[k] = n; kindAt[k] = m.type === 'exact' ? 1 : 2; mine++; }
    if (mine < MIN_MATCH) { for (let k = 0; k < owner.length; k++) if (owner[k] === n) owner[k] = -1; continue; }
    sources.push({ ...f, n, words: mine });
    if (sources.length >= 40) break;
  }

  const counted = sub.ws.length - sub.skip.reduce((a, b) => a + b, 0);
  const spans = [];
  for (let k = 0; k < sub.ws.length;) {
    if (owner[k] < 0) { k++; continue; }
    let j = k;
    while (j + 1 < sub.ws.length && owner[j + 1] === owner[k] && kindAt[j + 1] === kindAt[k]) j++;
    const src = sources.find((s) => s.n === owner[k]);
    const m = src.matches.find((x) => x.from <= k && x.to > k) || src.matches[0];
    const excerptFrom = Math.max(0, m.srcStart - 120);
    const excerptTo = Math.min(src.idx.text.length, m.srcEnd + 120);
    spans.push({
      start: sub.ws[k].start, end: sub.ws[j].end, source: src.n + 1, type: kindAt[k] === 1 ? 'exact' : 'paraphrase',
      words: j - k + 1, similarity: m.similarity || null,
      excerpt: { before: src.idx.text.slice(excerptFrom, m.srcStart).replace(/\s+/g, ' '), match: src.idx.text.slice(m.srcStart, m.srcEnd).replace(/\s+/g, ' '), after: src.idx.text.slice(m.srcEnd, excerptTo).replace(/\s+/g, ' ') },
    });
    k = j + 1;
  }
  const matchedWords = owner.reduce((n, o, k) => n + (o >= 0 && !sub.skip[k] ? 1 : 0), 0);
  emit('step', { id: 'compare', state: 'done', detail: `${candidates.length} sources compared` });

  if (!counted) notes.push('All words were excluded as quotations or references. There is no text left to score.');
  if (!candidates.length) notes.push('No sources could be compared, so no similarity score is available. Check your connection and the paper database settings.');
  return {
    text,
    words: sub.ws.length,
    countedWords: counted,
    score: counted && candidates.length ? Math.round((100 * matchedWords) / counted) : null,
    exactWords: owner.reduce((n, o, k) => n + (o >= 0 && kindAt[k] === 1 ? 1 : 0), 0),
    paraphraseWords: owner.reduce((n, o, k) => n + (o >= 0 && kindAt[k] === 2 ? 1 : 0), 0),
    sources: sources.map((s) => ({
      n: s.n + 1, kind: s.c.kind, title: s.c.title, url: s.c.url, doi: s.c.doi || '', host: s.c.host || '', authors: s.c.authors || [], year: s.c.year || null,
      venue: s.c.venue || '', part: s.c.part, words: s.words, percent: counted ? Math.max(1, Math.round((100 * s.words) / counted)) : 0,
      matches: spans.filter((sp) => sp.source === s.n + 1).length,
    })),
    spans,
    excluded: sub.excluded,
    searched: { passages: passages.length, candidates: candidates.length, papers: candidates.filter((c) => c.kind !== 'web').length, pages: candidates.filter((c) => c.kind === 'web').length, skipped },
    options: opts,
    notes,
  };
}

module.exports = { runSimilarityCheck, prepareSubmission, indexSource, compare, pickPassages, passageQuery, safeFetch, publicRequest, readPage, robotsAllow, robotsMatch, parseRobots, privateAddress, K, MIN_MATCH };
