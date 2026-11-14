'use strict';
// Semantic Scholar: ~200M papers, with one-line AI summaries ("tldr") for many of them.
// Works without a key, but the keyless pool is shared and often answers 429 (busy).

const { fetchJson } = require('../util');
const { makePaper } = require('./common');

const FIELDS = [
  'paperId', 'title', 'abstract', 'tldr', 'year', 'publicationDate', 'authors', 'venue', 'journal',
  'externalIds', 'citationCount', 'openAccessPdf', 'isOpenAccess', 'publicationTypes', 'url',
].join(',');

function buildUrl(query, { filters = {}, limit = 20 }) {
  const params = new URLSearchParams({ query, limit: String(limit), fields: FIELDS });
  if (filters.yearFrom || filters.yearTo) params.set('year', `${filters.yearFrom || ''}-${filters.yearTo || ''}`);
  if (filters.minCitations > 0) params.set('minCitationCount', String(filters.minCitations));
  let url = `https://api.semanticscholar.org/graph/v1/paper/search?${params}`;
  if (filters.oaOnly) url += '&openAccessPdf';
  return url;
}

function parse(json) {
  return (json.data || []).map((p) => {
    const ext = p.externalIds || {};
    const j = p.journal || {};
    return makePaper({
      source: 'semanticscholar',
      doi: ext.DOI,
      title: p.title,
      authors: (p.authors || []).map((a) => a.name),
      year: p.year,
      date: p.publicationDate,
      venue: j.name || p.venue,
      volume: j.volume,
      pages: j.pages,
      types: p.publicationTypes || [],
      abstract: p.abstract,
      tldr: p.tldr && p.tldr.text,
      citations: p.citationCount,
      isOA: !!p.isOpenAccess,
      pdfUrl: p.openAccessPdf && p.openAccessPdf.url,
      url: p.url,
    });
  });
}

async function search(query, opts = {}) {
  const key = opts.settings && opts.settings.keys && opts.settings.keys.semanticscholar;
  try {
    return parse(await fetchJson(buildUrl(query, opts), {
      signal: opts.signal,
      headers: key ? { 'x-api-key': key } : {},
      retries: 2,
    }));
  } catch (e) {
    if (e.status === 429) {
      e.message = key
        ? 'Semantic Scholar is rate-limiting this key. Try again in a moment.'
        : 'Semantic Scholar is busy (its keyless pool is shared). A free key in Settings makes it reliable.';
    }
    throw e;
  }
}

module.exports = { name: 'semanticscholar', label: 'Semantic Scholar', search, parse, buildUrl };
