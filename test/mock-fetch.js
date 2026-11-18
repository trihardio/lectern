'use strict';
// Replaces fetch() with canned responses so the whole app can run with no network.
// Used by the tests, and by `node -r ./test/mock-fetch.js server/start.js` to click
// through the interface offline. Requests to 127.0.0.1 still go to the real local server.

const fx = require('./fixtures');

const realFetch = globalThis.fetch;
const calls = [];
const state = { fail: {}, delay: Number(process.env.LECTERN_MOCK_DELAY || 0) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** OpenAlex has several kinds of request: a search, one paper by DOI, papers linked by citation, journals. */
function openalex(u) {
  const filter = u.searchParams.get('filter') || '';
  const one = /^\/works\/https:\/\/doi\.org\/(.+)$/.exec(decodeURIComponent(u.pathname));
  if (one) {
    const p = fx.BASE.find((x) => fx.doi(x) === one[1].toLowerCase());
    return p ? jsonResponse(fx.openalexWork(p)) : jsonResponse({ error: 'Not found' }, 404);
  }
  if (u.pathname === '/sources') {
    const ids = (/ids\.openalex:([^,]+)/.exec(filter) || [, ''])[1].split('|').filter(Boolean);
    return jsonResponse(fx.openalexSources(ids));
  }
  const dois = /(?:^|,)doi:([^,]+)/.exec(filter);
  if (dois) return jsonResponse(fx.openalex(fx.BASE.filter((p) => dois[1].split('|').includes(fx.doi(p))).map((p) => p.n)));
  if (/(?:^|,)cited_by:/.test(filter)) return jsonResponse(fx.openalex([1, 5, 6])); // what the paper cites
  if (/(?:^|,)cites:/.test(filter)) return jsonResponse(fx.openalex([3, 4, 8])); // what cites the paper
  return jsonResponse(fx.openalex());
}

/** The PMC Article Datasets bucket: a listing, an article's XML or JSON, or an image. */
function bucket(u) {
  const key = decodeURIComponent(u.pathname.slice(1));
  if (!key && u.searchParams.get('list-type') === '2') {
    return new Response(fx.bucketList(u.searchParams.get('prefix') || ''), { status: 200, headers: { 'content-type': 'application/xml' } });
  }
  if (fx.FIGURE_XML[key]) return new Response(fx.FIGURE_XML[key], { status: 200, headers: { 'content-type': 'binary/octet-stream' } });
  if (fx.FIGURE_JSON[key]) return new Response(JSON.stringify(fx.FIGURE_JSON[key]), { status: 200, headers: { 'content-type': 'binary/octet-stream' } });
  return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404, headers: { 'content-type': 'application/xml' } });
}

/**
 * The Gemini API: the key check (GET /v1beta/models) and the Interactions API, chosen by the key in the header.
 * Keys: 'bad-gemini-key' is refused, 'quota-gemini-key' has no quota left, 'free-gemini-key' has no web search,
 * 'cut-gemini-key' times out half way; any other key works. A model not named gemini-… is unknown.
 */
function gemini(u, init, body) {
  const key = (init.headers || {})['x-goog-api-key'];
  const err = (status, message, extra = {}) => jsonResponse({ error: { code: status, message, ...extra } }, status);
  if (!key || key === 'bad-gemini-key') return err(400, 'API key not valid. Please pass a valid API key.', { status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] });
  if (key === 'quota-gemini-key') return err(429, 'You exceeded your current quota, please check your plan and billing details.', { status: 'RESOURCE_EXHAUSTED' });
  if (u.pathname === '/v1beta/models') return jsonResponse({ models: [{ name: 'models/gemini-4-hydrogen' }] });
  if (u.pathname !== '/v1beta/interactions') return err(404, 'Not found.', { status: 'NOT_FOUND' });
  if (!/^gemini-/.test(body.model || '')) return err(404, `models/${body.model} is not found for API version v1beta.`, { status: 'NOT_FOUND' });
  if (key === 'free-gemini-key' && body.tools) return err(400, 'Grounding with Google Search is not available on the free tier.', { status: 'INVALID_ARGUMENT' });
  const web = !!body.tools;
  let text = fx.modelReply(`${body.system_instruction || ''}\n\n${body.input || ''}`);
  if (web && text === fx.ANSWER_TEXT) text = fx.withWebLinks(text);
  return new Response(fx.geminiStream({ text, model: body.model, web, cut: key === 'cut-gemini-key' }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function mockFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input.url;
  if (/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) return realFetch(input, init);

  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : null;
  if (init.signal && init.signal.aborted) throw new DOMException('Aborted', 'AbortError');
  calls.push({ url, host: u.hostname, path: u.pathname, params: Object.fromEntries(u.searchParams), headers: init.headers || {}, body });
  if (state.delay) await sleep(state.delay);

  const failing = state.fail[u.hostname];
  if (failing) return jsonResponse({ error: { message: 'mock failure' } }, failing);

  switch (u.hostname) {
    case 'api.openalex.org': return openalex(u);
    case 'api.semanticscholar.org': return jsonResponse(fx.semanticscholar());
    case 'api.crossref.org': return jsonResponse(fx.crossref());
    case 'www.ebi.ac.uk':
      // A search for a list of DOIs (finding open-access copies for figures), or a topic search.
      if (/DOI:"/.test(u.searchParams.get('query') || '')) return jsonResponse(fx.europepmcLite(u.searchParams.get('query')));
      return jsonResponse(fx.europepmc());
    case 'pmc-oa-opendata.s3.amazonaws.com': return bucket(u);
    case 'generativelanguage.googleapis.com': return gemini(u, init, body || {});
    case 'example.edu': {
      const r = fx.checkPage(u.pathname);
      return new Response(r.body || '', { status: r.status, headers: { 'content-type': r.type || 'text/plain', ...(r.location ? { location: r.location } : {}) } });
    }
    default:
      return jsonResponse({ error: { message: `unmocked host ${u.hostname}` } }, 599);
  }
}

globalThis.fetch = mockFetch;
// Offline there is no database to protect, so the request limiter (server/sources/index.js) does not wait between
// requests. Only the waiting is removed: the one-at-a-time rules still apply, so the order of requests stays realistic.
require('../server/sources').limiter.setPacing(false);
module.exports ={ calls, state, realFetch, reset() { calls.length = 0; state.fail = {}; } };
