'use strict';
// Small shared helpers. No dependencies: everything here runs on plain Node 20.3+ (AbortSignal.any).

const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// How Lectern names itself to the paper databases: its real version, from package.json.
const APP_UA = `Lectern/${require('../package.json').version} (local research app)`;
const uid = (n = 8) => crypto.randomBytes(n).toString('hex');

function clip(s, max) {
  s = String(s || '');
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}

function stripTags(s) {
  return String(s || '')
    .replace(/<\/(p|title|sec|div|li)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
}

function clean(s) {
  if (s == null) return '';
  return stripTags(Array.isArray(s) ? s[0] : s).replace(/\s+/g, ' ').trim();
}

function cleanAbstract(s) {
  return clean(s).replace(/^(abstract|summary)\s*[:.]?\s*/i, '');
}

function normDoi(doi) {
  if (!doi) return '';
  const d = String(doi).trim().toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
    .replace(/^doi:\s*/, '');
  return /^10\.\d{4,9}\/\S+$/.test(d) ? d : '';
}

function normTitle(t) {
  return String(t || '').toLowerCase().normalize('NFKD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function httpUrl(u) {
  if (!u || typeof u !== 'string') return '';
  return /^https?:\/\//i.test(u.trim()) ? u.trim() : '';
}

/**
 * A web address in a form for telling whether two links name the same page: http and https, "www.", a trailing
 * slash and the #fragment do not count. '' for anything that is not a web address. ui/render.js has the same rule.
 */
function urlKey(u) {
  let x;
  try { x = new URL(String(u || '').trim()); } catch { return ''; }
  if (x.protocol !== 'http:' && x.protocol !== 'https:') return '';
  return `${x.host.replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}${x.search}`;
}

/** Combine a caller's AbortSignal with a timeout. */
function withTimeout(signal, ms) {
  const signals = [AbortSignal.timeout(ms)];
  if (signal) signals.push(signal);
  return AbortSignal.any(signals);
}

class HttpError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/**
 * GET JSON with a timeout and one polite retry on 429/5xx.
 * Throws HttpError with .status on non-2xx.
 */
async function fetchJson(url, { headers = {}, signal, timeout = 15000, retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': APP_UA, ...headers },
        signal: withTimeout(signal, timeout),
      });
      if (res.ok) return await res.json();
      const body = await res.text().catch(() => '');
      const err = new HttpError(res.status, `HTTP ${res.status}`, body.slice(0, 500));
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const ra = Number(res.headers.get('retry-after'));
        await sleep(Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1200, 4000));
        lastErr = err;
        continue;
      }
      throw err;
    } catch (e) {
      if (signal && signal.aborted) throw e;
      if (e instanceof HttpError) throw e;
      lastErr = e;
      if (attempt < retries) { await sleep(600); continue; }
    }
  }
  throw lastErr;
}

/** Parse a fetch() Response body as server-sent events. Yields { event, data } with data as raw string. */
async function* sseEvents(res) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    // Events are separated by a blank line; tolerate \r\n.
    while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
      const ev = parseSseBlock(raw);
      if (ev) yield ev;
    }
  }
  const tail = parseSseBlock(buf);
  if (tail) yield tail;
}

function parseSseBlock(raw) {
  let event = 'message';
  const data = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i === -1 ? line : line.slice(0, i);
    const value = i === -1 ? '' : line.slice(i + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length ? { event, data: data.join('\n') } : null;
}

/**
 * Pull the first JSON object out of model text (handles ```json fences and stray prose). Models sometimes put raw line
 * breaks or tabs inside a string (a rewrite with paragraph breaks), which JSON forbids: when the object does not parse as
 * it is, it is read once more with those control characters escaped, inside strings only. Valid JSON is read unchanged.
 */
function extractJson(text) {
  if (!text) return null;
  const s = String(text);
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = fenced ? [fenced[1], s] : [s];
  const ESC = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };
  for (const c of candidates) {
    const start = c.indexOf('{');
    if (start === -1) continue;
    let depth = 0, inStr = false, esc = false, raw = false;
    let repaired = '';
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        else if (ch < ' ') { raw = true; repaired += ESC[ch] || `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`; continue; }
      } else if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(c.slice(start, i + 1)); } catch { /* try the repaired copy below */ }
          if (raw) { try { return JSON.parse(repaired + ch); } catch { /* not JSON after all */ } }
          break;
        }
      }
      repaired += ch;
    }
  }
  return null;
}

module.exports = {
  sleep, uid, clip, stripTags, clean, cleanAbstract, normDoi, normTitle, httpUrl, urlKey, APP_UA,
  withTimeout, HttpError, fetchJson, sseEvents, parseSseBlock, extractJson,
};
