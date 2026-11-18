'use strict';
// OpenAlex: ~250M works across every discipline. Since November 2026 it bills in dollars, not requests
// (docs.openalex.org/access/example-costs, read 2026-11-18): $0.10 a day without a key and $1 a day with a free key
// (openalex.org/settings/api-key). A search costs $0.001, a search with rerank $0.002, a list with filters only $0.0001, and
// looking up one work is free. So a keyless day is about 100 searches and a keyed day about 1,000.

const { fetchJson } = require('../util');
const { makePaper, plainQuery, withBoost, usable } = require('./common');

const SELECT = [
  'id', 'doi', 'display_name', 'publication_year', 'publication_date', 'type', 'cited_by_count',
  'is_retracted', 'authorships', 'primary_location', 'best_oa_location', 'open_access', 'biblio',
  'abstract_inverted_index', 'topics',
  // study_designs: tags from the title and abstract (RCT, systematic review...). ids and locations: other ids and DOIs
  // of the same work. rerank_score is only present on a reranked search.
  'ids', 'locations', 'study_designs', 'rerank_score',
].join(',');

// Kinds of record that are never a paper to cite. Excluded in the request so they do not use up result slots.
const NOT_RESEARCH = ['erratum', 'retraction', 'paratext', 'peer-review', 'supplementary-materials', 'study-registration', 'dataset', 'software', 'standard', 'conference-abstract', 'book-review'];

const tail = (id) => String(id || '').split('/').pop();

/** OpenAlex stores abstracts as { word: [positions] }. Rebuild the text. */
function rebuildAbstract(index) {
  if (!index || typeof index !== 'object') return '';
  const words = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const pos of positions) words[pos] = word;
  }
  return words.filter((w) => w !== undefined).join(' ');
}

/** The filters OpenAlex can apply itself. The rest are applied after merging (sources/index.js). */
function filterParts(filters = {}, { hasAbstract = false } = {}) {
  const f = ['is_retracted:false'];
  if (hasAbstract) f.push('has_abstract:true');
  if (filters.yearFrom) f.push(`from_publication_date:${filters.yearFrom}-01-01`);
  if (filters.yearTo) f.push(`to_publication_date:${filters.yearTo}-12-31`);
  if (filters.oaOnly) f.push('open_access.is_oa:true');
  if (filters.minCitations > 0) f.push(`cited_by_count:>${filters.minCitations - 1}`);
  f.push(`type:!${[...NOT_RESEARCH, ...(filters.noPreprints ? ['preprint'] : [])].join('|')}`);
  if (filters.fields && filters.fields.length) f.push(`topics.field.id:${filters.fields.join('|')}`);
  return f;
}

// The key travels in an Authorization header (docs.openalex.org/api/authentication lists it next to the api_key
// parameter), so it never appears in a URL, a log line or a cache key. The old mailto parameter is no longer documented.
function apiUrl(path, params) {
  return `https://api.openalex.org${path}?${new URLSearchParams(params)}`;
}

function authHeaders(settings = {}) {
  const key = settings.keys && settings.keys.openalex;
  return key ? { authorization: `Bearer ${key}` } : {};
}

/**
 * A query for OpenAlex's search. It accepts AND, OR, NOT, "phrases" and brackets, and answers 400 to a stray wildcard, an
 * odd number of quotes or brackets that do not pair up, so those are repaired here instead of failing the search.
 */
function cleanQuery(q) {
  let t = String(q || '').replace(/[*~^\\{}\[\]|]/g, ' ').replace(/["“”]/g, '"');
  if ((t.match(/"/g) || []).length % 2) t = t.replace(/"/g, ' ');
  const open = (t.match(/\(/g) || []).length;
  if (open !== (t.match(/\)/g) || []).length) t = t.replace(/[()]/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t.replace(/^(?:(?:AND|OR)\s+)+/, '').replace(/(?:\s+(?:AND|OR|NOT))+$/, '').trim();
}

// Which part of a work each search mode looks at (docs.openalex.org/api/searching, read 2026-11-18). `search` also
// reads the full text, which finds more and adds noise; the title/abstract/keywords form is what openalex.org itself uses;
// `semantic` ranks by meaning, returns at most 50 works and accepts only a few filters.
const SEARCH_PARAM = { fulltext: 'search', title_abstract_keywords: 'search.title_abstract_keywords', title_and_abstract: 'search.title_and_abstract', semantic: 'search.semantic' };

/** The only filters semantic search accepts (docs.openalex.org/api/semantic-search); any other returns a 400. */
function semanticFilterParts(filters = {}, { hasAbstract = false } = {}) {
  const f = ['is_retracted:false', `type:!${NOT_RESEARCH.join('|')}`];
  if (hasAbstract) f.push('has_abstract:true');
  if (filters.yearFrom || filters.yearTo) f.push(`publication_year:${filters.yearFrom || 1000}-${filters.yearTo || 2100}`);
  if (filters.oaOnly) f.push('open_access.is_oa:true');
  return f;
}

/**
 * opts.hasAbstract=true keeps only works that have an abstract (filter has_abstract, allowed in every mode);
 * opts.mode picks the search form (see SEARCH_PARAM); opts.rerank=true asks OpenAlex to reorder the top 100 by
 * relevance, at twice the price; opts.boost is a list of phrases the work should also mention (reviews-only searches).
 */
function buildUrl(query, { filters = {}, limit = 25, mode = DEFAULT_MODE, rerank = DEFAULT_RERANK, boost, hasAbstract = false } = {}) {
  const semantic = mode === 'semantic';
  const params = {
    [SEARCH_PARAM[mode] || 'search']: semantic ? withBoost(plainQuery(query), boost, false) : withBoost(cleanQuery(query), boost, true),
    per_page: String(Math.min(semantic ? 50 : 100, limit)),
    select: SELECT,
    filter: (semantic ? semanticFilterParts(filters, { hasAbstract }) : filterParts(filters, { hasAbstract })).join(','),
  };
  if (rerank && !semantic) params.rerank = 'true';
  return apiUrl('/works', params);
}

const DEFAULT_MODE = 'fulltext';
const DEFAULT_RERANK = false;

/** One OpenAlex work record -> Lectern's paper shape. */
function parseWork(w) {
  const loc = w.primary_location || {};
  const oa = w.best_oa_location || {};
  const src = loc.source || {};
  const b = w.biblio || {};
  // A paper carries up to three topics, each in a field; it counts as belonging to all of those fields.
  const fields = new Map((w.topics || []).map((t) => t.field).filter((f) => f && f.id).map((f) => [tail(f.id), f.display_name]));
  const locs = w.locations || [];
  const ids = w.ids || {};
  const arxivLoc = locs.find((l) => /arxiv\.org\/(abs|pdf)\//i.test(l.landing_page_url || '') || /arxiv\.org:/i.test(l.id || ''));
  const pages = b.first_page ? (b.last_page && b.last_page !== b.first_page ? `${b.first_page}-${b.last_page}` : b.first_page) : '';
  return makePaper({
    source: 'openalex',
    doi: w.doi,
    title: w.display_name,
    authors: (w.authorships || []).map((a) => a.author && a.author.display_name),
    year: w.publication_year,
    date: w.publication_date,
    venue: src.display_name,
    publisher: src.host_organization_name,
    volume: b.volume,
    issue: b.issue,
    pages,
    types: [w.type],
    designs: (w.study_designs || []).map((d) => d.id),
    preprint: w.type === 'preprint',
    pmid: ids.pmid,
    pmcid: ids.pmcid,
    arxiv: arxivLoc && ((arxivLoc.landing_page_url || '').replace(/^.*arxiv\.org\/(?:abs|pdf)\//i, '') || (arxivLoc.id || '').replace(/^.*arxiv\.org:/i, '')),
    // A work found by its published DOI can also hold a preprint's DOI: any location's DOI names the same work.
    altDois: locs.map((l) => l.doi),
    relScore: w.rerank_score,
    abstract: rebuildAbstract(w.abstract_inverted_index),
    citations: w.cited_by_count,
    isOA: !!(w.open_access && w.open_access.is_oa),
    pdfUrl: oa.pdf_url || loc.pdf_url || '',
    url: (w.open_access && w.open_access.oa_url) || loc.landing_page_url || w.doi || w.id,
    retracted: w.is_retracted,
    fields: [...fields.values()],
    fieldIds: [...fields.keys()],
    journalId: src.id ? tail(src.id) : '',
    oaId: tail(w.id),
  });
}

function parse(json) {
  return (json.results || []).map(parseWork);
}

/** Every OpenAlex request goes through here, so a refusal always reads the same way. */
async function request(url, opts = {}) {
  try {
    return await fetchJson(url, { signal: opts.signal, headers: authHeaders(opts.settings) });
  } catch (e) {
    if ([401, 403, 409, 429].includes(e.status)) {
      const hasKey = !!(opts.settings && opts.settings.keys && opts.settings.keys.openalex);
      e.message = hasKey
        ? 'OpenAlex refused the request. Check the key in Settings, or today\'s free allowance may be used up.'
        : 'OpenAlex turned this search away: the daily allowance without a key is used up. A free API key in Settings gives ten times more.';
      e.needsKey = !hasKey;
    }
    throw e;
  }
}

async function search(query, opts = {}) {
  return parse(await request(buildUrl(query, opts), opts)).filter(usable);
}

/** One paper by DOI, or null when OpenAlex does not have it. */
async function workByDoi(doi, opts = {}) {
  try {
    return parseWork(await request(apiUrl(`/works/https://doi.org/${encodeURI(doi)}`, { select: SELECT }), opts));
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

/** Many papers by DOI in as few requests as possible (50 DOIs each). */
async function worksByDoi(dois, opts = {}) {
  const out = [];
  for (let i = 0; i < dois.length; i += 50) {
    const chunk = dois.slice(i, i + 50);
    out.push(...parse(await request(apiUrl('/works', { filter: `doi:${chunk.join('|')}`, per_page: '50', select: SELECT }), opts)));
  }
  return out;
}

/**
 * Papers linked to one paper by citation.
 *   dir 'references'  the papers it cites        (OpenAlex filter cited_by:<id>)
 *   dir 'citing'      the papers that cite it    (OpenAlex filter cites:<id>)
 * sort 'cited' = most cited first, 'newest' = most recent first.
 */
function relatedUrl(oaId, dir, { filters = {}, limit = 20, sort = 'cited' } = {}) {
  const f = [`${dir === 'references' ? 'cited_by' : 'cites'}:${oaId}`, ...filterParts(filters)];
  return apiUrl('/works', {
    filter: f.join(','), per_page: String(limit), select: SELECT,
    sort: sort === 'newest' ? 'publication_date:desc' : 'cited_by_count:desc',
  });
}

async function related(oaId, dir, opts = {}) {
  return parse(await request(relatedUrl(oaId, dir, opts), opts));
}

/** Journal impact for a set of journals: Map of journal id -> 2-year mean citedness. */
async function journalStats(journalIds, opts = {}) {
  const out = new Map();
  for (let i = 0; i < journalIds.length; i += 50) {
    const chunk = journalIds.slice(i, i + 50);
    const json = await request(apiUrl('/sources', { filter: `ids.openalex:${chunk.join('|')}`, per_page: '50', select: 'id,summary_stats' }), opts);
    for (const src of json.results || []) {
      const v = src.summary_stats && src.summary_stats['2yr_mean_citedness'];
      if (Number.isFinite(v)) out.set(tail(src.id), v);
    }
  }
  return out;
}

module.exports = {
  name: 'openalex', label: 'OpenAlex', boosts: true, semantic: true, search, parse, parseWork, buildUrl, rebuildAbstract, cleanQuery, authHeaders,
  workByDoi, worksByDoi, related, relatedUrl, journalStats, filterParts,
};
