'use strict';
// Semantic Scholar: ~200M papers, with one-line AI summaries ("tldr") for many of them.
// Works without a key, but the keyless pool is shared and often answers 429 (busy).

const { fetchJson } = require('../util');
const { makePaper, plainQuery, withBoost, usable } = require('./common');

const FIELDS = [
  'paperId', 'title', 'abstract', 'tldr', 'year', 'publicationDate', 'authors', 'venue', 'journal',
  'externalIds', 'citationCount', 'openAccessPdf', 'isOpenAccess', 'publicationTypes', 'url',
].join(',');

// A search takes plain words only ("No special query syntax is supported", api.semanticscholar.org/api-docs, read
// 2026-11-18), and every word must be present, so operators and quotes the planner left in would only narrow the match.
// A request returns at most 100 papers.
function buildUrl(query, { filters = {}, limit = 20, boost } = {}) {
  const params = new URLSearchParams({ query: withBoost(plainQuery(query), boost, false), limit: String(Math.min(100, limit)), fields: FIELDS });
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
      // Semantic Scholar has no preprint type: a preprint is a paper whose DOI, venue or journal is a preprint server.
      preprint: !!ext.ArXiv && !j.name && /arxiv/i.test(p.venue || 'arxiv'),
      arxiv: ext.ArXiv,
      pmid: ext.PubMed,
      pmcid: ext.PubMedCentral && `PMC${String(ext.PubMedCentral).replace(/^PMC/i, '')}`,
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
    })).filter(usable);
  } catch (e) {
    if (e.status === 429) {
      e.message = key
        ? 'Semantic Scholar is rate-limiting this key. Try again in a moment.'
        : 'Semantic Scholar is busy (its keyless pool is shared). A free key in Settings makes it reliable.';
    }
    throw e;
  }
}

module.exports = { name: 'semanticscholar', label: 'Semantic Scholar', search, parse, buildUrl, boosts: true };
