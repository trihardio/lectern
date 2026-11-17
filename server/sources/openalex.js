'use strict';
// OpenAlex: ~250M works across every discipline. Queries work without a key on a small daily allowance;
// a free key (openalex.org/settings/api) gives ten times more (help.openalex.org, checked 2026-11-17).

const { fetchJson } = require('../util');
const { makePaper } = require('./common');

const SELECT = [
  'id', 'doi', 'display_name', 'publication_year', 'publication_date', 'type', 'cited_by_count',
  'is_retracted', 'authorships', 'primary_location', 'best_oa_location', 'open_access', 'biblio',
  'abstract_inverted_index', 'topics',
].join(',');

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
function filterParts(filters = {}) {
  const f = ['is_retracted:false'];
  if (filters.yearFrom) f.push(`from_publication_date:${filters.yearFrom}-01-01`);
  if (filters.yearTo) f.push(`to_publication_date:${filters.yearTo}-12-31`);
  if (filters.oaOnly) f.push('open_access.is_oa:true');
  if (filters.minCitations > 0) f.push(`cited_by_count:>${filters.minCitations - 1}`);
  if (filters.noPreprints) f.push('type:!preprint');
  if (filters.fields && filters.fields.length) f.push(`topics.field.id:${filters.fields.join('|')}`);
  return f;
}

function apiUrl(path, params, settings = {}) {
  const q = new URLSearchParams(params);
  if (settings.keys && settings.keys.openalex) q.set('api_key', settings.keys.openalex);
  if (settings.email) q.set('mailto', settings.email);
  return `https://api.openalex.org${path}?${q}`;
}

function buildUrl(query, { filters = {}, settings = {}, limit = 25 }) {
  return apiUrl('/works', { search: query, per_page: String(limit), select: SELECT, filter: filterParts(filters).join(',') }, settings);
}

/** One OpenAlex work record -> Lectern's paper shape. */
function parseWork(w) {
  const loc = w.primary_location || {};
  const oa = w.best_oa_location || {};
  const src = loc.source || {};
  const b = w.biblio || {};
  // A paper carries up to three topics, each in a field; it counts as belonging to all of those fields.
  const fields = new Map((w.topics || []).map((t) => t.field).filter((f) => f && f.id).map((f) => [tail(f.id), f.display_name]));
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
    return await fetchJson(url, { signal: opts.signal });
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
  return parse(await request(buildUrl(query, opts), opts));
}

/** One paper by DOI, or null when OpenAlex does not have it. */
async function workByDoi(doi, opts = {}) {
  try {
    return parseWork(await request(apiUrl(`/works/https://doi.org/${encodeURI(doi)}`, { select: SELECT }, opts.settings), opts));
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
    out.push(...parse(await request(apiUrl('/works', { filter: `doi:${chunk.join('|')}`, per_page: '50', select: SELECT }, opts.settings), opts)));
  }
  return out;
}

/**
 * Papers linked to one paper by citation.
 *   dir 'references'  the papers it cites        (OpenAlex filter cited_by:<id>)
 *   dir 'citing'      the papers that cite it    (OpenAlex filter cites:<id>)
 * sort 'cited' = most cited first, 'newest' = most recent first.
 */
function relatedUrl(oaId, dir, { filters = {}, settings = {}, limit = 20, sort = 'cited' } = {}) {
  const f = [`${dir === 'references' ? 'cited_by' : 'cites'}:${oaId}`, ...filterParts(filters)];
  return apiUrl('/works', {
    filter: f.join(','), per_page: String(limit), select: SELECT,
    sort: sort === 'newest' ? 'publication_date:desc' : 'cited_by_count:desc',
  }, settings);
}

async function related(oaId, dir, opts = {}) {
  return parse(await request(relatedUrl(oaId, dir, opts), opts));
}

/** Journal impact for a set of journals: Map of journal id -> 2-year mean citedness. */
async function journalStats(journalIds, opts = {}) {
  const out = new Map();
  for (let i = 0; i < journalIds.length; i += 50) {
    const chunk = journalIds.slice(i, i + 50);
    const json = await request(apiUrl('/sources', { filter: `ids.openalex:${chunk.join('|')}`, per_page: '50', select: 'id,summary_stats' }, opts.settings), opts);
    for (const src of json.results || []) {
      const v = src.summary_stats && src.summary_stats['2yr_mean_citedness'];
      if (Number.isFinite(v)) out.set(tail(src.id), v);
    }
  }
  return out;
}

module.exports = {
  name: 'openalex', label: 'OpenAlex', search, parse, parseWork, buildUrl, rebuildAbstract,
  workByDoi, worksByDoi, related, relatedUrl, journalStats, filterParts,
};
