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
    default:
      return jsonResponse({ error: { message: `unmocked host ${u.hostname}` } }, 599);
  }
}

globalThis.fetch = mockFetch;
module.exports = { calls, state, realFetch, reset() { calls.length = 0; state.fail = {}; } };
